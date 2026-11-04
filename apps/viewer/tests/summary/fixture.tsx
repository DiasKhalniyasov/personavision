import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import {
  aggregateSchema,
  recommendationsSchema,
  runPaths,
  runSchema,
  SCHEMA_VERSION,
} from '@personavision/contract';
import type { Aggregate, Recommendations, Run } from '@personavision/contract';
import { mountApp, readRunFile, serveRunData } from '../app';
import { paths } from '../../src/shell/paths';

/**
 * The two shapes of `/runs/:runId`, served the way the app reads one.
 *
 * The run is the repository's own hand-authored example run, parsed through
 * `packages/contract`, so a test reads what a reader reads. It compares **two** versions, so
 * the one-version shape is that same run with everything about its second version taken
 * away — the shape a path-1 test has (`docs/FLOW.md` section 11): one variant, one score,
 * one set of captures. Its figures are the committed aggregate's own, which is the point:
 * the Summary reads them rather than counting the sessions.
 *
 * `recommendations.json` is **optional** in a run directory and the fixture directory holds
 * none, so a run that recommends something is served one written here. Every citation in it
 * names a real session, a real version and step, and a real area of interest of that run, so
 * the links a test follows are links a reader could follow.
 */

/** The example run of `tests/fixtures/runs/`, the same id the other screens' suites read. */
export const SEED = '2026-10-24-1402-northwind-demo';

/** The file names inside a run directory, as the contract spells them. */
export const layout = runPaths('');

/** Where each of them is served, over the read-only run-data interface of `docs/adr/0001`. */
export const url = {
  run: `/runs/${SEED}/${layout.run}`,
  aggregate: `/runs/${SEED}/${layout.aggregate}`,
  recommendations: `/runs/${SEED}/${layout.recommendations}`,
} as const;

/** The two-version run, as the Verdict screen's own suites read it. */
export const seedRun = (): Run => runSchema.parse(readRunFile(SEED));

/** The aggregate the pipeline computed over that run's sessions. */
export const seedAggregate = (): Aggregate =>
  aggregateSchema.parse(readRunFile(SEED, layout.aggregate));

/** The version the one-version shape keeps, and the one it drops. */
const KEPT = 'A';

/**
 * The same run with one version: a path-1 test.
 *
 * Everything that belongs to the dropped version goes with it — its score, its captures, its
 * areas of interest and their metrics, its step caption — and the verdict's hero evidence
 * moves onto the version that is left, because a run cannot point at a version it does not
 * declare. The sessions, the people and the audience are untouched: the same 24 people
 * attempted the same task, which is what makes the aggregate below theirs.
 */
export const oneVersionRun = (patch: Partial<Run> = {}): Run => {
  const run = seedRun();
  const kept = new Set(run.aois.filter((area) => area.variant === KEPT).map((area) => area.id));

  return runSchema.parse({
    ...run,
    variants: run.variants.filter((variant) => variant.id === KEPT),
    scores: run.scores.filter((score) => score.variant === KEPT),
    screenshots: run.screenshots.filter((shot) => shot.variant === KEPT),
    aois: run.aois.filter((area) => area.variant === KEPT),
    aoiMetrics: run.aoiMetrics.filter((metric) => kept.has(metric.aoiId)),
    stepCaptions: run.stepCaptions.filter((caption) => caption.variant === KEPT),
    verdict: {
      ...run.verdict,
      harderVariant: KEPT,
      preferredVariant: KEPT,
      heroEvidence: { ...run.verdict.heroEvidence, variant: KEPT, aoiId: null },
    },
    ...patch,
  });
};

/**
 * The aggregate of a one-version run: the committed one with its per-version slices taken
 * away, which is what the composer produces for a run that declares a single version — a
 * one-URL test has no version to filter by.
 */
export const oneVersionAggregate = (patch: Partial<Aggregate> = {}): Aggregate => {
  const aggregate = seedAggregate();
  return aggregateSchema.parse({
    ...aggregate,
    funnelSlices: aggregate.funnelSlices.filter((slice) => slice.variant === null),
    ...patch,
  });
};

/** The whole-run slice of an aggregate: the one every figure on the Summary is read off. */
export const wholeRunSlice = (aggregate: Aggregate) => {
  const slice = aggregate.funnelSlices.find(
    (candidate) => candidate.variant === null && candidate.segment === null,
  );
  if (slice === undefined) throw new Error('this aggregate stores no whole-run slice');
  return slice;
};

/** How many of the scored sessions completed, as the aggregate counts them. */
export const completedCount = (aggregate: Aggregate): number => {
  const slice = aggregate.screenSlices.find(
    (candidate) => candidate.segment === null && candidate.outcome === 'success',
  );
  return slice?.sessionCount ?? 0;
};

/**
 * What this run says to change: three ranked recommendations, each citing a session with a
 * moment in it, a heatmap region and a funnel step — the three shapes a citation has.
 *
 * None of them cites `S-09` or `S-23`, the two sessions our own automation lost: no
 * recommendation may rest on an excluded session (`docs/FLOW.md` section 11).
 */
