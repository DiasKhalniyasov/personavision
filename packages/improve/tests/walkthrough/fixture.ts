import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, runPaths } from '@personavision/contract';
import { createOfflineWonderProvider } from '@personavision/provider';
import {
  branchForRun,
  createGitHubClient,
  createRecordedTransport,
  improveRunId,
  runImproveLoop,
} from '../../src/index.js';
import {
  BASE_BRANCH,
  commentIsPosted,
  FILES,
  noBranchYet,
  noPreviewAtAll,
  opensTheChange,
  previewIsServed,
  REPOSITORY,
  RUN_URL,
  TOKEN,
} from '../loop/fixture.js';
import type { Persona, Recommendation, Run, RunArtifact, Session } from '@personavision/contract';
import type {
  ComparisonDriven,
  ComparisonRequest,
  ImproveRequest,
  ImproveResult,
  RecordedExchange,
  RecordedRequest,
} from '../../src/index.js';

/**
 * The materials path 2's walk-through is made of: the **committed** path-1 run over the demo
 * shop, the recorded repository, and one comparison driven from that run's own sessions.
 *
 * It exists so that the walk-through — `./walkthrough.test.ts` here, and
 * `tests/path2-cold-start.test.ts` at the root, which serves what this writes to the built
 * viewer — can produce a whole path-2 run **from a fresh clone, with no credential and no
 * network**. Everything it needs is already in git: `runs/2026-10-24-1402-northwind-demo`
 * and its `recommendations.json` are the path-1 run the change is decided from, the GitHub
 * calls go over the recorded transport this step tests every client call on, and Muse Wonder
 * is the offline provider.
 *
 * ## The one substitution, stated
 *
 * A cold-start walk launches no browser, so the sessions of the path-2 run are **the
 * committed run's own, with its two versions re-labelled**. The committed run's *B* — the
 * redesign candidate, where the three planted defects are, which its recommendations are
 * about, and where all eleven of its scored people gave up — is the **baseline** here: the
 * site as it is, and the version handed to the loop first, so the baseline it drives is that
 * one. Its *A* — the clean checkout, where eleven of twelve finished — is **the change**, the
 * version the pull request's preview serves. The loop names its own two versions `A` and `B`
 * whatever the source run called them, so the sessions, the areas of interest and the
 * screenshots are re-labelled onto those ids together: every figure the walk prints is a
 * figure that run really measured, and what is substituted is which of the two versions is
 * called the baseline, and nothing else.
 *
 * Why re-label at all: path 2's whole point is a change that **wins**, and a comparison
 * where the change loses is scored as `not-ahead` — the holdout is then told there is no
 * gain for it to confirm, and neither verdict this walk has to show could be reached. The
 * honest alternative is a second browser run of a repaired shop, which is minutes of
 * Chromium and the acceptance gate's job (`tests/acceptance/pipeline.test.ts`), not a cold
 * start's.
 *
 * The holdout is twenty people — the fixed twenty of the owner's answer on #227 — generated
 * here by re-identifying the audience's own personas on a seed none of the run's three seed
 * groups used, and walked on both versions. Which way they went is the one thing a caller
 * chooses, because it is the one thing the product must be honest about: `confirmed` when
 * they moved with the rest of the audience, `not_confirmed` when they did not.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** The path-1 run a fresh clone finds under `runs/`, and the one every screen opens on. */
export const SOURCE_RUN_ID = '2026-10-24-1402-northwind-demo';

export const sourceRunDir = join(repoRoot, 'runs', SOURCE_RUN_ID);

/** The path-2 run id the loop derives from it, and the branch it would open. */
export const RUN_ID = improveRunId(SOURCE_RUN_ID);
export const BRANCH = branchForRun(RUN_ID);

/** The people the change was never chosen against: the owner's fixed twenty. */
export const HOLDOUT_SIZE = 20;

/** The seed they were drawn on. The run's own groups are 20261051–3; this is none of them. */
export const HOLDOUT_SEED = 20261054;

