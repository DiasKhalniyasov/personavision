/**
 * `@personavision/platform` — accounts, sign-in sessions, workspaces, audience storage
 * and the server behind `personavision serve`.
 *
 * Self-hosted and offline-capable by default: a file-backed store under a data directory
 * and a seeded demo workspace, so the whole product runs with no cloud account, no
 * managed database and no API key. A managed database later is a second implementation
 * of the store interfaces and nothing else.
 *
 * It depends on `@personavision/contract` and on nothing else in the repository: the
 * run-data mount and the built viewer are passed to `startPlatformServer` by
 * `@personavision/cli`, which owns them.
 */

export { createPlatform, SESSION_LIFETIME_SECONDS } from './platform.js';
export type { Platform, PlatformOptions } from './platform.js';

export {
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_NAME,
  DEMO_WORKSPACE_NAME,
  seedDemoWorkspace,
} from './seed.js';
export type { SeededWorkspace } from './seed.js';

export { DEFAULT_HOST, DEFAULT_PORT, startPlatformServer } from './server/server.js';
export type { PlatformServer, PlatformServerOptions } from './server/server.js';

export { sessionGuard, safeNextPath, SIGNIN_PATH } from './auth/guard.js';
export type { GuardOptions } from './auth/guard.js';

export { signIn } from './auth/signin.js';
export type { Credentials, SignedIn, SignInOptions } from './auth/signin.js';

export { workspaceForAccount } from './workspace/membership.js';

export { isNavigation, routeMount } from './server/router.js';
export { notImplemented, sendJson } from './server/routes/types.js';
export type { Middleware, Route } from './server/routes/types.js';

export {
  clearedSessionCookieHeader,
  isSecureRequest,
  readSessionId,
  SESSION_COOKIE,
  sessionCookieHeader,
  signSessionId,
} from './server/session.js';

export { openFileStore } from './store/file-store.js';
export { generatePassword, hashPassword, verifyPassword } from './store/password.js';
export type {
  AccountRecord,
  AccountStore,
  AudienceRecord,
  AudienceStore,
  NewAccount,
  NewSession,
  NewWorkspace,
  PasswordVerifier,
  PlatformStore,
  SessionRecord,
  SessionStore,
  WorkspaceRecord,
  WorkspaceStore,
} from './store/types.js';
