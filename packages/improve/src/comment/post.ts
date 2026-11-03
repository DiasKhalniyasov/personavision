import type { GitHubClient, GitHubRepository, IssueComment } from '../github/client.js';
import { COMMENT_MARKER, commentBody } from './body.js';
import type { CommentInput, CommentRefused } from './body.js';

/**
 * One comment per pull request, updated rather than repeated.
 *
 * A pull request that accumulates five comments as the owner pushes is noise, and the last
 * one is the only one that is true (`docs/FLOW.md` section 15, point 6). So a re-run finds
 * the comment this product wrote and **edits** it; there is no second create, and no
 * sweeping up of old ones afterwards.
 *
 * Finding it is by this product's own hidden marker and nothing else — not by the author,
 * not by the first comment on the pull request, not by anything a reader could reproduce
 * by writing a comment of their own. A comment that does not carry the marker is somebody
 * else's writing and is never edited, whoever wrote it and whatever it says.
 *
 * Everything here goes through the one GitHub client seam, so a test runs over the recorded
 * transport with no token and no network.
 */

export interface RunCommentPosted {
  readonly kind: 'posted';
  readonly comment: IssueComment;
}

/** The comment this product wrote earlier, now carrying this run's figures. */
export interface RunCommentUpdated {
  readonly kind: 'updated';
  readonly comment: IssueComment;
}

export type RunCommentResult = RunCommentPosted | RunCommentUpdated | CommentRefused;

/**
 * The comment this product wrote, by its marker. `undefined` when the pull request carries
 * none of ours — which is every pull request before the first run and any pull request
 * whose comments are all somebody else's.
 */
export const findRunComment = (comments: readonly IssueComment[]): IssueComment | undefined =>
  comments.find((entry) => entry.body.includes(COMMENT_MARKER));

/** `owner/name`, as the run records a repository and as the client seam takes one. */
const repositoryOf = (spelling: string): GitHubRepository => {
  const [owner = '', repo = ''] = spelling.split('/');
  return { owner, repo };
};

/**
 * Post this run's before/after on the pull request it tested, or edit the comment already
 * there. Answers {@link CommentRefused} and makes no call at all when there is no comment
 * to write — a run that tested no change, or a change that was never served anywhere.
 *
 * Throws what the client throws: a GitHub call that failed is not an answer about comments.
 */
export const postRunComment = async (
  client: GitHubClient,
  input: CommentInput,
): Promise<RunCommentResult> => {
  const draft = commentBody(input);
  if (draft.kind === 'refused') return draft;

  const repository = repositoryOf(draft.pullRequest.repository);
  const pullNumber = draft.pullRequest.number;
  const ours = findRunComment(await client.readComments(repository, pullNumber));

  return ours === undefined
    ? { kind: 'posted', comment: await client.postComment(repository, pullNumber, draft.text) }
    : { kind: 'updated', comment: await client.editComment(repository, ours.id, draft.text) };
};
