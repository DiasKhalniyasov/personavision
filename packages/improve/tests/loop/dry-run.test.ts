import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImproveLoop } from '../../src/index.js';
import {
  CHANGE_TITLE,
  CHANGED_FILE,
  loopFixture,
  noBranchYet,
  opensTheChange,
  ourBranchIsThere,
  path,
  pullRequestReply,
  pullsForBranch,
  PULL_NUMBER,
} from './fixture.js';
import type { ImproveDryRun, ImproveResult } from '../../src/index.js';

/**
 * `--dry-run`, which exists because this writes to somebody's repository: it reports the
 * change it would open, the file, the diff and the preview it would look for, and makes no
 * write call at all.
 *
 * The guarantee is a **property, not a promise**: the whole of `openChange` runs against a
 * read-only view of the client, so the refusals, the two reads and the patch applied to the
 * repository's own content all happen, and the first write it reaches throws instead of
 * creating anything. So what is asserted here is the transcript — every call a GET — rather
 * than the intention of the code that made them.
 */

const dry = (result: ImproveResult): ImproveDryRun => {
  if (result.kind !== 'dry_run') throw new Error(`not a dry run: ${result.kind}`);
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

describe('a dry run against a repository with nothing opened yet', () => {
  it('reports the change, the file, the diff and the preview it would resolve', async () => {
    // The two reads `openChange` makes before it would create anything; the three writes
    // after them are recorded and deliberately never reached.
    const fixture = await loopFixture([noBranchYet, ...opensTheChange(CHANGE_TITLE)]);
    try {
      const result = dry(await runImproveLoop(fixture.request({ dryRun: true })));

      expect(result.change?.changedFile).toBe(CHANGED_FILE);
      expect(result.change?.pullRequest.title).toBe(CHANGE_TITLE);
      expect(result.branch).toBe(`personavision/${result.runId}`);
      expect(result.preview).toContain('preview deployment clipforge/web publishes');
      expect(result.preview).toContain('never runs your build');

      const printed = fixture.printed().join('\n');
      expect(printed).toContain('a dry run: nothing is written');
      expect(printed).toContain(`It would open "${CHANGE_TITLE}" on clipforge/web`);
      expect(printed).toContain(`changing ${CHANGED_FILE}`);
      // The diff, line by line, as the change wrote it.
      for (const line of (result.change?.patch ?? '').split('\n')) {
        if (line !== '') expect(printed).toContain(`  | ${line}`);
      }
      expect(printed).toContain(
        'Nothing was written: no branch, no commit, no pull request and no comment.',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('makes no write call: the transcript is read-only', async () => {
    const fixture = await loopFixture([noBranchYet, ...opensTheChange(CHANGE_TITLE)]);
    try {
      await runImproveLoop(fixture.request({ dryRun: true }));

      expect(fixture.requests.map((call) => `${call.method} ${call.path}`)).toEqual([
        `GET ${path.ourBranch}`,
        `GET ${path.baseBranch}`,
        `GET ${path.file}`,
      ]);
      expect(fixture.requests.every((call) => call.method === 'GET')).toBe(true);
      expect(fixture.requests.every((call) => call.body === undefined)).toBe(true);
      // And nothing on disk either: no run directory was made.
      await expect(readdir(fixture.runsRoot)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('a dry run against a repository that already carries the pull request', () => {
  it('says the pull request would be reused and resolves nothing', async () => {
    const fixture = await loopFixture([
      ourBranchIsThere,
      pullsForBranch([pullRequestReply({ title: CHANGE_TITLE })]),
    ]);
    try {
      const result = dry(await runImproveLoop(fixture.request({ dryRun: true })));

      expect(result.pullRequest?.number).toBe(PULL_NUMBER);
      expect(result.preview).toContain(`pull request #${String(PULL_NUMBER)}`);
      expect(fixture.printed().join('\n')).toContain('it would be reused');
      expect(fixture.requests.every((call) => call.method === 'GET')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