export const recommendations = (patch: Partial<Recommendations> = {}): Recommendations =>
  recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: SEED,
    sample: {
      read: 20,
      of: 22,
      strategy: 'the slowest and the abandoned, then at random',
      seed: 7,
    },
    recommendations: [
      {
        id: 'R-1',
        rank: 1,
        sentence: 'Show the service fee on the cart, before anybody enters a card.',
        evidence:
          'Eight people left on the review step when the $9.95 fee appeared in the order summary, four of them within ten seconds of seeing it.',
        findingIds: ['F-1'],
        citations: [
          { kind: 'session', sessionId: 'S-17', offsetMs: 48_000 },
          { kind: 'session', sessionId: 'S-18', offsetMs: 19_500 },
          { kind: 'heatmap', variant: 'A', step: 'review', aoiId: 'A-review-summary' },
          { kind: 'funnel', stepId: 'review' },
        ],
        peopleAffected: 8,
        step: 'review',
      },
      {
        id: 'R-2',
        rank: 2,
        sentence: 'Name the button that completes the order.',
        evidence:
          'Three people pressed Place order and believed the purchase was done, and no order was placed.',
        findingIds: ['F-2'],
        citations: [
          { kind: 'session', sessionId: 'S-13', offsetMs: 26_300 },
          { kind: 'heatmap', variant: 'A', step: 'review', aoiId: null },
        ],
        peopleAffected: 3,
        step: 'review',
      },
      {
        id: 'R-3',
        rank: 3,
        sentence: 'Keep the cart total in view while the card is being entered.',
        evidence: 'Four people went back to the cart from the payment step to check the total.',
        findingIds: ['F-3'],
        citations: [{ kind: 'funnel', stepId: 'payment' }],
        peopleAffected: 4,
        step: 'payment',
      },
    ],
    ...patch,
  });

/**
 * The same run with a progress log in which `failures` of its sessions were our own
 * automation failing: how a run crosses the fifth the contract declares.
 *
 * The log is the one per-session record a run carries at every stage, and
 * `automationFailureNoticeIsDue` counts the notice off it — so this is the fixture that
 * makes the notice due, with the counts the screen would print beside it.
 */
export const withAutomationFailures = (run: Run, failures: number): Run => {
  const sessions = run.sessionIds.map((sessionId, index) => ({
    sessionId,
    personaName: run.personas[index]?.name ?? 'Someone',
    variant: KEPT,
    seed: run.seedGroups[0] ?? 1,
    finishedAt: run.createdAt,
    durationMs: 10_000,
    status: index < failures ? 'automation_failure' : 'success',
    step: index < failures ? 'payment' : 'confirm',
    reason: index < failures ? 'the browser stopped answering' : 'the order was placed',
    attribution: index < failures ? 'automation' : 'product',
  }));

  return runSchema.parse({
    ...run,
    progress: {
      totalSessions: sessions.length,
      finishedSessions: sessions.length,
      perVariant: [
        { variant: KEPT, totalSessions: sessions.length, finishedSessions: sessions.length },
      ],
      sessions,
    },
  });
};

/** What a test wants served: a run, and either of its two optional files, or neither. */
export interface SummaryData {
  readonly run?: Run;
  /** The aggregate, or `null` for a run that computed none. */
  readonly aggregate?: Aggregate | null;
  /**
   * The recommendations, or `null` for a run that produced none. A **string** is served
   * verbatim, which is how a file the contract refuses reaches the screen at all.
   */
  readonly recommendations?: Recommendations | string | null;
}

/**
 * The Summary screen, mounted on `/runs/:runId` over the data a test asks for.
 *
 * The default is the one-version shape with its aggregate and its recommendations: the lead
 * of a hundred-agent test, as `#screen-results` draws it. Passing `run: seedRun()` gives the
 * two-version shape instead, over the same route.
 */
export async function openSummary(data: SummaryData = {}) {
  const run = data.run ?? oneVersionRun();
  const aggregate = data.aggregate === undefined ? oneVersionAggregate() : data.aggregate;
  const recommended = data.recommendations === undefined ? recommendations() : data.recommendations;

  const files: Record<string, string> = { [url.run]: JSON.stringify(run) };
  const missing: string[] = [];
  if (aggregate === null) missing.push(url.aggregate);
  else files[url.aggregate] = JSON.stringify(aggregate);
  if (recommended === null) missing.push(url.recommendations);
  else {
    files[url.recommendations] =
      typeof recommended === 'string' ? recommended : JSON.stringify(recommended);
  }

  const served = await serveRunData({ files, missing });
  const mounted = mountApp(paths.run(SEED));

  // The run file is what the screen is composed from, and the aggregate and the
  // recommendations arrive after it over files of their own. The screen is there when the
  // run has resolved and no block is still holding a space: every section then reads what
  // the run actually carries, which is what a reader meets.
  await waitFor(() => {
    expect(mounted.container.querySelector('[data-section="audience-line"]')).not.toBeNull();
    expect(mounted.container.querySelectorAll('[data-state="loading"]')).toHaveLength(0);
  });

  return { ...mounted, ...served, run, aggregate, recommendations: recommended };
}

/**
 * One section of the screen, by the slot it declares. A screen's own sections carry
 * `data-section` and the shell's carry `data-shell`, and both are asked for by name here.
 */
export const slot = (container: HTMLElement, section: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(
    `[data-section="${section}"], [data-shell="${section}"]`,
  );
  if (found === null) throw new Error(`the screen drew no ${section}`);
  return found;
};

/** What one section of the screen reads, as one string. */
export const words = (container: HTMLElement, section: string): string =>
  slot(container, section).textContent ?? '';

/** Every slot the screen drew, in page order: what the two shapes are asserted by. */
export const sections = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll('[data-section], [data-shell]')]
    .map((element) => element.getAttribute('data-section') ?? element.getAttribute('data-shell'))
    .filter((name) => name !== null && !['chrome', 'tabbar'].includes(name));
