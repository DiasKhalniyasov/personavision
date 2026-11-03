import { useEffect, useState } from 'react';
import { useMatch } from 'react-router';
import {
  findingsSchema,
  recommendationsSchema,
  runPaths,
  runSchema,
  sessionSchema,
} from '@personavision/contract';
import type { Findings, Recommendations, Run, Session } from '@personavision/contract';
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
 * - `GET /runs/<runId>/recommendations.json` → what to change, when the run produced any
 * - `HEAD /runs/<runId>/videos/<id>.webm` → how big one session's recording is
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
const recommendationsUrl = (runId: string): string => runFile(runId, layout.recommendations);
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

/**
 * One test in the workspace's listing: the id that addresses it, what was tested in the
 * words it was asked for, and when it ran.
 *
 * It is `RunSummary` as this app can use it. The listing is read defensively: the id is
 * required of every entry, because it is what addresses the test and nothing is fetched
 * from a path built out of `undefined`, and the other two are `null` where the listing did
 * not state them rather than being invented.
 */
export interface ListedRun {
  readonly runId: string;
  /** `run.json`'s `task.prompt`, or `null` for an entry the listing gave no name. */
  readonly name: string | null;
  /** When it ran, as the listing states it, or `null` for an entry that gave no instant. */
  readonly createdAt: string | null;
}

export type RunIndexState =
  | { readonly status: 'loading' }
  /** The workspace's tests, newest first as `readRunIndex` sorts them. Empty is a workspace with none. */
  | { readonly status: 'ready'; readonly runs: readonly ListedRun[] }
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
 * What this run says to change, or the stated absence of it.
 *
 * `recommendations.json` is **optional** in a run directory: a run that produced none has
 * no file, which is not an empty list somebody wrote. A 404 is therefore `none` and not a
 * problem — every other failure is still named, because a file that is there and will not
 * parse is a broken run and not a run without recommendations.
 */
