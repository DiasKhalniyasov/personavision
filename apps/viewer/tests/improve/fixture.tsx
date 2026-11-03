import { vi } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { mountApp, readRunFile, serveRunData } from '../app';
import { CONNECTION_PATH, forgetGithubConnection } from '../../src/screens/settings/connection';
import { paths } from '../../src/shell/paths';

/**
 * The run and the platform this screen is read against.
 *
 * Two things a test of `/runs/:runId/improve` needs and the shared harness does not have
 * together: a **path-2 run** — no committed run has tested a change yet, because nothing
 * writes one (#302) — and the workspace's **GitHub connection**, which the screen's two
 * faces turn on.
 *
 * The run is the repository's own fixture run with the `improve` block bolted on where the
 * pipeline would put it, and **every variant of it is parsed through `runSchema`**: a
 * fixture the artifact would refuse is a test about a screen state no reader can reach, so
 * an invalid one fails here rather than passing quietly.
 */

/** The hand-authored example run of `tests/fixtures/runs/`, as every screen suite reads it. */
export const SEED_RUN_ID = '2026-10-24-1402-northwind-demo';

/** `/runs/<the fixture run>/improve`, built through the product's own path table. */
export const IMPROVE_PATH = paths.improve(SEED_RUN_ID);

/** Where the fixture run's `run.json` is served from, for an override. */
const RUN_FILE_PATH = `/runs/${SEED_RUN_ID}/run.json`;

/** The patch the fixture's change carries: one line removed and one added. */
export const FIXTURE_PATCH = [
  '- <section class="waiting"><h3>Making your video</h3></section>',
  '+ <section class="waiting"><p role="status">Usually ready in about 40 seconds.</p></section>',
].join('\n');

/** The holdout's own figures on one side: one of its two people finished. */
const HOLDOUT_FIGURES = {
  completionRate: 0.5,
  outcomeCounts: { success: 1, abandoned: 1, failed: 0, automationFailure: 0 },
  scoredSessionCount: 2,
} as const;

/** The `improve` block of a run that tested a change, as `improveSchema` spells it. */
const CHANGE = {
  recommendationId: 'R-1',
  recommendationSentence: 'tell people how long the video will take before they press Generate',
  changedFile: 'app/views/waiting.html',
  pullRequest: {
    repository: 'northwind/web',
    number: 482,
    url: 'https://github.example/northwind/web/pull/482',
    title: 'Show the expected wait before Generate',
    state: 'open',
  },
  preview: { url: 'https://northwind-web-git-pv-wait.preview.example' },
  patch: FIXTURE_PATCH,
  baselineVariant: 'A',
  changeVariant: 'B',
  holdout: { personaIds: ['price'], confirmed: true },
} as const;

/** How a holdout reads: the three spellings the contract allows. */
export type HoldoutAnswer = 'confirmed' | 'not_confirmed' | 'none';

export interface ChangeOptions {
  /** What the holdout said. `none` is a run that measured none, which records no figures. */
  readonly holdout?: HoldoutAnswer;
  /** The preview, when it is a stated nothing rather than a URL. */
  readonly noPreview?: string;
  /** Drop the patch, the state and the recommendation's sentence: a run that recorded none. */
  readonly bare?: boolean;
}

/** The fixture run as it is: a path-1 run, which has tested no change. */
export const pathOneRun = (): Run => runSchema.parse(readRunFile(SEED_RUN_ID));

/**
 * The fixture run with a change, a preview and a holdout — a path-2 run.
 *
 * The holdout's figures go on the change's own score, which is where the Improve screen
 * reads the third figure from, and the holdout's verdict is recorded in both the places the
 * contract holds to each other: `improve.holdout.confirmed` and `verdict.holdout`.
 */
export const pathTwoRun = (options: ChangeOptions = {}): Run => {
  const answer = options.holdout ?? 'confirmed';
  const ran = answer !== 'none';
  const run = readRunFile(SEED_RUN_ID) as unknown as Run;

  const improve = {
    ...CHANGE,
    ...(options.bare === true
      ? {
          patch: undefined,
          recommendationSentence: undefined,
          pullRequest: { ...CHANGE.pullRequest, state: undefined },
        }
      : {}),
    ...(options.noPreview === undefined
      ? {}
      : { preview: { url: null, reason: options.noPreview } }),
    holdout: {
      personaIds: ran ? [...CHANGE.holdout.personaIds] : [],
      confirmed: ran ? answer === 'confirmed' : null,
    },
  };

  return runSchema.parse({
    ...run,
    improve,
    // A score carries the holdout's figures only on a run that ran one: the contract
    // refuses a figure recorded for nobody.
    scores: run.scores.map((score) =>
      ran && score.variant === CHANGE.changeVariant
        ? { ...score, holdout: HOLDOUT_FIGURES }
        : score,
    ),
    verdict: { ...run.verdict, holdout: answer },
  });
};

/** What the platform answers about this workspace's connection. */
export interface ConnectionBehaviour {
  /** Whether the GitHub App is registered at all, which is the platform's answer (#319). */
  readonly registered?: boolean;
  /** The connected repository. `null` is a workspace that has connected none. */
  readonly repository?: string | null;
  /** The platform is not there: the state could not be read, and locked is the answer. */
  readonly unreachable?: boolean;
  /** Hold the answer, for a test about what is on the page while it is in flight. */
  readonly hold?: boolean;
}

export interface Served {
  /** Answer a held read. */
  readonly release: () => void;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Serve one run and one connection answer over the stubbed `fetch`.
 *
 * The run data mount is the shared harness's, with this run's `run.json` replaced when a
 * test hands over a run of its own; the connection route sits in front of it and everything
 * else falls through, exactly as the server composes them.
 */
export async function serveImprove(
  options: { run?: Run; connection?: ConnectionBehaviour } = {},
): Promise<Served> {
  // Anything read before this test is another test's answer.
  forgetGithubConnection();
  await serveRunData(
    options.run === undefined ? {} : { files: { [RUN_FILE_PATH]: JSON.stringify(options.run) } },
  );
  const runData = globalThis.fetch;

  const behaviour = options.connection ?? {};
  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== CONNECTION_PATH) return runData(input as RequestInfo, init);

    if (behaviour.unreachable === true) throw new TypeError('Failed to fetch');
    if (held !== null) await held;

    return json({
      registered: behaviour.registered ?? true,
      connection:
        behaviour.repository === undefined || behaviour.repository === null
          ? null
          : { repository: behaviour.repository },
    });
  });

  return { release };
}

/** The screen, mounted on its own route inside the signed-in chrome. */
export const showImprove = (path: string = IMPROVE_PATH) => mountApp(path);
