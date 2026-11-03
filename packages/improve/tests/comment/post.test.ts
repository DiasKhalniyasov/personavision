import { describe, expect, it } from 'vitest';
import {
  COMMENT_MARKER,
  commentBody,
  createGitHubClient,
  createRecordedTransport,
  findRunComment,
  postRunComment,
} from '../../src/index.js';
import type { IssueComment, RecordedExchange, RunCommentResult } from '../../src/index.js';
import { RUN_URL, runWithChange } from './fixture.js';

/**
 * One comment per pull request, found by this product's own marker and updated rather than
 * repeated — asserted on the requests the recorded transport saw, so what is proved is the
 * calls made and not only the replies handled.
 *
 * No test here holds a token or reaches the network: every call goes through the one client
 * seam over the recorded transport (#297).
 */

const TOKEN = 'installation-token-for-tests-0123456789';

const COMMENTS = '/repos/clipforge/web/issues/482/comments?per_page=100';
const POST = '/repos/clipforge/web/issues/482/comments';
const EDIT = '/repos/clipforge/web/issues/comments/9';

/** A comment as GitHub replies with one. */
const reply = (id: number, body: string, login = 'personavision[bot]'): unknown => ({
  id,
  body,
  html_url: `https://github.com/clipforge/web/pull/482#issuecomment-${String(id)}`,
  user: { login },
});

const over = (exchanges: readonly RecordedExchange[]) => {
  const recorded = createRecordedTransport(exchanges);
  return { recorded, client: createGitHubClient({ token: TOKEN, transport: recorded.transport }) };
};

/** The body this run writes, which is what a posted or edited comment should carry. */
const written = (): string => {
  const draft = commentBody({ run: runWithChange(), runUrl: RUN_URL });
  if (draft.kind !== 'comment') throw new Error(draft.reason);
  return draft.text;
};

const comment = (result: RunCommentResult): IssueComment => {
  expect(result.kind, result.kind === 'refused' ? result.reason : '').not.toBe('refused');
  if (result.kind === 'refused') throw new Error(result.reason);
  return result.comment;
};

describe('the first run posts one comment', () => {
  it('reads the pull request’s comments and posts the body, asserted on the request', async () => {
    const { client, recorded } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [] } },
      { method: 'POST', path: POST, reply: { status: 201, body: reply(9, written()) } },
    ]);

    const result = await postRunComment(client, { run: runWithChange(), runUrl: RUN_URL });

    expect(result.kind).toBe('posted');
    expect(comment(result).id).toBe(9);
    expect(recorded.requests).toEqual([
      {
        method: 'GET',
        path: COMMENTS,
        url: `https://api.github.com${COMMENTS}`,
      },
      {
        method: 'POST',
        path: POST,
        url: `https://api.github.com${POST}`,
        body: { body: written() },
      },
    ]);
  });

  it('posts on the pull request the run recorded, not on one it was handed', async () => {
    const { recorded, client } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [] } },
      { method: 'POST', path: POST, reply: { status: 201, body: reply(9, written()) } },
    ]);

    await postRunComment(client, { run: runWithChange(), runUrl: RUN_URL });

    expect(recorded.requests.map((request) => request.path)).toEqual([COMMENTS, POST]);
  });
});

describe('a second run edits that comment and repeats nothing', () => {
  it('shows an edit and no second create', async () => {
    const first = written();
    const run = runWithChange();
    run.scores[1].completionRate = 0.62;
    run.scores[1].outcomeCounts = { success: 59, abandoned: 21, failed: 15, automationFailure: 1 };

    const { recorded, client } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [reply(9, first)] } },
      { method: 'PATCH', path: EDIT, reply: { body: reply(9, 'the edited body') } },
    ]);

    const result = await postRunComment(client, { run, runUrl: RUN_URL });

    expect(result.kind).toBe('updated');
    expect(recorded.requests.map((request) => request.method)).toEqual(['GET', 'PATCH']);
    expect(recorded.requests.filter((request) => request.method === 'POST')).toEqual([]);

    const edit = recorded.requests[1];
    expect(edit.path).toBe(EDIT);
    expect(edit.body).toEqual({
      body: expect.stringContaining('**With the change** — 62% completed the task'),
    });
  });
});

