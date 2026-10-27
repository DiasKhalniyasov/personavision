/**
 * The trajectory file, the replay and the audit (#139).
 *
 * Everything here writes a real file into a temporary run directory and reads it back, with
 * `MODEL_API_KEY` in the environment, because the file is the thing a run directory ships:
 * an assertion about the sink's arguments would not catch a key reaching disk, and the
 * hygiene check here therefore searches the whole directory rather than the lines it expects.
 *
 * Nothing reaches the network. The transport is injected on the recording side and the
 * recording itself is the transport on the replaying side — which is the point of the
 * feature: a run re-runs from its own files with no key and no socket.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { totalUsage } from '../src/decision.js';
import { createMetaModelApiProvider, META_RESPONSES_ENDPOINT } from '../src/meta-model.js';
import { estimateCostUsd, MODEL_ID_BY_MODE } from '../src/meta-pricing.js';
import { MODEL_API_KEY_ENV } from '../src/select.js';
import {
  auditRunTrajectories,
  auditTrajectory,
  createTrajectoryReplayProvider,
  openTrajectoryFile,
  readTrajectory,
  replayTrajectory,
  TrajectoryMismatchError,
  trajectoryPath,
} from '../src/trajectory.js';
import { contextOf, SESSION_STEPS, walkSession } from './fixtures.js';
import { fakeTransport, FAKE_TOKENS, TEST_KEY } from './meta-fake.js';
import type { ModelTransport } from '../src/meta-model.js';
import type { ModelMode } from '../src/meta-pricing.js';
import type { TrajectoryLine } from '../src/trajectory.js';
import type { Decision } from '../src/types.js';

const anna = { personaId: 'p-anna', seed: 7 } as const;

/** The committed example run: a valid run directory, so a copy of it is one too. */
const EXAMPLE_RUN = fileURLToPath(
  new URL('../../../runs/2026-10-24-1402-northwind-demo', import.meta.url),
);

const temporaryRunDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'personavision-trajectory-'));

/** One session, recorded to a real file: the file it wrote and what it decided. */
const record = async (
  runDir: string,
  options: {
    readonly mode?: ModelMode;
    readonly sessionId?: string;
    readonly transport?: ModelTransport;
  } = {},
): Promise<{ readonly path: string; readonly decisions: readonly Decision[] }> => {
  const file = openTrajectoryFile({ runDir, sessionId: options.sessionId ?? 'S-01' });
  const provider = createMetaModelApiProvider({
    mode: options.mode ?? 'contributor',
    transport: options.transport ?? fakeTransport().transport,
  });
  const session = provider.beginSession(anna, { trajectory: file.sink });
  const decisions = await walkSession(session);
  await session.close();
  await file.close();
  return { path: file.path, decisions };
};

/** The file's lines, which a test reads back rather than being told. */
const lines = async (path: string): Promise<readonly TrajectoryLine[]> => {
  const read = await readTrajectory(path);
  expect(read).not.toBeNull();
  return read ?? [];
};

/** Every file in a directory tree, as text. */
const everyFile = async (dir: string): Promise<ReadonlyArray<{ path: string; text: string }>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return everyFile(path);
      return [{ path, text: await readFile(path, 'utf8') }];
    }),
  );
  return files.flat();
};

