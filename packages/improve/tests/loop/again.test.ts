import { readFile } from 'node:fs/promises';
import { readRun, runPaths } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMENT_MARKER, runImproveLoop } from '../../src/index.js';
import {
  CHANGE_TITLE,
  commentIsEdited,
  commentIsPosted,
  loopFixture,
  noBranchYet,
  opensTheChange,
  ourBranchIsThere,
  path,
  previewIsServed,
  pullRequestReply,
  pullsForBranch,
  PULL_NUMBER,
} from './fixture.js';
import type { ImproveFinished, ImproveResult } from '../../src/index.js';

/**
 * Nothing is written twice.
 *
 * Two runs of `improve` over one run open **one** pull request and leave **one** comment, and
 * the second run updates that comment rather than posting beside it. It is proved twice over,
 * because the two are different guarantees:
 *
 * 1. With the run directory the first loop wrote still there, the second loop reads that the
 *    comparison is done and runs nothing again — no swarm, no sessions, no second decision.
 * 2. With the run directory **gone**, the second loop still opens no second pull request: the
 *    branch of this run is read on the repository, the pull request already opened from it is
 *    found there, and the loop resumes from it. A user who deletes `runs/` does not get a
 *    second pull request on their repository.
 */

/** The comment the first loop left, as GitHub would hand it back on the second. */
const OURS = `${COMMENT_MARKER}\n### Before and after`;

const finished = (result: ImproveResult): ImproveFinished => {
  if (result.kind !== 'finished') {
    throw new Error(
      `the loop did not finish: ${result.kind === 'stopped' ? `${result.step} — ${result.reason}` : result.kind}`,
    );
  }
  return result;
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('no test in this package reaches the network');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('running it twice on the same run', () => {
  it('opens no second pull request, posts no second comment, and updates the one that is there', async () => {
    const fixture = await loopFixture([
      noBranchYet,
      ...opensTheChange(CHANGE_TITLE),
      ...previewIsServed,
      ...commentIsPosted,
      ...commentIsEdited(OURS),
    ]);
    try {
      let driven = 0;
      const request = fixture.request();
      const counted = {
        ...request,
        drive: async (input: Parameters<typeof request.drive>[0]) => {
          driven += 1;
          return request.drive(input);
        },
      };

      const first = finished(await runImproveLoop(counted));
      const before = await readFile(runPaths(first.runDir).run, 'utf8');
      const again = finished(await runImproveLoop(counted));

      expect(first.comment.kind).toBe('posted');
      expect(again.comment.kind).toBe('updated');
      expect(again.drove).toBe(false);
      expect(driven).toBe(1);
      // One pull request, one comment created, one comment edited.
      const calls = fixture.requests.map((call) => `${call.method} ${call.path}`);
      expect(calls.filter((call) => call === `POST ${path.pulls}`)).toHaveLength(1);
      expect(calls.filter((call) => call === `POST ${path.postComment}`)).toHaveLength(1);
      expect(calls.filter((call) => call === `PATCH ${path.comment}`)).toHaveLength(1);
      // And the run was not written again: the comparison it carries is the first one's.
      expect(await readFile(runPaths(again.runDir).run, 'utf8')).toBe(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it('opens no second pull request even with the run directory gone, because the branch is read', async () => {
    const fixture = await loopFixture([
      ourBranchIsThere,
      pullsForBranch([pullRequestReply({ title: CHANGE_TITLE })]),
      ...previewIsServed,
      ...commentIsEdited(OURS),
    ]);
    try {
      // No run directory at all: this is the second attempt of a user who deleted `runs/`,
      // or whose first attempt stopped after the pull request was opened.
      const result = finished(await runImproveLoop(fixture.request()));

      expect(result.drove).toBe(true);
      expect(result.pullRequest.number).toBe(PULL_NUMBER);
      expect(result.comment.kind).toBe('updated');
      const calls = fixture.requests.map((call) => `${call.method} ${call.path}`);
      expect(calls.filter((call) => call.startsWith('POST'))).toEqual([]);
      expect(calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
      expect(calls).toContain(`GET ${path.pullsForBranch}`);
      expect(fixture.printed().join('\n')).toContain('is already open');
      expect(fixture.printed().join('\n')).toContain('no second one is opened');
      // The run it wrote is this comparison's, with the pull request that was already open.
      const { run } = await readRun(result.runDir);
      expect(run.improve?.pullRequest.number).toBe(PULL_NUMBER);
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses to comment on a pull request that is not this change', async () => {
    const fixture = await loopFixture([
      ourBranchIsThere,
      pullsForBranch([pullRequestReply({ title: 'Somebody else’s pull request' })]),
    ]);
    try {
      const result = await runImproveLoop(fixture.request());

      if (result.kind !== 'stopped') throw new Error(`the loop did not stop: ${result.kind}`);
      expect(result.step).toBe('change');
      expect(result.reason).toContain('comments on the pull request it opened and on no other');
      expect(result.pullRequest?.number).toBe(PULL_NUMBER);
      expect(fixture.requests.every((call) => call.method === 'GET')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
