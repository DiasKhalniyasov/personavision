/**
 * The trajectory file: one agent session's whole LLM trajectory on disk, the replay that
 * re-runs that session from it, and the audit that reads a run's bill back out of it (#139).
 *
 * A model run is otherwise a black box. `sessions/S-NN.json` says what an agent did; nothing
 * in it says what the agent was asked or what came back, so a decision cannot be checked, a
 * run cannot be re-run without paying for it again, and an invoice cannot be reconciled with
 * anything. These functions are the answer, and four properties are load-bearing:
 *
 * 1. **Append-only, write-through.** Every record is one `appendFile` of one whole line, in
 *    the order the sink was handed them. Nothing is buffered and no line is ever rewritten,
 *    so a run killed between two turns leaves a file whose every line parses — and `close`
 *    has nothing left to flush but the appends already in flight.
 * 2. **No secrets, by construction.** The sink writes the record it is given and adds a
 *    timestamp. The provider hands it a body it has already redacted and never hands it a
 *    request header at all (`meta-model.ts`), so there is no path by which a key or an
 *    `Authorization` header could reach a run directory — not on the success path and not on
 *    the error path. `tests/trajectory.test.ts` asserts the outcome over the whole directory
 *    with a key in the environment, because the file is the thing a run ships.
 * 3. **Replay serves a recorded answer only to the question it was recorded for.** A request
 *    that does not match the recorded one is a typed mismatch, and the recorded response it
 *    did not match is *not* consumed: a replay that drifted one turn would otherwise answer
 *    every later screen with the turn before's decision and look like a successful run.
 * 4. **A turn is costed at the prices of the model the record names**, through the same
 *    `estimateCostUsd` and the same `totalUsage` the run artifact's figures are built with.
 *    A contributor turn priced as standard overstates it twelvefold, so the audit never
 *    knows a rate of its own.
 *
 * The file's path is written here rather than in `packages/contract`, because a trajectory is
 * a sidecar of the run directory and not a field of the run artifact — the same arrangement
 * as the committed capture set of #51. `personavision validate` reads the artifact's own
 * files and is indifferent to it.
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { totalUsage } from './decision.js';
import { createMetaModelApiProvider } from './meta-model.js';
import type { ModelFailureKind, ModelTransport, TrajectoryRecord } from './meta-model.js';
import { estimateCostUsd, MODEL_SPEC_BY_ID } from './meta-pricing.js';
import type { ModelId, ModelMode } from './meta-pricing.js';
import { readTokens } from './meta-request.js';
import type { DecisionProvider, DecisionUsage, TrajectoryEntry, TrajectorySink } from './types.js';
import type { RunUsage } from '@personavision/contract';

/** Where a run directory keeps its trajectories, beside `sessions/`. */
const TRAJECTORIES_DIR = 'trajectories';

const TRAJECTORY_EXTENSION = '.jsonl';

/** `trajectories/S-01.jsonl` for session `S-01`, under `runDir`. */
export const trajectoryPath = (runDir: string, sessionId: string): string =>
  join(runDir, TRAJECTORIES_DIR, `${sessionId}${TRAJECTORY_EXTENSION}`);

/** The session id a trajectory file name carries, or `null` if the file is not one. */
export const sessionIdFromTrajectoryFileName = (fileName: string): string | null => {
  if (!fileName.endsWith(TRAJECTORY_EXTENSION)) return null;
  const sessionId = fileName.slice(0, -TRAJECTORY_EXTENSION.length);
  return sessionId === '' ? null : sessionId;
};

/**
 * One line of a trajectory file: the provider's record, plus when the sink wrote it.
 *
 * `atMs` is epoch milliseconds read from the process's monotonic clock
 * (`performance.timeOrigin + performance.now()`), and clamped so that it never goes
 * backwards: a wall clock corrected mid-run would otherwise order two turns of one session
 * the wrong way round in the one file whose order is its meaning.
 */
export type TrajectoryLine = TrajectoryRecord & { readonly atMs: number };

const monotonicNow = (): number => Number((performance.timeOrigin + performance.now()).toFixed(3));