describe('a comment somebody else wrote is never edited', () => {
  it('posts its own rather than editing a marker-less comment of theirs', async () => {
    const theirs = reply(4, 'Looks good to me — can we ship this today?', 'a-reviewer');

    const { recorded, client } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [theirs] } },
      { method: 'POST', path: POST, reply: { status: 201, body: reply(9, written()) } },
    ]);

    const result = await postRunComment(client, { run: runWithChange(), runUrl: RUN_URL });

    expect(result.kind).toBe('posted');
    expect(recorded.requests.map((request) => request.path)).toEqual([COMMENTS, POST]);
    expect(
      recorded.requests.some(
        (request) => request.path === '/repos/clipforge/web/issues/comments/4',
      ),
    ).toBe(false);
  });

  it('edits ours and leaves theirs alone when the reply carries both', async () => {
    const theirs = reply(4, 'Looks good to me — can we ship this today?', 'a-reviewer');

    const { recorded, client } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [theirs, reply(9, written())] } },
      { method: 'PATCH', path: EDIT, reply: { body: reply(9, written()) } },
    ]);

    const result = await postRunComment(client, { run: runWithChange(), runUrl: RUN_URL });

    expect(result.kind).toBe('updated');
    expect(comment(result).id).toBe(9);
    expect(recorded.requests.map((request) => request.path)).toEqual([COMMENTS, EDIT]);
  });

  it('never edits a quote of our own comment, which carries the marker behind a “>”', async () => {
    // GitHub's Quote reply copies the raw markdown, HTML comment and all. Our own comment
    // has been deleted here — an owner tidying the pull request up — so the quote is the
    // only comment left carrying the marker.
    const quoted = written()
      .split('\n')
      .map((row) => `> ${row}`)
      .join('\n');
    const theirs = reply(4, `${quoted}\n\nIs the holdout really only 40 people?`, 'a-reviewer');

    const { recorded, client } = over([
      { method: 'GET', path: COMMENTS, reply: { body: [theirs] } },
      { method: 'POST', path: POST, reply: { status: 201, body: reply(9, written()) } },
    ]);

    const result = await postRunComment(client, { run: runWithChange(), runUrl: RUN_URL });

    expect(result.kind).toBe('posted');
    expect(recorded.requests.map((request) => request.path)).toEqual([COMMENTS, POST]);
  });

  it('finds ours by the marker it opens with, whatever the comment says after it', () => {
    const ours: IssueComment = {
      id: 9,
      body: written(),
      url: 'https://github.com/clipforge/web/pull/482#issuecomment-9',
      authorLogin: 'personavision[bot]',
    };
    const theirs: IssueComment = {
      id: 4,
      body: '41% to 58%? Nice. Every number labelled simulated, too.',
      url: 'https://github.com/clipforge/web/pull/482#issuecomment-4',
      authorLogin: 'a-reviewer',
    };

    expect(findRunComment([theirs, ours])?.id).toBe(9);
    expect(findRunComment([theirs])).toBeUndefined();
    expect(findRunComment([{ ...theirs, body: `> ${COMMENT_MARKER}\n> quoted` }])).toBeUndefined();
  });
});

describe('a refused body posts nothing at all', () => {
  it('makes no call for a run whose change was never served anywhere', async () => {
    const run = runWithChange();
    run.improve = {
      ...run.improve!,
      preview: { url: null, reason: 'this repository publishes no preview deployment' },
    };

    const { recorded, client } = over([]);
    const result = await postRunComment(client, { run, runUrl: RUN_URL });

    expect(result.kind).toBe('refused');
    expect(recorded.requests).toEqual([]);
  });

  it('makes no call for a body whose number it could not label', async () => {
    const run = runWithChange();
    run.verdict.reasons = ['17 of 33 people stayed to the preview.\nThat is what the change did.'];

    const { recorded, client } = over([]);
    const result = await postRunComment(client, { run, runUrl: RUN_URL });

    expect(result.kind).toBe('refused');
    expect(recorded.requests).toEqual([]);
  });
});
