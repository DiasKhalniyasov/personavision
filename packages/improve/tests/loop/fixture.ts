import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths } from '@personavision/contract';
import { createOfflineWonderProvider } from '@personavision/provider';
import {
  finishedEntry,
  validArtifact,
  validRecommendations,
  validSession,
} from '../../../contract/tests/fixtures.js';
import {
  branchForRun,
  createGitHubClient,
  createRecordedTransport,
  improveRunId,
} from '../../src/index.js';
import type { Recommendation, Run, Session } from '@personavision/contract';
import type { ChangeFile } from '@personavision/provider';
import type {
  ComparisonDriven,
  ComparisonRequest,
  GitHubRepository,
  ImproveRequest,
  RecordedExchange,
  RecordedRequest,
} from '../../src/index.js';

/**
 * What the loop is driven with in these tests: the recorded transport, the offline Muse
 * Wonder provider, and a comparison that is handed back rather than walked.
 *
 * Nothing here starts a browser, opens a socket or holds a credential. The swarm is reached
 * through {@link ImproveRequest.drive}, which is the caller's seam, so a test of the loop is
 * a test of the order the steps run in and of what happens when one of them says no — the
 * hundred sessions behind it are `@personavision/cli`'s own suite.
 */

/** Not a token and could not be one: what is asserted is that its value reaches nothing. */
export const TOKEN = 'installation-token-for-tests-0123456789';

export const REPOSITORY: GitHubRepository = { owner: 'clipforge', repo: 'web' };

export const BASE_BRANCH = 'main';

/** The path-1 run the change comes from, and so the run the improve run is named after. */
export const SOURCE_RUN_ID = '2026-10-24-1402-northwind-demo';

export const RUN_ID = improveRunId(SOURCE_RUN_ID);
export const BRANCH = branchForRun(RUN_ID);

export const BASE_SHA = '9f1c0b7e5d3a2f4b6c8d0e1f2a3b4c5d6e7f8a9b';
export const HEAD_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
export const FILE_SHA = 'bbbbccccddddeeeeffff00001111222233334444';

export const CHANGED_FILE = 'app/checkout/page.tsx';

export const PULL_NUMBER = 482;
export const PULL_URL = `https://github.com/clipforge/web/pull/${String(PULL_NUMBER)}`;
export const PREVIEW_URL = 'https://clipforge-web-git-pv.preview.example/cart';
export const RUN_URL =
  'https://app.personavision.example/runs/2026-10-24-1402-northwind-demo-improve';

export const DEPLOYMENT_ID = 7701;
export const COMMENT_ID = 55_501;

/** The file the change may touch, as the repository holds it and as the ask is handed it. */
export const REPOSITORY_FILE = [
  'export default function Checkout() {',
  '  return (',
  '    <section className="checkout">',
  '      <h3>Your order</h3>',
  '    </section>',
  '  );',
  '}',
  '',
].join('\n');

export const FILES: readonly ChangeFile[] = [{ path: CHANGED_FILE, text: REPOSITORY_FILE }];

export const RECOMMENDATIONS: readonly Recommendation[] = validRecommendations().recommendations;

/**
 * The title the offline change asks for, which is the recommendation's own sentence
 * (`offlineChange` in `@personavision/provider`). A resumed loop matches the pull request
 * that is open against it, so it is spelled here rather than in each test.
 */
export const CHANGE_TITLE = RECOMMENDATIONS[0]?.sentence ?? '';

/** The person held out, beside the one participant the run fixture's audience generates. */
export const HELD_OUT_ID = 'held-out-1';

/** The paths the client builds, spelled once so a test records a call rather than a URL. */
export const path = {
  ourBranch: `/repos/clipforge/web/git/ref/heads/${BRANCH}`,
  baseBranch: `/repos/clipforge/web/git/ref/heads/${BASE_BRANCH}`,
  pullsForBranch: `/repos/clipforge/web/pulls?head=${encodeURIComponent(`clipforge:${BRANCH}`)}&state=all&per_page=100`,
  file: `/repos/clipforge/web/contents/${CHANGED_FILE}?ref=${BASE_SHA}`,
  refs: '/repos/clipforge/web/git/refs',
  contents: `/repos/clipforge/web/contents/${CHANGED_FILE}`,
  pulls: '/repos/clipforge/web/pulls',
  deployments: `/repos/clipforge/web/deployments?sha=${HEAD_SHA}&per_page=100`,
  statuses: `/repos/clipforge/web/deployments/${String(DEPLOYMENT_ID)}/statuses?per_page=100`,
  /** The client asks for a hundred comments; posting one carries no query. */
  comments: `/repos/clipforge/web/issues/${String(PULL_NUMBER)}/comments?per_page=100`,
  postComment: `/repos/clipforge/web/issues/${String(PULL_NUMBER)}/comments`,
  comment: `/repos/clipforge/web/issues/comments/${String(COMMENT_ID)}`,
} as const;

