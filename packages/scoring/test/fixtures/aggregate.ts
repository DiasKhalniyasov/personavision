import { SCHEMA_VERSION, type Run, type Session } from '@personavision/contract';

/**
 * The run the aggregate step is built on, and the hundred-session run it is sized against.
 *
 * Two fixtures, written here once and read by the four figure tickets of this step (#289,
 * #290, #291 and #292) without any of them editing this file:
 *
 * 1. **The small run** — six people over four steps on two versions, whose every figure can
 *    be counted by hand. It carries, on purpose, every edge case the figures have to get
 *    right: a success, an abandonment, a failure, an automation failure, a revisit made by
 *    a `back` action, **a screen nobody looked at**, two segments, and a (version, segment)
 *    combination no session falls in.
 * 2. **The hundred-session run** — a path-1 test of one URL with the segment spread of the
 *    prototype's audience, for the size and agreement tests. Its figures are not hand-known
 *    and are not meant to be: what it is for is scale.
 *
 * Both are built from the same session builder, so neither can drift into a shape the other
 * does not have, and both parse against `@personavision/contract`.
 */

/** The four steps of the test, as `run.steps` declares and orders them. */
export const AGGREGATE_STEPS: Run['steps'] = [
  { id: 'landing', label: 'Landing' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'generate', label: 'Generate' },
  { id: 'preview', label: 'Preview' },
];

const PHONE: NonNullable<Session['persona']> = {
  id: 'phone',
  traits: {
    persistence: 0.6,
    scanningVsReading: 0.7,
    detailOrientation: 0.4,
    interfaceFamiliarity: 0.5,
    patience: 0.5,
    riskTolerance: 0.5,
  },
  device: {
    name: 'iPhone 15',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    touch: true,
  },
};

const DESKTOP: NonNullable<Session['persona']> = {
  id: 'desktop',
  traits: {
    persistence: 0.5,
    scanningVsReading: 0.4,
    detailOrientation: 0.7,
    interfaceFamiliarity: 0.8,
    patience: 0.6,
    riskTolerance: 0.4,
  },
  device: {
    name: 'Desktop 1440',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    touch: false,
  },
};

/** The two segments the people of these runs carry, as `personas[].segment` labels them. */
export const PHONE_SEGMENT = 'phone';
export const DESKTOP_SEGMENT = 'desktop';

const REASONS: Readonly<Record<Session['outcome']['status'], string>> = {
  success: 'the video was generated',
  abandoned: 'gave up waiting for the render',
  failed: 'the prompt was rejected',
  automation_failure: 'the generate selector timed out',
};

/** One screen of a fixture session, with the clock written down rather than derived. */
interface Visit {
  readonly step: string;
  /**
   * When the fixations on this screen landed, in session time. **An empty list is a screen
   * nobody looked at**, which is the case the step walk exists to get right.
   */
  readonly looksAtMs: readonly number[];
  /** Clicks made on this screen; `aoiId: null` is a click that landed on nothing. */
  readonly clicks?: ReadonlyArray<{
    readonly tMs: number;
    readonly aoiId: string | null;
    readonly ok?: boolean;
  }>;
  /** A `back` action at this time: how a revisit is written down in the data. */
  readonly backAtMs?: number;
  /** Scrolls made on this screen, as the page position they reached. */
  readonly scrolls?: ReadonlyArray<{ readonly tMs: number; readonly toY: number }>;
  /** Where the page was when the screen was captured. */
  readonly scrollY?: number;
}

interface SessionSpec {
  readonly sessionId: string;
  readonly variant: string;
  readonly personaId: string;
  readonly segment: string;
  readonly seed: number;
  readonly status: Session['outcome']['status'];
  /** The session's own clock, which the last screen's span ends at. */
  readonly durationMs: number;
  readonly visits: readonly Visit[];
}

/** `variant-step-what`: the id scheme the engine's `aoiId` uses, restated for the fixture. */
const aoiId = (variant: string, step: string, what: string): string =>
  `${variant.toLowerCase()}-${step}-${what}`;

/**
 * A session that reads exactly the way its spec says: the fixations land when the spec says
 * they land, the actions happen when it says they happen, and nothing is random.
 */
