/**
 * The session-level harness the behavioural and statistical suites share (#70).
 *
 * The suites in `behaviour.test.ts` and `statistical.test.ts` test the project's *claims*,
 * so they test them the way the product makes them: a capture goes in, a scanpath comes
 * out, and the properties a designer would expect hold. That means neither suite may reach
 * for a term — not `salienceByArea`'s numbers, not `relevanceByArea`'s — on its own. They
 * go through this harness, and this harness goes through `../src/index.js`: the one module
 * `package.json`'s `exports` publishes, so every claim below is made about the package's
 * public surface and a term is free to be refactored underneath it.
 *
 * **What the harness is.** The run loop (#44) that does not exist yet, in the smallest
 * honest form the engine's claims need: build the areas of interest with the default
 * offline segmenter, read the screenshot once, score salience for the persona, then walk
 * the page a screen at a time, sampling each screen with the areas that screen actually
 * shows and threading the session's viewing history through. The answer is a `Session` in
 * the contract's own shape, which `aggregate` then turns into the per-area numbers the
 * screens read — so a claim can be made either about the fixations or about the metric a
 * designer sees, and both run over the same code the pipeline will.
 *
 * **Two rules of the harness are the harness's and not the engine's**, and they are stated
 * here rather than hidden in a test:
 *
 * 1. *What a screen shows.* `sampleFixations` takes "the areas on this screen" and does no
 *    geometry of its own: an area is on a screen when its box intersects the viewport band
 *    the screen is scrolled to. Handing the sampler a whole tall page as one screen would
 *    claim the engine can fixate pixels nobody has scrolled to yet, which is the opposite
 *    of the claim #70 is here to prove.
 * 2. *How far down the page the agent gets.* The persona's `screenPersistenceScale` row of
 *    the trait table decides: an agent at least as persistent as the median one
 *    (`screenPersistenceScale >= 1`) scrolls the page through, and a hurried one stays on
 *    the first screen. Scrolling is the run loop's decision and not the engine's, so this
 *    is the harness's rule — but it is the trait table's number that drives it, never a
 *    constant written here.
 *
 * **Determinism.** No clock and no unseeded draw: `startedAt` is fixed, the session id
 * comes from the seed, and every number in the answer comes from the seeded sampler. The
 * same request therefore produces a byte-identical session, which is what
 * `behaviour.test.ts`'s end-to-end determinism test asserts.
 *
 * **Cost.** Building areas and reading pixels are per capture, not per session, and both
 * are memoised here: a statistical test over forty seeds decodes one screenshot once. The
 * suites' time budget is in `packages/engine/README.md`.
 */

import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION, sessionSchema } from '@personavision/contract';
import type { Session } from '@personavision/contract';
import {
  aggregate,
  buildAois,
  heuristicSegmenter,
  personaSamplingParams,
  readScreenshotPixels,
  resolveEngineConfig,
  salienceByArea,
  sampleFixations,
} from '../src/index.js';
import type {
  Aoi,
  AoiMetric,
  Capture,
  EngineConfigOverrides,
  Goal,
  PersonaTraits,
  SampledFixation,
  SampledSaccade,
  ScreenshotPixels,
} from '../src/index.js';
import { loadFixture } from './fixtures/index.js';
import type { FixtureName } from './fixtures/index.js';

/** One variant, since every claim here is about a page and not about a comparison. */
const VARIANT = 'A';

/**
 * A fixed instant, because a session's `startedAt` is a timestamp and a harness that read
 * the clock would make its own answers unrepeatable. Nothing in the engine reads it.
 */
const STARTED_AT = '2026-01-01T00:00:00.000Z';

/**
 * How many seeds a session's own seed reserves for its screens: one block per session, so
 * that two sessions cannot share a draw. A hundred is far more screens than any page the
 * fixtures carry, and `runSession` says so rather than silently wrapping if one ever does.
 */
const SCREEN_SEED_STRIDE = 100;