describe('the trajectory one session writes', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await temporaryRunDir();
    vi.stubEnv(MODEL_API_KEY_ENV, TEST_KEY);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(runDir, { recursive: true, force: true });
  });

  describe('the file', () => {
    it('writes one JSON object per line to trajectories/S-NN.jsonl, requests and responses interleaved', async () => {
      const session = await record(runDir);

      expect(session.path).toBe(trajectoryPath(runDir, 'S-01'));
      const text = await readFile(session.path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const written = await lines(session.path);
      expect(written.map((line) => line.kind)).toEqual([
        'request',
        'response',
        'request',
        'response',
        'request',
        'response',
      ]);
      expect(written.map((line) => line.turn)).toEqual([1, 1, 2, 2, 3, 3]);
    });

    it('carries the turn, the direction, the model, the mode, the verbatim body and a monotonic timestamp', async () => {
      const session = await record(runDir, { mode: 'standard' });
      const written = await lines(session.path);

      const request = written[0];
      const response = written[1];
      expect(request).toMatchObject({
        kind: 'request',
        turn: 1,
        mode: 'standard',
        modelId: MODEL_ID_BY_MODE.standard,
        personaId: anna.personaId,
        seed: anna.seed,
        url: META_RESPONSES_ENDPOINT,
      });
      expect(request?.kind === 'request' && request.body.model).toBe(MODEL_ID_BY_MODE.standard);

      // Verbatim: the reasoning item the protocol returned and the usage block, unprojected.
      expect(response?.kind === 'response' && response.status).toBe(200);
      const body = response?.kind === 'response' ? (response.body as Record<string, unknown>) : {};
      expect(body.usage).toEqual(FAKE_TOKENS);
      expect(Array.isArray(body.output) && body.output[0]).toEqual({
        type: 'reasoning',
        summary: ['weighed the options'],
      });

      const stamps = written.map((line) => line.atMs);
      expect(stamps.every((stamp) => stamp > 1_600_000_000_000)).toBe(true);
      expect([...stamps].sort((left, right) => left - right)).toEqual(stamps);
    });

    it('is append-only: what a turn wrote is still the head of the file after the next one', async () => {
      const file = openTrajectoryFile({ runDir, sessionId: 'S-01' });
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        transport: fakeTransport().transport,
      });
      const session = provider.beginSession(anna, { trajectory: file.sink });

      await session.decide(contextOf({ step: SESSION_STEPS[0] }));
      const afterFirst = await readFile(file.path, 'utf8');
      await session.decide(contextOf({ step: SESSION_STEPS[1] }));
      const afterSecond = await readFile(file.path, 'utf8');
      await session.close();
      await file.close();

      expect(afterFirst.split('\n').filter((line) => line !== '')).toHaveLength(2);
      expect(afterSecond.startsWith(afterFirst)).toBe(true);
      expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    });

    it('leaves every line parseable when the session is killed between two turns', async () => {
      const file = openTrajectoryFile({ runDir, sessionId: 'S-01' });
      const provider = createMetaModelApiProvider({
        mode: 'contributor',
        transport: fakeTransport().transport,
      });
      const session = provider.beginSession(anna, { trajectory: file.sink });
      await session.decide(contextOf({ step: SESSION_STEPS[0] }));
      // No close and no flush: the process is gone after the turn it had written.

      const text = await readFile(file.path, 'utf8');
      const parsed = text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { kind: string });
      expect(parsed.map((line) => line.kind)).toEqual(['request', 'response']);
    });

    it('is not written at all by a session that made no model call', async () => {
      const file = openTrajectoryFile({ runDir, sessionId: 'S-01' });
      await file.close();

      expect(await readTrajectory(file.path)).toBeNull();
      expect(await readdir(runDir)).toEqual([]);
    });
  });

  describe('a call that failed', () => {
    const failing = async (transport: ModelTransport): Promise<readonly TrajectoryLine[]> => {
      const file = openTrajectoryFile({ runDir, sessionId: 'S-01' });
      const provider = createMetaModelApiProvider({ mode: 'contributor', transport });
      const session = provider.beginSession(anna, { trajectory: file.sink });
      await expect(session.decide(contextOf())).rejects.toThrow();
      await session.close();
      await file.close();
      return lines(file.path);
    };

    it('records a transport error as a record of its own', async () => {
      const written = await failing(() => Promise.reject(new Error('socket hung up')));

      expect(written.map((line) => line.kind)).toEqual(['request', 'failure']);
      expect(written[1]?.kind === 'failure' && written[1].failure.kind).toBe('transport');
      expect(written[1]?.kind === 'failure' && written[1].failure.message).toContain(
        'socket hung up',
      );
    });

    it('records a timeout as a timeout', async () => {
      const written = await failing(() => {
        const error = new Error('the request was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      expect(written[1]?.kind === 'failure' && written[1].failure.kind).toBe('timeout');
    });

    it('records a refusal behind the response it came in', async () => {
      const written = await failing(() =>
        Promise.resolve({
          status: 200,
          body: {
            status: 'completed',
            output: [{ type: 'refusal', refusal: 'I will not pretend to be a person.' }],
            usage: FAKE_TOKENS,
          },
        }),
      );

      expect(written.map((line) => line.kind)).toEqual(['request', 'response', 'failure']);
      expect(written[2]?.kind === 'failure' && written[2].failure.kind).toBe('refusal');
    });

    it('records an unparseable reply behind the body that would not parse', async () => {
      const written = await failing(() =>
        Promise.resolve({
          status: 200,
          body: {
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'I clicked the button.' }],
              },
            ],
            usage: FAKE_TOKENS,
          },
        }),
      );

      expect(written.map((line) => line.kind)).toEqual(['request', 'response', 'failure']);
      expect(written[2]?.kind === 'failure' && written[2].failure.kind).toBe('unparseable');
    });

    it('records a non-2xx answer with its status and its error body', async () => {
      const written = await failing(() =>
        Promise.resolve({ status: 503, body: { error: { message: 'upstream is down' } } }),
      );

      expect(written.map((line) => line.kind)).toEqual(['request', 'response', 'failure']);
      expect(written[1]?.kind === 'response' && written[1].status).toBe(503);
      expect(written[1]?.kind === 'response' && written[1].body).toEqual({
        error: { message: 'upstream is down' },
      });
      expect(written[2]?.kind === 'failure' && written[2].failure.kind).toBe('http_status');
    });
  });

  describe('what it must never contain', () => {
    /** A response that quotes the key back at us, the way a proxy or a 401 page does. */
    const echoing: ModelTransport = (request) =>
      Promise.resolve({
        status: 200,
        body: {
          status: 'completed',
          echoed: `the key you sent was ${String(request.headers.authorization).replace('Bearer ', '')}`,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    intent: 'That is the thing I came for.',
                    action: { kind: 'click', targetElementId: 'el-jacket' },
                  }),
                },
              ],
            },
          ],
          usage: FAKE_TOKENS,
        },
      });

    it('holds no key, no Authorization header and no request header at all, on either path', async () => {
      await record(runDir, { sessionId: 'S-01', transport: echoing });
      const file = openTrajectoryFile({ runDir, sessionId: 'S-02' });
      const refused = createMetaModelApiProvider({
        mode: 'contributor',
        transport: () => Promise.resolve({ status: 401, body: `invalid key: ${TEST_KEY}` }),
      });
      const session = refused.beginSession(anna, { trajectory: file.sink });
      await expect(session.decide(contextOf())).rejects.toThrow();
      await session.close();
      await file.close();

      const files = await everyFile(runDir);
      expect(files).toHaveLength(2);
      for (const { path, text } of files) {
        expect(text, `${path} quotes the key`).not.toContain(TEST_KEY);
        expect(text.toLowerCase(), `${path} names a header`).not.toContain('authorization');
        expect(text.toLowerCase(), `${path} carries a bearer token`).not.toContain('bearer');
      }
      // The shape as well as the bytes: no record carries a headers field to begin with.
      for (const line of await lines(trajectoryPath(runDir, 'S-01'))) {
        expect(line).not.toHaveProperty('headers');
      }
    });
  });

  describe('replaying it', () => {
    it('re-runs the session from the file alone, with no key and no network', async () => {
      const recorded = await record(runDir);
      vi.stubEnv(MODEL_API_KEY_ENV, '');
      vi.stubGlobal('fetch', () => {
        throw new Error('a replay reached the network');
      });

      const provider = await createTrajectoryReplayProvider(recorded.path);
      const replayed = await walkSession(provider.beginSession(anna));

      expect(replayed).toEqual(recorded.decisions);
    });

    it('refuses a request that is not the recorded one, and keeps the answer it was not', async () => {
      const recorded = await record(runDir);
      const written = await lines(recorded.path);
      const first = written[0];
      const answer = written[1];
      if (first?.kind !== 'request' || answer?.kind !== 'response') throw new Error('not recorded');
      const transport = replayTrajectory(written);
      const send = (body: unknown): ReturnType<ModelTransport> =>
        transport({
          url: META_RESPONSES_ENDPOINT,
          method: 'POST',
          headers: {},
          body: body as (typeof first)['body'],
          signal: new AbortController().signal,
        });

      expect(() => send({ ...first.body, model: 'some-other-model' })).toThrow(
        TrajectoryMismatchError,
      );
      // The response it did not match is still the next one served, not spent on the mismatch.
      await expect(send(first.body)).resolves.toEqual({
        status: answer.status,
        body: answer.body,
      });
    });

    it('fails a session that replays a screen the run never sent, rather than answering it', async () => {
      const recorded = await record(runDir);
      const provider = await createTrajectoryReplayProvider(recorded.path);
      const session = provider.beginSession(anna);

      await expect(session.decide(contextOf({ step: SESSION_STEPS[2] }))).rejects.toThrow(
        /TrajectoryMismatchError/,
      );
      // And the first recorded turn is still there to be asked for.
      await expect(session.decide(contextOf({ step: SESSION_STEPS[0] }))).resolves.toEqual(
        recorded.decisions[0],
      );
    });
  });

  describe('auditing it', () => {
    it('totals the session’s tokens and cost to the figures its decisions reported', async () => {
      const recorded = await record(runDir);

      const audit = await auditTrajectory({ runDir, sessionId: 'S-01' });

      expect(audit.recorded).toBe(true);
      expect(audit.turns.map((turn) => turn.turn)).toEqual([1, 2, 3]);
      expect(audit.turns.every((turn) => turn.status === 200)).toBe(true);
      expect(audit.totals).toEqual(
        totalUsage(recorded.decisions.map((decision) => decision.usage)),
      );
    });

    it('prices a turn at the mode the record names, so the same tokens cost more in one of them', async () => {
      const standardDir = await temporaryRunDir();
      try {
        await record(runDir, { mode: 'contributor' });
        await record(standardDir, { mode: 'standard' });

        const contributor = await auditTrajectory({ runDir, sessionId: 'S-01' });
        const standard = await auditTrajectory({ runDir: standardDir, sessionId: 'S-01' });

        expect(standard.totals.inputTokens).toBe(contributor.totals.inputTokens);
        expect(standard.totals.outputTokens).toBe(contributor.totals.outputTokens);
        expect(standard.totals.reasoningTokens).toBe(contributor.totals.reasoningTokens);
        const tokens = {
          inputTokens: FAKE_TOKENS.input_tokens,
          cachedInputTokens: FAKE_TOKENS.input_tokens_details.cached_tokens,
          outputTokens: FAKE_TOKENS.output_tokens,
        };
        expect(contributor.turns[0]?.usage.estimatedCostUsd).toBe(
          estimateCostUsd(MODEL_ID_BY_MODE.contributor, tokens),
        );
        expect(standard.turns[0]?.usage.estimatedCostUsd).toBe(
          estimateCostUsd(MODEL_ID_BY_MODE.standard, tokens),
        );
        expect(standard.totals.estimatedCostUsd).toBeGreaterThan(
          contributor.totals.estimatedCostUsd * 10,
        );
      } finally {
        await rm(standardDir, { recursive: true, force: true });
      }
    });

    it('reports a session that recorded nothing as nothing rather than as an error', async () => {
      const audit = await auditTrajectory({ runDir, sessionId: 'S-09' });

      expect(audit).toMatchObject({ sessionId: 'S-09', recorded: false, turns: [] });
      expect(audit.totals).toEqual(totalUsage([]));
      expect(await auditRunTrajectories(runDir)).toEqual([]);
    });

    it('lists every trajectory a run directory holds, by session', async () => {
      await record(runDir, { sessionId: 'S-01' });
      await record(runDir, { sessionId: 'S-02' });

      const audits = await auditRunTrajectories(runDir);

      expect(audits.map((audit) => audit.sessionId)).toEqual(['S-01', 'S-02']);
      expect(audits.every((audit) => audit.recorded)).toBe(true);
    });
  });

  describe('the run directory it sits in', () => {
    it('still validates with a trajectories/ directory in it', async () => {
      const copy = join(runDir, 'example');
      await cp(EXAMPLE_RUN, copy, { recursive: true });
      expect(await validate(copy)).toEqual([]);

      await mkdir(join(copy, 'trajectories'), { recursive: true });
      await writeFile(
        trajectoryPath(copy, 'S-01'),
        `${JSON.stringify({
          kind: 'request',
          turn: 1,
          mode: 'contributor',
          modelId: MODEL_ID_BY_MODE.contributor,
          personaId: anna.personaId,
          seed: anna.seed,
          promptCacheKey: 'pv-1',
          url: META_RESPONSES_ENDPOINT,
          body: { model: MODEL_ID_BY_MODE.contributor, input: [] },
          atMs: 1_761_566_400_000,
        })}\n`,
        'utf8',
      );

      expect(await validate(copy)).toEqual([]);
    });
  });
});
