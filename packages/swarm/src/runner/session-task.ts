/**
 * What the container runs: **one** session, and the two files it leaves behind.
 *
 * This is the far end of the runner seam. It is the same `runSession` the local pool calls —
 * the same persona, the same seed, the same capture and the same written session file — with
 * two differences, and they are the only two:
 *
 * 1. its inputs arrive in the **environment**, because that is what a job execution can be
 *    handed, and `sessionTaskEnvironment` and `readSessionTaskEnvironment` are the one
 *    encoding of them, written beside each other so the two ends cannot drift;
 * 2. it writes its **run contributions** — what the session cost, the areas it looked at and
 *    the screens it captured — beside the session, because the coordinator collects those
 *    from the far end rather than observing them as they happen.
 *
 * The contributions sit in a dot-directory of their own and not in `sessions/`, where every
 * `.json` is read as a session and a sidecar would make the directory unreadable.
 *
 * **It reads no credential.** The decision provider comes from
 * `@personavision/provider`'s own selection, which is the one sanctioned place a model key is
 * read; the object store reads Google's own variable itself (#316). Nothing here names a
 * variable that is key-, token-, secret- or credential-shaped.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toScreenshotEntries } from '@personavision/browser';
import { ZERO_USAGE } from '@personavision/contract';
import { totalUsage } from '@personavision/provider';
import { runSession } from '../run-session.js';
import type { CaptureSource, TaskDefinition, Variant } from '@personavision/browser';
import type { Persona, Run, RunUsage } from '@personavision/contract';
import type { Aoi } from '@personavision/engine';
import type { DecisionUsage, ProviderMode } from '@personavision/provider';
import type { OutcomePolicy } from '../outcome.js';
import type { SessionProviders } from '../run-session.js';
import type { SessionRunRequest } from './types.js';

/** Where a task's run contributions go, relative to the run directory it wrote into. */
const CONTRIBUTIONS_DIR = '.runner';

/** `.runner/S-01.json` for session `S-01`, in whichever run directory it was written into. */
export const contributionsPath = (runDir: string, sessionId: string): string =>
  `${runDir.replace(/\/+$/, '')}/${CONTRIBUTIONS_DIR}/${sessionId}.json`;

/**
 * What one session owes the run beyond its own file: what it cost, the areas its fixations
 * name and the screens it captured. The coordinator declares all three on `run.json`.
 */
export interface SessionContributions {
  readonly usage: RunUsage;
  readonly aois: readonly Aoi[];
  readonly screenshots: Run['screenshots'];
  readonly elapsedMs: number;
}

/** The environment variables one session's task is handed, and nothing else. */
export const TASK_ENV = {
  runId: 'PV_RUN_ID',
  sessionId: 'PV_SESSION_ID',
  seed: 'PV_SEED',
  variant: 'PV_VARIANT',
  persona: 'PV_PERSONA',
  task: 'PV_TASK',
  startedAt: 'PV_STARTED_AT',
  timeoutMs: 'PV_SESSION_TIMEOUT_MS',
  maxScreens: 'PV_MAX_SCREENS',
  outcomePolicy: 'PV_OUTCOME_POLICY',
  engineMode: 'PV_ENGINE_MODE',
  /**
   * The bucket a task uploads its session, its contributions and its video to (#316). It is
   * passed on rather than read here: the object store reads it, and a remote run with none
   * is refused before any execution is created.
   */
  videoBucket: 'PV_VIDEO_BUCKET',
  /**
   * `local`, always. A task that read `cloud-run` would launch a job execution of its own
   * for the session it was itself started to run, and a hundred sessions would be a hundred
   * thousand. The one variable that chooses a runner is therefore set explicitly here rather
   * than inherited from the coordinator's own environment.
   */
  runner: 'PV_RUNNER',
} as const;

/** The argument vector the container is given: what to do, where the environment says with what. */
export const taskArgs = (runId: string, sessionId: string): readonly string[] => [
  'run-session',
  '--run',
  runId,
  '--session',
  sessionId,
];

