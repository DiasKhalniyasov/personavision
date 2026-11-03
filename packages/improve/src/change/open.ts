import type { Change, Improve, Recommendation } from '@personavision/contract';
import { applyUnifiedPatch } from '@personavision/provider';
import type { ChangeFile } from '@personavision/provider';
import { SIMULATED_LABEL } from '../comment/body.js';
import { GitHubCallError } from '../github/errors.js';
import { IMPROVE_BRANCH_PREFIX } from '../github/client.js';
import type { GitHubClient, GitHubRepository } from '../github/client.js';

/**
 * The change, opened as a pull request — **or refused**.
 *
 * #263 decided it: from its own ranked recommendations and the files it was given, Muse
 * Wonder answers one targeted change — the recommendation it answers, the file it touches,
 * the patch, and the pull request's title and body. It talks to nothing. This module is what
 * happens next (`docs/FLOW.md` section 15, point 2): the change is checked against the
 * recommendation it claims, the file is read from the connected repository, the patch is
 * applied on a branch of our own, the pull request is opened, and what was opened is handed
 * back for the run to record.
 *
 * **The refusal is the point.** The whole before/after rests on the change being one change:
 * a pull request that also tidied three other files produces a comparison that means
 * nothing, and it has been written into somebody's repository. So every check happens before
 * anything is created, and a refusal says which file was not named.
 *
 * Five things are load-bearing, and all five are tested rather than documented:
 *
 * 1. **One recommendation, one file, one commit, one pull request.** A change naming a file
 *    its recommendation was not given, or a patch touching a path the change did not
 *    declare, is refused with the path named and nothing is created.
 * 2. **The file is read from the repository at the commit the branch starts from**, and the
 *    patch is applied to *that* text. #263 proves the patch applies to the file it was
 *    handed; this proves it applies to the file the repository actually holds, which is not
 *    the same claim — the owner may have edited the file since the run read it.
 * 3. **The branch is new and named for the run**, so two runs never collide, and a branch of
 *    that name that already exists is a refusal rather than a force-push.
 * 4. **It never merges.** The client has no merge call (`tests/github/surface.test.ts`
 *    asserts that on its public surface) and this module adds no second path to one: it
 *    opens the pull request and stops.
 * 5. **The pull-request body is #263's, posted unchanged** — the recommendation, its
 *    evidence and the simulated label. A body arriving without the label is refused: a pull
 *    request is the one place this product's numbers reach a reader with no screen in front
 *    of them.
 *
 * A GitHub call that fails is **not** a refusal: the App removed from the repository, an
 * archived repository or a protected base branch throw {@link GitHubCallError}, which names
 * what was asked and what was answered, because "we could not ask" is a different thing
 * from "we would not do it". Nothing partial is handed back either way — a caller records
 * what this answers, and it answers a whole pull request or none.
 */

/** The pull request as it was opened, in the words the run records and the screen prints. */
export interface PullRequestRecord {
  /** `owner/name`, as the artifact spells a repository. */
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  /** GitHub's own word for it — `open`, or `draft` where it was opened as one. */
  readonly state: string;
}

/**
 * What the change became. Everything `#screen-improve`'s `.prbox` draws is here, so the
 * screen reads a record and composes nothing: the title and the `clipforge/web #482 · open`
 * tag from {@link PullRequestRecord}, the sentence naming the recommendation from
 * {@link ChangeOpened.recommendationSentence}, and the `.diff` block from
 * {@link ChangeOpened.diff}.
 */
export interface ChangeOpened {
  readonly kind: 'opened';
  readonly pullRequest: PullRequestRecord;
  /** The recommendation this change answers, by its id in `recommendations.json`. */
  readonly recommendationId: string;
  /** That recommendation's one sentence, as the screen prints it under the title. */
  readonly recommendationSentence: string;
  readonly changedFile: string;
  /** The patch, as the screen prints it and as #263 wrote it. */
  readonly diff: string;
  /** The branch the change is on, named for the run. */
  readonly branch: string;
  /** The commit the branch started from: the content the patch was applied to. */
  readonly baseSha: string;
  /** The commit the change is in, which is where #300 reads the preview's deployments. */
  readonly headSha: string;
}