const buildSession = (spec: SessionSpec): Session => {
  const screens: Session['screens'] = spec.visits.map((visit, index) => ({
    index,
    step: visit.step,
    screenshot: `screens/${spec.variant}-${visit.step}.png`,
    scrollY: visit.scrollY ?? 0,
    intent: `get past ${visit.step}`,
    decidedAction: `use the control on ${visit.step}`,
  }));

  const fixations: Session['fixations'] = spec.visits
    .flatMap((visit, screenIndex) =>
      visit.looksAtMs.map((tMs) => ({ screenIndex, tMs, step: visit.step })),
    )
    .sort((a, b) => a.tMs - b.tMs)
    .map((look, index) => ({
      index,
      screenIndex: look.screenIndex,
      tMs: look.tMs,
      durationMs: 250,
      x: 180,
      y: 320,
      pageX: 180,
      pageY: 320,
      aoiId: aoiId(spec.variant, look.step, 'body'),
    }));

  const actions: Session['actions'] = spec.visits
    .flatMap((visit): Session['actions'] => [
      ...(visit.clicks ?? []).map((click) => ({
        tMs: click.tMs,
        type: 'click' as const,
        target: click.aoiId === null ? null : `#${click.aoiId}`,
        aoiId: click.aoiId,
        value: null,
        ok: click.ok ?? true,
      })),
      ...(visit.scrolls ?? []).map((scroll) => ({
        tMs: scroll.tMs,
        type: 'scroll' as const,
        target: null,
        aoiId: null,
        value: String(scroll.toY),
        ok: true,
      })),
      ...(visit.backAtMs === undefined
        ? []
        : [
            {
              tMs: visit.backAtMs,
              type: 'back' as const,
              target: null,
              aoiId: null,
              value: null,
              ok: true,
            },
          ]),
    ])
    .concat(
      spec.status === 'abandoned'
        ? [
            {
              tMs: spec.durationMs,
              type: 'abandon' as const,
              target: null,
              aoiId: null,
              value: null,
              ok: true,
            },
          ]
        : spec.status === 'success'
          ? []
          : [
              {
                tMs: spec.durationMs,
                type: 'click' as const,
                target: '#generate',
                aoiId: null,
                value: null,
                ok: false,
              },
            ],
    )
    .sort((a, b) => a.tMs - b.tMs);

  const lastVisit = spec.visits[spec.visits.length - 1];
  if (lastVisit === undefined) throw new Error(`${spec.sessionId} walked no screens`);
  const isAutomationFailure = spec.status === 'automation_failure';

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: spec.sessionId,
    runId: 'aggregate-fixture-run',
    variant: spec.variant,
    taskId: 'generate-a-video',
    kind: 'simulated',
    persona: {
      id: spec.personaId,
      traits: (spec.segment === PHONE_SEGMENT ? PHONE : DESKTOP).traits,
      device: (spec.segment === PHONE_SEGMENT ? PHONE : DESKTOP).device,
    },
    participant: null,
    seed: spec.seed,
    startedAt: '2026-11-03T09:00:00.000Z',
    durationMs: spec.durationMs,
    screens,
    fixations,
    saccades: [],
    actions,
    outcome: {
      status: spec.status,
      step: lastVisit.step,
      reason: REASONS[spec.status],
      attribution: isAutomationFailure ? 'automation' : 'product',
      excludedFromScores: isAutomationFailure,
    },
    integrity: { selectorFailures: isAutomationFailure ? 1 : 0, retries: 0 },
  };
};

/** Two areas per screen: the control that advances the step, and the body around it. */
const aoisOf = (variants: readonly string[]): Run['aois'] =>
  variants.flatMap((variant) =>
    AGGREGATE_STEPS.flatMap((step) => [
      {
        id: aoiId(variant, step.id, 'body'),
        variant,
        step: step.id,
        label: `${step.label} copy`,
        source: 'dom' as const,
        role: 'text',
        bbox: { x: 24, y: 120, width: 342, height: 200 },
        isPrimaryAction: false,
        belowFold: false,
      },
      {
        id: aoiId(variant, step.id, 'primary'),
        variant,
        step: step.id,
        label: `${step.label} button`,
        source: 'dom' as const,
        role: 'button',
        bbox: { x: 24, y: 520, width: 342, height: 56 },
        isPrimaryAction: true,
        belowFold: false,
      },
    ]),
  );

