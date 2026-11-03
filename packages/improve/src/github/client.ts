import { answerOf, failureKindForStatus, GitHubCallError } from './errors.js';
import { createFetchTransport } from './transport.js';
import type { GitHubHttpResponse, GitHubMethod, GitHubTransport } from './transport.js';

/**
 * `GitHubClient` — the one interface through which this product talks to GitHub.
 *
 * Path 2 reads a repository, writes one change on a branch of its own, opens a pull request,
 * reads that pull request's deployments for a preview URL, and keeps one comment on it up to
 * date (`docs/FLOW.md` section 15). Those calls are declared here, in one place, and there is
 * **no generic sender**: a module that wants to reach GitHub adds a named method to this
 * interface, in the open, rather than composing a path of its own.
 *
 * Four things are load-bearing, and all four are tested rather than documented:
 *
 * 1. **The transport is injected**, and the default is built only when no other is given, so
 *    no test in this package or in any ticket built on it needs a token or a network.
 * 2. **No call merges, closes, deletes or pushes to a default branch.** Not disabled, not
 *    guarded — absent. The App's permissions are contents read and pull requests read and
 *    write (#231), and `tests/github/surface.test.ts` asserts the public surface against an
 *    exact list, so adding a merge call fails a test. The two calls that do write take a
 *    branch, and that branch must carry {@link IMPROVE_BRANCH_PREFIX}: whatever a customer's
 *    default branch is called, it is not a branch this client can write to.
 * 3. **The installation token never leaves the closure it is read in.** It arrives as an
 *    argument from the platform (#319) — this package reads no environment variable — is
 *    resolved at call time, goes into one `Authorization` header, and is redacted out of
 *    every string this module takes from a transport or a reply before a failure quotes it.
 * 4. **A GitHub error is reported in words**: a named {@link GitHubCallError} carrying what
 *    was asked and what was answered. Nothing is smoothed into a success.
 */

/** The one repository the App is installed on, as every call names it. */
export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

/**
 * The installation token, as an argument.
 *
 * A string for a single call; a function when the caller mints tokens — an installation token
 * is good for an hour, so the platform's minting module (#319) is read **at call time**,
 * every call, rather than once when the client was built.
 */
export type GitHubTokenSource = string | (() => string | Promise<string>);

export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** How long one call may take before it is our own timeout rather than a wait. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Every branch this product writes begins with this.
 *
 * It is what makes "this client cannot push to a default branch" a property rather than a
 * promise: `main`, `master`, `trunk` or whatever a customer calls theirs does not begin with
 * it, so the two writing calls refuse before a request is built. #302's run branch is named
 * under this prefix.
 */
export const IMPROVE_BRANCH_PREFIX = 'personavision/';

export interface GitHubClientOptions {
  /** The installation token, from the platform. Never read from the environment here. */
  readonly token: GitHubTokenSource;
  /** How a request is sent. Defaults to `fetch`, built only when this is absent. */
  readonly transport?: GitHubTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** GitHub asks every client to name itself. */
  readonly userAgent?: string;
}

/** A branch and the commit it points at. */
export interface BranchHead {
  readonly branch: string;
  readonly sha: string;
}

/** A file as the repository holds it at one commit. */
export interface RepositoryFile {
  readonly path: string;
  /** The blob sha, which a write of the same file has to carry back. */
  readonly sha: string;
  readonly text: string;
}

export interface FileWritten {
  readonly path: string;
  readonly commitSha: string;
  readonly fileSha: string;
}

export interface OpenPullRequest {
  readonly title: string;
  readonly body: string;
  /** The branch the change is on. Must carry {@link IMPROVE_BRANCH_PREFIX}. */
  readonly head: string;
  /** The branch it is opened against — read only; nothing here writes to it. */
  readonly base: string;
  readonly draft?: boolean;
}

export interface PullRequestOpened {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
}

