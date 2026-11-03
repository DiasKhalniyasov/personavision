import type { Preview } from '@personavision/contract';
import type {
  Deployment,
  DeploymentStatus,
  GitHubClient,
  GitHubRepository,
} from '../github/client.js';
import { createFetchProbe } from './probe.js';
import type { PreviewProbe } from './probe.js';

/**
 * The URL the changed version is tested at — and the honest nothing when there is none.
 *
 * The before/after of path 2 compares two **running** versions: the baseline is the
 * customer's live site, and the change has to be somewhere a hundred browsers can reach it
 * (`docs/FLOW.md` section 15, point 3). Where a repository already publishes a preview
 * deployment per pull request — the arrangement most repositories that deploy a site
 * already have — that URL is on the pull request's own deployment statuses, and this module
 * reads it from there, through the one GitHub client seam, with no new path to the network.
 *
 * Where there is none, the product **says so**. It does not guess a URL from a convention,
 * it does not fall back to the baseline, and it does not report a comparison it could not
 * make. **We never run a customer's build** — their build script, their dependencies and
 * their secrets stay on their own infrastructure. That is a decided security boundary
 * (`docs/adr/0003-previews-come-from-the-repository-s-own-deployment.md`, #232 answered on
 * 2026-11-03), so there is no runner here to turn on and no flag that would turn one on:
 * `tests/preview/surface.test.ts` holds this package to it.
 *
 * So a resolution is one of **three** answers, and they are three shapes rather than one
 * shape with a `null` in it:
 *
 * 1. {@link PreviewFound} — a URL, which has been asked whether it answers.
 * 2. {@link NoPreview} — this repository publishes no preview deployment for this pull
 *    request, with the sentence a user can act on.
 * 3. {@link PreviewUnusable} — a preview exists and cannot be used yet: still building
 *    within the caller's cap, failed, or serving nothing. Each carries what the status or
 *    the request answered.
 *
 * Only the first carries a `url`, so an unreachable host cannot be read as a preview, and
 * "there is none" cannot be read as "not yet".
 *
 * A GitHub call that fails is **not** one of the three: a 403 on a repository the App was
 * removed from throws {@link GitHubCallError} from the client, because "we could not ask"
 * is a different thing from "there is none".
 */

/** How long a pending deployment may be waited for, when the caller names no cap. */
export const DEFAULT_PREVIEW_WAIT_MS = 180_000;

/** How long between re-reads while a deployment is still building. */
export const DEFAULT_PREVIEW_POLL_MS = 5_000;

/** The ways a preview that exists cannot be used. */
export const PREVIEW_UNUSABLE_STATES = ['not_ready', 'failed', 'unreachable'] as const;

export type PreviewUnusableState = (typeof PREVIEW_UNUSABLE_STATES)[number];

/** A URL the change is served at, which answered when it was asked. */
export interface PreviewFound {
  readonly kind: 'preview';
  readonly url: string;
  readonly deploymentId: number;
  /** The deployment's environment, as the repository's own service named it. */
  readonly environment: string;
  /** What the deployment status said, for the record the artifact keeps. */
  readonly answered: string;
}

/** No preview deployment exists for this pull request. There is no URL, and no guess. */
export interface NoPreview {
  readonly kind: 'no_preview';
  /** What the Improve screen prints, and what the artifact records as the reason. */
  readonly reason: string;
}

/** A preview exists and cannot be used: not yet, failed, or serving nothing. */
export interface PreviewUnusable {
  readonly kind: 'unusable';
  readonly state: PreviewUnusableState;
  readonly reason: string;
  /** What the deployment status said, or what the request to the URL answered. */
  readonly answered: string;
  /** How long was waited before `not_ready` was the answer. */
  readonly waitedMs?: number;
  readonly deploymentId?: number;
}

export type PreviewResolution = PreviewFound | NoPreview | PreviewUnusable;

/** The pull request a preview is being resolved for. */
export interface PreviewRequest {
  readonly repository: GitHubRepository;
  /** The pull request's number, which is what the sentences name. */
  readonly pullNumber: number;
  /**
   * The commit the pull request's head points at: GitHub lists deployments by commit, and
   * the caller already holds this sha from the write that created the branch (#302).
   */
  readonly sha: string;
}

export interface PreviewOptions {
  /**
   * The wall-clock cap on waiting for a pending deployment, in milliseconds. **The
   * caller's to set**, like every other cap in this product, and nothing is retried past
   * it: the number of reads is bounded by the cap and the poll interval together, so a
   * clock that does not move cannot turn the wait into a loop.
   */
  readonly waitMs?: number;
  readonly pollEveryMs?: number;
  /** Whether the URL answers. Injected, so no test reaches the network. */
  readonly probe?: PreviewProbe;
  /** The sleep between re-reads. Injected, so no test waits in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The process clock the cap is measured on. Injected for the same reason. */
  readonly nowMs?: () => number;
}

/** A cap is a positive whole number of milliseconds, as the swarm's caps already are. */
const capOf = (given: number | undefined, fallback: number): number => {
  if (given === undefined || !Number.isFinite(given)) return fallback;
  return Math.max(1, Math.floor(given));
};