const screenshotsOf = (variants: readonly string[]): Run['screenshots'] =>
  variants.flatMap((variant) =>
    AGGREGATE_STEPS.map((step) => ({
      variant,
      step: step.id,
      path: `screens/${variant}-${step.id}.png`,
      viewport: { width: 390, height: 844 },
      pageHeight: 1600,
      foldY: 844,
    })),
  );

/**
 * The `scores[]` row of one version, counted off the sessions themselves rather than
 * written out, so the run cannot carry a completion rate its own sessions disagree with —
 * which is the agreement #292 tests the aggregate against.
 */
const scoreOf = (variant: string, sessions: readonly Session[]): Run['scores'][number] => {
  const mine = sessions.filter((session) => session.variant === variant);
  const counted = (status: Session['outcome']['status']): number =>
    mine.filter((session) => session.outcome.status === status).length;
  const outcomeCounts = {
    success: counted('success'),
    abandoned: counted('abandoned'),
    failed: counted('failed'),
    automationFailure: counted('automation_failure'),
  };
  const scoredSessionCount = outcomeCounts.success + outcomeCounts.abandoned + outcomeCounts.failed;
  return {
    variant,
    taskId: 'generate-a-video',
    frictionScore: { median: 42, sd: 4 },
    completionRate: scoredSessionCount === 0 ? 0 : outcomeCounts.success / scoredSessionCount,
    components: {
      taskFailureRate: 0.2,
      abandonment: 0.3,
      timeToFirstFixationPrimary: { worstStep: 'generate', medianSeconds: 2.4, value: 0.4 },
      deadEndRevisits: 0.1,
    },
    outcomeCounts,
    scoredSessionCount,
    perSeedGroup: [{ seed: 1, frictionScore: 42 }],
  };
};

const VERDICT: Run['verdict'] = {
  harderVariant: 'B',
  gapPoints: 12,
  bandsDisjoint: false,
  seedGroupsAgreeing: 1,
  sentence: 'Version B is harder. The gap held in 1 seed group.',
  preferredVariant: 'A',
  audienceSentence: 'Your audience gets the video out of the current flow.',
  reasons: ['Most of them gave up while the render was running.'],
  headlineFindingIds: [],
  heroEvidence: { variant: 'A', step: 'prompt', aoiId: 'a-prompt-primary' },
};

const audienceOf = (size: number, phoneShare: number): Run['audience'] => ({
  id: 'video-makers',
  name: 'People making a short video',
  ageRange: { min: 18, max: 44 },
  roles: ['creator'],
  regions: ['United Kingdom'],
  goals: ['generate a video from a prompt'],
  devices: [
    { ...PHONE.device, share: phoneShare },
    { ...DESKTOP.device, share: Math.round((1 - phoneShare) * 100) / 100 },
  ],
  techSavviness: 0.6,
  priceSensitivity: 0.4,
  size,
  generatedFrom: { seed: 1, generatorVersion: 'aggregate-fixture-1' },
});

const runOf = (
  runId: string,
  variants: Run['variants'],
  people: ReadonlyArray<{ readonly id: string; readonly segment: string }>,
  sessions: readonly Session[],
  audience: Run['audience'],
): Run => ({
  schemaVersion: SCHEMA_VERSION,
  runId,
  createdAt: '2026-11-03T08:59:00.000Z',
  status: 'finished',
  startedAt: '2026-11-03T09:00:00.000Z',
  finishedAt: '2026-11-03T09:20:00.000Z',
  task: { id: 'generate-a-video', prompt: 'Make a ten-second video of a city at night' },
  variants,
  steps: AGGREGATE_STEPS,
  stepCaptions: [],
  audience,
  personas: people.map((person) => ({
    id: person.id,
    name: `Person ${person.id}`,
    audienceId: audience.id,
    segment: person.segment,
    traits: (person.segment === PHONE_SEGMENT ? PHONE : DESKTOP).traits,
    device: (person.segment === PHONE_SEGMENT ? PHONE : DESKTOP).device,
  })),
  seedGroups: [1],
  engine: {
    mode: 'offline',
    provider: null,
    models: null,
    weights: { alpha: 1, beta: 1, gamma: 1 },
    version: 'aggregate-fixture-1',
  },
  sessionIds: sessions.map((session) => session.sessionId),
  screenshots: screenshotsOf(variants.map((variant) => variant.id)),
  aois: aoisOf(variants.map((variant) => variant.id)),
  aoiMetrics: [],
  scores: variants.map((variant) => scoreOf(variant.id, sessions)),
  verdict: VERDICT,
  calibration: null,
});

