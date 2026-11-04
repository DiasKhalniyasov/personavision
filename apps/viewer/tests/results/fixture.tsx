import { screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import {
  aggregateSchema,
  findingsSchema,
  recommendationsSchema,
  runPaths,
  runSchema,
  SCHEMA_VERSION,
  sessionSchema,
} from '@personavision/contract';
import type {
  Aggregate,
  Findings,
  Persona,
  Recommendation,
  Recommendations,
  Run,
  Session,
} from '@personavision/contract';
import { aggregateComputedAt, composeAggregate, writeUp } from '@personavision/scoring';
import type { Finding } from '@personavision/scoring';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { clearSessionCache } from '../../src/screens/replay/useReplaySession';
import { paths } from '../../src/shell/paths';

/**
 * **One run, shared by the whole walk-through**: a hundred simulated people on one version
 * of the Northwind checkout, with an aggregate, ranked recommendations, a generated
 * write-up and a recording per person — served the way the app serves a run.
 *
 * The step's six screens each have a suite of their own and each proves its own screen.
 * What this fixture exists for is the promises that are **about the six together** and that
 * no single screen can assert: that every citation resolves onto the screen, second and
 * filters it names; that the people our own automation broke are visible, marked and in no
 * figure; that all six are labelled, quiet, reachable at 390 px and still under
 * `prefers-reduced-motion`. Those need one run that all six read, which is this one.
 *
 * **Nothing here is invented where the pipeline has a function for it.** The run is the
 * repository's own hand-authored fixture run with its sessions multiplied up to a hundred,
 * so the people, the steps, the areas of interest and their labels are the ones every other
 * suite knows. The aggregate is **`composeAggregate`'s own output** over those hundred
 * sessions and the write-up is **`writeUp`'s** over those recommendations, so the figures the
 * screens read are the figures the pipeline would have written and no number in this file
 * was typed out by hand twice.
 *
 * Two properties are deliberate and are what the exclusions suite rests on:
 *
 * - **Eight of the hundred are our own automation failing.** They are the fifth template of
 *   the cycle below, so they fall across every seed group and both devices.
 * - **Counting them would move a figure.** 76 of the 92 scored people completed the task,
 *   which is 83%; counted against the hundred it would read 76%. A screen that quietly
 *   included them would therefore print a different number, which is what makes the
 *   assertion worth making (`docs/FLOW.md` section 11).
 */

/** The example run of `tests/fixtures/runs/`, the id every screen suite reads. */
export const RUN_ID = '2026-10-24-1402-northwind-demo';

/** The file names inside a run directory, as the contract spells them. */
const layout = runPaths('');

/** A hundred simulated people, which is what `docs/FLOW.md` section 11 runs by default. */
export const PEOPLE = 100;

/** The one version a path-1 test has: the current checkout. */
export const VARIANT = 'A';

/**
 * The twelve sessions of the committed run that ran on that version, in order: the templates
 * the hundred are drawn from. Nine completed, two gave up on the cart, and one — the ninth —
 * is our own browser automation breaking on the payment step.
 */
const TEMPLATE_IDS = [
  'S-01',
  'S-02',
  'S-03',
  'S-04',
  'S-05',
  'S-06',
  'S-07',
  'S-08',
  'S-09',
  'S-10',
  'S-11',
  'S-12',
] as const;

/** Where each file of this run is served, over the read-only mount of `docs/adr/0001`. */
export const url = {
  run: `/runs/${RUN_ID}/${layout.run}`,
  findings: `/runs/${RUN_ID}/${layout.findings}`,
  aggregate: `/runs/${RUN_ID}/${layout.aggregate}`,
  recommendations: `/runs/${RUN_ID}/${layout.recommendations}`,
  session: (sessionId: string): string => `/runs/${RUN_ID}/${layout.session(sessionId)}`,
  video: (sessionId: string): string => `/runs/${RUN_ID}/${layout.video(sessionId)}`,
} as const;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** `S-001` … `S-100`: the hundred people, in the order the run ran them. */
export const SESSION_IDS: readonly string[] = Array.from(
  { length: PEOPLE },
  (_unused, index) => `S-${pad(index + 1, 3)}`,
);

/** The committed run, parsed with the contract's own schema. */
const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/** The committed run's findings document, as the mount serves it. */
export const seedFindingsDocument = (): Findings =>
  findingsSchema.parse(readRunFile(RUN_ID, layout.findings));

/** The committed run's findings, which a recommendation names and a claim argues from. */
export const seedFindings = (): Finding[] => seedFindingsDocument().findings;

/** One of the twelve templates, parsed. */
const template = (sessionId: string): Session =>
  sessionSchema.parse(readRunFile(RUN_ID, layout.session(sessionId)));

const templates = (): Session[] => TEMPLATE_IDS.map(template);

/**
 * Where each screen of a session begins on its own clock: its first fixation, which is the
 * rule `src/session/timeline.ts` uses — so an offset written from it is the moment the
 * timeline reports for that screen and the two clocks agree about where a screen is.
 */
const screenStarts = (session: Session): number[] =>
  session.screens.map((_screen, index) => {
    const first = session.fixations.find((fixation) => fixation.screenIndex === index);
    return index === 0 ? 0 : (first?.tMs ?? 0);
  });

/**
 * How much longer each cycle of the twelve ran than the one before it.
 *
 * The templates are twelve attempts and a hundred people are not twelve attempts repeated:
 * without this every cycle would land on the same millisecond and the time-per-step
 * distribution would be a single spike. It is a fixed step rather than a random one, so the
 * aggregate composed from these sessions is the same bytes on every run.
 */
const CYCLE_MS = 900;

/**
 * The hundred sessions, each with the recording a run of this product now writes.
 *
 * A session keeps everything its template measured — its screens, its fixations, its
 * actions, its outcome and the attribution the pipeline decided — and changes only what
 * makes it its own person: the id, the persona it is of, and how long it took.
 */
export function hundredSessions(): Session[] {
  const base = templates();

  return SESSION_IDS.map((sessionId, index) => {
    const source = base[index % base.length] as Session;
    const cycle = Math.floor(index / base.length);
    const durationMs = source.durationMs + cycle * CYCLE_MS;

    return sessionSchema.parse({
      ...source,
      sessionId,
      durationMs,
      persona: source.persona === null ? null : { ...source.persona, id: personaId(source, index) },
      video: {
        state: 'recorded',
        path: layout.video(sessionId),
        durationMs,
        truncated: null,
        screenOffsetsMs: screenStarts(source),
        actionOffsetsMs: source.actions.map((action) => action.tMs),
      },
    });
  });
}

/** The same hundred people, recorded by a run of the product before video existed. */
export function unrecordedSessions(): Session[] {
  return hundredSessions().map((session) =>
    sessionSchema.parse({
      ...session,
      video: { state: 'absent', reason: 'this run recorded none' },
    }),
  );
}

/**
 * One generated person's id: their template's kind, numbered by the session they ran.
 *
 * **A hundred people, not a hundred attempts by four of them**: `docs/FLOW.md` section 11
 * sends a hundred participants out, each generated from the audience and each in a browser
 * of its own, so every session here is a person and every person has an id a session file
 * and the Sessions screen can both name.
 */
const personaId = (source: Session, index: number): string =>
  `${source.persona?.id ?? 'someone'}-${pad(index + 1, 3)}`;

/**
 * The hundred people the audience generated: one per session, each keeping its template's
 * traits, its device and — this is the one that matters to every filter on the results page
 * — its **segment**, so a hundred people fall into the committed run's four segments rather
 * than into a hundred of them.
 */
function hundredPersonas(): Persona[] {
  const base = templates();
  const people = seedRun().personas;

  return SESSION_IDS.map((_sessionId, index) => {
    const source = base[index % base.length] as Session;
    const persona = people.find((candidate) => candidate.id === source.persona?.id);
    if (persona === undefined) throw new Error(`${String(source.persona?.id)} is not of this run`);
    return { ...persona, id: personaId(source, index) };
  });
}

/** Who the run excluded from its figures, as the sessions themselves record it. */
export const excludedIds = (sessions: readonly Session[] = hundredSessions()): string[] =>
  sessions
    .filter(
      (session) =>
        session.outcome.excludedFromScores && session.outcome.attribution === 'automation',
    )
    .map((session) => session.sessionId);

/** How many of the sessions ended each of the four ways, counted off the sessions. */
export function outcomeCounts(sessions: readonly Session[]) {
  const of = (status: Session['outcome']['status']): number =>
    sessions.filter((session) => session.outcome.status === status).length;

  return {
    success: of('success'),
    abandoned: of('abandoned'),
    failed: of('failed'),
    automationFailure: of('automation_failure'),
  };
}

/** The progress log a run carries at every stage, over these hundred sessions. */
const progressOf = (run: Run, sessions: readonly Session[]) => ({
  totalSessions: sessions.length,
  finishedSessions: sessions.length,
  perVariant: [
    { variant: VARIANT, totalSessions: sessions.length, finishedSessions: sessions.length },
  ],
  sessions: sessions.map((session) => ({
    sessionId: session.sessionId,
    personaName:
      run.personas.find((persona) => persona.id === session.persona?.id)?.name ?? 'Someone',
    variant: session.variant,
    seed: session.seed,
    finishedAt: run.finishedAt ?? run.createdAt,
    durationMs: session.durationMs,
    status: session.outcome.status,
    step: session.outcome.step,
    reason: session.outcome.reason,
    attribution: session.outcome.attribution,
  })),
});

/** When this run started and stopped: a finished run, which is what a write-up needs. */
const STARTED_AT = '2026-10-24T14:02:00.000Z';
const FINISHED_AT = '2026-10-24T14:31:00.000Z';

/**
 * The hundred-session run: the committed run with everything about its second version taken
 * away and its sessions, its people and its score replaced by the hundred's.
 *
 * It is a **path-1** test (`docs/FLOW.md` section 11) — one version, one score, one set of
 * captures — so the lead is the Summary and the tab bar carries no Score breakdown. The
 * score row is the hundred's own counts, and `completionRate` is the share those counts
 * imply, which is the agreement `runSchema` holds a stored rate to.
 */
export function hundredRun(patch: Partial<Run> = {}): Run {
  const run = seedRun();
  const sessions = hundredSessions();
  const counts = outcomeCounts(sessions);
  const scored = counts.success + counts.abandoned + counts.failed;
  const kept = new Set(run.aois.filter((area) => area.variant === VARIANT).map((area) => area.id));
  const score = run.scores.find((row) => row.variant === VARIANT);
  if (score === undefined) throw new Error(`the committed run has no ${VARIANT} score`);
  const personas = hundredPersonas();

  const composed: Run = runSchema.parse({
    ...run,
    // The audience declares how many participants it generates, and a hundred of them ran.
    audience: { ...run.audience, size: PEOPLE },
    status: 'finished',
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    variants: run.variants.filter((variant) => variant.id === VARIANT),
    scores: [
      {
        ...score,
        completionRate: counts.success / scored,
        outcomeCounts: counts,
        scoredSessionCount: scored,
      },
    ],
    screenshots: run.screenshots.filter((shot) => shot.variant === VARIANT),
    aois: run.aois.filter((area) => area.variant === VARIANT),
    aoiMetrics: run.aoiMetrics.filter((metric) => kept.has(metric.aoiId)),
    stepCaptions: run.stepCaptions.filter((caption) => caption.variant === VARIANT),
    sessionIds: SESSION_IDS,
    personas,
    verdict: {
      ...run.verdict,
      harderVariant: VARIANT,
      preferredVariant: VARIANT,
      heroEvidence: { variant: VARIANT, step: CITED_STEP, aoiId: CITED_AREA },
    },
  });

  return runSchema.parse({ ...composed, progress: progressOf(composed, sessions), ...patch });
}

/** The committed two-version run, which is the shape the tab bar adds Score breakdown for. */
export const twoVersionRun = (): Run => seedRun();

/** The aggregate of a run, composed by the pipeline's own composer over its sessions. */
export const aggregateOf = (run: Run, sessions: readonly Session[]): Aggregate =>
  aggregateSchema.parse(composeAggregate({ run, sessions, computedAt: aggregateComputedAt(run) }));

/** The step and the area every heatmap citation in this fixture names. */
export const CITED_STEP = 'review';
export const CITED_AREA = 'A-review-summary';

/** How much of the run Wonder read, as the sampler stores it. */
export const SAMPLE = {
  read: 40,
  of: 92,
  strategy: 'the slowest and the abandoned, then at random',
  seed: 7,
} as const;

/**
 * What this run says to change: three ranked recommendations whose citations cover all three
 * shapes the contract declares — a person with a second in their recording, a heatmap
 * region, a funnel step.
 *
 * **Not one of them cites a session our own automation broke.** That is the rule of
 * `docs/FLOW.md` section 11 and it is a property of the fixture rather than something a
 * screen filters afterwards, so the walk-through can assert it over every rendered citation
 * of every screen.
 */
export const RECOMMENDATIONS: readonly Recommendation[] = [
  {
    id: 'R-1',
    rank: 1,
    sentence: 'Show the service fee on the cart, before anybody enters a card.',
    evidence:
      'Sixteen people left on the cart when the $9.95 service fee appeared in the order summary.',
    findingIds: ['F-1'],
    citations: [
      { kind: 'session', sessionId: 'S-011', offsetMs: 12_000 },
      { kind: 'session', sessionId: 'S-012', offsetMs: 9_000 },
      { kind: 'heatmap', variant: VARIANT, step: CITED_STEP, aoiId: CITED_AREA },
      { kind: 'funnel', stepId: CITED_STEP },
    ],
    peopleAffected: 16,
    step: CITED_STEP,
  },
  {
    id: 'R-2',
    rank: 2,
    sentence: 'Name the button that completes the order.',
    evidence: 'People read the order summary and then looked for a button that says what it does.',
    findingIds: ['F-2'],
    citations: [
      { kind: 'session', sessionId: 'S-004', offsetMs: 26_300 },
      { kind: 'heatmap', variant: VARIANT, step: CITED_STEP, aoiId: null },
    ],
    peopleAffected: 9,
    step: CITED_STEP,
  },
  {
    id: 'R-3',
    rank: 3,
    sentence: 'Keep the cart total in view while the card is being entered.',
    evidence: 'People went back to the cart from the payment step to check the total.',
    findingIds: ['F-3'],
    citations: [{ kind: 'funnel', stepId: 'payment' }],
    peopleAffected: 6,
    step: 'payment',
  },
];

/** The recommendations document, with the write-up the pipeline generates from it. */
export function hundredRecommendations(run: Run, aggregate: Aggregate): Recommendations {
  const document = recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    sample: SAMPLE,
    recommendations: RECOMMENDATIONS,
  });

  return recommendationsSchema.parse({
    ...document,
    writeUp: writeUp({
      run,
      aggregate,
      recommendations: document.recommendations,
      findings: seedFindings(),
      sample: document.sample,
    }),
  });
}

