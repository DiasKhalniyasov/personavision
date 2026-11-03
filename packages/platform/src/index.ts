/**
 * `@personavision/platform` — accounts, sign-in sessions, workspaces, audience storage,
 * the sites a workspace may be tested against and the server behind `personavision serve`.
 *
 * Self-hosted and offline-capable by default: a file-backed store under a data directory
 * and a seeded demo workspace, so the whole product runs with no cloud account, no
 * managed database and no API key. A managed database later is a second implementation
 * of the store interfaces and nothing else.
 *
 * It depends on `@personavision/contract` for every stored shape, and on
 * `@personavision/personas` for the generator that turns a stored audience into the people
 * a test would run on — the Audience screens read them beside the audience itself, so the
 * generator is called here rather than in a browser (#102). It depends on
 * `@personavision/provider` for two values and no behaviour: the model id each mode calls
 * and the typed error selection throws when a mode cannot be served, so that a refused test
 * names the model from the one place the model ids are written down (#144). Nothing else in
 * the repository:
 * the run-data mount and the built viewer are passed to `startPlatformServer` by
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

export {
  DraftNotAcceptedError,
  NoSuchSiteError,
  NoSuchWorkspaceError,
  ONE_URL_VARIANT_ID,
  seedForLaunchDay,
  startSiteTest,
  startTest,
  TestRefusedError,
  variantForSite,
} from './run/start.js';
export type {
  SiteAtLaunch,
  SiteTestDraft,
  StartedTest,
  StartSiteTestOptions,
  StartTestOptions,
  TestDraft,
  TestPipeline,
} from './run/start.js';

/**
 * The caps: the three numbers, and the typed refusal that states one in the user's words.
 *
 * Exported so that the CLI and the screens print the message this package wrote rather than
 * composing a sentence of their own, and so that whatever needs a cap's value reads it here
 * instead of writing a second literal (`packages/platform/test/caps.test.ts` greps for one).
 */
export {
  CAPS,
  CapRefusedError,
  concurrencyForSite,
  RUNNER_CONCURRENCY_ENV,
  sessionsInFlight,
  LAUNCH_LEDGER_HOURS,
  refuseTooManyAgents,
  refuseTooManyRunsThisHour,
  withLaunchRecorded,
} from './caps.js';
export type { CapName, ConcurrencyForSite } from './caps.js';

export { AudienceNotOfferedError, audienceForNewTest } from './audience/freeze.js';
export { withPeople } from './audience/people.js';
export type { AudienceWithPeople } from './audience/people.js';

export { audienceRoutes, DEFAULT_PARTICIPANTS } from './server/routes/audiences.js';
export type { AudienceRouteOptions } from './server/routes/audiences.js';

export { runRoutes } from './server/routes/runs.js';
export type { RunRouteOptions } from './server/routes/runs.js';

export {
  githubRoutes,
  GITHUB_APP_NOT_REGISTERED,
  GITHUB_APP_TICKET,
  NO_CONNECTION,
  unregisteredGithubApp,
} from './server/routes/github.js';
export type {
  GithubAppRegistration,
  GithubConnectionBody,
  GithubRouteOptions,
} from './server/routes/github.js';

/**
 * The GitHub App's credentials and the installation token minted from them (#319).
 *
 * Exported because the two callers are outside this package: `personavision serve` hands
 * `githubAppRegistration()` to `createPlatform` as its `githubApp` option, so
 * `/settings/github` and the locked path-2 card answer from the environment rather than from
 * the default, which says no App exists; and whatever drives path 2 hands
 * `tokenSourceFor(installationId)` to
 * `@personavision/improve`'s client as its `token`, which is the one shape #297 takes. The
 * credentials themselves are read in `src/github/credentials.ts` and nowhere else.
 */
