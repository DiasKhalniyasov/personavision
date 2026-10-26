import { SCHEMA_VERSION, type Run, type Session, type Verdict } from '@personavision/contract';
import type { Aoi, AoiMetric, PlantedDefect, Task, VariantScore } from '../../src/index.js';
import { buildAoiMetrics, buildSession, FIXTURE_PERSONAS, type SessionSpec } from './build.js';

/**
 * The two session sets the whole scoring step is built on: a clean checkout, and the same
 * checkout carrying the three planted defects.
 *
 * They are tuned so that the **real** formula reads what `docs/FLOW.md` section 5's
 * acceptance table requires — clean ≤ 25, defective ≥ 60, a gap of at least 30 points and
 * ± 1σ bands that do not overlap across three seed groups — rather than asserting numbers
 * the formula does not produce. `test/score.test.ts` is where that is checked; if a weight
 * or a normalisation constant changes, those assertions move and these sessions do not.
 *
 * The shape mirrors the example run: four generated personas × three seed groups per
 * variant, with one automation failure in each variant's second group, so a run is
 * eleven scored sessions and one excluded.
 *
 * The three planted defects are written into the data, not into a label:
 *
 * 1. **The primary action of the review step is below the fold and nobody fixates it.**
 *    `b-review-place-order` is `belowFold: true` and no B session ever looks at it, so its
 *    `aoiMetrics` row reports `timeToFirstFixationMs: null` and the component is a full 1.0.
 * 2. **A fee appears after the payment details, and people keep going back to the total.**
 *    The review step of B carries `b-review-fee-row` beside `b-review-total`, and B's
 *    sessions return between the two three to six times each.
 * 3. **A promo banner takes the first fixation and then holds the step.** `b-cart-promo` is
 *    the first area the cart step of B declares, which is the area its sessions open on,
 *    and `BANNER_LINGER` extra consecutive looks at it make it hold two thirds of
 *    everything the step's gaze spends — which is what separates a banner that competes
 *    from a heading that merely sits at the top of a page. Consecutive looks at one area
 *    are one visit, so this adds no dead-end return and the friction scores are unchanged.
 */

const box = (y: number, width: number, height: number): Aoi['bbox'] => ({
  x: 24,
  y,
  width,
  height,
});

interface AoiSpec {
  readonly name: string;
  readonly label: string;
  readonly role: string | null;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isPrimaryAction?: boolean;
  readonly belowFold?: boolean;
}

/**
 * Each step declares the areas it has, in the order the gaze meets them: the first one is
 * where the step opens. Every step a fixture session visits needs two areas that do not
 * advance the task, to alternate between when it goes back to one.
 */
const PAGES: Record<string, Record<string, readonly AoiSpec[]>> = {
  A: {
    cart: [
      { name: 'heading', label: 'Your basket', role: 'heading', y: 96, width: 300, height: 40 },
      { name: 'summary', label: 'Order summary', role: 'text', y: 320, width: 300, height: 160 },
      {
        name: 'checkout',
        label: 'Checkout',
        role: 'button',
        y: 540,
        width: 300,
        height: 56,
        isPrimaryAction: true,
      },
    ],
    payment: [
      { name: 'heading', label: 'Payment', role: 'heading', y: 96, width: 300, height: 40 },
      { name: 'card', label: 'Card number', role: 'textbox', y: 220, width: 300, height: 56 },
      {
        name: 'continue',
        label: 'Continue',
        role: 'button',
        y: 520,
        width: 300,
        height: 56,
        isPrimaryAction: true,
      },
    ],
    review: [
      { name: 'total', label: 'Order total', role: 'text', y: 300, width: 300, height: 48 },
      { name: 'address', label: 'Delivery address', role: 'text', y: 180, width: 300, height: 80 },
      {
        name: 'place-order',
        label: 'Place order',
        role: 'button',
        y: 470,
        width: 300,
        height: 56,
        isPrimaryAction: true,
      },
    ],
    confirm: [
      {
        name: 'heading',
        label: 'Order confirmed',
        role: 'heading',
        y: 150,
        width: 300,
        height: 48,
      },
      { name: 'order-number', label: 'Order number', role: 'text', y: 240, width: 300, height: 40 },
    ],
  },
  B: {
    cart: [
      // The banner the step opens on: planted defect 3.
      { name: 'promo', label: 'Save 15% today', role: 'img', y: 60, width: 342, height: 96 },
      { name: 'heading', label: 'Your basket', role: 'heading', y: 180, width: 300, height: 40 },
      {
        name: 'checkout',
        label: 'Checkout',
        role: 'button',
        y: 620,
        width: 300,
        height: 56,
        isPrimaryAction: true,
      },
    ],
    payment: [
      { name: 'heading', label: 'Payment', role: 'heading', y: 96, width: 300, height: 40 },
      { name: 'card', label: 'Card number', role: 'textbox', y: 220, width: 300, height: 56 },
      {
        name: 'continue',
        label: 'Continue',
        role: 'button',
        y: 540,
        width: 300,
        height: 56,
        isPrimaryAction: true,
      },
    ],
    review: [
      { name: 'total', label: 'Order total', role: 'text', y: 300, width: 300, height: 48 },
      // The fee that was not there before the card was entered: planted defect 2.
      { name: 'fee-row', label: 'Service fee $9.95', role: 'text', y: 360, width: 300, height: 32 },
      {
        name: 'place-order',
        label: 'Place order',
        role: 'button',
        // Past the fold of every device in the fixture audience: planted defect 1.
        y: 1180,
        width: 300,
        height: 56,
        isPrimaryAction: true,
        belowFold: true,
      },
    ],
    confirm: [
      {
        name: 'heading',
        label: 'Order confirmed',
        role: 'heading',
        y: 150,
        width: 300,
        height: 48,
      },
      { name: 'order-number', label: 'Order number', role: 'text', y: 240, width: 300, height: 40 },
    ],
  },
};

