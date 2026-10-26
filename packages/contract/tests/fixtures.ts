import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Audience,
  Findings,
  ModelMode,
  Run,
  RunArtifact,
  RunProgress,
  Session,
  SessionProgress,
} from '../src/index.js';
import { runPaths, SCHEMA_VERSION, ZERO_USAGE } from '../src/index.js';

/**
 * A valid run artifact, built here rather than read from disk: the committed example run
 * is produced by its own ticket, through this package's writer.
 */

/** `screenshots/<variant>/<step>.png`, as `run.json` records it. */
const screenshotPath = (variant: string, step: string): string =>
  runPaths('').screenshot(variant, step);

const RUN_ID = '2026-10-24-1402-northwind-demo';
const AUDIENCE_ID = 'outdoor-gear-shoppers';
const FINDING_ID = 'F-01';
const CART = 'cart';
const CONFIRM = 'confirm';
const CHECKOUT_AOI = 'a-cart-checkout';
const COMPLETE_AOI = 'b-confirm-complete';

/** Fresh every call: a test that mutates a fixture must not reach the next one. */
const device = () => ({
  name: 'Desktop 1440',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
});

/**
 * The audience the run was started for, copied into the artifact by value. One persona is
 * generated from it here, so its `size` is one: the size is how many people it generates.
 */
const audience = (): Audience => ({
  id: AUDIENCE_ID,
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['First-time buyer', 'Returning customer'],
  regions: ['United Kingdom', 'Ireland'],
  goals: ['Buy one item quickly', 'Compare prices first'],
  devices: [
    { ...device(), share: 0.6 },
    {
      name: 'Mobile 390',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
      share: 0.4,
    },
  ],
  techSavviness: 0.55,
  priceSensitivity: 0.75,
  size: 1,
  generatedFrom: { seed: 20_261_024, generatorVersion: 'persona-gen-1' },
});

const traits = () => ({
  persistence: 0.6,
  scanningVsReading: 0.4,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.7,
  patience: 0.3,
  riskTolerance: 0.5,
});

const score = (variant: string, median: number) => ({
  variant,
  taskId: 'buy-boots',
  frictionScore: { median, sd: 3 },
  // One scored session, and it completed: the rate the counts underneath it state.
  completionRate: 1,
  components: {
    taskFailureRate: 0.1,
    abandonment: 0.2,
    timeToFirstFixationPrimary: { worstStep: CONFIRM, medianSeconds: 2.3, value: 0.38 },
    deadEndRevisits: 0.15,
  },
  outcomeCounts: { success: 1, abandoned: 0, failed: 0, automationFailure: 0 },
  scoredSessionCount: 1,
  perSeedGroup: [{ seed: 1, frictionScore: median }],
});

const STARTED_AT = '2026-10-24T14:02:05.000Z';
const FINISHED_AT = '2026-10-24T14:03:30.000Z';

/**
 * One finished session as the run's progress log records it: the same person, seed and
 * outcome as `validSession`, because the log is about the sessions that are on disk.
 */
export const finishedEntry = (sessionId: string, variant: string): SessionProgress => ({
  sessionId,
  personaName: 'Rushed buyer',
  variant,
  seed: 1,
  finishedAt: '2026-10-24T14:02:48.000Z',
  durationMs: 38_000,
  status: 'success',
  step: CONFIRM,
  reason: 'Order placed.',
  attribution: 'product',
});

/** Both sessions of `validArtifact`, finished: one per variant, and the counts to match. */
export const finishedProgress = (): RunProgress => ({
  totalSessions: 2,
  finishedSessions: 2,
  perVariant: [
    { variant: 'A', totalSessions: 1, finishedSessions: 1 },
    { variant: 'B', totalSessions: 1, finishedSessions: 1 },
  ],
  sessions: [finishedEntry('S-01', 'A'), finishedEntry('S-02', 'B')],
});

