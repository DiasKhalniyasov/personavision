import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRun, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { createRecordedTransport } from '@personavision/improve';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { improveCommand, IMPROVE_EXIT_CODES } from '../src/commands/improve.js';
import { runCommand } from '../src/commands/run.js';
import { CliError } from '../src/cli-error.js';
import { runFixture } from '../test/run-swarm.js';
import { TASK } from '../../swarm/test/harness.js';
import type { Findings, Recommendations, RunArtifact } from '@personavision/contract';
import type { RecordedExchange } from '@personavision/improve';
import type { RunFixture } from '../test/run-swarm.js';

/**
 * `personavision improve <runId>` end to end, **offline**: the whole of path 2's loop over
 * the recorded GitHub transport and `packages/browser`'s committed capture set.
 *
 * Nothing here starts a browser, opens a socket or holds a credential. The path-1 run it
 * improves is produced by `personavision run` through the same fixture source, so the run
 * this command reads is a genuine artifact and not a hand-written one; what is added to it
 * is the one finding and the one recommendation Muse Wonder would answer from.
 */

/** The two addresses the committed capture set was recorded at. */
const BASELINE_URL = 'https://fixture.test/cart.html';
/** The preview the change is served at — the capture set's second variant. */
const PREVIEW_URL = 'https://fixture.test/b/cart.html';

const REPOSITORY = 'clipforge/web';
const BASE_BRANCH = 'main';
const CHANGED_FILE = 'app/checkout/page.tsx';
const BASE_SHA = '9f1c0b7e5d3a2f4b6c8d0e1f2a3b4c5d6e7f8a9b';
const HEAD_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const FILE_SHA = 'bbbbccccddddeeeeffff00001111222233334444';
const PULL_NUMBER = 482;
const PULL_URL = `https://github.com/clipforge/web/pull/${String(PULL_NUMBER)}`;
const COMMENT_ID = 55_501;
const DEPLOYMENT_ID = 7701;

/** Not a credential and could not be one: what is asserted is that it reaches nothing. */
const STAND_IN_TOKEN = 'installation-token-for-tests-0123456789';