/** The whole run, composed once: the four files and the hundred sessions that agree. */
export interface HundredRun {
  readonly run: Run;
  readonly sessions: readonly Session[];
  readonly aggregate: Aggregate;
  readonly recommendations: Recommendations;
}

/** The fixture run, every file of it derived from the hundred sessions. */
export function hundred(): HundredRun {
  const run = hundredRun();
  const sessions = hundredSessions();
  const aggregate = aggregateOf(run, sessions);
  return { run, sessions, aggregate, recommendations: hundredRecommendations(run, aggregate) };
}

/** What a test wants served. Everything defaults to the fixture run above. */
export interface ServeOptions {
  readonly run?: Run;
  readonly sessions?: readonly Session[];
  /** The aggregate, or `null` for a run that computed none. */
  readonly aggregate?: Aggregate | null;
  /** The recommendations, or `null` for a run that produced none. */
  readonly recommendations?: Recommendations | null;
  /** Whether the mount answers for the recordings. `false` is a run that recorded none. */
  readonly videos?: boolean;
  /**
   * Paths the mount answers **late**, so that the state a screen is in while it reads them
   * is observable at all. The stub otherwise answers in a microtask, which is a loading
   * state no test can see.
   */
  readonly slow?: readonly string[];
  /** How late, in milliseconds. */
  readonly slowMs?: number;
}