/**
 * The six sessions of the small run, with the clock of each one written out.
 *
 * | session | version | segment | outcome             | what it is here for                 |
 * | ------- | ------- | ------- | ------------------- | ----------------------------------- |
 * | S-01    | A       | phone   | success             | the ordinary walk, all four steps   |
 * | S-02    | A       | phone   | abandoned           | gave up on the third step           |
 * | S-03    | A       | desktop | failed              | the only desktop session scored     |
 * | S-04    | B       | phone   | success             | a `back` revisit: prompt twice      |
 * | S-05    | B       | desktop | automation_failure  | excluded from every figure          |
 * | S-06    | B       | phone   | abandoned           | a screen nobody looked at           |
 *
 * Because the one desktop session that counts is on version A, the pair *(B, desktop)* is a
 * combination no session falls in — which is how the slice enumeration's rule that an empty
 * combination is not a slice is reachable from the fixture.
 */
const SMALL_RUN_SPECS: readonly SessionSpec[] = [
  {
    sessionId: 'S-01',
    variant: 'A',
    personaId: 'P-1',
    segment: PHONE_SEGMENT,
    seed: 1,
    status: 'success',
    durationMs: 20_000,
    visits: [
      { step: 'landing', looksAtMs: [200, 800] },
      { step: 'prompt', looksAtMs: [4000], clicks: [{ tMs: 8000, aoiId: 'a-prompt-primary' }] },
      { step: 'generate', looksAtMs: [9000], clicks: [{ tMs: 14_000, aoiId: null }] },
      { step: 'preview', looksAtMs: [15_000], scrollY: 300, scrolls: [{ tMs: 16_000, toY: 300 }] },
    ],
  },
  {
    sessionId: 'S-02',
    variant: 'A',
    personaId: 'P-2',
    segment: PHONE_SEGMENT,
    seed: 1,
    status: 'abandoned',
    durationMs: 12_000,
    visits: [
      { step: 'landing', looksAtMs: [100] },
      { step: 'prompt', looksAtMs: [3000], clicks: [{ tMs: 6000, aoiId: 'a-prompt-primary' }] },
      { step: 'generate', looksAtMs: [7000] },
    ],
  },
  {
    sessionId: 'S-03',
    variant: 'A',
    personaId: 'P-3',
    segment: DESKTOP_SEGMENT,
    seed: 1,
    status: 'failed',
    durationMs: 6000,
    visits: [
      { step: 'landing', looksAtMs: [150] },
      {
        step: 'prompt',
        looksAtMs: [2000],
        clicks: [{ tMs: 5000, aoiId: 'a-prompt-primary', ok: false }],
      },
    ],
  },
  {
    sessionId: 'S-04',
    variant: 'B',
    personaId: 'P-4',
    segment: PHONE_SEGMENT,
    seed: 1,
    status: 'success',
    durationMs: 25_000,
    visits: [
      { step: 'landing', looksAtMs: [200] },
      { step: 'prompt', looksAtMs: [3000], clicks: [{ tMs: 7000, aoiId: 'b-prompt-primary' }] },
      { step: 'generate', looksAtMs: [8000], backAtMs: 12_500 },
      { step: 'prompt', looksAtMs: [13_000], clicks: [{ tMs: 17_000, aoiId: 'b-prompt-primary' }] },
      { step: 'preview', looksAtMs: [18_000], scrollY: 120 },
    ],
  },
  {
    sessionId: 'S-05',
    variant: 'B',
    personaId: 'P-5',
    segment: DESKTOP_SEGMENT,
    seed: 1,
    status: 'automation_failure',
    durationMs: 4000,
    visits: [
      { step: 'landing', looksAtMs: [100] },
      { step: 'prompt', looksAtMs: [1500] },
    ],
  },
  {
    sessionId: 'S-06',
    variant: 'B',
    personaId: 'P-6',
    segment: PHONE_SEGMENT,
    seed: 1,
    status: 'abandoned',
    durationMs: 10_000,
    visits: [
      { step: 'landing', looksAtMs: [100] },
      { step: 'prompt', looksAtMs: [2000], clicks: [{ tMs: 4000, aoiId: 'b-prompt-primary' }] },
      // The screen nobody looked at: reached, and nothing measured on it.
      { step: 'generate', looksAtMs: [] },
      { step: 'preview', looksAtMs: [6000] },
    ],
  },
];