/** A deployment of one commit, which is where a preview URL comes from (#300). */
export interface Deployment {
  readonly id: number;
  readonly environment: string;
  readonly ref: string;
  readonly createdAt: string;
}

export interface DeploymentStatus {
  readonly id: number;
  readonly state: string;
  /** The URL the deployment published, when it published one. */
  readonly environmentUrl?: string;
  readonly description?: string;
  readonly createdAt: string;
}

/** A comment on a pull request, which GitHub holds as an issue comment (#301). */
export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly url: string;
  /** The login that wrote it, so a comment somebody else wrote is never edited. */
  readonly authorLogin: string;
}

/**
 * Every call this product makes to GitHub. The list is the permission surface: contents read,
 * contents write on a branch of our own, pull requests read and write, deployments read.
 */
export interface GitHubClient {
  /** The commit a branch points at, which a change branches from. */
  readonly readBranch: (repository: GitHubRepository, branch: string) => Promise<BranchHead>;
  /** A new branch at a commit. An existing name is GitHub's 422, not a force-push. */
  readonly createBranch: (
    repository: GitHubRepository,
    input: { readonly branch: string; readonly fromSha: string },
  ) => Promise<BranchHead>;
  readonly readFile: (
    repository: GitHubRepository,
    input: { readonly path: string; readonly ref: string },
  ) => Promise<RepositoryFile>;
  /** One file, on one branch of ours. `sha` is the blob being replaced. */
  readonly writeFile: (
    repository: GitHubRepository,
    input: {
      readonly path: string;
      readonly branch: string;
      readonly message: string;
      readonly text: string;
      readonly sha?: string;
    },
  ) => Promise<FileWritten>;
  readonly openPullRequest: (
    repository: GitHubRepository,
    input: OpenPullRequest,
  ) => Promise<PullRequestOpened>;
  readonly readPullRequest: (
    repository: GitHubRepository,
    pullNumber: number,
  ) => Promise<PullRequestOpened>;
  readonly readDeployments: (
    repository: GitHubRepository,
    input: { readonly sha: string },
  ) => Promise<readonly Deployment[]>;
  readonly readDeploymentStatuses: (
    repository: GitHubRepository,
    deploymentId: number,
  ) => Promise<readonly DeploymentStatus[]>;
  readonly readComments: (
    repository: GitHubRepository,
    pullNumber: number,
  ) => Promise<readonly IssueComment[]>;
  readonly postComment: (
    repository: GitHubRepository,
    pullNumber: number,
    body: string,
  ) => Promise<IssueComment>;
  readonly editComment: (
    repository: GitHubRepository,
    commentId: number,
    body: string,
  ) => Promise<IssueComment>;
}

interface Call {
  readonly method: GitHubMethod;
  readonly path: string;
  readonly body?: unknown;
}

const segment = (value: string): string => encodeURIComponent(value);

const filePath = (path: string): string => path.split('/').map(segment).join('/');