/** `variant-step-name`, the id scheme the engine's `aoiId` uses. */
export const fixtureAois: Aoi[] = Object.entries(PAGES).flatMap(([variant, steps]) =>
  Object.entries(steps).flatMap(([step, specs]) =>
    specs.map((spec) => ({
      id: `${variant.toLowerCase()}-${step}-${spec.name}`,
      variant,
      step,
      label: spec.label,
      source: 'dom' as const,
      role: spec.role,
      bbox: box(spec.y, spec.width, spec.height),
      isPrimaryAction: spec.isPrimaryAction ?? false,
      belowFold: spec.belowFold ?? false,
    })),
  ),
);

export const fixtureTask: Task = { id: 'buy-a-tent', prompt: 'Buy the two-person tent' };

/** A row of the table below: the four steps' readings, as `seconds / returns`. */
interface Row {
  readonly sessionId: string;
  readonly personaId: string;
  readonly seed: number;
  readonly status: SessionSpec['status'];
  /** Seconds to the primary action per step, `null` where it was never fixated. */
  readonly seconds: readonly [number | null, number | null, number | null];
  /** Returns to a dead end, all of them on the review step. */
  readonly returns: number;
  /** A session that did not finish stops at the step it stopped at. */
  readonly upTo: 'cart' | 'payment' | 'review' | 'confirm';
}

const STEPS = ['cart', 'payment', 'review', 'confirm'] as const;

/**
 * How many extra consecutive looks the promo banner of B's cart takes. Three, which puts
 * it at two thirds of the step's attention against the control beneath it — comfortably
 * over `scoringConfig.thresholds.competingDwellShare` — while leaving the control's own
 * reading of 1.9–2.2 s room to happen after them.
 */
const BANNER_LINGER = 3;

const toSpec = (variant: string, row: Row): SessionSpec => {
  const reached = STEPS.slice(0, STEPS.indexOf(row.upTo) + 1);
  return {
    sessionId: row.sessionId,
    variant,
    seed: row.seed,
    personaId: row.personaId,
    status: row.status,
    steps: reached.map((step, index) => ({
      step,
      primaryAfterSeconds: row.seconds[index] ?? null,
      deadEndReturns: step === 'review' ? row.returns : 0,
      lingerFixations: variant === 'B' && step === 'cart' ? BANNER_LINGER : 0,
    })),
  };
};

/**
 * The clean checkout. Nine of eleven scored sessions complete, two give up, none fails;
 * the control that advances the review step is found in a couple of seconds and people
 * check the total once or twice.
 */
