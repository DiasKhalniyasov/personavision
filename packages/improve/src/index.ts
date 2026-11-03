/**
 * `@personavision/improve` — path 2's closed loop.
 *
 * After a path-1 run on a repository the owner has connected, this package is what decides
 * one targeted change, opens it as a pull request, finds the URL the changed version is
 * served at, and posts the before/after back as one comment (`docs/FLOW.md` section 15).
 * **It never merges. The owner merges.**
 *
 * #297 builds the floor the rest of the step stands on: the one client interface through
 * which this product talks to GitHub, the recorded transport every test here and in the
 * tickets after it runs over, and one call proved end to end — opening a pull request.
 * Reading a pull request's deployments (#300), the comment (#301) and the change itself
 * (#302) are built against this seam.
 *
 * Nothing in this package reads an environment variable. The installation token arrives as
 * an argument from `@personavision/platform` (#319), which is the one place the App's
 * credentials are read, and `tests/workspace.test.ts`'s scanner holds this package to that.
 */

export {
  createGitHubClient,
  DEFAULT_TIMEOUT_MS,
  GITHUB_API_BASE_URL,
  IMPROVE_BRANCH_PREFIX,
} from './github/client.js';
export type {
  BranchHead,
  Deployment,
  DeploymentStatus,
  FileWritten,
  GitHubClient,
  GitHubClientOptions,
  GitHubRepository,
  GitHubTokenSource,
  IssueComment,
  OpenPullRequest,
  PullRequestOpened,
  RepositoryFile,
} from './github/client.js';

export { GITHUB_FAILURE_KINDS, GitHubCallError } from './github/errors.js';
export type { GitHubFailureKind } from './github/errors.js';

export { createFetchTransport } from './github/transport.js';
export type {
  GitHubHttpRequest,
  GitHubHttpResponse,
  GitHubMethod,
  GitHubTransport,
} from './github/transport.js';

export { createRecordedTransport, UnrecordedGitHubCallError } from './github/recorded.js';
export type {
  RecordedExchange,
  RecordedReply,
  RecordedRequest,
  RecordedTransport,
} from './github/recorded.js';

export { branchForRun, changeRecordOf, openChange } from './change/open.js';
export type {
  ChangeOpened,
  ChangeRecord,
  ChangeRefused,
  ChangeRequest,
  ChangeResult,
  PullRequestRecord,
} from './change/open.js';

export { COMMENT_MARKER, commentBody, SIMULATED_LABEL } from './comment/body.js';
export type { CommentDraft, CommentInput, CommentRefused, RunComment } from './comment/body.js';

export { findRunComment, postRunComment } from './comment/post.js';
export type { RunCommentPosted, RunCommentResult, RunCommentUpdated } from './comment/post.js';

export { IMPROVE_STEPS, improveRunId, runImproveLoop } from './loop.js';
export type {
  ChangeUnderWay,
  ComparisonDriven,
  ComparisonRequest,
  ComparisonVariant,
  DriveComparison,
  ImproveDryRun,
  ImproveFinished,
  ImproveRequest,
  ImproveResult,
  ImproveStep,
  ImproveStopped,
  SourceRun,
} from './loop.js';

export { createFetchProbe, DEFAULT_PROBE_TIMEOUT_MS } from './preview/probe.js';
export type { PreviewProbe, PreviewProbeAnswer } from './preview/probe.js';

export {
  DEFAULT_PREVIEW_POLL_MS,
  DEFAULT_PREVIEW_WAIT_MS,
  PREVIEW_UNUSABLE_STATES,
  previewRecordOf,
  resolvePreview,
} from './preview/resolve.js';
export type {
  NoPreview,
  PreviewFound,
  PreviewOptions,
  PreviewRequest,
  PreviewResolution,
  PreviewUnusable,
  PreviewUnusableState,
} from './preview/resolve.js';