/** One session's open trajectory file. */
export interface TrajectoryFile {
  /** The file it writes, which does not exist until the first record arrives. */
  readonly path: string;
  /** Where the provider's records go. */
  readonly sink: TrajectorySink;
  /**
   * Waits for every record handed to the sink to be on disk, and resolves however often it
   * is called. It never rejects: nothing is buffered, so a write that failed already came
   * back to the provider that asked for it, which turns it into a typed `trajectory` failure
   * rather than a hole in a file nobody was told about.
   */
  close(): Promise<void>;
}

/**
 * Opens one session's trajectory file. Nothing is created until the first record: a session
 * on the offline provider makes no model call, writes no record, and so leaves no file
 * rather than an empty one — which is what the audit reader reports as nothing.
 */
export const openTrajectoryFile = (options: {
  readonly runDir: string;
  readonly sessionId: string;
  /** The clock, for a test that wants a trajectory it can predict. */
  readonly now?: () => number;
}): TrajectoryFile => {
  const path = trajectoryPath(options.runDir, options.sessionId);
  const clock = options.now ?? monotonicNow;
  let previous = 0;
  let written: Promise<void> = Promise.resolve();
  let directoryMade = false;

  const append = async (record: TrajectoryEntry): Promise<void> => {
    const atMs = Math.max(previous, clock());
    previous = atMs;
    if (!directoryMade) {
      await mkdir(dirname(path), { recursive: true });
      directoryMade = true;
    }
    await appendFile(path, `${JSON.stringify({ ...record, atMs })}\n`, 'utf8');
  };

  return {
    path,
    // Chained rather than fired: the file's order is the trajectory, so two records handed
    // over without an await in between are still appended in the order they arrived.
    sink: (record) => {
      const appending = written.then(() => append(record));
      written = appending.catch(() => undefined);
      return appending;
    },
    close: () => written,
  };
};

/** A trajectory file that is not one: a line that will not parse, or a record without its fields. */
export class TrajectoryReadError extends Error {
  readonly path: string;
  /** Counted from 1, as a reader of the file counts. */
  readonly line: number | null;

