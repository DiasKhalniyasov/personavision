import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  createRecordedTransport,
  GitHubCallError,
  IMPROVE_BRANCH_PREFIX,
} from '../../src/index.js';
import type {
  GitHubHttpRequest,
  GitHubRepository,
  GitHubTransport,
  RecordedExchange,
} from '../../src/index.js';

/**
 * Not a GitHub-shaped token on purpose: every test here runs with no App, no installation and
 * no network, and a string that looked like a credential would be one more thing a scanner
 * has to be told about.
 */
const TOKEN = 'installation-token-for-tests-0123456789';

const REPOSITORY: GitHubRepository = { owner: 'clipforge', repo: 'web' };

const BRANCH = `${IMPROVE_BRANCH_PREFIX}2026-11-03-1402-clipforge`;

const PULL_REQUEST_REPLY = {
  number: 482,
  html_url: 'https://github.com/clipforge/web/pull/482',
  title: 'Move the plan picker above the fold',
  state: 'open',
  draft: false,
  head: { ref: BRANCH },
  base: { ref: 'main' },
};

const OPEN = {
  title: 'Move the plan picker above the fold',
  body: 'From recommendation R-02. The numbers behind it are **simulated**.',
  head: BRANCH,
  base: 'main',
};

/** The pull-request call and its reply, which most tests here only need once. */
const opened: RecordedExchange = {
  method: 'POST',
  path: '/repos/clipforge/web/pulls',
  reply: { status: 201, body: PULL_REQUEST_REPLY },
};

const clientOver = (exchanges: readonly RecordedExchange[]) => {
  const recorded = createRecordedTransport(exchanges);
  return { recorded, client: createGitHubClient({ token: TOKEN, transport: recorded.transport }) };
};

/** A transport that hands the request straight back, so a test can read its headers. */
const capturing = (): { seen: GitHubHttpRequest[]; transport: GitHubTransport } => {
  const seen: GitHubHttpRequest[] = [];
  return {
    seen,
    transport: async (request) => {
      seen.push(request);
      return { status: 201, headers: {}, body: PULL_REQUEST_REPLY };
    },
  };
};

const thrown = async (call: () => Promise<unknown>): Promise<GitHubCallError> => {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubCallError);
    return error as GitHubCallError;
  }
  throw new Error('the call was expected to fail and did not');
};