const CLEAN: readonly Row[] = [
  {
    sessionId: 'S-01',
    personaId: 'P-1',
    seed: 1,
    status: 'success',
    seconds: [1, 1.5, 2.2],
    returns: 1,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-02',
    personaId: 'P-2',
    seed: 1,
    status: 'success',
    seconds: [1.2, 1.4, 2.6],
    returns: 1,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-03',
    personaId: 'P-3',
    seed: 1,
    status: 'success',
    seconds: [0.9, 1.6, 2.4],
    returns: 0,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-04',
    personaId: 'P-4',
    seed: 1,
    status: 'abandoned',
    seconds: [1.1, 1.5, 2.4],
    returns: 2,
    upTo: 'review',
  },
  {
    sessionId: 'S-05',
    personaId: 'P-1',
    seed: 2,
    status: 'success',
    seconds: [1, 1.5, 3],
    returns: 2,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-06',
    personaId: 'P-2',
    seed: 2,
    status: 'success',
    seconds: [1.1, 1.5, 2.8],
    returns: 2,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-07',
    personaId: 'P-3',
    seed: 2,
    status: 'success',
    seconds: [1, 1.5, 3.2],
    returns: 3,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-08',
    personaId: 'P-4',
    seed: 2,
    status: 'automation_failure',
    seconds: [1, 1.5, null],
    returns: 0,
    upTo: 'payment',
  },
  {
    sessionId: 'S-09',
    personaId: 'P-1',
    seed: 3,
    status: 'success',
    seconds: [0.9, 1.4, 1.7],
    returns: 1,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-10',
    personaId: 'P-2',
    seed: 3,
    status: 'success',
    seconds: [1, 1.5, 1.9],
    returns: 0,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-11',
    personaId: 'P-3',
    seed: 3,
    status: 'success',
    seconds: [1.1, 1.5, 1.8],
    returns: 1,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-12',
    personaId: 'P-4',
    seed: 3,
    status: 'abandoned',
    seconds: [1, 1.5, 1.8],
    returns: 2,
    upTo: 'review',
  },
];

/**
 * The same checkout with the three defects planted. Two of eleven scored sessions
 * complete, six give up and three fail; nobody ever looks at the control that places the
 * order, and people go back between the total and the new fee three to six times.
 */
const DEFECTIVE: readonly Row[] = [
  {
    sessionId: 'S-13',
    personaId: 'P-1',
    seed: 1,
    status: 'success',
    seconds: [1.9, 1.7, null],
    returns: 4,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-14',
    personaId: 'P-2',
    seed: 1,
    status: 'abandoned',
    seconds: [2.1, 1.8, null],
    returns: 5,
    upTo: 'review',
  },
  {
    sessionId: 'S-15',
    personaId: 'P-3',
    seed: 1,
    status: 'abandoned',
    seconds: [2, 1.9, null],
    returns: 4,
    upTo: 'review',
  },
  {
    sessionId: 'S-16',
    personaId: 'P-4',
    seed: 1,
    status: 'failed',
    seconds: [2.2, 1.7, null],
    returns: 3,
    upTo: 'review',
  },
  {
    sessionId: 'S-17',
    personaId: 'P-1',
    seed: 2,
    status: 'success',
    seconds: [1.9, 1.8, null],
    returns: 5,
    upTo: 'confirm',
  },
  {
    sessionId: 'S-18',
    personaId: 'P-2',
    seed: 2,
    status: 'abandoned',
    seconds: [2, 1.7, null],
    returns: 6,
    upTo: 'review',
  },
  {
    sessionId: 'S-19',
    personaId: 'P-3',
    seed: 2,
    status: 'abandoned',
    seconds: [2.1, 1.8, null],
    returns: 5,
    upTo: 'review',
  },
  {
    sessionId: 'S-20',
    personaId: 'P-4',
    seed: 2,
    status: 'automation_failure',
    seconds: [2, 1.8, null],
    returns: 0,
    upTo: 'payment',
  },
  {
    sessionId: 'S-21',
    personaId: 'P-1',
    seed: 3,
    status: 'failed',
    seconds: [2, 1.7, null],
    returns: 4,
    upTo: 'review',
  },
  {
    sessionId: 'S-22',
    personaId: 'P-2',
    seed: 3,
    status: 'abandoned',
    seconds: [2.1, 1.8, null],
    returns: 3,
    upTo: 'review',
  },
  {
    sessionId: 'S-23',
    personaId: 'P-3',
    seed: 3,
    status: 'abandoned',
    seconds: [1.9, 1.9, null],
    returns: 5,
    upTo: 'review',
  },
  {
    sessionId: 'S-24',
    personaId: 'P-4',
    seed: 3,
    status: 'failed',
    seconds: [2, 1.8, null],
    returns: 4,
    upTo: 'review',
  },
];

export const cleanVariantSessions: Session[] = CLEAN.map((row) =>
  buildSession(toSpec('A', row), fixtureAois),
);

export const defectiveVariantSessions: Session[] = DEFECTIVE.map((row) =>
  buildSession(toSpec('B', row), fixtureAois),
);

