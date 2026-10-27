import { useEffect, useState } from 'react';
import { useMatch } from 'react-router';
import { findingsSchema, runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Findings, Run, Session } from '@personavision/contract';
// Type-only, and therefore erased: the listing's shape is `readRunIndex`'s own, so the
// viewer does not restate the three field names it answers with. `@personavision/cli`
// reads files and never reaches the browser bundle.
import type { RunSummary } from '@personavision/cli';
import { matches, patterns } from './paths';

/**
 * Reading a run. The **only** place in the viewer that does.
 *
 * It reads the run artifact through `packages/contract` — `runSchema` parses what the
 * server answers, so every field name the product uses is the contract's and a run written
 * for another schema version is named as such rather than half-rendered. No screen fetches
 * or parses a run file itself.
 *
 * The URLs are the read-only run-data interface of
 * `docs/adr/0001-run-data-over-http-as-static-files.md`, which `packages/cli` implements
 * and both `personavision open` and this app's dev server mount:
 *
 * - `GET /runs/index.json` → the workspace's tests, newest first
 * - `GET /runs/<runId>/run.json` → one run, byte for byte as the pipeline wrote it
 * - `GET /runs/<runId>/findings.json` → that run's ranked findings
 *
 * The session files of a run are read by `src/session/` (#20), through this same interface
 * and the same contract. What is read here instead is the one figure no run-level field
 * carries — who the run excluded from its scores — because this module is the one that asks
 * the server, and the Verdict screen's banner states that figure above its headline.
 */

const RUNS = '/runs';
const indexUrl = `${RUNS}/index.json`;
/** The file names inside a run are the contract's layout, never restated here. */
const layout = runPaths('');

/**
 * One run's directory as the mount serves it, ending in a slash: what a path stored inside
 * the artifact resolves against. A screen that reads a file this module does not — a
 * session, a screenshot — hands this to `src/session/` rather than spelling `/runs` itself.
 */
export const runDataBase = (runId: string): string => `${RUNS}/${encodeURIComponent(runId)}/`;

const runFile = (runId: string, file: string): string => `${runDataBase(runId)}${file}`;
const runUrl = (runId: string): string => runFile(runId, layout.run);
const findingsUrl = (runId: string): string => runFile(runId, layout.findings);
const sessionUrl = (runId: string, sessionId: string): string =>
  runFile(runId, layout.session(sessionId));

/** Run data is served from the site root; `fetch` wants an absolute URL in a test. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

export type RunState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly run: Run }
  /** No such test in this workspace. `url` is what was looked for. */
  | { readonly status: 'not-found'; readonly runId: string; readonly url: string }
  /** The test is there but could not be read: `problem` says what is wrong with it. */
  | {
      readonly status: 'unreadable';
      readonly runId: string;
      readonly url: string;
      readonly problem: string;
    };