/**
 * The fixed seed set every statistical claim is made over: twenty-four, which is a run's
 * worth of sessions (`packages/engine/README.md`), and above the twenty #70 asks for.
 *
 * The seeds are fixed, so a share or a median below is a *number*, not a sample: it is the
 * same on every machine and in every run, and a band that passes once passes forever
 * unless a term moved. That is what makes the bands tolerances on the engine rather than
 * tolerances on the test.
 */
export const SEEDS: readonly number[] = Array.from({ length: 24 }, (_unused, at) => at + 1);

/** The median agent: every trait at the middle of its scale. */
export const MIDDLING: PersonaTraits = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

/** The median agent with one trait moved: how a claim about one row is controlled. */
export const withTrait = (trait: keyof PersonaTraits, value: number): PersonaTraits => ({
  ...MIDDLING,
  [trait]: value,
});

/**
 * Two whole personas, for the claims that are about a person rather than about a row.
 *
 * They differ in every trait the sampler reads: how long a look lasts and how many of them
 * there are (`scanningVsReading`), how long a look at a familiar area dwells
 * (`detailOrientation`, `patience`), how far down the page the agent gets (`persistence`)
 * and which areas the role prior favours (`interfaceFamiliarity`). `riskTolerance` is the
 * same in both because its row — `verificationScale` — reaches no sampling parameter yet,
 * and a persona that pretended otherwise would make a claim nothing could keep.
 */
export const HURRIED_SCANNER: PersonaTraits = {
  persistence: 0.2,
  scanningVsReading: 0.9,
  detailOrientation: 0.2,
  interfaceFamiliarity: 0.9,
  patience: 0.2,
  riskTolerance: 0.5,
};

export const PATIENT_READER: PersonaTraits = {
  persistence: 0.8,
  scanningVsReading: 0.1,
  detailOrientation: 0.9,
  interfaceFamiliarity: 0.1,
  patience: 0.9,
  riskTolerance: 0.5,
};

export interface SessionRequest {
  readonly fixture: FixtureName;
  /** Named, so a test's failure message says which persona was looking. */
  readonly personaId: string;
  readonly persona: PersonaTraits;
  readonly goal: Goal;
  readonly seed: number;
  /** The run's `engine.weights` over the defaults; the sensitivity tests move one. */
  readonly weights?: EngineConfigOverrides;
}

/** A session, and the areas it was sampled over — what `aggregate` needs both of. */
export interface SessionRun {
  readonly session: Session;
  readonly aois: readonly Aoi[];
}

/** The fixture's capture with the committed screenshot's real path, as a reader needs it. */
const captureOf = (fixture: FixtureName): Capture => {
  const { capture, screenshotPath } = loadFixture(fixture);
  return { ...capture, screenshot: screenshotPath };
};

/**
 * The areas of interest, built once per capture with the **default offline segmenter**
 * (#66): a cold clone with no credential and no network builds the same areas, which is
 * what makes the suite's "no API key, no network" criterion a property of the path under
 * test rather than of the test's own wiring.
 */
const areasByFixture = new Map<FixtureName, Promise<readonly Aoi[]>>();

const areasOf = (fixture: FixtureName): Promise<readonly Aoi[]> => {
  const built = areasByFixture.get(fixture);
  if (built !== undefined) return built;
  const building = buildAois({
    capture: captureOf(fixture),
    variant: VARIANT,
    segmenter: heuristicSegmenter(),
  }).then((areas) => areas as readonly Aoi[]);
  areasByFixture.set(fixture, building);
  return building;
};

/** The screenshot decoded once per capture, as `readScreenshotPixels` exists for. */
const pixelsByFixture = new Map<FixtureName, Promise<ScreenshotPixels>>();

const pixelsOf = (fixture: FixtureName): Promise<ScreenshotPixels> => {
  const read = pixelsByFixture.get(fixture);
  if (read !== undefined) return read;
  const reading = readScreenshotPixels(readFileSync(loadFixture(fixture).screenshotPath));
  pixelsByFixture.set(fixture, reading);
  return reading;
};