/** The six sessions above, in session-id order, as `run.sessionIds` lists them. */
export const smallRunSessions: readonly Session[] = SMALL_RUN_SPECS.map(buildSession);

/** The small run itself: two versions, six people, two segments. */
export const smallRun: Run = runOf(
  'aggregate-fixture-run',
  [
    { id: 'A', name: 'Current flow', url: 'http://localhost:4173/a' },
    { id: 'B', name: 'Redesign candidate', url: 'http://localhost:4173/b' },
  ],
  SMALL_RUN_SPECS.map((spec) => ({ id: spec.personaId, segment: spec.segment })),
  smallRunSessions,
  audienceOf(SMALL_RUN_SPECS.length, 0.67),
);

/** How many people the big run is of, and how many of them our own harness broke. */
const HUNDRED = 100;
/**
 * The sessions the harness broke, by position. Two of them are on a phone and five on a
 * desktop, which leaves **67 phone and 26 desktop sessions scored** — the spread the
 * prototype's own filter buttons read (`#screen-funnel`).
 */
const AUTOMATION_FAILURES = new Set([3, 11, 72, 78, 84, 90, 96]);
/** The first 69 people are on a phone, which is the audience's own device mix. */
const PHONE_PEOPLE = 69;

/**
 * A hundred sessions of a **path-1 test** — one URL, one version — with the segment spread
 * of the prototype's audience, for the size, agreement and determinism tests of #292.
 *
 * Everything about it is derived from the session's position, so the same builder always
 * produces the same run: how far the person got, what became of them, when they looked and
 * where they clicked. Its figures are not hand-known; the small run above is the one whose
 * numbers are counted by hand.
 */
export const buildHundredSessionRun = (): { run: Run; sessions: Session[] } => {
  const specs: SessionSpec[] = Array.from({ length: HUNDRED }, (_unused, position) => {
    const reached = 1 + (position % AGGREGATE_STEPS.length);
    const broke = AUTOMATION_FAILURES.has(position);
    const status: Session['outcome']['status'] = broke
      ? 'automation_failure'
      : reached === AGGREGATE_STEPS.length
        ? 'success'
        : position % 3 === 0
          ? 'failed'
          : 'abandoned';
    const visits = AGGREGATE_STEPS.slice(0, reached).map((step, index) => ({
      step: step.id,
      looksAtMs: [index * 5000 + 500, index * 5000 + 1500],
      clicks:
        index + 1 < reached
          ? [
              {
                tMs: index * 5000 + 2000,
                aoiId: position % 5 === 0 ? null : aoiId('A', step.id, 'primary'),
              },
            ]
          : [],
      scrolls: position % 3 === 0 ? [{ tMs: index * 5000 + 2500, toY: 400 }] : [],
      scrollY: position % 3 === 0 ? 400 : 0,
    }));
    return {
      sessionId: `S-${String(position + 1).padStart(2, '0')}`,
      variant: 'A',
      personaId: `P-${String(position + 1).padStart(3, '0')}`,
      segment: position < PHONE_PEOPLE ? PHONE_SEGMENT : DESKTOP_SEGMENT,
      seed: 1,
      status,
      durationMs: reached * 5000 + (position % 7) * 250,
      visits,
    };
  });

  const sessions = specs.map(buildSession);
  const run = runOf(
    'aggregate-hundred-run',
    [{ id: 'A', name: 'The current page', url: 'http://localhost:4173/a' }],
    specs.map((spec) => ({ id: spec.personaId, segment: spec.segment })),
    sessions,
    audienceOf(HUNDRED, 0.69),
  );
  return { run, sessions };
};
