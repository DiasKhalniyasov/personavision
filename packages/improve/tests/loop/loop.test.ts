import { readRun, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMENT_MARKER, runImproveLoop } from '../../src/index.js';
import { validAggregate } from '../../../contract/tests/fixtures.js';
import {
  CHANGE_TITLE,
  commentIsPosted,
  comparisonDriven,
  HELD_OUT_ID,
  loopFixture,
  opensTheChange,
  noBranchYet,
  path,
  previewIsServed,
  PREVIEW_URL,
  PULL_NUMBER,
  PULL_URL,
  RUN_ID,
  SOURCE_RUN_ID,
  TOKEN,
} from './fixture.js';
import type { ImproveResult } from '../../src/index.js';
import type { LoopFixture } from './fixture.js';

/**
 * The loop, start to finish: `personavision improve` over the recorded transport, with no
 * token that is a token, no App and no network — `fetch` is stubbed to throw, so a call that
 * left this file would fail rather than reach GitHub.
 *
 * What is asserted is the **transcript** as much as the answer: that the calls were made in
 * the order the loop declares, that none of them merges, closes, deletes or pushes, and that
 * the run on disk carries the change, the preview, the holdout and the before/after.
 */

const FULL_LOOP = [
  noBranchYet,
  ...opensTheChange(CHANGE_TITLE),
  ...previewIsServed,
  ...commentIsPosted,
];

let fixture: LoopFixture;

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('no test in this package reaches the network');
    }),
  );
  fixture = await loopFixture(FULL_LOOP);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture.cleanup();
});

const finished = (result: ImproveResult) => {
  if (result.kind !== 'finished') {
    throw new Error(
      `the loop did not finish: ${result.kind === 'stopped' ? `${result.step} — ${result.reason}` : result.kind}`,
    );
  }
  return result;
};