/**
 * Why no pull request was opened, in the sentence `#screen-improve` prints in place of the
 * box. Nothing was created: no branch, no commit, no pull request.
 */
export interface ChangeRefused {
  readonly kind: 'refused';
  readonly reason: string;
}

export type ChangeResult = ChangeOpened | ChangeRefused;

/** Everything opening one change takes. */
export interface ChangeRequest {
  /** The connected repository the App is installed on. */
  readonly repository: GitHubRepository;
  /** The run this change belongs to: the branch is named for it. */
  readonly runId: string;
  /**
   * The branch the pull request is opened against — the repository's default branch, as the
   * installation record holds it. **Read only**: it is the base of a pull request and the
   * commit a branch of ours starts from, and nothing here writes to it.
   */
  readonly baseBranch: string;
  /** The change #263 decided, in the contract's shape. */
  readonly change: Change;
  /** The recommendation it claims to answer, from the run's own `recommendations.json`. */
  readonly recommendation: Recommendation;
  /**
   * The files that recommendation was offered — the same files #263's decision was handed.
   * This is what "a file the recommendation names" means: a change may only touch a file
   * somebody put in front of it. Only the paths are read here; the text the patch is applied
   * to comes from the repository.
   */
  readonly files: readonly ChangeFile[];
  /** Opened as a draft where the caller asks for one. It is never merged either way. */
  readonly draft?: boolean;
}

/** The part of a run's `improve` block this module can answer for. */
export type ChangeRecord = Pick<Improve, 'recommendationId' | 'changedFile' | 'pullRequest'>;

const refused = (reason: string): ChangeRefused => ({ kind: 'refused', reason });

/**
 * What may be a run id here: it becomes a git ref and a URL path segment, so the characters
 * are held to the ones both read the same way. A run id outside them is refused rather than
 * rewritten — a branch named for a run the user cannot recognise is worse than a sentence.
 */
const PLAIN = /^[A-Za-z0-9._-]+$/;

/** The branch one run's change is written on. Two runs never collide, because run ids do not. */
export const branchForRun = (runId: string): string => `${IMPROVE_BRANCH_PREFIX}${runId}`;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Everything checked before a single call is made, so that a refusal is a refusal and not a
 * half-written branch. The patch itself is checked against the repository's own content
 * below, which needs two reads — reads, and nothing created.
 */
const refusalBeforeAnything = (request: ChangeRequest): ChangeRefused | undefined => {
  const { change, recommendation } = request;

  if (change.recommendationId !== recommendation.id) {
    return refused(
      `this change says it answers recommendation ${change.recommendationId} and the recommendation it was given is ${recommendation.id}: a change is opened against the recommendation it names, never against another one`,
    );
  }

  const offered = request.files.map((file) => file.path);
  if (!offered.includes(change.changedFile)) {
    return refused(
      `this change touches "${change.changedFile}" and recommendation ${recommendation.id} names ${offered.length === 0 ? 'no file at all' : offered.map((path) => `"${path}"`).join(', ')}: one targeted change touches one file its recommendation named, so nothing was opened`,
    );
  }

  if (!change.pullRequest.body.toLowerCase().includes(SIMULATED_LABEL)) {
    return refused(
      `this pull request's body does not say that the numbers behind it are ${SIMULATED_LABEL}, and a pull request is the one place this product's figures reach a reader with no screen in front of them: nothing was opened`,
    );
  }

  if (!PLAIN.test(request.runId)) {
    return refused(
      `"${request.runId}" is not a run id a branch can be named for: a branch of ours is ${IMPROVE_BRANCH_PREFIX} and the run's own id, in letters, digits, dots, dashes and underscores`,
    );
  }

  const { owner, repo } = request.repository;
  if (!PLAIN.test(owner) || !PLAIN.test(repo)) {
    return refused(
      `"${owner}/${repo}" is not a repository as GitHub spells one, so a pull request opened on it could not be recorded: nothing was opened`,
    );
  }

  return undefined;
};