beforeEach(() => {
  // Nothing in this package may reach the network. A test that did would call this.
  vi.stubGlobal('fetch', () => {
    throw new Error('a test reached the network');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('opening a pull request', () => {
  it('is asserted on the request made — method, path and body', async () => {
    const { recorded, client } = clientOver([opened]);

    await client.openPullRequest(REPOSITORY, OPEN);

    expect(recorded.requests).toEqual([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        url: 'https://api.github.com/repos/clipforge/web/pulls',
        body: {
          title: OPEN.title,
          body: OPEN.body,
          head: BRANCH,
          base: 'main',
          draft: false,
        },
      },
    ]);
  });

  it('reads the pull request GitHub opened back, field for field', async () => {
    const { client } = clientOver([opened]);

    await expect(client.openPullRequest(REPOSITORY, OPEN)).resolves.toEqual({
      number: 482,
      url: 'https://github.com/clipforge/web/pull/482',
      title: 'Move the plan picker above the fold',
      state: 'open',
      headBranch: BRANCH,
      baseBranch: 'main',
      draft: false,
    });
  });

  it('sends the installation token in one Authorization header, and nothing else carries it', async () => {
    const { seen, transport } = capturing();
    const client = createGitHubClient({ token: TOKEN, transport });

    await client.openPullRequest(REPOSITORY, OPEN);

    const request = seen[0];
    expect(request?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers['accept']).toBe('application/vnd.github+json');
    expect(request?.headers['x-github-api-version']).toBe('2022-11-28');
    const elsewhere = { ...request, headers: undefined };
    expect(JSON.stringify(elsewhere)).not.toContain(TOKEN);
  });

  it('reads the token at call time, so a rotated installation token is the one that is used', async () => {
    const tokens = ['first-token-0123456789', 'second-token-0123456789'];
    const { seen, transport } = capturing();
    const client = createGitHubClient({ token: () => tokens.shift() ?? '', transport });

    await client.openPullRequest(REPOSITORY, OPEN);
    await client.openPullRequest(REPOSITORY, OPEN);

    expect(seen.map((request) => request.headers['authorization'])).toEqual([
      'Bearer first-token-0123456789',
      'Bearer second-token-0123456789',
    ]);
  });

  it('builds no default transport when one is given, so no test can reach the network', async () => {
    const { client } = clientOver([opened]);

    await expect(client.openPullRequest(REPOSITORY, OPEN)).resolves.toMatchObject({ number: 482 });
    // `fetch` is stubbed to throw for every test in this file, and no test has tripped it.
  });

  it('refuses a head branch that is not one of ours, before any request is made', async () => {
    const { recorded, client } = clientOver([opened]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, { ...OPEN, head: 'main' }));

    expect(error.kind).toBe('refused');
    expect(error.message).toContain('main is not a branch this product writes');
    expect(recorded.requests).toEqual([]);
  });
});

describe('a GitHub error is reported in words', () => {
  it('names a 403 on a repository the App is not installed on', async () => {
    const { client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        reply: {
          status: 403,
          body: { message: 'Resource not accessible by integration' },
        },
      },
    ]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(error.method).toBe('POST');
    expect(error.path).toBe('/repos/clipforge/web/pulls');
    expect(error.answered).toBe('Resource not accessible by integration');
    expect(error.message).toBe(
      'GitHub answered 403 to POST /repos/clipforge/web/pulls — forbidden: Resource not accessible by integration',
    );
  });

  it('names a 422 on a pull request that already exists, with what GitHub said about it', async () => {
    const { client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        reply: {
          status: 422,
          body: {
            message: 'Validation Failed',
            errors: [{ message: 'A pull request already exists for clipforge:personavision/x.' }],
          },
        },
      },
    ]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('unprocessable');
    expect(error.status).toBe(422);
    expect(error.answered).toBe(
      'Validation Failed; A pull request already exists for clipforge:personavision/x.',
    );
  });

  it('tells a rate limit apart from a plain 403, by the quota header', async () => {
    const { client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        reply: {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
          body: { message: 'API rate limit exceeded for installation ID 1.' },
        },
      },
    ]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('rate_limit');
    expect(error.answered).toContain('API rate limit exceeded');
  });

  it('names a 429 as a rate limit too', async () => {
    const { client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        reply: { status: 429, body: { message: 'You have exceeded a secondary rate limit.' } },
      },
    ]);

    expect((await thrown(() => client.openPullRequest(REPOSITORY, OPEN))).kind).toBe('rate_limit');
  });

  it('names a transport that never reached GitHub', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      transport: () => Promise.reject(new TypeError('fetch failed')),
    });

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('transport');
    expect(error.answered).toBe('TypeError: fetch failed');
  });

  it('names our own timeout as a timeout, not as a dropped connection', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      timeoutMs: 1,
      transport: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });

    expect((await thrown(() => client.openPullRequest(REPOSITORY, OPEN))).kind).toBe('timeout');
  });

  it('never smooths a 2xx reply it cannot read into a success', async () => {
    const { client } = clientOver([
      { method: 'POST', path: '/repos/clipforge/web/pulls', reply: { status: 201, body: {} } },
    ]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('unparseable');
    expect(error.answered).toBe('the reply carried no pull request');
  });
});