export {
  GITHUB_APP_FAILURE_KINDS,
  GITHUB_APP_ID_ENV,
  GITHUB_APP_JWT_ALGORITHM,
  GITHUB_APP_PRIVATE_KEY_ENV,
  GITHUB_APP_PRIVATE_KEY_PATH_ENV,
  GITHUB_APP_SLUG,
  GithubAppError,
  githubAppId,
  githubAppIsRegistered,
  githubAppRegistration,
  readGithubAppSigner,
} from './github/credentials.js';
export type {
  GithubAppCredentialOptions,
  GithubAppFailureKind,
  GithubAppRegistrationOptions,
  GithubAppSigner,
} from './github/credentials.js';

export {
  APP_JWT_BACKDATE_SECONDS,
  APP_JWT_MAX_SPAN_SECONDS,
  claimsOfAppJwt,
  createGithubInstallationTokens,
  GITHUB_API_BASE_URL,
  GITHUB_USER_AGENT,
  INSTALLATION_TOKEN_LIFETIME_MS,
  INSTALLATION_TOKEN_MARGIN_MS,
  mintAppJwt,
  mintInstallationToken,
  TOKEN_MINT_TIMEOUT_MS,
} from './github/token.js';
export type {
  AppJwtClaims,
  GithubInstallationTokens,
  GithubTokenAnswer,
  GithubTokenOptions,
  GithubTokenRequest,
  GithubTokenTransport,
  MintedInstallationToken,
} from './github/token.js';

export {
  acceptedEstimateRequest,
  EstimateNotAcceptedError,
  estimateRun,
  measuredHistoryOfRuns,
  providerPrices,
} from './run/estimate.js';
export type {
  AgentsFigures,
  CostEstimate,
  CostFigures,
  EstimateDraft,
  EstimateIssue,
  EstimateRequest,
  MeasuredFrom,
  MeasuredHistory,
  MeasuredHistoryReader,
  MeasuredRun,
  NothingToPay,
  PriceTable,
  Range,
  RunEstimate,
  RunHistorySource,
  StorageEstimate,
  StorageFigures,
  TimeEstimate,
  TimeFigures,
  UnknownFigure,
} from './run/estimate.js';

export { estimateRoutes } from './server/routes/estimate.js';
export type { EstimateRouteOptions } from './server/routes/estimate.js';

export {
  addSite,
  AVAILABLE_SITE_VERIFICATION_METHODS,
  checkConnectedRepository,
  checkDnsTxt,
  defaultSiteCheckDeps,
  foundTheLine,
  mintSiteToken,
  noAnswer,
  nodeTxtResolver,
  noSiteConnections,
  nothingPublished,
  otherValues,
  parseSiteUrl,
  places,
  SITE_TOKEN_PREFIX,
  SITE_VERIFICATION_METHODS,
  SITE_VERIFICATION_NAME,
  siteCheckFor,
  siteCheckResult,
  SiteCheckNotAvailableError,
  siteVerificationPair,
  SiteUrlNotAcceptedError,
  storedSiteConnections,
  verificationDomains,
  verifySite,
} from './site/index.js';
export type {
  CheckedSite,
  SiteCheck,
  SiteCheckDeps,
  SiteCheckFinding,
  SiteCheckOutcome,
  SiteCheckResult,
  SiteCheckSubject,
  SiteCheckTarget,
  SiteConnections,
  SiteIssue,
  SiteRepositoryConnection,
  TxtResolver,
  VerifiedSite,
} from './site/index.js';

export { siteRoutes } from './server/routes/sites.js';
export type { SiteBody, SiteRouteOptions } from './server/routes/sites.js';

export { isNavigation, routeMount } from './server/router.js';
export { notImplemented, readJsonBody, sendJson } from './server/routes/types.js';
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
  GithubInstallationRecord,
  GithubInstallationStore,
  NewAccount,
  NewGithubInstallation,
  NewSession,
  NewSite,
  NewWorkspace,
  PasswordVerifier,
  PlatformStore,
  SessionRecord,
  SessionStore,
  SiteLaunch,
  SiteRecord,
  SiteStore,
  SiteVerification,
  SiteVerificationMethod,
  WorkspaceRecord,
  WorkspaceStore,
} from './store/types.js';