/** What a request for a recording was answered with, so a test can assert the mount is read. */
export interface VideoRequest {
  readonly path: string;
  readonly method: string;
}

/**
 * The fixture run served at the URLs of `docs/adr/0001`, with no server-side computation:
 * the four files on disk, one file per person, and the recordings answered as the mount
 * answers them — a `content-length` for the `HEAD` the outcome card reads, and
 * `accept-ranges`, which is what makes a recording seekable.
 */
export async function serveHundred(options: ServeOptions = {}) {
  const run = options.run ?? hundredRun();
  const sessions = options.sessions ?? hundredSessions();
  const aggregate =
    options.aggregate === undefined ? aggregateOf(run, sessions) : options.aggregate;
  const recommended =
    options.recommendations === undefined
      ? aggregate === null
        ? null
        : hundredRecommendations(run, aggregate)
      : options.recommendations;

  const files: Record<string, string> = { [url.run]: JSON.stringify(run) };
  for (const session of sessions) files[url.session(session.sessionId)] = JSON.stringify(session);

  const missing: string[] = [];
  if (aggregate === null) missing.push(url.aggregate);
  else files[url.aggregate] = JSON.stringify(aggregate);
  if (recommended === null) missing.push(url.recommendations);
  else files[url.recommendations] = JSON.stringify(recommended);

  const served = await serveRunData({ files, missing });

  const underneath = globalThis.fetch;
  const videoRequests: VideoRequest[] = [];
  const videos = options.videos ?? true;
  const slow = new Set(options.slow ?? []);
  const slowMs = options.slowMs ?? 200;

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const asked = new URL(
      String(input instanceof Request ? input.url : input),
      globalThis.location.href,
    );
    if (!asked.pathname.startsWith(`/runs/${RUN_ID}/${layout.videosDir}/`)) {
      if (!slow.has(asked.pathname)) return underneath(input, init);
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(underneath(input, init) as Response | Promise<Response>);
        }, slowMs);
      });
    }
    videoRequests.push({ path: asked.pathname, method: init?.method ?? 'GET' });
    return Promise.resolve(
      videos
        ? new Response(null, {
            status: 200,
            headers: {
              'content-type': 'video/webm',
              'accept-ranges': 'bytes',
              'content-length': '11400000',
            },
          })
        : new Response(`There is no ${asked.pathname} here.\n`, { status: 404 }),
    );
  });

  // `served.requests` is every JSON path the app asked the mount for, in order;
  // `videoRequests` is what it asked about the recordings, which are not JSON.
  return { ...served, run, sessions, aggregate, recommendations: recommended, videoRequests };
}