describe('the installation token never leaves the closure it is read in', () => {
  /** Every string this module could have put a token into, on every path. */
  const everythingEmitted = (error: unknown, recorded: unknown, result: unknown): string =>
    [
      JSON.stringify(recorded),
      JSON.stringify(result),
      error instanceof Error ? `${error.message}${error.stack ?? ''}` : '',
      JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
    ].join('\n');

  beforeEach(() => {
    // A token in the environment as well as in the arguments: this package reads no
    // environment variable, and the assertions below hold either way.
    vi.stubEnv('GITHUB_INSTALLATION_TOKEN', TOKEN);
  });

  it('appears in no recorded request, no result and no log line on the happy path', async () => {
    const logs: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...written: unknown[]) => {
        logs.push(...written);
      });
    }
    const { recorded, client } = clientOver([opened]);

    const result = await client.openPullRequest(REPOSITORY, OPEN);

    expect(logs).toEqual([]);
    expect(everythingEmitted(undefined, recorded.requests, result)).not.toContain(TOKEN);
  });

  it('is redacted out of a reply that quotes it back', async () => {
    const { recorded, client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/pulls',
        reply: { status: 401, body: { message: `Bad credentials: Bearer ${TOKEN}` } },
      },
    ]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.kind).toBe('unauthorized');
    expect(error.answered).toBe('Bad credentials: Bearer [redacted]');
    expect(everythingEmitted(error, recorded.requests, undefined)).not.toContain(TOKEN);
  });

  it('is redacted out of an error a transport throws with it inside', async () => {
    const client = createGitHubClient({
      token: TOKEN,
      transport: () => Promise.reject(new Error(`proxy rejected authorization: Bearer ${TOKEN}`)),
    });

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    expect(error.answered).toBe('Error: proxy rejected authorization: Bearer [redacted]');
    expect(everythingEmitted(error, undefined, undefined)).not.toContain(TOKEN);
  });

  it('is written to no file, because this package touches no file system', () => {
    const directory = fileURLToPath(new URL('../../src/github/', import.meta.url));
    const sources = readdirSync(directory).filter((entry) => entry.endsWith('.ts'));

    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      const source = readFileSync(`${directory}${entry}`, 'utf8');
      expect(source, entry).not.toMatch(/from\s+'node:fs(?:\/promises)?'/);
      expect(source, entry).not.toMatch(/\bconsole\.\w+\(/);
    }
  });
});

describe('the recorded transport the tickets after this one test against', () => {
  it('fails loudly on a call no test recorded, rather than answering nothing', async () => {
    const { recorded, client } = clientOver([]);

    const error = await thrown(() => client.openPullRequest(REPOSITORY, OPEN));

    // The client knows nothing of this helper: an unrecorded call is a transport that did
    // not answer, and what it did not answer is named in words.
    expect(error.kind).toBe('transport');
    expect(error.answered).toBe(
      'UnrecordedGitHubCallError: no recorded reply for POST /repos/clipforge/web/pulls',
    );
    expect(recorded.requests).toHaveLength(1);
  });

  it('answers two turns of the same call in the order they were stated', async () => {
    const { recorded, client } = clientOver([
      {
        method: 'GET',
        path: '/repos/clipforge/web/issues/482/comments?per_page=100',
        reply: { body: [] },
      },
      {
        method: 'GET',
        path: '/repos/clipforge/web/issues/482/comments?per_page=100',
        reply: {
          body: [
            {
              id: 9,
              body: 'simulated',
              html_url: 'https://github.com/clipforge/web/pull/482#issuecomment-9',
              user: { login: 'personavision[bot]' },
            },
          ],
        },
      },
    ]);

    await expect(client.readComments(REPOSITORY, 482)).resolves.toEqual([]);
    await expect(client.readComments(REPOSITORY, 482)).resolves.toHaveLength(1);
    expect(recorded.requests).toHaveLength(2);
  });

  it('keeps no headers, so a printed transcript cannot carry a credential', async () => {
    const { recorded, client } = clientOver([opened]);

    await client.openPullRequest(REPOSITORY, OPEN);

    expect(recorded.requests[0]).not.toHaveProperty('headers');
  });
});