const NOT_FOUND = { status: 404, body: { message: 'Not Found' } };

/** The branch of this run is not there: the first attempt's answer. */
export const noBranchYet: RecordedExchange = {
  method: 'GET',
  path: path.ourBranch,
  reply: NOT_FOUND,
};

/** The branch of this run is there, at the commit the change was written on. */
export const ourBranchIsThere: RecordedExchange = {
  method: 'GET',
  path: path.ourBranch,
  reply: { body: { object: { sha: HEAD_SHA } } },
};

export const pullsForBranch = (pulls: readonly unknown[]): RecordedExchange => ({
  method: 'GET',
  path: path.pullsForBranch,
  reply: { body: pulls },
});

/** GitHub's own shape for a pull request, as the client reads one. */
export const pullRequestReply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: PULL_NUMBER,
  html_url: PULL_URL,
  title: 'Show the expected wait before Generate',
  state: 'open',
  draft: false,
  head: { ref: BRANCH },
  base: { ref: BASE_BRANCH },
  ...over,
});

/** The five calls that open one change: two reads, a ref, a file and the pull request. */
export const opensTheChange = (title: string): readonly RecordedExchange[] => [
  { method: 'GET', path: path.baseBranch, reply: { body: { object: { sha: BASE_SHA } } } },
  {
    method: 'GET',
    path: path.file,
    reply: {
      body: {
        sha: FILE_SHA,
        encoding: 'base64',
        content: Buffer.from(REPOSITORY_FILE, 'utf8').toString('base64'),
      },
    },
  },
  { method: 'POST', path: path.refs, reply: { body: { object: { sha: BASE_SHA } } } },
  {
    method: 'PUT',
    path: path.contents,
    reply: { body: { commit: { sha: HEAD_SHA }, content: { sha: FILE_SHA } } },
  },
  { method: 'POST', path: path.pulls, reply: { body: pullRequestReply({ title }) } },
];

