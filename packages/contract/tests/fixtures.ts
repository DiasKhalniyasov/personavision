import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings, Run, RunArtifact, Session } from '../src/index.js';
import { runPaths } from '../src/index.js';

/**
 * A valid run artifact, built here rather than read from disk: the committed example run
 * is produced by its own ticket, through this package's writer.
 */

/** `screenshots/<variant>/<step>.png`, as `run.json` records it. */
const screenshotPath = (variant: string, step: string): string =>
  runPaths('').screenshot(variant, step);

const RUN_ID = '2026-10-24-1402-northwind-demo';
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

export const validRun = (): Run => ({
  schemaVersion: 1,
  runId: RUN_ID,
  createdAt: '2026-10-24T14:02:00.000Z',
  task: { id: 'buy-boots', prompt: 'Buy the Ridgeline hiking boots in size 43.' },
  variants: [
    { id: 'A', name: 'Current checkout', url: 'https://example.test/a/cart' },
    { id: 'B', name: 'Redesigned checkout', url: 'https://example.test/b/cart' },
  ],
  steps: [
    { id: CART, label: 'Cart' },
    { id: CONFIRM, label: 'Confirmation' },
  ],
  personas: [{ id: 'rushed-buyer', name: 'Rushed buyer', traits: traits(), device: device() }],
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
  },
  calibration: null,
});

export const validSession = (sessionId: string, variant: string): Session => ({
  schemaVersion: 1,
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
  schemaVersion: 1,
  runId: RUN_ID,
  findings: [
    {
      id: 'F-01',
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

/** A temporary run directory, and the callback to throw it away again. */
export const temporaryRunDir = async (): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), 'personavision-contract-'));
  return {
    dir: join(root, 'runs', RUN_ID),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

export { RUN_ID, CHECKOUT_AOI, COMPLETE_AOI, CART, CONFIRM };