export type LatestRunState =
  | { readonly status: 'loading' }
  /** The workspace has no test yet. */
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly runId: string }
  | { readonly status: 'unreadable'; readonly url: string; readonly problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readJson = async (
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; problem: string }> => {
  let response: Response;
  try {
    response = await fetch(absolute(url));
  } catch (error) {
    return { ok: false, status: 0, problem: `it could not be fetched: ${reason(error)}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      problem: `the server answered ${response.status}`,
    };
  }
  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      problem: `it is not valid JSON: ${reason(error)}`,
    };
  }
};

/** The first thing wrong with a run file, at the place it is wrong. */
const firstViolation = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }) => {
  const issue = error.issues[0];
  if (issue === undefined) return 'it does not match the run schema';
  const at = issue.path.length === 0 ? 'the file itself' : issue.path.map(String).join('.');
  return `${at}: ${issue.message}`;
};

const readRun = async (runId: string): Promise<RunState> => {
  const url = runUrl(runId);
  const answer = await readJson(url);
  if (!answer.ok) {
    return answer.status === 404
      ? { status: 'not-found', runId, url }
      : { status: 'unreadable', runId, url, problem: answer.problem };
  }
  const parsed = runSchema.safeParse(answer.body);
  return parsed.success
    ? { status: 'ready', run: parsed.data }
    : { status: 'unreadable', runId, url, problem: firstViolation(parsed.error) };
};

const readFindings = async (runId: string): Promise<FindingsState> => {
  const url = findingsUrl(runId);
  const answer = await readJson(url);
  if (!answer.ok) return { status: 'unreadable', runId, url, problem: answer.problem };
  const parsed = findingsSchema.safeParse(answer.body);
  return parsed.success
    ? { status: 'ready', findings: parsed.data }
    : { status: 'unreadable', runId, url, problem: firstViolation(parsed.error) };
};

/**
 * One person a run excluded from its figures.
 *
 * `excludedFromScores` and `attribution` are stored on each session and were decided once,
 * together, by the pipeline (`packages/swarm/src/outcome.ts`). Nothing here re-derives
 * exclusion from an outcome status, and the three outcome statuses stay three.
 */
const isExcluded = (session: Session): boolean =>
  session.outcome.excludedFromScores && session.outcome.attribution === 'automation';

type SessionRead =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly url: string; readonly problem: string };

const readSession = async (runId: string, sessionId: string): Promise<SessionRead> => {
  const url = sessionUrl(runId, sessionId);
  const answer = await readJson(url);
  if (!answer.ok) return { ok: false, url, problem: answer.problem };
  const parsed = sessionSchema.safeParse(answer.body);
  return parsed.success
    ? { ok: true, session: parsed.data }
    : { ok: false, url, problem: firstViolation(parsed.error) };
};

/**
 * Who this run excluded, from the sessions themselves.
 *
 * The two fields that decide exclusion sit on each session, so every session the manifest
 * names is read. The run's scores do carry a per-status count — `outcomeCounts`, which an
 * automation failure lands in — but counting from that is deciding exclusion from an
 * outcome status a second time, which this screen does not do. One session that cannot be
 * read makes the whole count unreadable rather than short.
 */
const readExcluded = async (
  runId: string,
  sessionIds: readonly string[],
): Promise<ExcludedState> => {
  const read = await Promise.all(sessionIds.map((sessionId) => readSession(runId, sessionId)));
  for (const entry of read) {
    if (!entry.ok) {
      return { status: 'unreadable', runId, url: entry.url, problem: entry.problem };
    }
  }
  return {
    status: 'ready',
    people: read.flatMap((entry) =>
      entry.ok && isExcluded(entry.session)
        ? [{ sessionId: entry.session.sessionId, step: entry.session.outcome.step }]
        : [],
    ),
  };
};

const readLatestRunId = async (): Promise<LatestRunState> => {
  const answer = await readJson(indexUrl);
  if (!answer.ok) return { status: 'unreadable', url: indexUrl, problem: answer.problem };
  // The listing is newest first, as `readRunIndex` sorts it, so the most recent test is
  // the first entry and the viewer does not re-sort it by a timestamp of its own.
  const listed: unknown = answer.body;
  if (!Array.isArray(listed)) {
    return { status: 'unreadable', url: indexUrl, problem: 'it is not a list of tests' };
  }
  const latest = (listed as Partial<RunSummary>[])[0];
  if (latest === undefined) return { status: 'none' };
  // The id addresses every other read, so a listing that carries none is unreadable rather
  // than a workspace with no test: nothing is fetched from a path built out of `undefined`.
  return typeof latest.runId === 'string' && latest.runId !== ''
    ? { status: 'ready', runId: latest.runId }
    : { status: 'unreadable', url: indexUrl, problem: 'a test in the listing has no id' };
};

/**
 * One read per run while the app is open.
 *
 * The chrome names the test being read and the screen inside it renders the same run, so
 * both ask for it and one request answers them. Only a successful read is kept: a run that
 * could not be fetched is read again rather than remembered as broken. A run directory
 * changes without a rebuild — the server says `cache-control: no-store` — so a ticket that
 * watches an open test drops its entry with `refreshRun` rather than polling through this.
 */
const cache = new Map<string, Promise<RunState>>();
const findingsCache = new Map<string, Promise<FindingsState>>();
const excludedCache = new Map<string, Promise<ExcludedState>>();
let latestRun: Promise<LatestRunState> | null = null;

const keep = <State extends { status: string }>(
  key: string,
  store: Map<string, Promise<State>>,
  read: Promise<State>,
): Promise<State> => {
  const pending = read.then((state) => {
    if (state.status !== 'ready' && state.status !== 'none') store.delete(key);
    return state;
  });
  store.set(key, pending);
  return pending;
};

const loadRun = (runId: string): Promise<RunState> =>
  cache.get(runId) ?? keep(runId, cache, readRun(runId));

const loadFindings = (runId: string): Promise<FindingsState> =>
  findingsCache.get(runId) ?? keep(runId, findingsCache, readFindings(runId));

const loadExcluded = (runId: string, sessionIds: readonly string[]): Promise<ExcludedState> =>
  excludedCache.get(runId) ?? keep(runId, excludedCache, readExcluded(runId, sessionIds));

const loadLatestRunId = (): Promise<LatestRunState> => {
  latestRun ??= readLatestRunId().then((state) => {
    if (state.status === 'unreadable') latestRun = null;
    return state;
  });
  return latestRun;
};

/** Read this run again on the next render that asks for it. */
export const refreshRun = (runId: string): void => {
  cache.delete(runId);
  findingsCache.delete(runId);
  excludedCache.delete(runId);
  latestRun = null;
};

/** Forget every run that has been read. For tests, and for signing out. */
export const clearRunCache = (): void => {
  cache.clear();
  findingsCache.clear();
  excludedCache.clear();
  latestRun = null;
};

export type FindingsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly findings: Findings }
  | {
      readonly status: 'unreadable';
      readonly runId: string;
      readonly url: string;
      readonly problem: string;
    };

/** One person a run excluded from its figures, and where their session stopped. */
export interface ExcludedPerson {
  readonly sessionId: string;
  /** The step it ended on, as stored. `run.steps` holds the label a reader sees. */
  readonly step: string;
}

export type ExcludedState =
  | { readonly status: 'loading' }
  /** Empty for a run that excluded nobody, which is a result and not a gap. */
  | { readonly status: 'ready'; readonly people: readonly ExcludedPerson[] }
  | {
      readonly status: 'unreadable';
      readonly runId: string;
      readonly url: string;
      readonly problem: string;
    };

/**
 * Who one run excluded from its figures: read once per run while the app is open.
 *
 * The Verdict screen's banner names how many of how many, so the figure is read from the
 * stored fields on the run's sessions and never worked out from their outcome statuses.
 */
export function useExcluded(run: Run): ExcludedState {
  const [state, setState] = useState<ExcludedState>({ status: 'loading' });
  // The two the read is made of, so that another `Run` object for the same test does not
  // re-fire the effect: every other hook here takes an id for the same reason.
  const { runId, sessionIds } = run;

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void loadExcluded(runId, sessionIds).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [runId, sessionIds]);

  return state;
}

/** One run, by its id. The id is a test's directory name and so its id in the contract. */
export function useRun(runId: string): RunState {
  const state = useOptionalRun(runId);
  return state ?? { status: 'loading' };
}

/**
 * One run's findings — the ranked list the pipeline wrote beside `run.json`.
 *
 * The Verdict screen shows at most three of them and the Score breakdown screen the whole
 * list, both by the ids the verdict carries. A run directory with no readable
 * `findings.json` is reported, not treated as a run with no findings.
 */
export function useFindings(runId: string): FindingsState {
  const [state, setState] = useState<FindingsState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void loadFindings(runId).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [runId]);

  return state;
}

/** The most recent test in the workspace, which is what `/` opens. */
export function useLatestRun(): LatestRunState {
  const [state, setState] = useState<LatestRunState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void loadLatestRunId().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/** The run the current route is about, or `null` on a route that is about no test. */
export function useCurrentRunId(): string | null {
  // Two patterns rather than one wildcard, so that `/runs/<id>` and everything under it
  // are both the same test, and nothing else is.
  const run = useMatch(patterns.run);
  const under = useMatch(matches.runScreens);
  return run?.params.runId ?? under?.params.runId ?? null;
}

/**
 * The run the chrome names: the one the route is about, or the workspace's most recent test
 * on a route that is about no test. `null` when the workspace has no test at all.
 */
export function useCurrentRun(): RunState | null {
  const routeRunId = useCurrentRunId();
  const latest = useLatestRun();
  const fallback = latest.status === 'ready' ? latest.runId : null;
  const runId = routeRunId ?? fallback;
  const state = useOptionalRun(runId);
  if (state !== null) return state;
  // No id to read: there is a test to name only while the listing is still coming back.
  const listed = latest.status === 'none' || latest.status === 'unreadable';
  return routeRunId === null && listed ? null : { status: 'loading' };
}

/**
 * One run, or no run: `null` while there is no id to read, which is what a caller that may
 * not have one yet asks with. `useRun` is this with a loading state in place of the `null`.
 */
export function useOptionalRun(runId: string | null): RunState | null {
  const [state, setState] = useState<RunState | null>(null);

  useEffect(() => {
    if (runId === null) {
      setState(null);
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    void loadRun(runId).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [runId]);

  return state;
}