export const holdoutPersonaId = (position: number): string =>
  `holdout-${String(position + 1).padStart(2, '0')}`;

/**
 * Which of the committed run's two versions plays which part here.
 *
 * The loop calls its baseline `A` and its change `B` (`BASELINE_VARIANT` and
 * `CHANGE_VARIANT` in `packages/improve/src/loop.ts`), and here the baseline is the
 * committed run's `B`: so its `B` is this run's `A`, and its `A` is this run's `B`.
 */
const RELABELLED: Readonly<Record<string, string>> = { A: 'B', B: 'A' };

/** The committed run's version this walk takes as the site as it is. */
export const BASELINE_VERSION = 'B';

const relabel = (variant: string): string => RELABELLED[variant] ?? variant;

/** The committed path-1 run, read from the repository as a fresh clone holds it. */
export const pathOneRun = (): Promise<RunArtifact> => readRun(sourceRunDir);

/**
 * The change the offline Muse Wonder decides from a run's recommendations: the top-ranked
 * one, whose sentence is the pull request's title.
 *
 * It is spelled here because the recorded repository has to answer the call that opens *that*
 * pull request, so the title is needed before the loop runs — and because a walk asserting
 * the title against the recommendation it came from is asserting the two agree.
 */
export const topRecommendation = (recommendations: readonly Recommendation[]): Recommendation => {
  const best = [...recommendations].sort((left, right) => left.rank - right.rank)[0];
  if (best === undefined) throw new Error(`${SOURCE_RUN_ID} recommends nothing`);
  return best;
};

/** Which way the twenty went on the change, which is what the holdout line reports. */
export type HoldoutWent = 'confirmed' | 'not_confirmed';

interface Driven {
  readonly run: Run;
  readonly sessions: readonly Session[];
}

/** One finished-session log entry of a run's progress block. */
type ProgressEntry = NonNullable<Run['progress']>['sessions'][number];

/** One progress entry, read off the session it is about rather than invented beside it. */
const entryOf = (session: Session, personaName: string): ProgressEntry => ({
  sessionId: session.sessionId,
  personaName,
  variant: session.variant,
  seed: session.seed,
  finishedAt: new Date(
    Date.parse(session.startedAt) + Math.round(session.durationMs),
  ).toISOString(),
  durationMs: session.durationMs,
  status: session.outcome.status,
  step: session.outcome.step,
  reason: session.outcome.reason,
  attribution: session.outcome.attribution,
});

/** A session of the committed run, re-labelled onto this run's own two versions. */
const relabelled = (session: Session, runId: string): Session => {
  const variant = relabel(session.variant);
  return {
    ...session,
    runId,
    variant,
    screens: session.screens.map((screen) => ({
      ...screen,
      screenshot: runPaths('').screenshot(variant, screen.step),
    })),
  };
};

/** The template a holdout person's session on one version is a copy of. */
const templateFor = (sessions: readonly Session[], variant: string): Session => {
  const found = sessions.find(
    (session) => session.variant === variant && !session.outcome.excludedFromScores,
  );
  if (found === undefined) throw new Error(`${SOURCE_RUN_ID} has no scored session on ${variant}`);
  return found;
};

/**
 * The twenty people's two walks each, on the seed the change was never chosen against.
 *
 * Content comes from the version they walked, so their fixations are of the page they were
 * on; the **outcome** is the one the caller asked for — and for a holdout that went the
 * other way, it is the outcome the *other* version's own sessions recorded, so even a
 * not-confirmed walk states no result this run did not measure somewhere.
 */