/** One session's environment, as the coordinator sends it. */
export const sessionTaskEnvironment = (
  request: SessionRunRequest,
  { videoBucket, engineMode }: { videoBucket: string; engineMode: ProviderMode },
): Record<string, string> => ({
  [TASK_ENV.runId]: request.runId,
  [TASK_ENV.sessionId]: request.sessionId,
  [TASK_ENV.seed]: String(request.seed),
  [TASK_ENV.variant]: JSON.stringify(request.variant),
  [TASK_ENV.persona]: JSON.stringify(request.persona),
  [TASK_ENV.task]: JSON.stringify(request.task),
  [TASK_ENV.startedAt]: request.startedAt,
  [TASK_ENV.timeoutMs]: String(request.timeoutMs),
  [TASK_ENV.engineMode]: engineMode,
  [TASK_ENV.videoBucket]: videoBucket,
  [TASK_ENV.runner]: 'local',
  ...(request.maxScreens === undefined
    ? {}
    : { [TASK_ENV.maxScreens]: String(request.maxScreens) }),
  ...(request.outcomePolicy === undefined
    ? {}
    : { [TASK_ENV.outcomePolicy]: JSON.stringify(request.outcomePolicy) }),
});

const required = (env: Readonly<Record<string, string | undefined>>, key: string): string => {
  const value = env[key]?.trim() ?? '';
  if (value === '') throw new Error(`${key} names what this task is to run, and it is not set`);
  return value;
};

const asJson = <T>(env: Readonly<Record<string, string | undefined>>, key: string): T => {
  try {
    return JSON.parse(required(env, key)) as T;
  } catch (error) {
    throw new Error(`${key} is not readable JSON: ${error instanceof Error ? error.message : ''}`);
  }
};

const asNumber = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): number | undefined => {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} is "${raw}", which is not a number`);
  return value;
};

/**
 * The session this task was started to run, read off its environment.
 *
 * The run directory, the capture source and the decision provider are **not** in the
 * environment and are passed in: the first is the container's own scratch directory, and the
 * other two are what a task builds for itself — a live browser and whichever provider the
 * engine mode selects.
 */
export const readSessionTaskEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  {
    runDir,
    source,
    providers,
  }: { runDir: string; source: CaptureSource; providers: SessionProviders },
): SessionRunRequest => {
  const timeoutMs = asNumber(env, TASK_ENV.timeoutMs);
  if (timeoutMs === undefined) {
    throw new Error(`${TASK_ENV.timeoutMs} caps this session, and it is not set`);
  }
  const maxScreens = asNumber(env, TASK_ENV.maxScreens);
  const policy = env[TASK_ENV.outcomePolicy]?.trim() ?? '';
  return {
    runDir,
    runId: required(env, TASK_ENV.runId),
    sessionId: required(env, TASK_ENV.sessionId),
    persona: asJson<Persona>(env, TASK_ENV.persona),
    variant: asJson<Variant>(env, TASK_ENV.variant),
    seed: Number(required(env, TASK_ENV.seed)),
    task: asJson<TaskDefinition>(env, TASK_ENV.task),
    startedAt: required(env, TASK_ENV.startedAt),
    timeoutMs,
    source,
    providers,
    ...(maxScreens === undefined ? {} : { maxScreens }),
    ...(policy === '' ? {} : { outcomePolicy: JSON.parse(policy) as OutcomePolicy }),
  };
};

/**
 * One session, run and written: `sessions/<id>.json` by `runSession` itself, and
 * `.runner/<id>.json` beside it.
 *
 * It throws what the session threw. A task that exits non-zero is an execution the
 * coordinator reads as a failed one and records as that session's typed automation failure,
 * which is a better division of labour than a container deciding how a run reports itself.
 */
export const runSessionTask = async (request: SessionRunRequest): Promise<void> => {
  const aois: Aoi[] = [];
  const captures: Parameters<typeof toScreenshotEntries>[0][number][] = [];
  const usages: DecisionUsage[] = [];
  const startedMs = Date.now();

  await runSession({
    runDir: request.runDir,
    runId: request.runId,
    sessionId: request.sessionId,
    variant: request.variant,
    persona: request.persona,
    seed: request.seed,
    task: request.task,
    source: request.source,
    providers: request.providers,
    startedAt: request.startedAt,
    ...(request.segmenter === undefined ? {} : { segmenter: request.segmenter }),
    ...(request.weights === undefined ? {} : { weights: request.weights }),
    ...(request.maxScreens === undefined ? {} : { maxScreens: request.maxScreens }),
    ...(request.outcomePolicy === undefined ? {} : { outcomePolicy: request.outcomePolicy }),
    onScreen: (screen) => {
      aois.push(...screen.aois);
      captures.push(screen.capture);
      if (screen.decision !== null) usages.push(screen.decision.usage);
    },
  });

  const contributions: SessionContributions = {
    usage: request.providers.decision.mode === 'model' ? totalUsage(usages) : { ...ZERO_USAGE },
    aois,
    screenshots: toScreenshotEntries(captures),
    elapsedMs: Math.max(0, Date.now() - startedMs),
  };
  const path = contributionsPath(request.runDir, request.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(contributions, null, 2)}\n`, 'utf8');
};

