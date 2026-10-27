/**
 * What the Session replay's tests need on top of the app harness.
 *
 * The app, the providers and the run data all come from `tests/app.tsx`, which serves the
 * **repository's own** run directory — session files included — so these tests assert what
 * a reader of the committed example run sees. What is here is the little this screen adds:
 * the seed run's id, a session file a test wants to change before it is served, and a
 * teardown that also forgets the sessions this screen read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths } from '@personavision/contract';
import { clearSessionCache } from '../../src/screens/replay/useReplaySession';
import { forgetRuns } from '../app';

export { mountApp, serveRunData } from '../app';

/** The committed example run: 24 people over two versions of the northwind checkout. */
export const SEED_RUN = '2026-10-24-1402-northwind-demo';

// Under the jsdom environment `new URL(…, import.meta.url)` throws, as `tests/app.tsx` notes.
const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/runs');

const layout = runPaths('');

/** The URL a session file is served at — the contract's path under the run's own. */
export const sessionPath = (sessionId: string): string =>
  `/runs/${SEED_RUN}/${layout.session(sessionId)}`;

/** One session of the seed run, parsed, for a test that wants to serve a variation of it. */
export function readSeedSession(sessionId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runsRoot, SEED_RUN, layout.session(sessionId)), 'utf8'),
  ) as Record<string, unknown>;
}

/** Every run and session read so far is forgotten, so one test cannot see another's. */
export const forget = (): void => {
  forgetRuns();
  clearSessionCache();
};
