import { improveSchema } from '@personavision/contract';
import type { Change, Improve, Recommendation } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  branchForRun,
  changeRecordOf,
  createGitHubClient,
  createRecordedTransport,
  GitHubCallError,
  openChange,
} from '../../src/index.js';
import type {
  ChangeOpened,
  ChangeRequest,
  ChangeResult,
  GitHubRepository,
  RecordedExchange,
} from '../../src/index.js';

/**
 * The change opened as a pull request, or refused for touching more than its recommendation
 * (#302).
 *
 * Every test here runs over the recorded transport with no token that is a token, no App and
 * no network: `fetch` is stubbed to throw, so a call that left this file would fail rather
 * than reach GitHub. What each test asserts is **the requests that were made** — a refusal
 * is only a refusal if nothing was created, and that is a statement about the transcript
 * rather than about the value handed back.
 */

const TOKEN = 'installation-token-for-tests-0123456789';

const REPOSITORY: GitHubRepository = { owner: 'clipforge', repo: 'web' };

const RUN_ID = '2026-10-24-1402-northwind-demo';
const BRANCH = branchForRun(RUN_ID);
const BASE_SHA = '9f1c0b7e5d3a2f4b6c8d0e1f2a3b4c5d6e7f8a9b';
const HEAD_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const FILE_SHA = 'bbbbccccddddeeeeffff00001111222233334444';

const CHANGED_FILE = 'app/waiting/page.tsx';

/** The file as the repository holds it at {@link BASE_SHA}. */
const REPOSITORY_FILE = [
  'export default function Waiting() {',
  '  return (',
  '    <section className="waiting">',
  '      <h3>Making your video</h3>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

const PATCHED_FILE = [
  'export default function Waiting() {',
  '  return (',
  '    <section className="waiting">',
  '      <h3>Making your video</h3>',
  '      <p role="status">Usually ready in about 40 seconds.</p>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

const PATCH = [
  `--- a/${CHANGED_FILE}`,
  `+++ b/${CHANGED_FILE}`,
  '@@ -3,5 +3,6 @@',
  '     <section className="waiting">',
  '       <h3>Making your video</h3>',
  '+      <p role="status">Usually ready in about 40 seconds.</p>',
  '     </section>',
  '   );',
  ' }',
].join('\n');

const RECOMMENDATION: Recommendation = {
  id: 'R-01',
  rank: 1,
  sentence: 'Tell people how long the video will take before they press Generate.',
  evidence: '31 of 93 people left the waiting screen before it finished.',
  findingIds: ['F-04'],
  citations: [{ kind: 'funnel', stepId: 'generate' }],
  peopleAffected: 31,
  step: 'generate',
};

const CHANGE: Change = {
  recommendationId: 'R-01',
  changedFile: CHANGED_FILE,
  patch: PATCH,
  pullRequest: {
    title: 'Show the expected wait before Generate',
    body: `From recommendation R-01 — ${RECOMMENDATION.sentence} ${RECOMMENDATION.evidence} The numbers behind it are simulated.`,
  },
};

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  repository: REPOSITORY,
  runId: RUN_ID,
  baseBranch: 'main',
  change: CHANGE,
  recommendation: RECOMMENDATION,
  files: [{ path: CHANGED_FILE, text: REPOSITORY_FILE }],
  ...over,
});

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const READ_BRANCH: RecordedExchange = {
  method: 'GET',
  path: '/repos/clipforge/web/git/ref/heads/main',
  reply: { body: { object: { sha: BASE_SHA } } },
};

const readFileReply = (text: string): RecordedExchange => ({
  method: 'GET',
  path: `/repos/clipforge/web/contents/${CHANGED_FILE}?ref=${BASE_SHA}`,
  reply: { body: { sha: FILE_SHA, encoding: 'base64', content: base64(text) } },
});

const CREATE_BRANCH: RecordedExchange = {
  method: 'POST',
  path: '/repos/clipforge/web/git/refs',
  reply: { status: 201, body: { object: { sha: BASE_SHA } } },
};

const WRITE_FILE: RecordedExchange = {
  method: 'PUT',
  path: `/repos/clipforge/web/contents/${CHANGED_FILE}`,
  reply: { status: 201, body: { commit: { sha: HEAD_SHA }, content: { sha: 'ffff1111' } } },
};