/**
 * The contributions a finished task left, read back at the trust boundary.
 *
 * Every field is rebuilt by hand rather than trusted as parsed: the file crossed a process
 * boundary, and a malformed area of interest reaching `appendFinishedSession` would fail the
 * run's own write, which is the one failure that stops a swarm. Rebuilding also makes drift
 * a **compile** error — a field added to `Run['aois'][number]` stops this file building
 * until it is read here too.
 */
export const readContributions = async (
  runDir: string,
  sessionId: string,
): Promise<SessionContributions> => {
  const path = contributionsPath(runDir, sessionId);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not an object, so this session's contributions cannot be read`);
  }
  const held = parsed as Partial<SessionContributions>;
  return {
    usage: readUsage(held.usage, path),
    aois: (held.aois ?? []).map((aoi) => readAoi(aoi, path)),
    screenshots: (held.screenshots ?? []).map((screen) => readScreenshot(screen, path)),
    elapsedMs: readNumber(held.elapsedMs, 'elapsedMs', path),
  };
};

const readNumber = (value: unknown, field: string, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}: ${field} is not a number`);
  }
  return value;
};

const readString = (value: unknown, field: string, path: string): string => {
  if (typeof value !== 'string') throw new Error(`${path}: ${field} is not a string`);
  return value;
};

const readUsage = (value: SessionContributions['usage'] | undefined, path: string): RunUsage => {
  if (value === undefined) return { ...ZERO_USAGE };
  return {
    calls: readNumber(value.calls, 'usage.calls', path),
    inputTokens: readNumber(value.inputTokens, 'usage.inputTokens', path),
    cachedInputTokens: readNumber(value.cachedInputTokens, 'usage.cachedInputTokens', path),
    outputTokens: readNumber(value.outputTokens, 'usage.outputTokens', path),
    reasoningTokens: readNumber(value.reasoningTokens, 'usage.reasoningTokens', path),
    estimatedCostUsd: readNumber(value.estimatedCostUsd, 'usage.estimatedCostUsd', path),
  };
};

const readAoi = (value: Aoi, path: string): Aoi => ({
  id: readString(value.id, 'aois[].id', path),
  variant: readString(value.variant, 'aois[].variant', path),
  step: readString(value.step, 'aois[].step', path),
  label: readString(value.label, 'aois[].label', path),
  source: value.source,
  role: value.role === null ? null : readString(value.role, 'aois[].role', path),
  bbox: {
    x: readNumber(value.bbox?.x, 'aois[].bbox.x', path),
    y: readNumber(value.bbox?.y, 'aois[].bbox.y', path),
    width: readNumber(value.bbox?.width, 'aois[].bbox.width', path),
    height: readNumber(value.bbox?.height, 'aois[].bbox.height', path),
  },
  isPrimaryAction: value.isPrimaryAction === true,
  belowFold: value.belowFold === true,
});

const readScreenshot = (
  value: Run['screenshots'][number],
  path: string,
): Run['screenshots'][number] => ({
  variant: readString(value.variant, 'screenshots[].variant', path),
  step: readString(value.step, 'screenshots[].step', path),
  path: readString(value.path, 'screenshots[].path', path),
  viewport: {
    width: readNumber(value.viewport?.width, 'screenshots[].viewport.width', path),
    height: readNumber(value.viewport?.height, 'screenshots[].viewport.height', path),
  },
  pageHeight: readNumber(value.pageHeight, 'screenshots[].pageHeight', path),
  foldY: readNumber(value.foldY, 'screenshots[].foldY', path),
});