/**
 * Salience per area, memoised on everything it depends on: the capture, the one trait that
 * reaches it (`interfaceFamiliarity` scales the role prior) and the weights a sensitivity
 * test moved. Two personas that differ in nothing else share one computation.
 */
const salienceByKey = new Map<string, Promise<ReadonlyMap<string, number>>>();

const salienceOf = async (
  fixture: FixtureName,
  traits: PersonaTraits,
  weights: EngineConfigOverrides | undefined,
): Promise<ReadonlyMap<string, number>> => {
  const key = `${fixture}|${traits.interfaceFamiliarity}|${JSON.stringify(weights ?? {})}`;
  const scored = salienceByKey.get(key);
  if (scored !== undefined) return scored;
  const capture = captureOf(fixture);
  const scoring = Promise.all([pixelsOf(fixture), areasOf(fixture)]).then(([screenshot, aois]) =>
    salienceByArea({
      screenshot,
      page: { width: capture.viewport.width, height: capture.pageHeight },
      aois: [...aois],
      traits,
      config: resolveEngineConfig(weights).config,
    }),
  );
  salienceByKey.set(key, scoring);
  return scoring;
};

/**
 * The scroll offsets of the screens this page has, top to bottom: a viewport band at a
 * time, with the last screen resting on the page's bottom edge the way a scrolled page
 * does. A page no taller than the viewport is one screen at offset zero.
 */
const screenOffsets = (capture: Capture): readonly number[] => {
  const band = capture.viewport.height;
  const bottom = Math.max(0, capture.pageHeight - band);
  const offsets: number[] = [];
  for (let top = 0; top < bottom; top += band) offsets.push(top);
  offsets.push(bottom);
  return offsets;
};

/** The areas the screen at `scrollY` shows: the ones whose box meets its viewport band. */
const areasOnScreen = (
  aois: readonly Aoi[],
  scrollY: number,
  viewportHeight: number,
): readonly Aoi[] =>
  aois.filter(
    (area) => area.bbox.y < scrollY + viewportHeight && area.bbox.y + area.bbox.height > scrollY,
  );

/**
 * How many of the page's screens this persona gets to — rule 2 above. The number comes
 * from the persona-trait table through `personaSamplingParams`, so a calibration that
 * refits `screenPersistenceScale` moves this harness with it.
 */
const screensVisited = (
  persona: PersonaTraits,
  capture: Capture,
  weights?: EngineConfigOverrides,
): number => {
  const { config } = resolveEngineConfig(weights);
  const { screenPersistenceScale } = personaSamplingParams(persona, config);
  return screenPersistenceScale >= 1 ? screenOffsets(capture).length : 1;
};

/**
 * One session: the persona driven down the page with the goal, at the seed given.
 *
 * Pure and deterministic — the same request answers a deeply equal session, and nothing
 * here reads a clock, opens a socket or calls a model. The only files touched are the
 * committed fixture's own bytes, read before the engine is entered.
 */