/**
 * The fixture run served **whole**: the aggregate and the recommendations present, and both
 * narrowed to themselves.
 *
 * `serveHundred` can be asked for a run that composed neither — that is the nothing-recorded
 * state — so its result says they may be absent. A test about a run that recorded everything
 * would otherwise have to re-state that at every figure it reads, which is noise around the
 * assertion that matters; here it is stated once, and loudly, as the fixture's own failure.
 */
export async function serveWhole(options: ServeOptions = {}) {
  const served = await serveHundred(options);
  const { aggregate, recommendations } = served;
  if (aggregate === null) throw new Error('this fixture run composed no aggregate');
  if (recommendations === null) throw new Error('this fixture run produced no recommendations');
  return { ...served, aggregate, recommendations };
}

/** Every file of this run that lands after `run.json`: what a slow read is made of. */
export const laterFiles = (sessions: readonly Session[] = hundredSessions()): string[] => [
  url.aggregate,
  url.recommendations,
  ...sessions.map((session) => url.session(session.sessionId)),
];

/** Every run, session and audience read so far is forgotten, so one test cannot see another's. */
export const forget = (): void => {
  forgetRuns();
  clearSessionCache();
};

/* ---- The six screens --------------------------------------------------- */

/** One of the six results screens: what it is called, where it is, and when it has settled. */
export interface ResultScreen {
  /** The name `docs/FLOW.md` section 14 gives it. */
  readonly name: string;
  readonly path: (runId: string) => string;
  /** Resolves once every file this screen reads has arrived and nothing is holding a space. */
  readonly settled: () => Promise<void>;
}