/** One preview deployment that published a URL and succeeded. */
export const previewIsServed: readonly RecordedExchange[] = [
  {
    method: 'GET',
    path: path.deployments,
    reply: {
      body: [
        {
          id: DEPLOYMENT_ID,
          environment: 'preview',
          ref: BRANCH,
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
];

/** The repository publishes no deployment for this commit at all. */
export const noPreviewAtAll: readonly RecordedExchange[] = [
  { method: 'GET', path: path.deployments, reply: { body: [] } },
];

/** A preview that exists and failed to build. */
export const previewFailed: readonly RecordedExchange[] = [
  previewIsServed[0] as RecordedExchange,
  {
    method: 'GET',
    path: path.statuses,
    reply: {
      body: [
        {
          id: 1,
          state: 'failure',
          description: 'Build failed',
          created_at: '2026-11-04T09:01:00Z',
        },
      ],
    },
  },
];

/** The pull request carries no comment of ours, and one is posted. */
export const commentIsPosted: readonly RecordedExchange[] = [
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

/** The pull request already carries ours, and it is edited rather than posted again. */
export const commentIsEdited = (body: string): readonly RecordedExchange[] => [
  {
    method: 'GET',
    path: path.comments,
    reply: {
      body: [
        {
          id: COMMENT_ID,
          body,
          html_url: `${PULL_URL}#issuecomment-${String(COMMENT_ID)}`,
          user: { login: 'personavision[bot]' },
        },
      ],
    },
  },
  {
    method: 'PATCH',
    path: path.comment,
    reply: {
      body: {
        id: COMMENT_ID,
        body,
        html_url: `${PULL_URL}#issuecomment-${String(COMMENT_ID)}`,
        user: { login: 'personavision[bot]' },
      },
    },
  },
];

/**
 * The comparison, handed back rather than walked: the contract's own two-variant run with
 * one person held out beside its participant, and that person's two sessions.
 *
 * It is what the swarm would have left: every session landed, the run closed, and **nothing
 * scored** — the scores, the findings and the verdict are the loop's to write from these.
 */
export const comparisonDriven = (request: ComparisonRequest): ComparisonDriven => {
  const artifact = validArtifact();
  const participant = artifact.run.personas[0];
  if (participant === undefined) throw new Error('the run fixture generates nobody');
  const heldOut = { ...structuredClone(participant), id: HELD_OUT_ID, name: 'Held out' };

  const held = (sessionId: string, variant: string): Session => {
    const session: Session = validSession(sessionId, variant);
    // `persona` is null on a session a real person walked; the fixture's are simulated.
    if (session.persona === null) throw new Error('the session fixture walked nobody');
    const persona: Session['persona'] = { ...session.persona, id: HELD_OUT_ID };
    // The seed they were sampled on, which is not one of the run's seed groups: a holdout
    // person walks each side once, on a seed the change was never chosen against.
    return { ...session, runId: request.runId, persona, seed: 99 };
  };
  const sessions: readonly Session[] = [
    ...artifact.sessions.map((session): Session => ({ ...session, runId: request.runId })),
    held('S-03', request.baseline.id),
    held('S-04', request.change.id),
  ];

  const run: Run = {
    ...artifact.run,
    runId: request.runId,
    variants: [
      { id: request.baseline.id, name: request.baseline.name, url: request.baseline.url },
      { id: request.change.id, name: request.change.name, url: request.change.url },
    ],
    personas: [...artifact.run.personas, heldOut],
    // Every step of both versions is declared, because a verdict names the screen its
    // heatmap is drawn on and which screen that is depends on what the sessions found.
    screenshots: [request.baseline.id, request.change.id].flatMap((variant) =>
      artifact.run.steps.map((step) => ({
        variant,
        step: step.id,
        path: runPaths('').screenshot(variant, step.id),
        viewport: heldOut.device.viewport,
        pageHeight: heldOut.device.viewport.height,
        foldY: heldOut.device.viewport.height,
      })),
    ),
    sessionIds: sessions.map((session) => session.sessionId),
    progress: {
      totalSessions: sessions.length,
      finishedSessions: sessions.length,
      perVariant: [request.baseline.id, request.change.id].map((variant) => ({
        variant,
        totalSessions: sessions.filter((session) => session.variant === variant).length,
        finishedSessions: sessions.filter((session) => session.variant === variant).length,
      })),
      sessions: sessions.map((session) => finishedEntry(session.sessionId, session.variant)),
    },
    // What the swarm leaves: the run closed and nothing scored.
    scores: [],
    aoiMetrics: [],
    improve: {
      ...request.improve,
      holdout: { personaIds: [HELD_OUT_ID], confirmed: null },
    },
    verdict: { ...artifact.run.verdict, headlineFindingIds: [], holdout: 'none' },
  };

  return {
    run,
    sessions,
    aoiMetrics: artifact.run.aoiMetrics,
    holdoutPersonaIds: [HELD_OUT_ID],
  };
};

export interface LoopFixture {
  readonly runsRoot: string;
  readonly requests: readonly RecordedRequest[];
  readonly printed: () => readonly string[];
  readonly request: (over?: Partial<ImproveRequest>) => ImproveRequest;
  readonly cleanup: () => Promise<void>;
}

/**
 * A loop to run, with its own runs root, its own transcript and its own printed lines.
 *
 * `exchanges` is the whole of what GitHub would answer, in order: a call the test did not
 * record throws rather than resolving to nothing (`createRecordedTransport`).
 */
export const loopFixture = async (exchanges: readonly RecordedExchange[]): Promise<LoopFixture> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-improve-'));
  const runsRoot = join(dir, 'runs');
  const lines: string[] = [];
  const recorded = createRecordedTransport(exchanges);
  const client = createGitHubClient({ token: TOKEN, transport: recorded.transport });

  return {
    runsRoot,
    requests: recorded.requests,
    printed: () => [...lines],
    request: (over = {}) => ({
      runsRoot,
      source: {
        runId: SOURCE_RUN_ID,
        run: validArtifact().run,
        recommendations: RECOMMENDATIONS,
      },
      repository: REPOSITORY,
      baseBranch: BASE_BRANCH,
      files: FILES,
      wonder: createOfflineWonderProvider(),
      client,
      drive: async (request) => comparisonDriven(request),
      runUrl: () => RUN_URL,
      report: (line) => void lines.push(line),
      // No clock and no network: the preview is asked by an injected probe and waited for
      // on an injected clock.
      preview: { probe: async (url) => ({ reachable: true, answered: `200 from ${url}` }) },
      ...over,
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};
