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
const SESSION_FILE = new RegExp(`^${layout.sessionsDir}/[^/]+\\.json$`);
const serves = (file: string): boolean =>
  file === layout.run || file === layout.findings || SESSION_FILE.test(file);

export interface ServedRunData {
  /** The run directories the listing holds, newest first. */
  runIds: string[];
  /** What a request asked for, in order: the shell must not read a run twice. */
  requests: string[];
}

/**
 * Serve the repository's run directories over a stubbed `fetch`, at the URLs of
 * `docs/adr/0001-run-data-over-http-as-static-files.md`.
 *
 * `runIds` narrows the workspace — pass `[]` for a workspace with no test. A run directory
 * can also be replaced with text of its own, to test a file the viewer cannot read.
 */
export async function serveRunData(
  options: { runIds?: string[]; files?: Record<string, string> } = {},
): Promise<ServedRunData> {
  const available = await listRunDirs(runsRoot);
  const runIds = options.runIds ?? available;
  const index = await readRunIndex(runsRoot, runIds);
  const overrides = options.files ?? {};
  const requests: string[] = [];

  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    requests.push(pathname);

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

  return { runIds, requests };
}

/**
 * One file of a run directory of the repository, parsed. The run's own `run.json` by
 * default; a test that overrides a session passes `runPaths('').session(id)`.
 */
export function readRunFile(runId: string, file: string = layout.run): Record<string, unknown> {
  return JSON.parse(readFileSync(join(runsRoot, runId, file), 'utf8')) as Record<string, unknown>;
}

export interface MountOptions {
  /** Who is signed in. The default is the stub's signed-in demo workspace. */
  session?: SessionState;
  /** What audiences the workspace has. The default is whatever the stub works out. */
  audiences?: AudiencesState | null;
}

/** The app, mounted on one route, with the providers #103 and #102 will own. */
export function mountApp(path: string, options: MountOptions = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const tree: ReactElement = (
    <SessionContext.Provider value={options.session ?? DEMO_SESSION}>
      <AudiencesContext.Provider value={options.audiences ?? null}>
        <App router={router} />
      </AudiencesContext.Provider>
    </SessionContext.Provider>
  );

  return { router, ...render(tree) };
}

/** Every run read so far is forgotten, so one test cannot see another's. */
export const forgetRuns = (): void => {
  clearRunCache();
  vi.unstubAllGlobals();
};