  constructor(options: { readonly path: string; readonly line?: number; readonly detail: string }) {
    super(
      `${options.path}${options.line === undefined ? '' : ` line ${options.line}`}: ${options.detail}`,
    );
    this.name = 'TrajectoryReadError';
    this.path = options.path;
    this.line = options.line ?? null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const KINDS = new Set(['request', 'response', 'failure']);

/**
 * Reads one trajectory file, or `null` when there is none — a session that made no model
 * call, which is nothing rather than an error.
 *
 * A line that will not parse is a `TrajectoryReadError` naming the line, because the file is
 * the evidence: a reader that skipped a bad line would audit a run against a trajectory it
 * had quietly shortened.
 */
export const readTrajectory = async (path: string): Promise<readonly TrajectoryLine[] | null> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.trim() !== '')
    .map((entry) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.line) as unknown;
      } catch (error) {
        throw new TrajectoryReadError({
          path,
          line: entry.number,
          detail: `is not JSON (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      if (
        !isObject(parsed) ||
        typeof parsed.kind !== 'string' ||
        !KINDS.has(parsed.kind) ||
        typeof parsed.turn !== 'number' ||
        typeof parsed.modelId !== 'string' ||
        typeof parsed.mode !== 'string' ||
        typeof parsed.atMs !== 'number'
      ) {
        throw new TrajectoryReadError({
          path,
          line: entry.number,
          detail: 'is not a trajectory record: a kind, a turn, a model id, a mode and a timestamp',
        });
      }
      return parsed as unknown as TrajectoryLine;
    });
};

/**
 * A replayed request that is not the recorded one.
 *
 * It is typed and it is thrown rather than answered, because the alternative is the one
 * failure a replay must not have: serving the next recorded response to a question it was
 * not the answer to. The recorded turn stays unconsumed, so the mismatch is recoverable and
 * the trajectory still reads from where it was.
 */
export class TrajectoryMismatchError extends Error {
  readonly kind = 'mismatch' as const;
  /** The recorded turn the request was compared against, or `null` when there is none left. */
  readonly turn: number | null;

  constructor(options: { readonly turn: number | null; readonly detail: string }) {
    super(
      `the replayed request does not match ${
        options.turn === null ? 'the trajectory' : `recorded turn ${options.turn}`
      }: ${options.detail}`,
    );
    this.name = 'TrajectoryMismatchError';
    this.turn = options.turn;
  }
}

/** An `AbortError`, so that a recorded timeout replays as a timeout and not as a transport error. */
const replayedFailure = (failure: {
  readonly kind: ModelFailureKind;
  readonly message: string;
}): Error => {
  const error = new Error(`recorded ${failure.kind}: ${failure.message}`);
  if (failure.kind === 'timeout') error.name = 'AbortError';
  return error;
};

/**
 * A transport that answers from a recorded trajectory: no key, no socket, and the same
 * responses in the same order.
 *
 * It matches on the request body, which carries the model, the whole conversation and the
 * session's `prompt_cache_key` — so a replay of the wrong persona, the wrong seed or a screen
 * the session never saw is a mismatch rather than a plausible-looking run.
 */
export const replayTrajectory = (lines: readonly TrajectoryLine[]): ModelTransport => {
  let cursor = 0;

  return (request) => {
    // Scanned on a copy of the cursor: nothing is consumed until the request has matched.
    let at = cursor;
    while (at < lines.length && lines[at]?.kind !== 'request') at += 1;
    const recorded = lines[at];
    if (recorded === undefined || recorded.kind !== 'request') {
      throw new TrajectoryMismatchError({
        turn: null,
        detail: 'the trajectory records no further request',
      });
    }
    if (JSON.stringify(recorded.body) !== JSON.stringify(request.body)) {
      throw new TrajectoryMismatchError({
        turn: recorded.turn,
        detail: 'the conversation sent is not the conversation recorded',
      });
    }

    const answer = lines[at + 1];
    if (answer === undefined) {
      throw new TrajectoryMismatchError({
        turn: recorded.turn,
        detail: 'the recorded request has no answer, so the run it came from was cut short',
      });
    }

    cursor = at + 2;
    if (answer.kind === 'response') {
      return Promise.resolve({ status: answer.status, body: answer.body });
    }
    if (answer.kind === 'failure') return Promise.reject(replayedFailure(answer.failure));
    throw new TrajectoryMismatchError({
      turn: recorded.turn,
      detail: `the record after it is a ${answer.kind}, not an answer`,
    });
  };
};

/**
 * The key a replayed session is handed. It is not a credential and opens nothing: the
 * provider refuses to call at all without one, and the replay transport ignores the header it
 * ends up in. It is here so that replaying a run needs no key on the machine doing it.
 */
export const REPLAY_API_KEY = 'replayed-trajectory-no-key-needed';

/**
 * A provider that decides from a recorded trajectory: the real provider, with the recorded
 * mode, a placeholder key and the replay transport in place of the network.
 *
 * It is the real provider rather than a stand-in so that a replay exercises the request the
 * run made — the same prefix, the same cache key, the same parsing of the same bytes. A
 * session re-run on it produces the recorded decisions, or a typed mismatch.
 */
export const createTrajectoryReplayProvider = async (path: string): Promise<DecisionProvider> => {
  const lines = await readTrajectory(path);
  const first = lines?.[0];
  if (first === undefined) {
    throw new TrajectoryReadError({
      path,
      detail: 'holds no records, so there is nothing to replay',
    });
  }
  return createMetaModelApiProvider({
    mode: first.mode,
    apiKey: REPLAY_API_KEY,
    transport: replayTrajectory(lines ?? []),
  });
};

/** One turn of a session, as the trajectory records it and the invoice bills it. */
export interface TrajectoryTurn {
  /** Counted from 1, in the order the session made its calls — failed calls included. */
  readonly turn: number;
  readonly mode: ModelMode;
  readonly modelId: ModelId;
  /** The HTTP status, or `null` for a turn that never got one. */
  readonly status: number | null;
  /** The five figures, priced at the rates of the model this record names. */
  readonly usage: DecisionUsage;
  /** What went wrong, for a turn that produced no decision. */
  readonly failure: { readonly kind: string; readonly message: string } | null;
}

/** What one session's trajectory file says it did and what it cost. */
export interface TrajectoryAudit {
  readonly sessionId: string;
  readonly path: string;
  /**
   * `false` when the session wrote no trajectory at all — an offline session, which made no
   * model call. Nothing recorded is nothing, not a failure to read.
   */
  readonly recorded: boolean;
  readonly turns: readonly TrajectoryTurn[];
  /** The turns added up the way the run artifact adds its own usage up. */
  readonly totals: RunUsage;
}

const ZERO: DecisionUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: 0,
};

const isModelId = (modelId: string): modelId is ModelId => modelId in MODEL_SPEC_BY_ID;

/**
 * What one turn spent, read off its response and priced at its own model's rates.
 *
 * Only a 2xx answer is costed: a call that was refused a connection or answered 401 was not
 * billed, and inventing tokens for it would make a broken run look like an expensive one.
 */
const usageOf = (
  path: string,
  line: TrajectoryLine & { readonly kind: 'response' },
): DecisionUsage => {
  if (line.status < 200 || line.status >= 300) return ZERO;
  if (!isModelId(line.modelId)) {
    throw new TrajectoryReadError({
      path,
      detail: `turn ${line.turn} names model "${line.modelId}", which has no price here — a turn is never costed at another model's rates`,
    });
  }
  const tokens = readTokens(isObject(line.body) ? line.body.usage : undefined);
  return { ...tokens, estimatedCostUsd: estimateCostUsd(line.modelId, tokens) };
};