const repoPath = ({ owner, repo }: GitHubRepository, rest: string): string =>
  `/repos/${segment(owner)}/${segment(repo)}${rest}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (source: Record<string, unknown> | undefined, name: string): string | undefined =>
  typeof source?.[name] === 'string' ? (source[name] as string) : undefined;

const count = (source: Record<string, unknown> | undefined, name: string): number | undefined =>
  typeof source?.[name] === 'number' ? (source[name] as number) : undefined;

const flag = (source: Record<string, unknown> | undefined, name: string): boolean | undefined =>
  typeof source?.[name] === 'boolean' ? (source[name] as boolean) : undefined;

const unreadable = (call: Call, what: string): GitHubCallError =>
  new GitHubCallError({
    kind: 'unparseable',
    method: call.method,
    path: call.path,
    answered: `the reply carried no ${what}`,
  });

const refused = (call: Call, why: string): GitHubCallError =>
  new GitHubCallError({
    kind: 'refused',
    method: call.method,
    path: call.path,
    answered: why,
  });

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const isTimeout = (error: unknown, signal: AbortSignal): boolean => {
  if (signal.aborted) return true;
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || name === 'TimeoutError';
};

const branchHead = (branch: string, body: unknown, call: Call): BranchHead => {
  const sha = text(asRecord(asRecord(body)?.['object']), 'sha');
  if (sha === undefined) throw unreadable(call, 'commit for that branch');
  return { branch, sha };
};

const pullRequest = (body: unknown, call: Call): PullRequestOpened => {
  const reply = asRecord(body);
  const number = count(reply, 'number');
  const url = text(reply, 'html_url');
  const title = text(reply, 'title');
  const state = text(reply, 'state');
  const headBranch = text(asRecord(reply?.['head']), 'ref');
  const baseBranch = text(asRecord(reply?.['base']), 'ref');
  if (
    number === undefined ||
    url === undefined ||
    title === undefined ||
    state === undefined ||
    headBranch === undefined ||
    baseBranch === undefined
  ) {
    throw unreadable(call, 'pull request');
  }
  return {
    number,
    url,
    title,
    state,
    headBranch,
    baseBranch,
    draft: flag(reply, 'draft') ?? false,
  };
};

const comment = (body: unknown, call: Call): IssueComment => {
  const reply = asRecord(body);
  const id = count(reply, 'id');
  const written = text(reply, 'body');
  const url = text(reply, 'html_url');
  const authorLogin = text(asRecord(reply?.['user']), 'login');
  if (id === undefined || written === undefined || url === undefined || authorLogin === undefined) {
    throw unreadable(call, 'comment');
  }
  return { id, body: written, url, authorLogin };
};

const list = (body: unknown, call: Call, what: string): readonly unknown[] => {
  if (!Array.isArray(body)) throw unreadable(call, what);
  return body;
};

/**
 * The client. `token` is resolved inside each call and is in scope nowhere else: it reaches
 * one header and the redaction of what comes back, and no other line of this module.
 */
export const createGitHubClient = (options: GitHubClientOptions): GitHubClient => {
  const transport = options.transport ?? createFetchTransport();
  const baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? 'personavision';
  const token = options.token;

  const send = async (call: Call): Promise<unknown> => {
    const secret = typeof token === 'string' ? token : await token();
    /** The last line of defence: a reply or a transport error is not ours to trust. */
    const hide = (value: string): string =>
      secret === '' ? value : value.split(secret).join('[redacted]');
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${secret}`,
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
      ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
    };

    let response: GitHubHttpResponse;
    try {
      response = await transport({
        method: call.method,
        path: call.path,
        url: `${baseUrl}${call.path}`,
        headers,
        ...(call.body === undefined ? {} : { body: call.body }),
        signal,
      });
    } catch (error) {
      throw new GitHubCallError({
        kind: isTimeout(error, signal) ? 'timeout' : 'transport',
        method: call.method,
        path: call.path,
        answered: hide(messageOf(error)),
      });
    }

    if (response.status < 200 || response.status >= 300) {
      const answered = hide(answerOf(response.body));
      throw new GitHubCallError({
        kind: failureKindForStatus(response.status, response.headers, answered),
        method: call.method,
        path: call.path,
        status: response.status,
        answered,
      });
    }
    return response.body;
  };

  const ownBranch = (call: Call, branch: string): void => {
    if (branch.startsWith(IMPROVE_BRANCH_PREFIX)) return;
    throw refused(
      call,
      `${branch} is not a branch this product writes: a write names a branch under ${IMPROVE_BRANCH_PREFIX}`,
    );
  };

  return {
    readBranch: async (repository, branch) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(repository, `/git/ref/heads/${filePath(branch)}`),
      };
      return branchHead(branch, await send(call), call);
    },

    createBranch: async (repository, input) => {
      const call: Call = {
        method: 'POST',
        path: repoPath(repository, '/git/refs'),
        body: { ref: `refs/heads/${input.branch}`, sha: input.fromSha },
      };
      ownBranch(call, input.branch);
      return branchHead(input.branch, await send(call), call);
    },

    readFile: async (repository, input) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(
          repository,
          `/contents/${filePath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
        ),
      };
      const reply = asRecord(await send(call));
      const sha = text(reply, 'sha');
      const content = text(reply, 'content');
      if (sha === undefined || content === undefined) throw unreadable(call, 'file');
      const encoding = text(reply, 'encoding') ?? 'base64';
      if (encoding !== 'base64') throw unreadable(call, `file this client can read (${encoding})`);
      return { path: input.path, sha, text: Buffer.from(content, 'base64').toString('utf8') };
    },

    writeFile: async (repository, input) => {
      const call: Call = {
        method: 'PUT',
        path: repoPath(repository, `/contents/${filePath(input.path)}`),
        body: {
          message: input.message,
          content: Buffer.from(input.text, 'utf8').toString('base64'),
          branch: input.branch,
          ...(input.sha === undefined ? {} : { sha: input.sha }),
        },
      };
      ownBranch(call, input.branch);
      const reply = asRecord(await send(call));
      const commitSha = text(asRecord(reply?.['commit']), 'sha');
      const fileSha = text(asRecord(reply?.['content']), 'sha');
      if (commitSha === undefined || fileSha === undefined) throw unreadable(call, 'commit');
      return { path: input.path, commitSha, fileSha };
    },

    openPullRequest: async (repository, input) => {
      const call: Call = {
        method: 'POST',
        path: repoPath(repository, '/pulls'),
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft ?? false,
        },
      };
      ownBranch(call, input.head);
      return pullRequest(await send(call), call);
    },

    readPullRequest: async (repository, pullNumber) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(repository, `/pulls/${String(pullNumber)}`),
      };
      return pullRequest(await send(call), call);
    },

    readDeployments: async (repository, input) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(
          repository,
          `/deployments?sha=${encodeURIComponent(input.sha)}&per_page=100`,
        ),
      };
      return list(await send(call), call, 'deployments').map((entry) => {
        const record = asRecord(entry);
        const id = count(record, 'id');
        const environment = text(record, 'environment');
        const ref = text(record, 'ref');
        const createdAt = text(record, 'created_at');
        if (id === undefined || environment === undefined || ref === undefined) {
          throw unreadable(call, 'deployment');
        }
        return { id, environment, ref, createdAt: createdAt ?? '' };
      });
    },

    readDeploymentStatuses: async (repository, deploymentId) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(repository, `/deployments/${String(deploymentId)}/statuses?per_page=100`),
      };
      return list(await send(call), call, 'deployment statuses').map((entry) => {
        const record = asRecord(entry);
        const id = count(record, 'id');
        const state = text(record, 'state');
        if (id === undefined || state === undefined) throw unreadable(call, 'deployment status');
        const environmentUrl = text(record, 'environment_url');
        const description = text(record, 'description');
        return {
          id,
          state,
          ...(environmentUrl === undefined ? {} : { environmentUrl }),
          ...(description === undefined ? {} : { description }),
          createdAt: text(record, 'created_at') ?? '',
        };
      });
    },

    readComments: async (repository, pullNumber) => {
      const call: Call = {
        method: 'GET',
        path: repoPath(repository, `/issues/${String(pullNumber)}/comments?per_page=100`),
      };
      return list(await send(call), call, 'comments').map((entry) => comment(entry, call));
    },

    postComment: async (repository, pullNumber, body) => {
      const call: Call = {
        method: 'POST',
        path: repoPath(repository, `/issues/${String(pullNumber)}/comments`),
        body: { body },
      };
      return comment(await send(call), call);
    },

    editComment: async (repository, commentId, body) => {
      const call: Call = {
        method: 'PATCH',
        path: repoPath(repository, `/issues/comments/${String(commentId)}`),
        body: { body },
      };
      return comment(await send(call), call);
    },
  };
};