const OPEN_PULL_REQUEST: RecordedExchange = {
  method: 'POST',
  path: '/repos/clipforge/web/pulls',
  reply: {
    status: 201,
    body: {
      number: 482,
      html_url: 'https://github.com/clipforge/web/pull/482',
      title: CHANGE.pullRequest.title,
      state: 'open',
      draft: false,
      head: { ref: BRANCH },
      base: { ref: 'main' },
    },
  },
};

/** The whole of a successful run, in the order the calls are made. */
const WHOLE_RUN: readonly RecordedExchange[] = [
  READ_BRANCH,
  readFileReply(REPOSITORY_FILE),
  CREATE_BRANCH,
  WRITE_FILE,
  OPEN_PULL_REQUEST,
];

const over = (exchanges: readonly RecordedExchange[]) => {
  const recorded = createRecordedTransport(exchanges);
  return { recorded, client: createGitHubClient({ token: TOKEN, transport: recorded.transport }) };
};

const asOpened = (result: ChangeResult): ChangeOpened => {
  if (result.kind !== 'opened') throw new Error(`expected a pull request, got: ${result.reason}`);
  return result;
};

const asRefused = (result: ChangeResult): string => {
  if (result.kind !== 'refused') {
    throw new Error(`expected a refusal, got pull request ${String(result.pullRequest.number)}`);
  }
  return result.reason;
};

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a test reached the network');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a change opens one pull request', () => {
  it('makes the five calls, in order, asserted on the requests made', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const opened = asOpened(await openChange(client, request()));

    expect(recorded.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /repos/clipforge/web/git/ref/heads/main',
      `GET /repos/clipforge/web/contents/${CHANGED_FILE}?ref=${BASE_SHA}`,
      'POST /repos/clipforge/web/git/refs',
      `PUT /repos/clipforge/web/contents/${CHANGED_FILE}`,
      'POST /repos/clipforge/web/pulls',
    ]);
    // The branch is created at the commit the file was read at, and named for the run.
    expect(recorded.requests[2]?.body).toEqual({
      ref: `refs/heads/${BRANCH}`,
      sha: BASE_SHA,
    });
    // One commit, on our branch, carrying the patched file and the blob it replaces.
    expect(recorded.requests[3]?.body).toEqual({
      message: CHANGE.pullRequest.title,
      content: base64(PATCHED_FILE),
      branch: BRANCH,
      sha: FILE_SHA,
    });
    // #263's body, posted unchanged.
    expect(recorded.requests[4]?.body).toEqual({
      title: CHANGE.pullRequest.title,
      body: CHANGE.pullRequest.body,
      head: BRANCH,
      base: 'main',
      draft: false,
    });
    expect(opened.pullRequest).toEqual({
      repository: 'clipforge/web',
      number: 482,
      url: 'https://github.com/clipforge/web/pull/482',
      title: CHANGE.pullRequest.title,
      state: 'open',
    });
    expect(opened.headSha).toBe(HEAD_SHA);
    expect(opened.baseSha).toBe(BASE_SHA);
  });

  it('hands the screen the sentence, the file and the diff it prints', async () => {
    const { client } = over(WHOLE_RUN);

    const opened = asOpened(await openChange(client, request()));

    expect(opened.recommendationId).toBe('R-01');
    expect(opened.recommendationSentence).toBe(RECOMMENDATION.sentence);
    expect(opened.changedFile).toBe(CHANGED_FILE);
    expect(opened.diff).toBe(PATCH);
    expect(opened.branch).toBe('personavision/2026-10-24-1402-northwind-demo');
  });

  it('opens a draft where the caller asks for one, and says so as its state', async () => {
    const { recorded, client } = over([
      READ_BRANCH,
      readFileReply(REPOSITORY_FILE),
      CREATE_BRANCH,
      WRITE_FILE,
      {
        ...OPEN_PULL_REQUEST,
        reply: {
          status: 201,
          body: { ...(OPEN_PULL_REQUEST.reply.body as object), draft: true },
        },
      },
    ]);

    const opened = asOpened(await openChange(client, request({ draft: true })));

    expect(opened.pullRequest.state).toBe('draft');
    expect((recorded.requests[4]?.body as { readonly draft: boolean }).draft).toBe(true);
  });

  it('applies the patch to the repository’s own content and not to the copy the run read', async () => {
    // The run's copy is stale — the owner reformatted the file since — and the patch is
    // applied to what the repository answers with, which is what the commit must contain.
    const { recorded, client } = over(WHOLE_RUN);

    await openChange(
      client,
      request({ files: [{ path: CHANGED_FILE, text: 'something else entirely\n' }] }),
    );

    expect(recorded.requests[3]?.body).toMatchObject({ content: base64(PATCHED_FILE) });
  });
});