const readRecommendations = async (runId: string): Promise<RecommendationsState> => {
  const url = recommendationsUrl(runId);
  const answer = await readJson(url);
  if (!answer.ok) {
    return answer.status === 404
      ? { status: 'none' }
      : { status: 'unreadable', runId, url, problem: answer.problem };
  }
  const parsed = recommendationsSchema.safeParse(answer.body);
  return parsed.success
    ? { status: 'ready', recommendations: parsed.data }
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

const readRunIndexFile = async (): Promise<RunIndexState> => {
  const answer = await readJson(indexUrl);
  if (!answer.ok) return { status: 'unreadable', url: indexUrl, problem: answer.problem };
  // The listing is newest first, as `readRunIndex` sorts it, so the most recent test is
  // the first entry and the viewer does not re-sort it by a timestamp of its own.
  const listed: unknown = answer.body;
  if (!Array.isArray(listed)) {
    return { status: 'unreadable', url: indexUrl, problem: 'it is not a list of tests' };
  }
  const entries = listed as Partial<RunSummary>[];
  // The id addresses every other read — a run file, a screen's URL, the site card's join —
  // so an entry that carries none is **dropped**: there is nothing it could be used for,
  // and nothing is ever fetched from a path built out of `undefined`. One bad entry does
  // not cost the reader the tests either side of it, which matters because the chrome and
  // `/` read this same listing on every signed-in screen.
  const runs: ListedRun[] = entries.flatMap((entry) =>
    typeof entry.runId === 'string' && entry.runId !== ''
      ? [
          {
            runId: entry.runId,
            name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
            createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
          },
        ]
      : [],
  );
  // Unless **nothing** survived: a listing with entries in it must never read as a
  // workspace with no test, which is the one reading that would send somebody to "start
  // your first test" over the top of the tests they have.
  return runs.length === 0 && entries.length > 0
    ? { status: 'unreadable', url: indexUrl, problem: 'no test in the listing has an id' }
    : { status: 'ready', runs };
};

/**
 * The most recent test, off the one listing above rather than off a read of its own: the
 * chrome asks for it on every signed-in screen, so a second read of the same file would be
 * the same bytes fetched twice.
 */
const latestOf = (state: RunIndexState): LatestRunState => {
  if (state.status !== 'ready') return state;
  const latest = state.runs[0];
  return latest === undefined ? { status: 'none' } : { status: 'ready', runId: latest.runId };
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
const recommendationsCache = new Map<string, Promise<RecommendationsState>>();
let runIndex: Promise<RunIndexState> | null = null;

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

const loadRecommendations = (runId: string): Promise<RecommendationsState> =>
  recommendationsCache.get(runId) ?? keep(runId, recommendationsCache, readRecommendations(runId));

const loadRunIndex = (): Promise<RunIndexState> => {
  runIndex ??= readRunIndexFile().then((state) => {
    if (state.status === 'unreadable') runIndex = null;
    return state;
  });
  return runIndex;
};

/** Read this run again on the next render that asks for it. */
export const refreshRun = (runId: string): void => {
  cache.delete(runId);
  findingsCache.delete(runId);
  excludedCache.delete(runId);
  recommendationsCache.delete(runId);
  runIndex = null;
};

/** Forget every run that has been read. For tests, and for signing out. */
export const clearRunCache = (): void => {
  cache.clear();
  findingsCache.clear();
  excludedCache.clear();
  recommendationsCache.clear();
  runIndex = null;
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

export type RecommendationsState =
  | { readonly status: 'loading' }
  /** The run produced none: there is no file, which is an absence and not a failure. */
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly recommendations: Recommendations }
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

/**
 * The workspace's tests, newest first: one read of `/runs/index.json` while the app is open.
 *
 * What it is for is naming a test somewhere other than on that test's own screens — the
 * Sites screen's _"Last test: …"_ line, which has a run id from the platform and needs the
 * words that test was asked for. Reading `run.json` for each of them would be one request
 * per test to render a list of sites; the listing already carries the name, and carries it
 * for every test at once.
 */
export function useRunIndex(): RunIndexState {
  const [state, setState] = useState<RunIndexState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void loadRunIndex().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/** The most recent test in the workspace, which is what `/` opens. */
export function useLatestRun(): LatestRunState {
  return latestOf(useRunIndex());
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

/**
 * What this run says to change: read once per run while the app is open.
 *
 * The replay's outcome card names the recommendations one session is evidence for, which is
 * a lookup over the citations stored in this file. A run that produced none answers `none`,
 * and the card says so rather than showing a row that reads as *supports nothing*.
 */
export function useRecommendations(runId: string): RecommendationsState {
  const [state, setState] = useState<RecommendationsState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    void loadRecommendations(runId).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [runId]);

  return state;
}

/**
 * How big one session's recording is, asked of the mount rather than of the artifact.
 *
 * The replay's outcome card states the file's size, and nothing in a run directory records
 * it: the contract stores the recording's path, its duration and its offsets, which are
 * what the recorder measured. The size is a fact of **the file**, so it is read from the
 * file — one `HEAD` over the same read-only run mount the stage plays from, which answers
 * `content-length` for every file it serves and computes nothing to do it. It is read here
 * because this module is where this app asks a server about a run.
 *
 * `null` until it is known, and `null` for a mount that does not say: a card that cannot
 * read the size says so in words rather than printing a zero somebody might believe.
 */
export function useRecordingSize(runId: string, path: string | null): number | null {
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setBytes(null);
    if (path === null) return;

    void fetch(absolute(runFile(runId, path)), { method: 'HEAD' })
      .then((response) => {
        const length = response.ok ? Number(response.headers.get('content-length')) : Number.NaN;
        if (live && Number.isFinite(length) && length > 0) setBytes(length);
      })
      .catch(() => {
        // A size that could not be read is a size the card does not state. It is not an
        // error about the session: the recording itself may well play.
      });

    return () => {
      live = false;
    };
  }, [runId, path]);

  return bytes;
}