export const validRun = (): Run => ({
  schemaVersion: SCHEMA_VERSION,
  runId: RUN_ID,
  createdAt: '2026-10-24T14:02:00.000Z',
  status: 'finished',
  startedAt: STARTED_AT,
  finishedAt: FINISHED_AT,
  progress: finishedProgress(),
  // The offline engine makes no model calls, and zero is recorded rather than left unknown.
  usage: { ...ZERO_USAGE },
  task: { id: 'buy-boots', prompt: 'Buy the Ridgeline hiking boots in size 43.' },
  variants: [
    { id: 'A', name: 'Current checkout', url: 'https://example.test/a/cart' },
    { id: 'B', name: 'Redesigned checkout', url: 'https://example.test/b/cart' },
  ],
  steps: [
    { id: CART, label: 'Cart' },
    { id: CONFIRM, label: 'Confirmation' },
  ],
  stepCaptions: [
    { variant: 'A', step: CART, caption: 'Variant A, cart. Two people read the total.' },
  ],
  audience: audience(),
  personas: [
    {
      id: 'rushed-buyer',
      name: 'Rushed buyer',
      audienceId: AUDIENCE_ID,
      segment: 'desktop · price-sensitive',
      traits: traits(),
      device: device(),
    },
  ],
  seedGroups: [1, 2],
  engine: {
    mode: 'offline',
    provider: null,
    models: null,
    weights: { alpha: 0.35, beta: 0.35, gamma: 0.3 },
    version: 'seed-fixture',
  },
  sessionIds: ['S-01', 'S-02'],
  screenshots: [
    {
      variant: 'A',
      step: CART,
      path: screenshotPath('A', CART),
      viewport: device().viewport,
      pageHeight: 1800,
      foldY: 900,
    },
    {
      variant: 'B',
      step: CONFIRM,
      path: screenshotPath('B', CONFIRM),
      viewport: device().viewport,
      pageHeight: 1600,
      foldY: 900,
    },
  ],
  aois: [
    {
      id: CHECKOUT_AOI,
      variant: 'A',
      step: CART,
      label: 'Checkout',
      source: 'dom',
      role: 'button',
      bbox: { x: 1080, y: 620, width: 220, height: 48 },
      isPrimaryAction: true,
      belowFold: false,
    },
    {
      id: COMPLETE_AOI,
      variant: 'B',
      step: CONFIRM,
      label: 'Complete order',
      source: 'a11y',
      role: 'button',
      bbox: { x: 1080, y: 1240, width: 220, height: 48 },
      isPrimaryAction: true,
      belowFold: true,
    },
  ],
  aoiMetrics: [
    {
      aoiId: CHECKOUT_AOI,
      timeToFirstFixationMs: 1400,
      firstFixationDurationMs: 520,
      totalDwellMs: 760,
      fixationCount: 2,
      revisits: 1,
      lookedAtShare: 1,
      sessionCount: 1,
    },
    {
      // Never fixated on variant B: a result, not missing data.
      aoiId: COMPLETE_AOI,
      timeToFirstFixationMs: null,
      firstFixationDurationMs: null,
      totalDwellMs: 0,
      fixationCount: 0,
      revisits: 0,
      lookedAtShare: 0,
      sessionCount: 1,
    },
  ],
  scores: [score('A', 22), score('B', 67)],
  verdict: {
    harderVariant: 'B',
    gapPoints: 45,
    bandsDisjoint: true,
    seedGroupsAgreeing: 2,
    sentence: 'Variant B is harder, by 45 points.',
    preferredVariant: 'A',
    audienceSentence:
      'Your audience completes the purchase on the current checkout, not on the redesign.',
    reasons: ['The button that completes the order was never seen on the redesign.'],
    headlineFindingIds: [FINDING_ID],
    heroEvidence: { variant: 'B', step: CONFIRM, aoiId: COMPLETE_AOI },
  },
  calibration: null,
});

/**
 * The same run, run against a model: the engine block a non-zero bill and a recorded model
 * mode belong to. The two model ids are the ones the owner's per-run mode chooses between,
 * and `engine.modelMode` says which of them was called without anybody parsing the id.
 */
export const onTheModel = (run: Run, modelMode: ModelMode = 'standard'): Run => {
  const decision = modelMode === 'contributor' ? 'muse-spark-1.3-contributor' : 'muse-spark-1.3';
  return {
    ...run,
    engine: {
      ...run.engine,
      mode: 'model',
      provider: 'meta-model-api',
      modelMode,
      models: { decision, segmentation: decision, planning: decision },
    },
  };
};