const holdoutSessions = (
  relabelledSessions: readonly Session[],
  people: readonly Persona[],
  went: HoldoutWent,
  runId: string,
): Session[] => {
  // `S-01, S-02 … S-NN` is what the contract spells a session id, so the holdout's walks
  // carry on the numbering of the people who went before them rather than a letter of
  // their own: who was held out is read from `improve.holdout.personaIds`, which is where
  // the artifact records it.
  let numbered = relabelledSessions.length;
  const onBaseline = templateFor(relabelledSessions, 'A');
  const onChange = templateFor(relabelledSessions, 'B');
  // Confirmed: the twenty did on each version what the rest of the audience did. Not
  // confirmed: they did the opposite, which is the gain the swarm could not reproduce.
  const outcomes =
    went === 'confirmed'
      ? { A: onBaseline.outcome, B: onChange.outcome }
      : { A: onChange.outcome, B: onBaseline.outcome };

  return people.flatMap((person) =>
    (
      [
        ['A', onBaseline],
        ['B', onChange],
      ] as const
    ).map(([variant, template]): Session => {
      const persona = template.persona;
      if (persona === null) throw new Error(`${template.sessionId} walked nobody`);
      numbered += 1;
      return {
        ...template,
        sessionId: `S-${String(numbered).padStart(2, '0')}`,
        runId,
        persona: { ...persona, id: person.id },
        seed: HOLDOUT_SEED,
        outcome: { ...outcomes[variant] },
      };
    }),
  );
};