const REPOSITORY_FILE = [
  'export default function Checkout() {',
  '  return (',
  '    <section className="checkout">',
  '      <h3>Your order</h3>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

const RECOMMENDATION_SENTENCE = 'Move Place order above the fold on the checkout step.';
const RECOMMENDATION_EVIDENCE = 'Nobody fixated it: the control sits below the fold on a phone.';

const path = {
  baseBranch: `/repos/${REPOSITORY}/git/ref/heads/${BASE_BRANCH}`,
  file: `/repos/${REPOSITORY}/contents/${CHANGED_FILE}?ref=${BASE_SHA}`,
  refs: `/repos/${REPOSITORY}/git/refs`,
  contents: `/repos/${REPOSITORY}/contents/${CHANGED_FILE}`,
  pulls: `/repos/${REPOSITORY}/pulls`,
  deployments: `/repos/${REPOSITORY}/deployments?sha=${HEAD_SHA}&per_page=100`,
  statuses: `/repos/${REPOSITORY}/deployments/${String(DEPLOYMENT_ID)}/statuses?per_page=100`,
  comments: `/repos/${REPOSITORY}/issues/${String(PULL_NUMBER)}/comments?per_page=100`,
  postComment: `/repos/${REPOSITORY}/issues/${String(PULL_NUMBER)}/comments`,
  ourBranch: (runId: string) => `/repos/${REPOSITORY}/git/ref/heads/personavision/improve-${runId}`,
} as const;

const readsTheFile: RecordedExchange = {
  method: 'GET',
  path: path.file,
  reply: {
    body: {
      sha: FILE_SHA,
      encoding: 'base64',
      content: Buffer.from(REPOSITORY_FILE, 'utf8').toString('base64'),
    },
  },
};

const readsTheBase: RecordedExchange = {
  method: 'GET',
  path: path.baseBranch,
  reply: { body: { object: { sha: BASE_SHA } } },
};

/** Everything GitHub answers across a whole successful loop, in order. */
const wholeLoop = (runId: string): readonly RecordedExchange[] => [
  // What the command reads before the loop: the base branch and the candidate file.
  readsTheBase,
  readsTheFile,
  // The loop's own first question: has this run's branch already been written?
  { method: 'GET', path: path.ourBranch(runId), reply: { status: 404, body: {} } },
  // Opening the change: two reads, a ref, a file and the pull request.
  readsTheBase,
  readsTheFile,
  { method: 'POST', path: path.refs, reply: { body: { object: { sha: BASE_SHA } } } },
  {
    method: 'PUT',
    path: path.contents,
    reply: { body: { commit: { sha: HEAD_SHA }, content: { sha: FILE_SHA } } },
  },
  {
    method: 'POST',
    path: path.pulls,
    reply: {
      body: {
        number: PULL_NUMBER,
        html_url: PULL_URL,
        title: RECOMMENDATION_SENTENCE,
        state: 'open',
        draft: false,
        head: { ref: `personavision/improve-${runId}` },
        base: { ref: BASE_BRANCH },
      },
    },
  },
  // The preview, from the pull request's own deployment.
  {
    method: 'GET',
    path: path.deployments,
    reply: {
      body: [
        {
          id: DEPLOYMENT_ID,
          environment: 'preview',
          ref: `personavision/improve-${runId}`,
          created_at: '2026-11-04T09:00:00Z',
        },
      ],
    },
  },
  {
    method: 'GET',
    path: path.statuses,
    reply: {
      body: [
        {
          id: 1,
          state: 'success',
          environment_url: PREVIEW_URL,
          description: 'Deployment has completed',
          created_at: '2026-11-04T09:01:00Z',
        },
      ],
    },
  },
  // The one comment, posted because the pull request carries none of ours.
  { method: 'GET', path: path.comments, reply: { body: [] } },
  {
    method: 'POST',
    path: path.postComment,
    reply: {
      body: {
        id: COMMENT_ID,
        body: '<!-- personavision:run-comment -->',
        html_url: `${PULL_URL}#issuecomment-${String(COMMENT_ID)}`,
        user: { login: 'personavision[bot]' },
      },
    },
  },
];

/**
 * The one finding and the one recommendation a path-1 run has to carry before there is a
 * change to decide, written into the run through the contract's own writer so the
 * recommendation cites a finding and a session this run actually holds.
 */
const withARecommendation = (artifact: RunArtifact): RunArtifact => {
  const { run } = artifact;
  const variant = run.variants[0]?.id ?? '';
  const aoi = run.aois.find((area) => area.variant === variant);
  const step = aoi?.step ?? run.steps[0]?.id ?? '';
  const sessionId = run.sessionIds.find((id) =>
    artifact.sessions.some((session) => session.sessionId === id && session.variant === variant),
  );
  if (aoi === undefined || sessionId === undefined) {
    throw new Error('the fixture run captured no area of interest to cite');
  }
  const findings: Findings = {
    schemaVersion: SCHEMA_VERSION,
    runId: run.runId,
    findings: [
      {
        id: 'F-01',
        rank: 1,
        severity: 'critical',
        claim: 'Place order sits below the fold on the checkout step.',
        evidence: RECOMMENDATION_EVIDENCE,
        variant,
        step,
        aoiId: aoi.id,
        sessionIds: [sessionId],
        sessionCount: 1,
        attribution: 'product',
        evidence_link: { screen: 'attention', params: { variant, step } },
      },
    ],
  };
  const recommendations: Recommendations = {
    schemaVersion: SCHEMA_VERSION,
    runId: run.runId,
    sample: {
      read: artifact.sessions.length,
      of: artifact.sessions.length,
      strategy: 'the whole run',
      seed: 11,
    },
    recommendations: [
      {
        id: 'R-01',
        rank: 1,
        sentence: RECOMMENDATION_SENTENCE,
        evidence: RECOMMENDATION_EVIDENCE,
        findingIds: ['F-01'],
        citations: [{ kind: 'heatmap', variant, step, aoiId: aoi.id }],
        peopleAffected: 1,
        step,
      },
    ],
  };
  return { ...artifact, findings, recommendations };
};

interface Improvable {
  readonly fixture: RunFixture;
  readonly runId: string;
  readonly printed: () => readonly string[];
  readonly log: (line: string) => void;
}

/** A finished path-1 run over the capture set, with a recommendation to answer. */
const aRunToImprove = async (): Promise<Improvable> => {
  const fixture = await runFixture({ size: 2 });
  await runCommand(fixture.options({ url: [BASELINE_URL, PREVIEW_URL] }));
  const [runId] = (await readdir(fixture.runsRoot)).sort();
  if (runId === undefined) throw new Error('the run command wrote no run');
  const sourceDir = join(fixture.runsRoot, runId);
  await writeRun(sourceDir, withARecommendation(await readRun(sourceDir)));
  const lines: string[] = [];
  return { fixture, runId, printed: () => [...lines], log: (line) => void lines.push(line) };
};

let improvable: Improvable;

beforeEach(async () => {
  improvable = await aRunToImprove();
});

afterEach(async () => {
  await improvable.fixture.cleanup();
});

const commandOptions = (
  over: Partial<Parameters<typeof improveCommand>[0]> = {},
): Parameters<typeof improveCommand>[0] => ({
  runId: improvable.runId,
  runsRoot: improvable.fixture.runsRoot,
  repository: REPOSITORY,
  base: BASE_BRANCH,
  file: [CHANGED_FILE],
  mode: 'contributor',
  engine: 'offline',
  log: improvable.log,
  env: {},
  source: improvable.fixture.options().source,
  token: STAND_IN_TOKEN,
  // The URL is asked one question before the swarm walks it; nothing here reaches a network.
  preview: { probe: async (url) => ({ reachable: true, answered: `200 from ${url}` }) },
  concurrency: 2,
  // The capture set's own steps, which is what the path-1 run above was driven with.
  taskSteps: TASK.steps,
  ...over,
});

describe('personavision improve, over the recorded transport and the capture set', () => {
  it('runs the whole loop and writes a run carrying the change, the preview, the holdout and the before and after', async () => {
    const recorded = createRecordedTransport(wholeLoop(improvable.runId));

    const result = await improveCommand(commandOptions({ transport: recorded.transport }));

    expect(result.kind).toBe('finished');
    if (result.kind !== 'finished') return;
    const { run } = await readRun(result.runDir);
    expect(run.runId).toBe(`improve-${improvable.runId}`);
    expect(run.improve?.pullRequest).toEqual({
      repository: REPOSITORY,
      number: PULL_NUMBER,
      url: PULL_URL,
      title: RECOMMENDATION_SENTENCE,
    });
    expect(run.improve?.preview).toEqual({ url: PREVIEW_URL });
    expect(run.improve?.changedFile).toBe(CHANGED_FILE);
    // A holdout of its own people, driven and recorded, with a verdict beside it.
    expect(run.improve?.holdout.personaIds.length).toBeGreaterThan(0);
    expect(run.verdict.holdout).toBeDefined();
    // The before and the after: both versions scored on the task the run tested.
    expect(run.scores.map((score) => score.variant).sort()).toEqual(['A', 'B']);
    // The holdout's people are the run's own personas, beside its participants.
    expect(run.personas).toHaveLength(
      run.audience.size + (run.improve?.holdout.personaIds.length ?? 0),
    );
    expect(run.status).toBe('finished');
  }, 120_000);

  it('reports each step in words a person can read, and the loop that finished exits 0', async () => {
    const recorded = createRecordedTransport(wholeLoop(improvable.runId));

    await improveCommand(commandOptions({ transport: recorded.transport }));

    const printed = improvable.printed().join('\n');
    expect(printed).toContain(`Improving ${improvable.runId} on ${REPOSITORY}`);
    expect(printed).toContain('Step 1 of 5 — deciding one change');
    expect(printed).toContain('Step 2 of 5 — opening the change as a pull request');
    expect(printed).toContain('Step 3 of 5 — resolving the preview');
    expect(printed).toContain('Step 4 of 5 — driving Baseline');
    expect(printed).toContain('Step 5 of 5 — the comment');
    // The sessions as they land, in the same words the Running screen renders.
    expect(printed).toMatch(/\n {2}\d+ of \d+|finished/);
  }, 120_000);

  it('never merges: no call in the whole transcript merges, closes, deletes or pushes to main', async () => {
    const recorded = createRecordedTransport(wholeLoop(improvable.runId));

    await improveCommand(commandOptions({ transport: recorded.transport }));

    const calls = recorded.requests.map((call) => `${call.method} ${call.path}`);
    expect(calls.filter((call) => /merge|squash|rebase/i.test(call))).toEqual([]);
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual([]);
    // `main` is read and never written.
    expect(calls.filter((call) => call.includes(`heads/${BASE_BRANCH}`))).toEqual([
      `GET ${path.baseBranch}`,
      `GET ${path.baseBranch}`,
    ]);
    for (const call of recorded.requests) {
      if (call.method === 'GET') continue;
      expect(JSON.stringify(call.body ?? {})).not.toMatch(/merge/i);
    }
  }, 120_000);

  it('writes no token into the run, the output or the transcript', async () => {
    const recorded = createRecordedTransport(wholeLoop(improvable.runId));

    const result = await improveCommand(commandOptions({ transport: recorded.transport }));
    if (result.kind !== 'finished') throw new Error('the loop did not finish');

    const onDisk = await readFile(join(result.runDir, 'run.json'), 'utf8');
    expect(onDisk).not.toContain(STAND_IN_TOKEN);
    expect(improvable.printed().join('\n')).not.toContain(STAND_IN_TOKEN);
    expect(JSON.stringify(recorded.requests)).not.toContain(STAND_IN_TOKEN);
  }, 120_000);
});

describe('personavision improve --dry-run', () => {
  it('reports the change, the file, the diff and the preview, and makes no write call', async () => {
    const recorded = createRecordedTransport([
      readsTheBase,
      readsTheFile,
      { method: 'GET', path: path.ourBranch(improvable.runId), reply: { status: 404, body: {} } },
      readsTheBase,
      readsTheFile,
    ]);

    const result = await improveCommand(
      commandOptions({ transport: recorded.transport, dryRun: true }),
    );

    expect(result.kind).toBe('dry_run');
    if (result.kind !== 'dry_run') return;
    expect(result.change?.changedFile).toBe(CHANGED_FILE);
    expect(result.preview).toContain('preview deployment');
    const printed = improvable.printed().join('\n');
    expect(printed).toContain('a dry run: nothing is written');
    expect(printed).toContain(
      'Nothing was written: no branch, no commit, no pull request and no comment.',
    );
    // The transcript is read-only, and no run directory was made for it.
    expect(recorded.requests.every((call) => call.method === 'GET')).toBe(true);
    expect(await readdir(improvable.fixture.runsRoot)).toEqual([improvable.runId]);
  });
});

describe('personavision improve on a run with no connected repository', () => {
  it('is refused with the sentence that says what to connect, and nothing is written', async () => {
    const thrown = await improveCommand(commandOptions({ repository: undefined })).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).toContain('GitHub App is installed on');
    expect((thrown as CliError).exitCode).toBe(IMPROVE_EXIT_CODES.notStarted);
    // The path-1 run is the only thing in the runs root: nothing was written.
    expect(await readdir(improvable.fixture.runsRoot)).toEqual([improvable.runId]);
  });
});

describe('personavision improve when a step stops the loop', () => {
  it('exits 3, names the step and the reason, and leaves the pull request open', async () => {
    const recorded = createRecordedTransport([
      readsTheBase,
      readsTheFile,
      { method: 'GET', path: path.ourBranch(improvable.runId), reply: { status: 404, body: {} } },
      ...wholeLoop(improvable.runId).slice(3, 8),
      // The repository publishes no deployment for this commit.
      { method: 'GET', path: path.deployments, reply: { body: [] } },
    ]);

    const thrown = await improveCommand(commandOptions({ transport: recorded.transport })).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(CliError);
    const error = thrown as CliError;
    expect(error.exitCode).toBe(IMPROVE_EXIT_CODES.stopped);
    expect(error.message).toContain('The loop stopped at the preview step.');
    expect(error.message).toContain(PULL_URL);
    expect(error.message).toContain('stays open: nothing about it was undone');
    // And the run it recorded says what had already happened.
    const { run } = await readRun(join(improvable.fixture.runsRoot, `improve-${improvable.runId}`));
    expect(run.status).toBe('failed');
    expect(run.failure?.detail).toContain(PULL_URL);
  });
});