const PENDING_STATES = new Set(['pending', 'queued', 'in_progress', 'waiting']);
const FAILED_STATES = new Set(['error', 'failure']);
/** A deployment GitHub has marked as superseded: not this pull request's preview any more. */
const SUPERSEDED_STATE = 'inactive';

/**
 * A production deployment of the same commit is not a preview.
 *
 * It happens — somebody deploys the branch, or the commit has already shipped — and using
 * that URL would point the swarm at the customer's live site, which is the baseline. The
 * one thing this module must never do is report a comparison of the baseline with itself.
 */
const isPreviewEnvironment = (deployment: Deployment): boolean =>
  !/^prod(uction)?\b/i.test(deployment.environment.trim());

/** Newest first, by the time GitHub stamped it, with the id breaking a tie. */
const newestFirst = <T extends { readonly createdAt: string; readonly id: number }>(
  entries: readonly T[],
): readonly T[] =>
  [...entries].sort((left, right) =>
    left.createdAt === right.createdAt
      ? right.id - left.id
      : left.createdAt < right.createdAt
        ? 1
        : -1,
  );

interface UrlCandidate {
  readonly kind: 'url';
  readonly deployment: Deployment;
  readonly url: string;
  readonly answered: string;
}

interface PendingCandidate {
  readonly kind: 'pending';
  readonly deployment: Deployment;
  readonly answered: string;
}

interface FailedCandidate {
  readonly kind: 'failed';
  readonly deployment: Deployment;
  readonly answered: string;
}

/** A deployment GitHub has marked `inactive`: torn down, or replaced by a newer one. */
interface SupersededCandidate {
  readonly kind: 'superseded';
  readonly deployment: Deployment;
}

type Candidate = UrlCandidate | PendingCandidate | FailedCandidate | SupersededCandidate;

/** What one deployment's newest status says about it. */
const candidateOf = (deployment: Deployment, statuses: readonly DeploymentStatus[]): Candidate => {
  const latest = newestFirst(statuses)[0];
  const where = `the ${deployment.environment} deployment of this pull request`;
  if (latest === undefined) {
    return { kind: 'pending', deployment, answered: `${where} has reported no status yet` };
  }
  const said = latest.description ?? latest.state;

  if (latest.state === 'success') {
    /**
     * GitHub carries `environment_url` as an empty string when the deployment published
     * none, rather than leaving the field out, so a blank one is **no URL** — not a URL
     * that answers nothing. The two read alike on a screen and are different problems: one
     * is a service that never told us where it put the change.
     */
    const published = latest.environmentUrl?.trim() ?? '';
    return published === ''
      ? {
          kind: 'failed',
          deployment,
          answered: `${where} reported success and published no URL: ${said}`,
        }
      : {
          kind: 'url',
          deployment,
          url: published,
          answered: `${where} published ${published}: ${said}`,
        };
  }
  if (PENDING_STATES.has(latest.state)) {
    return { kind: 'pending', deployment, answered: `${where} is ${latest.state}: ${said}` };
  }
  if (FAILED_STATES.has(latest.state)) {
    return { kind: 'failed', deployment, answered: `${where} is ${latest.state}: ${said}` };
  }
  if (latest.state === SUPERSEDED_STATE) return { kind: 'superseded', deployment };
  /**
   * A state this product has not met is **waited for**, not called a failure. GitHub adds
   * states — `waiting` arrived with environment protection rules — and the cap bounds the
   * wait either way, so the cost of guessing wrong is one cap rather than a change reported
   * as broken when it was building.
   */
  return {
    kind: 'pending',
    deployment,
    answered: `${where} answered a state this product does not know — ${latest.state}: ${said}`,
  };
};

/** One pass over the pull request's deployments, newest first, previews only. */
const readCandidates = async (
  client: GitHubClient,
  request: PreviewRequest,
): Promise<readonly Candidate[]> => {
  const deployments = newestFirst(
    await client.readDeployments(request.repository, { sha: request.sha }),
  ).filter(isPreviewEnvironment);

  const candidates: Candidate[] = [];
  for (const deployment of deployments) {
    // In order, so the transcript a failing test prints reads in the order it happened.
    const statuses = await client.readDeploymentStatuses(request.repository, deployment.id);
    candidates.push(candidateOf(deployment, statuses));
  }
  return candidates;
};

const pullRequestOf = (request: PreviewRequest): string =>
  `pull request #${String(request.pullNumber)} of ${request.repository.owner}/${request.repository.repo}`;

const noPreview = (request: PreviewRequest): NoPreview => ({
  kind: 'no_preview',
  reason: `Path 2 needs a preview deployment: ${pullRequestOf(request)} has none, so there is no running version of the change to test. PersonaVision never runs your build — add a per-pull-request preview deployment to the repository and test the change again.`,
});

const notReady = (
  request: PreviewRequest,
  answered: string,
  waitedMs: number,
): PreviewUnusable => ({
  kind: 'unusable',
  state: 'not_ready',
  reason: `The preview deployment for ${pullRequestOf(request)} was still building after ${String(Math.round(waitedMs / 1000))} s, so the change has not been tested yet.`,
  answered,
  waitedMs,
});