/**
 * Walks one session's trajectory and reports its turns with their tokens and their cost.
 *
 * The totals are `totalUsage`'s, over usage priced by `estimateCostUsd` — the same two
 * functions the run artifact's figures come out of — so a session's audit and the run's
 * record of that session are the same arithmetic over the same numbers rather than two
 * estimates that happen to agree.
 */
export const auditTrajectory = async (options: {
  readonly runDir: string;
  readonly sessionId: string;
}): Promise<TrajectoryAudit> => {
  const path = trajectoryPath(options.runDir, options.sessionId);
  const lines = await readTrajectory(path);
  if (lines === null) {
    return {
      sessionId: options.sessionId,
      path,
      recorded: false,
      turns: [],
      totals: totalUsage([]),
    };
  }

  const byTurn = new Map<number, TrajectoryTurn>();
  for (const line of lines) {
    const existing = byTurn.get(line.turn);
    byTurn.set(line.turn, {
      turn: line.turn,
      mode: line.mode,
      modelId: line.modelId,
      status: line.kind === 'response' ? line.status : (existing?.status ?? null),
      // A turn is one request and one answer, so only the answer can have carried usage.
      usage: line.kind === 'response' ? usageOf(path, line) : (existing?.usage ?? ZERO),
      failure: line.kind === 'failure' ? line.failure : (existing?.failure ?? null),
    });
  }

  const turns = [...byTurn.values()].sort((left, right) => left.turn - right.turn);
  return {
    sessionId: options.sessionId,
    path,
    recorded: true,
    turns,
    totals: totalUsage(turns.map((turn) => turn.usage)),
  };
};

/**
 * Every trajectory a run directory holds, by session id. An offline run holds none, and that
 * is an empty list rather than an error.
 */
export const auditRunTrajectories = async (runDir: string): Promise<readonly TrajectoryAudit[]> => {
  let entries: string[];
  try {
    entries = await readdir(join(runDir, TRAJECTORIES_DIR));
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const sessionIds = entries
    .map(sessionIdFromTrajectoryFileName)
    .filter((sessionId): sessionId is string => sessionId !== null)
    .sort();
  return Promise.all(sessionIds.map((sessionId) => auditTrajectory({ runDir, sessionId })));
};