describe('the whole loop over a recorded repository', () => {
  it('runs the five steps in order and finishes', async () => {
    const result = finished(await runImproveLoop(fixture.request()));

    expect(result.runId).toBe(RUN_ID);
    expect(result.drove).toBe(true);
    expect(result.pullRequest.number).toBe(PULL_NUMBER);
    expect(result.comment.kind).toBe('posted');
    expect(fixture.requests.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${path.ourBranch}`,
      `GET ${path.baseBranch}`,
      `GET ${path.file}`,
      `POST ${path.refs}`,
      `PUT ${path.contents}`,
      `POST ${path.pulls}`,
      `GET ${path.deployments}`,
      `GET ${path.statuses}`,
      `GET ${path.comments}`,
      `POST ${path.postComment}`,
    ]);
  });

  it('writes a run carrying the change, the preview, the holdout and the before and after', async () => {
    const result = finished(await runImproveLoop(fixture.request()));

    const { run } = await readRun(result.runDir);
    const improve = run.improve;
    expect(improve?.pullRequest).toEqual({
      repository: 'clipforge/web',
      number: PULL_NUMBER,
      url: PULL_URL,
      title: CHANGE_TITLE,
      // The state the Improve screen prints beside the number (#307): recorded as it was
      // when the run was written, and never derived from this product having opened it.
      state: 'open',
    });
    expect(improve?.preview).toEqual({ url: PREVIEW_URL });
    expect(improve?.recommendationId).toBe('R-01');
    expect(improve?.holdout.personaIds).toEqual([HELD_OUT_ID]);
    // The before and the after: one score row per version, on the task the run tested.
    expect(run.scores.map((score) => score.variant).sort()).toEqual([
      improve?.baselineVariant,
      improve?.changeVariant,
    ]);
    expect(run.status).toBe('finished');
  });

  it('records the holdout verdict and the figures in one claim', async () => {
    const result = finished(await runImproveLoop(fixture.request()));

    const { run } = await readRun(result.runDir);
    // `null` is the third state and the common one on one person: the holdout ran and its
    // bands could not separate the two versions, which reads as `none` (#304).
    const confirmed = run.improve?.holdout.confirmed;
    expect(run.verdict.holdout).toBe(
      confirmed === null ? 'none' : confirmed === true ? 'confirmed' : 'not_confirmed',
    );
    // The holdout's own figures sit beside the two versions', about the holdout alone.
    const held = run.scores.find((score) => score.holdout !== undefined);
    expect(held?.holdout?.scoredSessionCount).toBe(1);
  });

  /**
   * The figures the run wrote for itself as its sessions landed (#293).
   *
   * This write is where they could be lost: it is the loop's own, over the whole artifact,
   * and `writeRun` removes an `aggregate.json` it is not given. The driver here writes the
   * directory the way the swarm leaves it — figures and all — because the fixture's own
   * driver writes nothing, which is the case the loop already handled.
   */
  it('keeps the figures the run wrote for itself while it was open', async () => {
    const figures = { ...validAggregate(), runId: RUN_ID };

    const result = finished(
      await runImproveLoop(
        fixture.request({
          drive: async (request) => {
            const driven = comparisonDriven(request);
            await writeRun(request.runDir, {
              run: driven.run,
              sessions: [...driven.sessions],
              findings: { schemaVersion: SCHEMA_VERSION, runId: request.runId, findings: [] },
              aggregate: figures,
            });
            return driven;
          },
        }),
      ),
    );

    expect((await readRun(result.runDir)).aggregate).toEqual(figures);
  });

  it('posts one comment carrying the marker a re-run finds it by', async () => {
    await runImproveLoop(fixture.request());

    const posted = fixture.requests.find(
      (call) => call.method === 'POST' && call.path === path.postComment,
    );
    const body = (posted?.body as { body?: string } | undefined)?.body ?? '';
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('simulated');
  });

  it('reports every step in words a person can read', async () => {
    await runImproveLoop(fixture.request());

    const printed = fixture.printed().join('\n');
    expect(printed).toContain(`Improving ${SOURCE_RUN_ID} on clipforge/web`);
    expect(printed).toContain('Step 1 of 5 — deciding one change');
    expect(printed).toContain('Step 2 of 5 — opening the change as a pull request');
    expect(printed).toContain('Step 3 of 5 — resolving the preview');
    expect(printed).toContain('Step 4 of 5 — driving');
    expect(printed).toContain('Step 5 of 5 — the comment');
  });
});

describe('it never merges, on any path', () => {
  it('makes no call that merges, closes, deletes or pushes to the base branch', async () => {
    await runImproveLoop(fixture.request());

    const transcript = fixture.requests.map((call) => `${call.method} ${call.path}`);
    expect(transcript.filter((call) => /merge|squash|rebase|\/merges?\b/i.test(call))).toEqual([]);
    expect(transcript.filter((call) => call.startsWith('DELETE'))).toEqual([]);
    // The only two writes that touch a ref or a file name a branch of ours, and the base
    // branch is read and never written: `main` appears once, on a GET.
    expect(transcript.filter((call) => call.includes('heads/main'))).toEqual([
      `GET ${path.baseBranch}`,
    ]);
    const refs = fixture.requests.find((call) => call.path === path.refs);
    expect((refs?.body as { ref?: string } | undefined)?.ref).toBe(
      `refs/heads/personavision/${RUN_ID}`,
    );
    const written = fixture.requests.find((call) => call.method === 'PUT');
    expect((written?.body as { branch?: string } | undefined)?.branch).toBe(
      `personavision/${RUN_ID}`,
    );
  });

  it('closes no pull request and re-opens none: every write is a create or an edit of ours', async () => {
    await runImproveLoop(fixture.request());

    for (const call of fixture.requests) {
      if (call.method === 'GET') continue;
      const body = JSON.stringify(call.body ?? {});
      expect(body).not.toMatch(/"state"\s*:\s*"(closed|open)"/);
      expect(body).not.toMatch(/merge/i);
    }
  });
});

describe('no credential reaches anything this loop produces', () => {
  it('appears in no reported line, no answer and no written run', async () => {
    const result = finished(await runImproveLoop(fixture.request()));

    const { run } = await readRun(result.runDir);
    expect(fixture.printed().join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    // Nor in the transcript, which carries no headers at all by construction.
    expect(JSON.stringify(fixture.requests)).not.toContain(TOKEN);
  });

  it('appears in no error either, when a call fails with the token in the answer', async () => {
    const leaky = await loopFixture([
      {
        method: 'GET',
        path: path.ourBranch,
        reply: { status: 403, body: { message: `bad credentials: ${TOKEN}` } },
      },
    ]);
    try {
      const thrown = await runImproveLoop(leaky.request()).then(
        () => null,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain('[redacted]');
      expect(String(thrown)).not.toContain(TOKEN);
    } finally {
      await leaky.cleanup();
    }
  });
});
