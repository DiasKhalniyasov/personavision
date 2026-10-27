/**
 * The harness every screen test in this app uses.
 *
 * Two things it gives a test: the app mounted on one route, and the run data served the way
 * the shipped app reads it. The run data is the **repository's own** run directories, built
 * by the same `readRunIndex` the server answers `/runs/index.json` with and the same files
 * on disk, so a test reads what a reader reads rather than a fixture a test wrote.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { listRunDirs, runPaths } from '@personavision/contract';
import { readRunIndex } from '@personavision/cli';
import { App } from '../src/app';
import { routes } from '../src/routes';
import { clearAudienceCache } from '../src/screens/audience/useAudienceList';
import type { AudienceRecord } from '../src/screens/audience/store';
import { AudiencesContext } from '../src/shell/useAudiences';
import type { AudiencesState } from '../src/shell/useAudiences';
import { clearRunCache } from '../src/shell/useRun';
import { DEMO_SESSION, SessionContext } from '../src/shell/useSession';
import type { SessionState } from '../src/shell/useSession';

// Under the jsdom environment `new URL(…, import.meta.url)` throws, so the path comes from
// the string form, as `setup.ts` does.
const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../runs');

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const missing = (path: string): Response =>
  new Response(`There is no ${path} here.\n`, { status: 404 });

/** The run directory and file a URL names, if it names one. */
const RUN_FILE = /^\/runs\/([^/]+)\/(.+)$/;
/** The files of a run, under the contract's own names, and nothing else. */
const layout = runPaths('');
/** `sessions/<id>.json`: one file per person, as `runPaths` spells it. */
const isSessionFile = (file: string): boolean => {
  if (!file.startsWith(`${layout.sessionsDir}/`) || !file.endsWith('.json')) return false;
  const name = file.slice(layout.sessionsDir.length + 1);
  return name !== '' && !name.includes('/');
};
const serves = (file: string): boolean =>
  file === layout.run || file === layout.findings || isSessionFile(file);

export interface ServedRunData {
  /** The run directories the listing holds, newest first. */
  runIds: string[];
  /** What a request asked for, in order: the shell must not read a run twice. */
  requests: string[];
  /** The audiences the store answers with, as #102's routes shape them. */
  audiences: AudienceRecord[];
}

/** The run whose audience the seeded demo workspace has described (`packages/platform`). */
const SEED_RUN_ID = '2026-10-24-1402-northwind-demo';

/**
 * The workspace's one audience, as `GET /audiences` answers with it.
 *
 * It is built from the committed example run's own audience block and its personas, so a
 * test reads the audience a reader reads and the people that run really went out with —
 * the store generates them with `@personavision/personas`, which does not reach a browser.
 */
export function demoAudienceRecord(): AudienceRecord {
  const run = readRunFile(SEED_RUN_ID) as unknown as {
    createdAt: string;
    audience: AudienceRecord['audience'];
    personas: AudienceRecord['people'];
  };
  return {
    id: 'aud-outdoor-gear-shoppers',
    audience: run.audience,
    people: run.personas,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    deletedAt: null,
    issues: [],
  };
}

/** `/audiences` and `/audiences/<record id>`, the two reads the screens make. */
const AUDIENCE_PATH = /^\/audiences\/([^/]+)$/;

/**
 * Serve the repository's run directories over a stubbed `fetch`, at the URLs of
 * `docs/adr/0001-run-data-over-http-as-static-files.md`.
 *
 * `runIds` narrows the workspace — pass `[]` for a workspace with no test. A run directory
 * can also be replaced with text of its own, to test a file the viewer cannot read.
 */
export async function serveRunData(
  options: {
    runIds?: string[];
    files?: Record<string, string>;
    /** The workspace's audiences. The default is the one the demo workspace is seeded with. */
    audiences?: AudienceRecord[];
  } = {},
): Promise<ServedRunData> {
  const available = await listRunDirs(runsRoot);
  const runIds = options.runIds ?? available;
  const index = await readRunIndex(runsRoot, runIds);
  const overrides = options.files ?? {};
  const audiences = options.audiences ?? [demoAudienceRecord()];
  const requests: string[] = [];

  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    requests.push(pathname);

    if (pathname === '/audiences') return Promise.resolve(json({ audiences }));
    const audiencePath = AUDIENCE_PATH.exec(pathname);
    if (audiencePath !== null) {
      const record = audiences.find((candidate) => candidate.id === audiencePath[1]);
      return Promise.resolve(
        record === undefined
          ? new Response(JSON.stringify({ error: 'There is no such audience.' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
          : json(record),
      );
    }

    const override = overrides[pathname];
    if (override !== undefined) {
      return Promise.resolve(
        new Response(override, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }
    if (pathname === '/runs/index.json') return Promise.resolve(json(index));

    const file = RUN_FILE.exec(pathname);
    if (file === null || !runIds.includes(file[1] as string) || !serves(file[2] as string)) {
      return Promise.resolve(missing(pathname));
    }
    try {
      const body = readFileSync(join(runsRoot, file[1] as string, file[2] as string));
      return Promise.resolve(json(JSON.parse(body.toString('utf8'))));
    } catch {
      return Promise.resolve(missing(pathname));
    }
  });

  return { runIds, requests, audiences };
}

/**
 * One file of a run directory of the repository, parsed. The run's own `run.json` by
 * default; a test that overrides a session passes `runPaths('').session(id)`.
 */
export function readRunFile(runId: string, file: string = layout.run): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runsRoot, runId, file), 'utf8')) as Record<string, unknown>;
}

/** One run directory's findings, parsed. The reader reads this file through `useFindings`. */
export function readFindingsFile(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runsRoot, runId, layout.findings), 'utf8')) as Record<
    string,
    unknown
  >;
}

export interface MountOptions {
  /**
   * Who is signed in. The default is the demo workspace, signed in, so a screen test is
   * about its own screen; `null` overrides nothing and lets the app read `GET /auth/session`
   * for itself, which is what #103's sign-in tests are about.
   */
  session?: SessionState | null;
  /** What audiences the workspace has. The default is whatever the stub works out. */
  audiences?: AudiencesState | null;
}

/** The app, mounted on one route, with the providers #103 and #102 will own. */
export function mountApp(path: string, options: MountOptions = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const tree: ReactElement = (
    <SessionContext.Provider value={options.session === undefined ? DEMO_SESSION : options.session}>
      <AudiencesContext.Provider value={options.audiences ?? null}>
        <App router={router} />
      </AudiencesContext.Provider>
    </SessionContext.Provider>
  );

  return { router, ...render(tree) };
}

/** Every run and audience read so far is forgotten, so one test cannot see another's. */
export const forgetRuns = (): void => {
  clearRunCache();
  clearAudienceCache();
  vi.unstubAllGlobals();
};
