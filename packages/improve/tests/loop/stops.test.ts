import { readdir } from 'node:fs/promises';
import { readRun } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImproveLoop } from '../../src/index.js';
import {
  CHANGE_TITLE,
  loopFixture,
  noBranchYet,
  noPreviewAtAll,
  opensTheChange,
  path,
  previewFailed,
  previewIsServed,
  PULL_NUMBER,
  PULL_URL,
} from './fixture.js';
import type { Change } from '@personavision/contract';
import type { WonderProvider } from '@personavision/provider';
import type { ImproveResult, ImproveStopped } from '../../src/index.js';

/**
 * Every way the loop stops, and the one promise that holds across all of them: **what was
 * already done stays done**.
 *
 * A pull request that was opened is never closed, deleted or re-opened because a later step
 * failed — it is reported as open with no comparison yet, and the run on disk says so. The
 * assertions are about the transcript as well as the answer, because "nothing was undone" is
 * a statement about the calls that were made.
 */

const stopped = (result: ImproveResult): ImproveStopped => {
  if (result.kind !== 'stopped') throw new Error(`the loop did not stop: ${result.kind}`);
  return result;
};

/** A Muse Wonder that answers whatever change a test wants, without a model. */
const answers = (change: Change): WonderProvider => ({
  name: 'a-change-this-test-wrote',
  mode: 'offline',
  ask: async () => ({
    value: change as never,
    model: null,
    usage: {
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    },
  }),
});

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

describe('a run with no connected repository', () => {
  it('is refused with the sentence that says what to connect, and nothing is written', async () => {
    const fixture = await loopFixture([]);
    try {
      const result = stopped(await runImproveLoop(fixture.request({ repository: undefined })));

      expect(result.step).toBe('repository');
      expect(result.reason).toContain('Connect a GitHub repository');
      expect(result.reason).toContain('Nothing was written');
      expect(result.pullRequest).toBeUndefined();
      // Nothing was asked of GitHub and nothing was put on disk.
      expect(fixture.requests).toEqual([]);
      await expect(readdir(fixture.runsRoot)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('a run with no change to make', () => {
  it('stops at the change step when the run recommended nothing', async () => {
    const fixture = await loopFixture([noBranchYet]);
    try {
      const request = fixture.request();
      const result = stopped(
        await runImproveLoop({
          ...request,
          source: { ...request.source, recommendations: [] },
        }),
      );

      expect(result.step).toBe('change');
      expect(result.reason).toContain('recommended nothing');
      expect(fixture.requests.map((call) => call.method)).toEqual(['GET']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops at the change step when the change touches a file its recommendation never named', async () => {
    const fixture = await loopFixture([noBranchYet]);
    try {
      const result = stopped(
        await runImproveLoop(
          fixture.request({
            wonder: answers({
              recommendationId: 'R-01',
              changedFile: 'app/somewhere/else.tsx',
              patch:
                '--- a/app/somewhere/else.tsx\n+++ b/app/somewhere/else.tsx\n@@ -1,1 +1,1 @@\n-a\n+b\n',
              pullRequest: { title: 'Something else', body: 'simulated' },
            }),
          }),
        ),
      );

      expect(result.step).toBe('change');
      expect(result.reason).toContain('"app/somewhere/else.tsx"');
      expect(result.reason).toContain('one targeted change touches one file');
      // The refusal happened before a single write: only the branch was read.
      expect(fixture.requests.map((call) => `${call.method} ${call.path}`)).toEqual([
        `GET ${path.ourBranch}`,
      ]);
      expect(result.pullRequest).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('a pull request that was opened and a preview that never came', () => {
  it('stops at the preview step, keeps the pull request open and records what happened', async () => {
    const fixture = await loopFixture([
      noBranchYet,
      ...opensTheChange(CHANGE_TITLE),
      ...noPreviewAtAll,
    ]);
    try {
      const result = stopped(await runImproveLoop(fixture.request()));

      expect(result.step).toBe('preview');
      expect(result.reason).toContain('has none');
      expect(result.preview).toEqual({ url: null, reason: expect.stringContaining('none') });
      // The pull request is reported as open, with no comparison yet.
      expect(result.pullRequest?.number).toBe(PULL_NUMBER);
      expect(result.pullRequest?.state).toBe('open');
      // And nothing closed it, deleted it or re-opened it: the whole transcript after the
      // pull request was opened is two reads of its deployments.
      const after = fixture.requests.slice(
        fixture.requests.findIndex((call) => call.path === path.pulls) + 1,
      );
      expect(after.map((call) => call.method)).toEqual(['GET']);

      const { run } = await readRun(result.runDir);
      expect(run.status).toBe('failed');
      expect(run.failure?.reason).toContain('no preview deployment');
      expect(run.failure?.detail).toContain(PULL_URL);
      expect(run.failure?.detail).toContain('stays open');
      expect(run.sessionIds).toEqual([]);
      expect(run.improve).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('stops at the preview step when the preview exists and could not be used', async () => {
    const fixture = await loopFixture([
      noBranchYet,
      ...opensTheChange(CHANGE_TITLE),
      ...previewFailed,
    ]);
    try {
      const result = stopped(await runImproveLoop(fixture.request()));

      expect(result.step).toBe('preview');
      expect(result.reason).toContain('failed');
      expect(result.pullRequest?.number).toBe(PULL_NUMBER);
      const { run } = await readRun(result.runDir);
      expect(run.failure?.reason).toContain('could not be used');
      expect(run.failure?.detail).toContain('Build failed');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('a branch of this run that is already there with no pull request on it', () => {
  it('is refused, and says the change opens under a new run id', async () => {
    const fixture = await loopFixture([
      { method: 'GET', path: path.ourBranch, reply: { body: { object: { sha: 'abc' } } } },
      { method: 'GET', path: path.pullsForBranch, reply: { body: [] } },
    ]);
    try {
      const result = stopped(await runImproveLoop(fixture.request()));

      expect(result.step).toBe('change');
      expect(result.reason).toContain('carries no pull request of ours');
      expect(result.reason).toContain('under a new run id');
      // Two reads and nothing else: nothing was written to a branch we did not create.
      expect(fixture.requests.map((call) => call.method)).toEqual(['GET', 'GET']);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('the comparison that could not be driven', () => {
  it('stops at the comparison step and leaves the pull request open', async () => {
    const fixture = await loopFixture([
      noBranchYet,
      ...opensTheChange(CHANGE_TITLE),
      ...previewIsServed,
    ]);
    try {
      const result = stopped(
        await runImproveLoop(
          fixture.request({
            drive: async () => {
              throw new Error('the browser could not be started on this machine');
            },
          }),
        ),
      );

      expect(result.step).toBe('comparison');
      expect(result.reason).toContain('could not be started');
      expect(result.pullRequest?.number).toBe(PULL_NUMBER);
      expect(result.preview?.url).not.toBeNull();
      expect(
        fixture.requests.filter((call) => call.method !== 'GET').map((call) => call.path),
      ).toEqual([path.refs, path.contents, path.pulls]);
    } finally {
      await fixture.cleanup();
    }
  });
});