const settle = async (check: () => void): Promise<void> => {
  await waitFor(check, { timeout: 15_000 });
};

/** The replay the walk-through opens: the first person of the hundred. */
export const FIRST_PERSON = 'S-001';

/**
 * The six screens of `docs/FLOW.md` section 14, in the order a reader meets them. Session
 * replay is the sixth; it is reached from the Sessions grid rather than from the tab bar,
 * which is why the bar carries five.
 */
export const SCREENS: readonly ResultScreen[] = [
  {
    name: 'Summary',
    path: (runId) => paths.run(runId),
    settled: () =>
      settle(() => {
        if (document.querySelector('[data-screen="summary"]') === null) {
          throw new Error('the Summary has not rendered');
        }
        if (document.querySelector('[data-section="headline-figures"][data-state="loading"]')) {
          throw new Error('the figures are still being read');
        }
      }),
  },
  {
    name: 'Sessions',
    path: (runId) => paths.sessions(runId),
    settled: async () => {
      await screen.findByRole('heading', { level: 1 }, { timeout: 15_000 });
      await settle(() => {
        if (document.querySelectorAll('a[aria-label^="S-"]').length === 0) {
          throw new Error('no tile has been drawn');
        }
      });
    },
  },
  {
    name: 'Session replay',
    path: (runId) => paths.session(runId, FIRST_PERSON),
    settled: () =>
      settle(() => {
        if (document.querySelector('#rp-clock') === null) {
          throw new Error('the replay has no clock yet');
        }
        // The outcome card reads this test's findings and its recommendations to say what
        // rests on this person, so the screen is settled once those have answered too.
        if (document.querySelector('[aria-busy="true"]') !== null) {
          throw new Error('the outcome card is still reading');
        }
      }),
  },
  {
    name: 'Heatmaps',
    path: (runId) => paths.attention(runId, VARIANT, CITED_STEP),
    settled: () =>
      settle(() => {
        if (document.querySelector('[data-aoi-row]') === null) {
          throw new Error('the areas table has no rows yet');
        }
        if (document.querySelector('[data-reach="reading"]') !== null) {
          throw new Error('the people are still being read');
        }
      }),
  },
  {
    name: 'Funnel and timing',
    path: (runId) => paths.funnel(runId),
    settled: () =>
      settle(() => {
        if (document.querySelector('[data-funnel="rows"]') === null) {
          throw new Error('the funnel has not rendered');
        }
        // The slowest sessions are read from the session files, which land after the
        // aggregate: the screen is settled when those rows have stopped reading too.
        if (document.querySelector('[data-screen="funnel"] [aria-busy="true"]') !== null) {
          throw new Error('the slowest sessions are still being read');
        }
      }),
  },
  {
    name: 'Analysis',
    path: (runId) => paths.analysis(runId),
    settled: () =>
      settle(() => {
        if (document.querySelector('[data-screen="analysis"]') === null) {
          throw new Error('the Analysis has not rendered');
        }
        if (document.querySelector('[data-analysis="loading"]') !== null) {
          throw new Error('the write-up is still being read');
        }
      }),
  },
];