/** Both variants of one run, in session-id order, as `run.sessionIds` lists them. */
export const fixtureSessions: Session[] = [...cleanVariantSessions, ...defectiveVariantSessions];

/** The rows `aggregate` would produce for this run: one per area, both variants. */
export const fixtureAoiMetrics: AoiMetric[] = buildAoiMetrics(fixtureSessions, fixtureAois);

/** The four steps of the checkout, as `run.steps` labels them. */
const RUN_STEPS: Run['steps'] = [
  { id: 'cart', label: 'Basket' },
  { id: 'payment', label: 'Payment' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirmation' },
];

/** The audience these twelve people per variant were generated from. */
const FIXTURE_AUDIENCE: Run['audience'] = {
  id: 'outdoor-gear-shoppers',
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['shopper'],
  regions: ['United Kingdom'],
  goals: ['buy a tent'],
  devices: [
    {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
      share: 0.5,
    },
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 0.5,
    },
  ],
  techSavviness: 0.5,
  priceSensitivity: 0.7,
  size: 4,
  generatedFrom: { seed: 1, generatorVersion: 'fixture-1' },
};

/** A verdict that parses, for a run assembled before #27 can write one. */
const PLACEHOLDER_VERDICT: Verdict = {
  harderVariant: 'B',
  gapPoints: 42.5,
  bandsDisjoint: true,
  seedGroupsAgreeing: 3,
  sentence: 'Variant B is harder. The gap held in all 3 seed groups.',
  preferredVariant: 'A',
  audienceSentence: 'Your audience completes the purchase on the current checkout.',
  reasons: ['Nobody ever looked at the button that completes the order on the redesign.'],
  headlineFindingIds: [],
  heroEvidence: { variant: 'B', step: 'review', aoiId: 'b-review-place-order' },
};

/**
 * The whole fixture as a run artifact, so that what this package produces can be parsed by
 * the schemas that own it rather than only compared against a type.
 *
 * #27 can pass its own verdict in place of the placeholder; everything else — the
 * audience, the four people it generated, the steps, the areas and the metrics — is the
 * same fixture the scores were computed over.
 */
export const buildFixtureRun = (
  scores: readonly VariantScore[],
  verdict: Verdict = PLACEHOLDER_VERDICT,
): Run => ({
  schemaVersion: SCHEMA_VERSION,
  runId: 'fixture-run',
  createdAt: '2026-10-24T14:02:00.000Z',
  task: fixtureTask,
  variants: [
    { id: 'A', name: 'Current checkout', url: 'http://localhost:4173/checkout-a' },
    { id: 'B', name: 'Redesign candidate', url: 'http://localhost:4173/checkout-b' },
  ],
  steps: RUN_STEPS,
  stepCaptions: [],
  audience: FIXTURE_AUDIENCE,
  personas: Object.values(FIXTURE_PERSONAS).map((persona) => ({
    id: persona.id,
    name: `Person ${persona.id}`,
    audienceId: FIXTURE_AUDIENCE.id,
    segment: persona.device.touch ? 'mobile · price-sensitive' : 'desktop · price-sensitive',
    traits: persona.traits,
    device: persona.device,
  })),
  seedGroups: [1, 2, 3],
  engine: {
    mode: 'offline',
    provider: null,
    models: null,
    weights: { alpha: 1, beta: 1, gamma: 1 },
    version: 'fixture-1',
  },
  sessionIds: fixtureSessions.map((session) => session.sessionId),
  screenshots: [],
  aois: fixtureAois,
  aoiMetrics: fixtureAoiMetrics,
  scores: [...scores],
  verdict,
  calibration: null,
});

/**
 * What the defective variant was built with, for the precision and recall the demo step
 * measures (#29). Declared here beside the sessions that carry them so the two cannot
 * drift apart.
 */
export const plantedDefects: PlantedDefect[] = [
  {
    id: 'D-1',
    ruleId: 'never-fixated-primary-action',
    variant: 'B',
    step: 'review',
    aoiId: 'b-review-place-order',
    description: 'The button that places the order sits below the fold and nobody sees it.',
  },
  {
    id: 'D-2',
    ruleId: 'value-changed-between-steps',
    variant: 'B',
    step: 'review',
    aoiId: 'b-review-fee-row',
    description: 'A $9.95 service fee appears only after the card details are entered.',
  },
  {
    id: 'D-3',
    ruleId: 'competing-first-fixation',
    variant: 'B',
    step: 'cart',
    aoiId: 'b-cart-promo',
    description: 'A promo banner takes the first look on the basket step.',
  },
];