describe('a change touching more than its recommendation is refused', () => {
  it('refuses a file the recommendation does not name, with both names, and creates nothing', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(
        client,
        request({
          change: { ...CHANGE, changedFile: 'app/checkout/page.tsx' },
          files: [{ path: CHANGED_FILE, text: REPOSITORY_FILE }],
        }),
      ),
    );

    expect(reason).toContain('app/checkout/page.tsx');
    expect(reason).toContain('R-01');
    expect(reason).toContain(CHANGED_FILE);
    expect(recorded.requests).toEqual([]);
  });

  it('refuses a change that answers a recommendation it was not given, naming both', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(client, request({ change: { ...CHANGE, recommendationId: 'R-07' } })),
    );

    expect(reason).toContain('R-07');
    expect(reason).toContain('R-01');
    expect(recorded.requests).toEqual([]);
  });

  it('refuses a patch touching a path the change did not declare, with that path named', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(
        client,
        request({
          change: {
            ...CHANGE,
            patch: `${PATCH}\n--- a/app/checkout/page.tsx\n+++ b/app/checkout/page.tsx\n@@ -1,1 +1,1 @@\n-one\n+two`,
          },
        }),
      ),
    );

    expect(reason).toContain('app/checkout/page.tsx');
    expect(reason).toContain('Nothing was opened.');
    // Two reads happened — reading is not creating — and nothing was written.
    expect(recorded.requests.map(({ method }) => method)).toEqual(['GET', 'GET']);
  });

  it('refuses a patch that does not apply to the repository’s content, with the reason', async () => {
    const edited = REPOSITORY_FILE.replace('Making your video', 'Rendering your video');
    const { recorded, client } = over([READ_BRANCH, readFileReply(edited)]);

    const reason = asRefused(await openChange(client, request()));

    expect(reason).toContain('does not apply');
    expect(reason).toContain(BASE_SHA);
    expect(reason).toContain('Rendering your video');
    expect(recorded.requests.map(({ method }) => method)).toEqual(['GET', 'GET']);
  });

  it('refuses a branch name that already exists, and overwrites nothing', async () => {
    const { recorded, client } = over([
      READ_BRANCH,
      readFileReply(REPOSITORY_FILE),
      {
        method: 'POST',
        path: '/repos/clipforge/web/git/refs',
        reply: { status: 422, body: { message: 'Reference already exists' } },
      },
    ]);

    const reason = asRefused(await openChange(client, request()));

    expect(reason).toContain(BRANCH);
    expect(reason).toContain('Reference already exists');
    expect(reason).toContain('nothing was overwritten');
    expect(recorded.requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('refuses a body that does not carry the simulated label, before any call at all', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(
        client,
        request({
          change: {
            ...CHANGE,
            pullRequest: { ...CHANGE.pullRequest, body: 'From recommendation R-01. 41% to 58%.' },
          },
        }),
      ),
    );

    expect(reason).toContain('simulated');
    expect(recorded.requests).toEqual([]);
  });

  it('refuses a body that does not state the recommendation it comes from', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(
        client,
        request({
          change: {
            ...CHANGE,
            pullRequest: {
              ...CHANGE.pullRequest,
              body: `From recommendation R-01. ${RECOMMENDATION.evidence} The numbers are simulated.`,
            },
          },
        }),
      ),
    );

    expect(reason).toContain(RECOMMENDATION.sentence);
    expect(recorded.requests).toEqual([]);
  });

  it('refuses a body that does not state the evidence that recommendation cites', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(
      await openChange(
        client,
        request({
          change: {
            ...CHANGE,
            pullRequest: {
              ...CHANGE.pullRequest,
              body: `From recommendation R-01 — ${RECOMMENDATION.sentence} The numbers are simulated.`,
            },
          },
        }),
      ),
    );

    expect(reason).toContain(RECOMMENDATION.evidence);
    expect(recorded.requests).toEqual([]);
  });

  it('reads a body wrapped across lines as the sentences it carries', async () => {
    const { client } = over(WHOLE_RUN);

    const wrapped = `From recommendation R-01 —\n${RECOMMENDATION.sentence.replace(' before', '\nbefore')}\n\n${RECOMMENDATION.evidence}\n\nThe numbers behind it are simulated.`;

    const result = await openChange(
      client,
      request({ change: { ...CHANGE, pullRequest: { ...CHANGE.pullRequest, body: wrapped } } }),
    );

    expect(result.kind).toBe('opened');
  });

  it('refuses a run id a branch cannot be named for', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    const reason = asRefused(await openChange(client, request({ runId: 'run 1/../main' })));

    expect(reason).toContain('run 1/../main');
    expect(recorded.requests).toEqual([]);
  });
});

