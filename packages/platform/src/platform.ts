import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { seedDemoWorkspace } from './seed.js';
import type { SeededWorkspace } from './seed.js';
import { audienceRoutes } from './server/routes/audiences.js';
import { authRoutes } from './server/routes/auth.js';
import type { Route } from './server/routes/types.js';
import { readSessionId, sessionCookieHeader, signSessionId } from './server/session.js';
import { openFileStore } from './store/file-store.js';
import type { PlatformStore, SessionRecord } from './store/types.js';
import { readSettings, writeSettings } from './store/settings.js';

/**
 * The platform: the store, the seeded demo workspace, the routes, and the two functions
 * the run mount and sign-in are built on — which runs a request may read, and the session
 * it carries.
 *
 * It owns no HTTP server of its own and no static assets: `startPlatformServer` composes
 * it with the run-data mount and the built viewer, both passed in by `personavision
 * serve` (`packages/cli`).
 */

/** Two weeks, absolute — a session ends when it ends, rather than sliding. */
export const SESSION_LIFETIME_SECONDS = 14 * 24 * 60 * 60;

export interface PlatformOptions {
  /** Where accounts, workspaces, audiences and sessions live. `--data-dir`. */
  dataDir: string;
  /** The directory the run directories sit in — `./runs`. */
  runsRoot: string;
}

export interface Platform {
  dataDir: string;
  runsRoot: string;
  store: PlatformStore;
  routes: Route[];
  /**
   * Non-null exactly when this start seeded the data directory, and the only place the
   * generated password exists. A restart against the same directory returns `null`.
   */
  seeded: SeededWorkspace | null;
  /**
   * The runs one request may read, handed to the run-data mount so that the listing and
   * the files are scoped together. A signed-in request sees its workspace's runs; a
   * signed-out one sees only the seeded demo run, which `/` and `/demo` read without an
   * account (`docs/FLOW.md` section 3). A run of another workspace is not in the list, so
   * the mount answers 404 — that another workspace holds it is not disclosed.
   */
  visibleRuns: (request: IncomingMessage) => Promise<readonly string[]>;
  /** The session a request carries, or `null` for a request that is signed out. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /** The cookie value for a session, and the `set-cookie` header carrying it (#101). */
  signSession: (sessionId: string) => string;
  sessionCookie: (sessionId: string, options: { secure: boolean }) => string;
}

export const createPlatform = async ({ dataDir, runsRoot }: PlatformOptions): Promise<Platform> => {
  const resolvedDataDir = resolve(dataDir);
  const resolvedRunsRoot = resolve(runsRoot);
  // The settings file is what "this data directory has been started before" means: it is
  // written last, so a start interrupted half way through seeding seeds again rather
  // than coming up with half a workspace.
  const existing = await readSettings(resolvedDataDir);
  const store = await openFileStore(resolvedDataDir);
  const seeded =
    existing === null ? await seedDemoWorkspace({ store, runsRoot: resolvedRunsRoot }) : null;
  const settings = existing ?? (await writeSettings(resolvedDataDir));

  const readSession = async (request: IncomingMessage): Promise<SessionRecord | null> => {
    const sessionId = readSessionId(request, settings.signingKey);
    return sessionId === null ? null : await store.sessions.byId(sessionId);
  };

  return {
    dataDir: resolvedDataDir,
    runsRoot: resolvedRunsRoot,
    store,
    routes: [...authRoutes, ...audienceRoutes],
    seeded,
    visibleRuns: async (request) => {
      const session = await readSession(request);
      if (session === null) return store.workspaces.publicRunIds();
      const workspace = await store.workspaces.byId(session.workspaceId);
      return workspace?.runIds ?? [];
    },
    readSession,
    signSession: (sessionId) => signSessionId(sessionId, settings.signingKey),
    sessionCookie: (sessionId, { secure }) =>
      sessionCookieHeader(signSessionId(sessionId, settings.signingKey), {
        secure,
        maxAgeSeconds: SESSION_LIFETIME_SECONDS,
      }),
  };
};