const failed = (request: PreviewRequest, candidate: FailedCandidate): PreviewUnusable => ({
  kind: 'unusable',
  state: 'failed',
  reason: `The preview deployment for ${pullRequestOf(request)} failed, so there is no running version of the change to test.`,
  answered: candidate.answered,
  deploymentId: candidate.deployment.id,
});

/**
 * The repository does publish previews and this one is not running any more. Telling such
 * a user to add a preview deployment would be advice about infrastructure they already
 * have, so it is its own answer.
 */
const deactivated = (request: PreviewRequest, deployment: Deployment): PreviewUnusable => ({
  kind: 'unusable',
  state: 'failed',
  reason: `The preview deployment for ${pullRequestOf(request)} is no longer running — GitHub has marked it inactive — so there is no running version of the change to test.`,
  answered: `the ${deployment.environment} deployment of this pull request is inactive: it was torn down or replaced by a newer one`,
  deploymentId: deployment.id,
});

const unreachable = (
  request: PreviewRequest,
  deployment: Deployment,
  answered: string,
): PreviewUnusable => ({
  kind: 'unusable',
  state: 'unreachable',
  reason: `The preview deployment for ${pullRequestOf(request)} published a URL that answers nothing, so the change was not tested there.`,
  answered,
  deploymentId: deployment.id,
});

/**
 * Resolve the one preview URL a pull request's deployments carry, or say which of the two
 * nothings it is.
 *
 * Reads through `client` and nowhere else. Throws what the client throws: a GitHub call
 * that failed is not an answer about previews.
 */
export const resolvePreview = async (
  client: GitHubClient,
  request: PreviewRequest,
  options: PreviewOptions = {},
): Promise<PreviewResolution> => {
  const waitMs = capOf(options.waitMs, DEFAULT_PREVIEW_WAIT_MS);
  const pollEveryMs = Math.min(capOf(options.pollEveryMs, DEFAULT_PREVIEW_POLL_MS), waitMs);
  const probe = options.probe ?? createFetchProbe();
  const nowMs = options.nowMs ?? ((): number => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((settle) => {
        setTimeout(settle, ms);
      }));

  /** The ceiling that makes "nothing is retried forever" true of a clock that lies too. */
  const reads = 1 + Math.ceil(waitMs / pollEveryMs);
  const startedMs = nowMs();
  let pendingAnswered = `no deployment of ${pullRequestOf(request)} has reported a status`;

  /** The URL is asked whether it answers, and only then is it anybody else's. */
  const handOn = async (found: UrlCandidate): Promise<PreviewResolution> => {
    const asked = await probe(found.url);
    return asked.reachable
      ? {
          kind: 'preview',
          url: found.url,
          deploymentId: found.deployment.id,
          environment: found.deployment.environment,
          answered: found.answered,
        }
      : unreachable(request, found.deployment, asked.answered);
  };

  /** A URL from an older deployment of the same commit: worth having, second in line. */
  let older: UrlCandidate | undefined;

  for (let read = 1; read <= reads; read += 1) {
    // Each pass is one read of the deployments and of each one's statuses.
    const candidates = await readCandidates(client, request);

    /**
     * The newest deployment that decides anything: a URL now, or a build still running.
     * Taking any URL in the list instead would hand on an older deployment's host while a
     * newer one of the same commit is still building — and that newer one, on success,
     * marks the older `inactive` and takes its host away mid-run.
     */
    const decisive = candidates.find(
      (candidate) => candidate.kind === 'url' || candidate.kind === 'pending',
    );

    if (decisive === undefined) {
      const broken = candidates.find((candidate) => candidate.kind === 'failed');
      if (broken !== undefined) return failed(request, broken);
      const gone = candidates.find((candidate) => candidate.kind === 'superseded');
      if (gone !== undefined) return deactivated(request, gone.deployment);
      return noPreview(request);
    }

    if (decisive.kind === 'url') return handOn(decisive);

    older =
      candidates.find((candidate): candidate is UrlCandidate => candidate.kind === 'url') ?? older;
    pendingAnswered = decisive.answered;
    const remainingMs = waitMs - (nowMs() - startedMs);
    if (read === reads || remainingMs <= 0) break;
    await sleep(Math.min(pollEveryMs, remainingMs));
  }

  // The cap is spent with the newest deployment still building. An older URL for the same
  // commit is the honest best answer; with none, the answer is that it is not ready.
  if (older !== undefined) return handOn(older);
  return notReady(request, pendingAnswered, nowMs() - startedMs);
};

/**
 * How a resolution is written into a run (`@personavision/contract`'s `preview`): a URL, or
 * `null` and the reason there is none. The reason is never left blank, which is what the
 * contract itself refuses, so the one place the three answers narrow to the artifact's two
 * fields is here rather than in each caller.
 */
export const previewRecordOf = (resolution: PreviewResolution): Preview => {
  if (resolution.kind === 'preview') return { url: resolution.url };
  if (resolution.kind === 'no_preview') return { url: null, reason: resolution.reason };
  return { url: null, reason: `${resolution.reason} ${resolution.answered}` };
};