export const runSession = async (request: SessionRequest): Promise<SessionRun> => {
  const { fixture, persona, goal, seed, weights } = request;
  const capture = captureOf(fixture);
  const [aois, salience] = await Promise.all([
    areasOf(fixture),
    salienceOf(fixture, persona, weights),
  ]);

  const offsets = screenOffsets(capture).slice(0, screensVisited(persona, capture, weights));
  if (offsets.length > SCREEN_SEED_STRIDE) {
    throw new Error(
      `${fixture} has ${offsets.length} screens, more than the ${SCREEN_SEED_STRIDE} a session's seeds are spaced for.`,
    );
  }
  const fixations: SampledFixation[] = [];
  const saccades: SampledSaccade[] = [];

  offsets.forEach((scrollY, screenIndex) => {
    const screen = sampleFixations({
      aois: areasOnScreen(aois, scrollY, capture.viewport.height),
      goal,
      persona,
      history: fixations,
      /**
       * A stream of its own per screen, inside the block of `SCREEN_SEED_STRIDE` this
       * session's seed owns. The screens of one session are therefore different draws
       * rather than the same one repeated, no screen of one session ever replays a stream
       * another session used — which would couple two sessions a share is counted over —
       * and the session is still a pure function of the one seed it was asked for.
       */
      seed: seed * SCREEN_SEED_STRIDE + screenIndex,
      weights,
      salience,
      screenIndex,
      scrollY,
    });
    fixations.push(...screen.fixations);
    saccades.push(...screen.saccades);
  });

  const last = fixations.at(-1);
  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    /**
     * The shape `sessionSchema` requires of a session id, and the schema is the only
     * authority on it: `assertContractShape` parses a session built here, so this string
     * cannot drift from the contract without a named failure. The seed is in it so that a
     * failure message names the session that produced the number.
     */
    sessionId: `S-${String(seed).padStart(2, '0')}`,
    runId: 'engine-claims',
    variant: VARIANT,
    taskId: fixture,
    kind: 'simulated',
    persona: {
      id: request.personaId,
      traits: persona,
      device: {
        name: 'fixture-desktop',
        viewport: capture.viewport,
        deviceScaleFactor: 1,
        touch: false,
      },
    },
    participant: null,
    seed,
    startedAt: STARTED_AT,
    durationMs: last === undefined ? 0 : last.tMs + last.durationMs,
    screens: offsets.map((scrollY, index) => ({
      index,
      step: capture.step,
      screenshot: capture.screenshot,
      scrollY,
      intent: goal.text,
      /**
       * Deciding an action is the swarm step's, not the engine's, so the harness records
       * none: the scroll between two screens is in `scrollY` and needs no invented verb.
       */
      decidedAction: '',
    })),
    fixations: [...fixations],
    saccades: [...saccades],
    actions: [],
    outcome: {
      status: 'success',
      step: capture.step,
      reason: '',
      attribution: 'product',
      excludedFromScores: false,
    },
    integrity: { selectorFailures: 0, retries: 0 },
  };

  return { session, aois };
};

/**
 * The same session over a fixed set of seeds — the statistical suite's unit of work, and
 * the behavioural suite's whenever a claim is about more than one seed.
 */
export const runSessions = async (
  request: Omit<SessionRequest, 'seed'>,
  seeds: readonly number[],
): Promise<readonly SessionRun[]> =>
  Promise.all(seeds.map((seed) => runSession({ ...request, seed })));

/**
 * Holds the harness to the contract: a session it builds is one `packages/contract`
 * accepts. Asserted once, in `behaviour.test.ts`, rather than on every call — a harness
 * that drifted from the session shape would be testing the engine against a session the
 * pipeline could never write.
 */
export const assertContractShape = (session: Session): void => {
  sessionSchema.parse(session);
};

/**
 * The id of the area the capture declares its primary action, or a thrown error.
 *
 * A fixture with no primary action, or with two, is not material for a claim about *the*
 * primary action, and saying so here is how that mistake arrives named rather than as a
 * band that quietly describes the wrong element.
 */
export const primaryActionId = async (fixture: FixtureName): Promise<string> => {
  const primary = (await areasOf(fixture)).filter((area) => area.isPrimaryAction);
  if (primary.length !== 1) {
    throw new Error(
      `${fixture} declares ${primary.length} primary actions; a claim about the primary action needs exactly one.`,
    );
  }
  return primary[0].id;
};

/**
 * The ids of the areas a fixture labels exactly `label`, in reading order.
 *
 * Areas are named by what they *say*, never by the element id the capture carries: an
 * area's id is minted from the variant, step, role, name and box, so a test that wrote one
 * out would be asserting against a hash of the geometry and would break the day a fixture
 * moved by a pixel. `count` is checked, so a label that stops matching what it used to is
 * a named failure here instead of an empty set a share quietly reports as zero.
 */
export const areaIdsLabelled = async (
  fixture: FixtureName,
  label: string,
  count: number,
): Promise<readonly string[]> => {
  const found = (await areasOf(fixture)).filter((area) => area.label === label);
  if (found.length !== count) {
    throw new Error(
      `${fixture} has ${found.length} areas labelled "${label}", not ${count} — regenerate the fixtures or fix the label.`,
    );
  }
  return found.map((area) => area.id);
};