describe('nothing on any path merges, closes or writes to the default branch', () => {
  it('is asserted over the whole recorded transcript of a successful run', async () => {
    const { recorded, client } = over(WHOLE_RUN);

    await openChange(client, request());

    for (const made of recorded.requests) {
      expect(made.path, made.path).not.toMatch(
        /merge|\/close|reopen|\/protect|\/reviews|\/requested_reviewers/i,
      );
      expect(['GET', 'POST', 'PUT'], made.method).toContain(made.method);
    }
    // Every write names our own branch; `main` is read and opened against, never written to.
    for (const made of recorded.requests.filter(({ method }) => method !== 'GET')) {
      const body = made.body as { readonly branch?: string; readonly ref?: string };
      expect(body.branch ?? body.ref ?? `refs/heads/${BRANCH}`).toContain(BRANCH);
    }
    expect(recorded.requests.filter(({ path }) => path.includes('heads/main'))).toHaveLength(1);
  });
});

describe('a GitHub refusal is reported in words, and nothing partial is recorded', () => {
  it('names what was asked and what was answered when the App is not installed', async () => {
    const { recorded, client } = over([
      {
        method: 'GET',
        path: '/repos/clipforge/web/git/ref/heads/main',
        reply: { status: 403, body: { message: 'Resource not accessible by integration' } },
      },
    ]);

    const error = await openChange(client, request()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GitHubCallError);
    expect((error as GitHubCallError).kind).toBe('forbidden');
    expect((error as GitHubCallError).message).toContain('GET /repos/clipforge/web/git/ref');
    expect((error as GitHubCallError).message).toContain('Resource not accessible by integration');
    expect(recorded.requests).toHaveLength(1);
  });

  it('carries no token in any refusal or any error it reports', async () => {
    const { client } = over([
      READ_BRANCH,
      {
        method: 'GET',
        path: `/repos/clipforge/web/contents/${CHANGED_FILE}?ref=${BASE_SHA}`,
        reply: { status: 401, body: { message: `bad credentials for ${TOKEN}` } },
      },
    ]);

    const error = await openChange(client, request()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const said = `${String((error as Error).message)} ${JSON.stringify(error)}`;
    expect(said).not.toContain(TOKEN);
    expect(said).toContain('[redacted]');
  });
});

describe('the run records what was opened', () => {
  it('reads back through the contract’s improve block unchanged', async () => {
    const { client } = over(WHOLE_RUN);

    const opened = asOpened(await openChange(client, request()));
    const record = changeRecordOf(opened);
    const block: Improve = {
      ...record,
      // The preview (#300), the two variants and the holdout (#303) are the run's, not ours.
      preview: { url: null, reason: 'this repository publishes no preview deployment' },
      baselineVariant: 'A',
      changeVariant: 'B',
      holdout: { personaIds: [], confirmed: null },
    };

    expect(improveSchema.parse(JSON.parse(JSON.stringify(block)))).toEqual(block);
    expect(record).toEqual({
      recommendationId: 'R-01',
      changedFile: CHANGED_FILE,
      pullRequest: {
        repository: 'clipforge/web',
        number: 482,
        url: 'https://github.com/clipforge/web/pull/482',
        title: CHANGE.pullRequest.title,
      },
    });
  });
});