/** One of the six, by the name section 14 gives it. */
export const screenNamed = (name: string): ResultScreen => {
  const found = SCREENS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`there is no results screen called ${name}`);
  return found;
};

/** The app mounted on one of the six, settled. */
export async function openScreen(one: ResultScreen, runId: string = RUN_ID) {
  const mounted = mountApp(one.path(runId));
  await one.settled();
  return mounted;
}

/** The app mounted on any path of this run, settled on the screen that path leads to. */
export async function openAt(path: string, one: ResultScreen) {
  const mounted = mountApp(path);
  await one.settled();
  return mounted;
}

/** What one screen reads, as one line with its whitespace collapsed. */
export const prose = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/gu, ' ').trim();

/**
 * How many characters of prose mean a screen has finished drawing itself.
 *
 * It is the wait for a state that has no marker of its own — a run that recorded nothing,
 * where three of the six never draw the block their `settled()` waits for. Every one of the
 * six carries its heading, its standfirst and the simulated line, which is comfortably more
 * than this; a screen that had only begun carries less. One constant rather than the number
 * written at each of the places that waits.
 */
export const DRAWN = 200;

/**
 * Which screen of a session's recording a given moment falls in: the last one that had
 * started by then, as the session file's own `screenOffsetsMs` records their starts.
 *
 * Computed here from the file rather than read off the screen, so that an assertion about
 * where a citation landed is an assertion against the run and not against the component.
 */
export const screenAt = (session: Session, offsetMs: number): number => {
  const recording = session.video;
  const offsets: readonly (number | null)[] =
    recording !== undefined && recording.state === 'recorded' ? recording.screenOffsetsMs : [];
  // A screen whose start was never measured is not a screen this moment can fall in.
  const started = offsets.filter((start) => start !== null && start <= offsetMs).length;
  return Math.max(0, started - 1);
};