export const validSession = (sessionId: string, variant: string): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId,
  runId: RUN_ID,
  variant,
  taskId: 'buy-boots',
  kind: 'simulated',
  persona: { id: 'rushed-buyer', traits: traits(), device: device() },
  participant: null,
  seed: 1,
  startedAt: '2026-10-24T14:02:10.000Z',
  durationMs: 38_000,
  screens: [
    {
      index: 0,
      step: CART,
      screenshot: screenshotPath(variant, CART),
      scrollY: 0,
      intent: 'Find the way to pay.',
      decidedAction: 'click Checkout',
    },
  ],
  fixations: [
    {
      index: 0,
      screenIndex: 0,
      tMs: 320,
      durationMs: 310,
      x: 420,
      y: 300,
      pageX: 420,
      pageY: 300,
      aoiId: null,
    },
    {
      index: 1,
      screenIndex: 0,
      tMs: 1400,
      durationMs: 520,
      x: 1180,
      y: 640,
      pageX: 1180,
      pageY: 640,
      aoiId: CHECKOUT_AOI,
    },
    {
      index: 2,
      screenIndex: 0,
      tMs: 2100,
      durationMs: 240,
      x: 1190,
      y: 646,
      pageX: 1190,
      pageY: 646,
      aoiId: CHECKOUT_AOI,
    },
  ],
  saccades: [
    { fromFixation: 0, toFixation: 1, amplitudePx: 820, durationMs: 60 },
    { fromFixation: 1, toFixation: 2, amplitudePx: 12, durationMs: 20 },
  ],
  actions: [
    { tMs: 2400, type: 'click', target: '#checkout', aoiId: CHECKOUT_AOI, value: null, ok: true },
  ],
  outcome: {
    status: 'success',
    step: CONFIRM,
    reason: 'Order placed.',
    attribution: 'product',
    excludedFromScores: false,
  },
  integrity: { selectorFailures: 0, retries: 0 },
});

export const validFindings = (): Findings => ({
  schemaVersion: SCHEMA_VERSION,
  runId: RUN_ID,
  findings: [
    {
      id: FINDING_ID,
      rank: 1,
      severity: 'critical',
      claim: 'Complete order sits below the fold on variant B.',
      evidence: 'No session fixated it; the area is 340 px below the fold at 1440 x 900.',
      variant: 'B',
      step: CONFIRM,
      aoiId: COMPLETE_AOI,
      sessionIds: ['S-02'],
      sessionCount: 1,
      attribution: 'product',
      evidence_link: { screen: 'attention', params: { variant: 'B', step: CONFIRM } },
    },
  ],
});

export const validArtifact = (): RunArtifact => ({
  run: validRun(),
  sessions: [validSession('S-01', 'A'), validSession('S-02', 'B')],
  findings: validFindings(),
});

/**
 * A run that has started and finished nothing: the empty state the Running screen renders,
 * and what the appending writer is handed. Its plan is the two sessions of `validArtifact`,
 * so appending both leaves a run that agrees with its own counts.
 */
export const openRunArtifact = (): RunArtifact => {
  const run: Run = {
    ...validRun(),
    status: 'open',
    startedAt: STARTED_AT,
    progress: {
      totalSessions: 2,
      finishedSessions: 0,
      perVariant: [
        { variant: 'A', totalSessions: 1, finishedSessions: 0 },
        { variant: 'B', totalSessions: 1, finishedSessions: 0 },
      ],
      sessions: [],
    },
    sessionIds: [],
    // Nothing has been scored and nothing has been found yet: a run says what it has.
    scores: [],
    verdict: { ...validRun().verdict, headlineFindingIds: [] },
  };
  // An open run has not finished, so it records no finishing time at all.
  delete run.finishedAt;
  return { run, sessions: [], findings: { ...validFindings(), findings: [] } };
};

/** A temporary run directory, and the callback to throw it away again. */
export const temporaryRunDir = async (): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), 'personavision-contract-'));
  return {
    dir: join(root, 'runs', RUN_ID),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

export { RUN_ID, AUDIENCE_ID, FINDING_ID, CHECKOUT_AOI, COMPLETE_AOI, CART, CONFIRM };