/**
 * Open the change as one pull request on the connected repository, or refuse it.
 *
 * The calls, in order and in full: read the base branch's commit, read the changed file at
 * that commit, create the run's branch there, write the patched file on it, open the pull
 * request. Five calls, one commit, one pull request, and no sixth path.
 *
 * Throws what the client throws. A {@link GitHubCallError} means GitHub did not answer what
 * was asked, which the caller reports in those words; the one exception is the 422 on
 * creating a branch that already exists, which is this product's own refusal and comes back
 * as one.
 */
export const openChange = async (
  client: GitHubClient,
  request: ChangeRequest,
): Promise<ChangeResult> => {
  const early = refusalBeforeAnything(request);
  if (early !== undefined) return early;

  const { change, recommendation, repository } = request;
  const branch = branchForRun(request.runId);

  // The commit the branch starts from, and the file as the repository holds it *there*: the
  // patch is applied to the repository's own content and not to the copy the run read.
  const base = await client.readBranch(repository, request.baseBranch);
  const file = await client.readFile(repository, { path: change.changedFile, ref: base.sha });

  let patched: string;
  try {
    patched = applyUnifiedPatch({ path: file.path, text: file.text }, change.patch);
  } catch (error) {
    return refused(
      `this change's patch does not apply to "${change.changedFile}" as ${repository.owner}/${repository.repo} holds it at ${base.sha}: ${reasonOf(error)}. Nothing was opened.`,
    );
  }

  try {
    await client.createBranch(repository, { branch, fromSha: base.sha });
  } catch (error) {
    if (error instanceof GitHubCallError && error.kind === 'unprocessable') {
      return refused(
        `the branch ${branch} already exists on ${repository.owner}/${repository.repo}, and this run writes a branch of its own rather than over one that is there: GitHub answered "${error.answered}". Nothing was opened and nothing was overwritten.`,
      );
    }
    throw error;
  }

  const written = await client.writeFile(repository, {
    path: change.changedFile,
    branch,
    message: change.pullRequest.title,
    text: patched,
    sha: file.sha,
  });

  const opened = await client.openPullRequest(repository, {
    title: change.pullRequest.title,
    // #263's body, unchanged: the recommendation, its evidence and the simulated label.
    body: change.pullRequest.body,
    head: branch,
    base: request.baseBranch,
    ...(request.draft === undefined ? {} : { draft: request.draft }),
  });

  return {
    kind: 'opened',
    pullRequest: {
      repository: `${repository.owner}/${repository.repo}`,
      number: opened.number,
      url: opened.url,
      title: opened.title,
      state: opened.draft ? 'draft' : opened.state,
    },
    recommendationId: recommendation.id,
    recommendationSentence: recommendation.sentence,
    changedFile: change.changedFile,
    diff: change.patch,
    branch,
    baseSha: base.sha,
    headSha: written.commitSha,
  };
};

/**
 * What a run records of an opened change, in the contract's `improve` block: the
 * recommendation, the file and the pull request. The rest of that block — the preview
 * (#300), the two variant ids and the holdout (#303) — belongs to the run that tested it,
 * and nothing here is recomputed from GitHub later.
 */
export const changeRecordOf = (opened: ChangeOpened): ChangeRecord => ({
  recommendationId: opened.recommendationId,
  changedFile: opened.changedFile,
  pullRequest: {
    repository: opened.pullRequest.repository,
    number: opened.pullRequest.number,
    url: opened.pullRequest.url,
    title: opened.pullRequest.title,
  },
});