describe('the calls the tickets after this one read through', () => {
  it('reads a branch head, a file and a pull request, each on the documented path', async () => {
    const { recorded, client } = clientOver([
      {
        method: 'GET',
        path: '/repos/clipforge/web/git/ref/heads/main',
        reply: { body: { ref: 'refs/heads/main', object: { sha: 'base-sha' } } },
      },
      {
        method: 'GET',
        path: '/repos/clipforge/web/contents/src/pricing.tsx?ref=base-sha',
        reply: {
          body: {
            sha: 'blob-sha',
            encoding: 'base64',
            content: Buffer.from('<h1>Pricing</h1>', 'utf8').toString('base64'),
          },
        },
      },
      {
        method: 'POST',
        path: '/repos/clipforge/web/git/refs',
        reply: { status: 201, body: { ref: `refs/heads/${BRANCH}`, object: { sha: 'base-sha' } } },
      },
      {
        method: 'PUT',
        path: '/repos/clipforge/web/contents/src/pricing.tsx',
        reply: { body: { commit: { sha: 'commit-sha' }, content: { sha: 'new-blob-sha' } } },
      },
    ]);

    await expect(client.readBranch(REPOSITORY, 'main')).resolves.toEqual({
      branch: 'main',
      sha: 'base-sha',
    });
    await expect(
      client.readFile(REPOSITORY, { path: 'src/pricing.tsx', ref: 'base-sha' }),
    ).resolves.toEqual({ path: 'src/pricing.tsx', sha: 'blob-sha', text: '<h1>Pricing</h1>' });
    await expect(
      client.createBranch(REPOSITORY, { branch: BRANCH, fromSha: 'base-sha' }),
    ).resolves.toEqual({ branch: BRANCH, sha: 'base-sha' });
    await expect(
      client.writeFile(REPOSITORY, {
        path: 'src/pricing.tsx',
        branch: BRANCH,
        message: 'Move the plan picker above the fold',
        text: '<h1>Plans</h1>',
      }),
    ).resolves.toEqual({
      path: 'src/pricing.tsx',
      commitSha: 'commit-sha',
      fileSha: 'new-blob-sha',
    });

    expect(recorded.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /repos/clipforge/web/git/ref/heads/main',
      'GET /repos/clipforge/web/contents/src/pricing.tsx?ref=base-sha',
      'POST /repos/clipforge/web/git/refs',
      'PUT /repos/clipforge/web/contents/src/pricing.tsx',
    ]);
  });

  it('refuses a write to a branch that is not ours, whatever a default branch is called', async () => {
    const { recorded, client } = clientOver([]);

    for (const branch of ['main', 'master', 'trunk', 'release']) {
      const write = await thrown(() =>
        client.writeFile(REPOSITORY, {
          path: 'src/pricing.tsx',
          branch,
          message: 'no',
          text: 'no',
        }),
      );
      const create = await thrown(() =>
        client.createBranch(REPOSITORY, { branch, fromSha: 'base-sha' }),
      );
      expect([write.kind, create.kind]).toEqual(['refused', 'refused']);
    }

    expect(recorded.requests).toEqual([]);
  });

  it('reads a pull request deployments and its statuses, which the preview is resolved from', async () => {
    const { client } = clientOver([
      {
        method: 'GET',
        path: '/repos/clipforge/web/deployments?sha=head-sha&per_page=100',
        reply: {
          body: [
            { id: 7, environment: 'Preview', ref: BRANCH, created_at: '2026-11-03T14:02:00Z' },
          ],
        },
      },
      {
        method: 'GET',
        path: '/repos/clipforge/web/deployments/7/statuses?per_page=100',
        reply: {
          body: [
            {
              id: 11,
              state: 'success',
              environment_url: 'https://web-pr-482.example.app',
              description: 'Deployment has completed',
              created_at: '2026-11-03T14:05:00Z',
            },
          ],
        },
      },
    ]);

    await expect(client.readDeployments(REPOSITORY, { sha: 'head-sha' })).resolves.toEqual([
      { id: 7, environment: 'Preview', ref: BRANCH, createdAt: '2026-11-03T14:02:00Z' },
    ]);
    await expect(client.readDeploymentStatuses(REPOSITORY, 7)).resolves.toEqual([
      {
        id: 11,
        state: 'success',
        environmentUrl: 'https://web-pr-482.example.app',
        description: 'Deployment has completed',
        createdAt: '2026-11-03T14:05:00Z',
      },
    ]);
  });

  it('posts a comment and edits that one, which is how a re-run repeats nothing', async () => {
    const { recorded, client } = clientOver([
      {
        method: 'POST',
        path: '/repos/clipforge/web/issues/482/comments',
        reply: {
          status: 201,
          body: {
            id: 9,
            body: 'first',
            html_url: 'https://github.com/clipforge/web/pull/482#issuecomment-9',
            user: { login: 'personavision[bot]' },
          },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/clipforge/web/issues/comments/9',
        reply: {
          body: {
            id: 9,
            body: 'second',
            html_url: 'https://github.com/clipforge/web/pull/482#issuecomment-9',
            user: { login: 'personavision[bot]' },
          },
        },
      },
    ]);

    const posted = await client.postComment(REPOSITORY, 482, 'first');
    await client.editComment(REPOSITORY, posted.id, 'second');

    expect(recorded.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      {
        method: 'POST',
        path: '/repos/clipforge/web/issues/482/comments',
        body: { body: 'first' },
      },
      {
        method: 'PATCH',
        path: '/repos/clipforge/web/issues/comments/9',
        body: { body: 'second' },
      },
    ]);
  });
});