/** Every version-and-step pair the run declares a page for, so a verdict can point anywhere. */
const everyScreenshot = (run: Run): Run['screenshots'] => {
  const seen = new Set<string>();
  const shots: Run['screenshots'][number][] = [];
  const first = run.screenshots[0];
  if (first === undefined) throw new Error(`${SOURCE_RUN_ID} captured no page`);
  for (const variant of ['A', 'B']) {
    for (const step of run.steps) {
      const key = `${variant}/${step.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const captured =
        run.screenshots.find(
          (shot) => relabel(shot.variant) === variant && shot.step === step.id,
        ) ?? first;
      shots.push({
        ...captured,
        variant,
        step: step.id,
        path: runPaths('').screenshot(variant, step.id),
      });
    }
  }
  return shots;
};

/**
 * The comparison the loop is handed back: the baseline, the change and the holdout, as the
 * swarm would have left them — every session landed, the run closed, and **nothing scored**.
 * The scores, the findings and the verdict are the loop's to write from these.
 */
export const drivenFrom = (
  artifact: RunArtifact,
  request: ComparisonRequest,
  went: HoldoutWent,
): Driven => {
  const source = artifact.run;
  const participants = source.personas;
  const holdout: Persona[] = Array.from({ length: HOLDOUT_SIZE }, (_, position) => {
    const like = participants[position % participants.length];
    if (like === undefined) throw new Error(`${SOURCE_RUN_ID} generates nobody`);
    return {
      ...structuredClone(like),
      id: holdoutPersonaId(position),
      name: `${like.name} (holdout ${String(position + 1)})`,
    };
  });

  const walked = artifact.sessions.map((session) => relabelled(session, request.runId));
  const held = holdoutSessions(walked, holdout, went, request.runId);
  const sessions = [...walked, ...held];
  const named = new Map(
    [...participants, ...holdout].map((person) => [person.id, person.name] as const),
  );

  const variants = [request.baseline, request.change];
  const run: Run = {
    ...source,
    runId: request.runId,
    variants: variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      url: variant.url,
    })),
    personas: [...participants, ...holdout],
    aois: source.aois.map((aoi) => ({ ...aoi, variant: relabel(aoi.variant) })),
    screenshots: everyScreenshot(source),
    stepCaptions: source.stepCaptions.map((caption) => ({
      ...caption,
      variant: relabel(caption.variant),
    })),
    sessionIds: sessions.map((session) => session.sessionId),
    progress: {
      totalSessions: sessions.length,
      finishedSessions: sessions.length,
      perVariant: variants.map((variant) => ({
        variant: variant.id,
        totalSessions: sessions.filter((session) => session.variant === variant.id).length,
        finishedSessions: sessions.filter((session) => session.variant === variant.id).length,
      })),
      sessions: sessions.map((session) =>
        entryOf(session, named.get(session.persona?.id ?? '') ?? 'Somebody'),
      ),
    },
    // What the swarm leaves: the run closed and nothing measured.
    scores: [],
    aoiMetrics: [],
    improve: {
      ...request.improve,
      holdout: { personaIds: holdout.map((person) => person.id), confirmed: null },
    },
    verdict: { ...source.verdict, headlineFindingIds: [], holdout: 'none' },
  };

  return { run, sessions };
};

export interface WalkOptions {
  /** Which way the twenty went on the change. */
  readonly went?: HoldoutWent;
  /** The repository publishes no preview for the pull request, which stops the loop. */
  readonly noPreview?: boolean;
  /** Where run directories go. A caller serving the result to the viewer passes its own. */
  readonly runsRoot?: string;
}

export interface Walk {
  readonly result: ImproveResult;
  readonly runId: string;
  readonly runDir: string;
  readonly runsRoot: string;
  /** The path-1 run the change came from, and the recommendation it answers. */
  readonly source: RunArtifact;
  readonly recommendation: Recommendation;
  /** Every GitHub call the walk made, in order, and no header of any of them. */
  readonly requests: readonly RecordedRequest[];
  /** Every line it reported, as a person reading the command's output sees them. */
  readonly printed: readonly string[];
  readonly cleanup: () => Promise<void>;
}

/**
 * One walk of path 2, end to end, over the committed path-1 run and the recorded repository.
 *
 * No token that is a token, no App, no network and no browser: the transport answers from
 * the recording, Muse Wonder is the offline provider, the preview is asked by an injected
 * probe, and the comparison is {@link drivenFrom}.
 */
export const walkPathTwo = async (options: WalkOptions = {}): Promise<Walk> => {
  const went = options.went ?? 'confirmed';
  const source = await pathOneRun();
  const recommendations = source.recommendations?.recommendations ?? [];
  const recommendation = topRecommendation(recommendations);
  const own =
    options.runsRoot === undefined
      ? await mkdtemp(join(tmpdir(), 'personavision-path2-'))
      : undefined;
  const scratch = options.runsRoot ?? join(own ?? '', 'runs');
  const exchanges: RecordedExchange[] = [
    noBranchYet,
    ...opensTheChange(recommendation.sentence),
    ...(options.noPreview === true ? noPreviewAtAll : previewIsServed),
    ...(options.noPreview === true ? [] : commentIsPosted),
  ];
  const recorded = createRecordedTransport(exchanges);
  const lines: string[] = [];
  // The loop drives `source.run.variants[0]` as the baseline, so the version this walk
  // takes as the site as it is — the one the recommendations are about — is handed over
  // first. Nothing else about the source run is changed.
  const baselineFirst = [
    ...source.run.variants.filter((version) => version.id === BASELINE_VERSION),
    ...source.run.variants.filter((version) => version.id !== BASELINE_VERSION),
  ];
  const request: ImproveRequest = {
    runsRoot: scratch,
    source: {
      runId: SOURCE_RUN_ID,
      run: { ...source.run, variants: baselineFirst },
      recommendations,
    },
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    files: FILES,
    wonder: createOfflineWonderProvider(),
    client: createGitHubClient({ token: TOKEN, transport: recorded.transport }),
    drive: async (driveRequest) => {
      const driven = drivenFrom(source, driveRequest, went);
      return {
        run: driven.run,
        sessions: driven.sessions,
        aoiMetrics: source.run.aoiMetrics,
        holdoutPersonaIds: driven.run.improve?.holdout.personaIds ?? [],
      } satisfies ComparisonDriven;
    },
    runUrl: () => RUN_URL,
    report: (line) => void lines.push(line),
    preview: { probe: async (url) => ({ reachable: true, answered: `200 from ${url}` }) },
  };

  const result = await runImproveLoop(request);

  return {
    result,
    runId: RUN_ID,
    runDir: join(scratch, RUN_ID),
    runsRoot: scratch,
    source,
    recommendation,
    requests: recorded.requests,
    printed: lines,
    cleanup: () =>
      own === undefined ? Promise.resolve() : rm(own, { recursive: true, force: true }),
  };
};