/** The one area a fixture labels exactly `label`. */
export const areaIdLabelled = async (fixture: FixtureName, label: string): Promise<string> =>
  (await areaIdsLabelled(fixture, label, 1))[0];

/**
 * The ids of the areas the **segmenter** found on a fixture — the regions the DOM never
 * explained — selected by `source`, which is a published field of an `Aoi` and the same
 * way `heuristic-segmenter.test.ts` tells them apart. Not by the shape of the id: an id is
 * minted from the variant, step, role, name and box, and a test that matched on part of
 * one would be asserting against a private format.
 */
export const segmentedAreaIds = async (
  fixture: FixtureName,
  count: number,
): Promise<readonly string[]> => {
  const found = (await areasOf(fixture)).filter((area) => area.source === 'sam');
  if (found.length !== count) {
    throw new Error(
      `${fixture} has ${found.length} segmented regions, not ${count} — the segmenter's answer moved.`,
    );
  }
  return found.map((area) => area.id);
};

/**
 * The per-area metrics of a set of sessions, through `aggregate` — the numbers the screens
 * read. A claim made about a metric is made about the same function the pipeline calls,
 * and never about a median a test worked out for itself.
 */
export const metricsOf = (runs: readonly SessionRun[]): readonly AoiMetric[] => {
  const first = runs[0];
  if (first === undefined) throw new Error('no sessions to aggregate');
  return aggregate(
    runs.map((run) => run.session),
    [...first.aois],
  );
};

/** One area's row of those metrics, or a thrown error naming the area that is missing. */
export const metricOf = (runs: readonly SessionRun[], aoiId: string): AoiMetric => {
  const row = metricsOf(runs).find((metric) => metric.aoiId === aoiId);
  if (row === undefined) throw new Error(`no metric row for ${aoiId}`);
  return row;
};

/** Every fixation of every session, in session order. */
export const allFixations = (runs: readonly SessionRun[]): readonly SampledFixation[] =>
  runs.flatMap((run) => run.session.fixations);

/** The share of all the fixations over all the sessions that landed in one of these areas. */
export const fixationShareOn = (runs: readonly SessionRun[], aoiIds: readonly string[]): number => {
  const all = allFixations(runs);
  if (all.length === 0) throw new Error('no fixations to take a share of');
  return (
    all.filter((fixation) => fixation.aoiId !== null && aoiIds.includes(fixation.aoiId)).length /
    all.length
  );
};

/** The share of the sessions that fixated one of these areas at least once. */
export const sessionShareReaching = (
  runs: readonly SessionRun[],
  aoiIds: readonly string[],
): number =>
  runs.filter((run) =>
    run.session.fixations.some(
      (fixation) => fixation.aoiId !== null && aoiIds.includes(fixation.aoiId),
    ),
  ).length / runs.length;

/**
 * Where in the session's scanpath an area was first fixated, counted in fixations from the
 * start, or `null` when the session never fixated it — never `-1` dressed up as a
 * position, and never a 0 that reads as "first".
 */
export const firstPositionOf = (run: SessionRun, aoiId: string): number | null => {
  const at = run.session.fixations.findIndex((fixation) => fixation.aoiId === aoiId);
  return at === -1 ? null : at;
};

/** The total dwell of a session: what the agent spent looking, in milliseconds. */
export const totalDwellMs = (run: SessionRun): number =>
  run.session.fixations.reduce((sum, fixation) => sum + fixation.durationMs, 0);

/** The median of a non-empty list, by the same definition `aggregate` uses. */
export const median = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error('no values to take a median of');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Empties the memo tables above, so the next session recomputes the areas, the pixels and
 * the salience from the committed bytes.
 *
 * The end-to-end determinism test needs this: two sessions that shared a cached salience
 * map would prove the sampler repeatable and say nothing about the half of the path that
 * reads the screenshot, which is the half a `sharp` upgrade could move.
 */
export const resetCaches = (): void => {
  areasByFixture.clear();
  pixelsByFixture.clear();
  salienceByKey.clear();
};
