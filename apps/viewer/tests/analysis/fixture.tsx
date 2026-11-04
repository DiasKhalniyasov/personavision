import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import {
  aggregateSchema,
  findingsSchema,
  recommendationsSchema,
  runPaths,
  runSchema,
  SCHEMA_VERSION,
} from '@personavision/contract';
import type {
  Aggregate,
  Recommendation,
  Recommendations,
  Run,
  WriteUpClaim,
} from '@personavision/contract';
import { writeUp } from '@personavision/scoring';
import type { Finding } from '@personavision/scoring';
import { mountApp, readRunFile, serveRunData } from '../app';
import type { ServedRunData } from '../app';
import { paths } from '../../src/shell/paths';

/**
 * The Analysis screen, mounted over a write-up a test can change.
 *
 * The one thing this screen must prove is that **it renders the write-up the pipeline
 * generated and never writes one**, so the harness is built the way the pipeline is: the
 * recommendations below are a document the contract accepts, and the write-up served with
 * them is produced by **`@personavision/scoring`'s own `writeUp` generator** over this run,
 * its aggregate and its findings. A sentence on the screen that the generator did not
 * produce is a sentence this screen composed.
 *
 * The run is the repository's hand-authored fixture run, as every screen suite reads it
 * (`tests/app.tsx`), so the people, the steps and their labels are the ones the other
 * suites know. `recommendations.json` is **optional** in a run directory and the fixture
 * directory holds none, so a run that was written up is served one from here.
 */

/** The example run of `tests/fixtures/runs/`, the same id the other screens' suites read. */
export const RUN_ID = '2026-10-24-1402-northwind-demo';

/** The file names inside a run directory, as the contract spells them. */
const layout = runPaths('');

/** Where each of them is served, over the read-only run-data interface of `docs/adr/0001`. */
export const url = {
  run: `/runs/${RUN_ID}/${layout.run}`,
  aggregate: `/runs/${RUN_ID}/${layout.aggregate}`,
  recommendations: `/runs/${RUN_ID}/${layout.recommendations}`,
} as const;

/** The fixture run, parsed with the contract's own schema. */
export const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/**
 * The run's aggregate, **finished**: the figures a claim argues from.
 *
 * The committed fixture's own aggregate is of an open run, and the write-up generator
 * refuses one — half a write-up read as a finished one is worse than none (#260) — so the
 * run this screen is tested over is the one a reader meets on it: a test that has finished.
 */
export const finishedAggregate = (patch: Partial<Aggregate> = {}): Aggregate =>
  aggregateSchema.parse({
    ...readRunFile(RUN_ID, layout.aggregate),
    runStatus: 'finished',
    ...patch,
  });

/** The run's findings, which a claim's paragraph argues from. */
export const seedFindings = (): Finding[] =>
  findingsSchema.parse(readRunFile(RUN_ID, layout.findings)).findings;

/** The two people this run's own automation broke, as their session files record them. */
export const OUR_BREAKAGE = ['S-09', 'S-23'] as const;

/**
 * A session id a claim's **prose** names and its citations do not.
 *
 * It is in the first recommendation's `evidence` sentence, which the generator makes that
 * claim's heading, so the rendered screen carries the words `S-07` with no citation behind
 * them: the fixture a test proves *"no sentence is parsed to produce a link"* over.
 */
export const UNCITED_SESSION = 'S-07';

/**
 * What this run says to change: three ranked recommendations, each citing its evidence in
 * the shapes the contract declares — a funnel step, people with a moment in their
 * recording, a heatmap region.
 *
 * The third cites **nothing but `S-09`**, one of the two sessions our own automation broke:
 * the claim generated from it is the one the screen must not publish (`docs/FLOW.md`
 * section 11). The other two rest on people the run measured.
 */
export const RECOMMENDATIONS: readonly Recommendation[] = [
  {
    id: 'R-1',
    rank: 1,
    sentence: 'Show the service fee on the cart, before anybody enters a card.',
    evidence: `the fee is what loses people on the review step, and ${UNCITED_SESSION} is not one of them`,
    findingIds: ['F-1'],
    citations: [
      { kind: 'funnel', stepId: 'review' },
      { kind: 'session', sessionId: 'S-17', offsetMs: 48_000 },
      { kind: 'session', sessionId: 'S-18', offsetMs: 19_500 },
      { kind: 'heatmap', variant: 'A', step: 'review', aoiId: 'A-review-summary' },
    ],
    peopleAffected: 8,
    step: 'review',
  },
  {
    id: 'R-2',
    rank: 2,
    sentence: 'Name the button that completes the order.',
    evidence: 'three people believed the order was placed when it was not',
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
    evidence: 'four people went back to the cart from the payment step',
    findingIds: ['F-3'],
    citations: [{ kind: 'session', sessionId: OUR_BREAKAGE[0], offsetMs: 12_000 }],
    peopleAffected: 4,
    step: 'payment',
  },
];

/** How much of the run was read, as the sampler of #252 stores it. */
export const SAMPLE = {
  read: 20,
  of: 22,
  strategy: 'stratified by outcome, then segment',
  seed: 20_261_024,
} as const;

/**
 * The document without its write-up block: what a run that has been analysed but not
 * written up carries, which is what an open run's directory holds.
 */
export const baseDocument = (patch: Partial<Recommendations> = {}): Recommendations =>
  recommendationsSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId: RUN_ID,
    sample: SAMPLE,
    recommendations: RECOMMENDATIONS,
    ...patch,
  });

/**
 * The claims the pipeline would generate for a document, from the run it is about.
 *
 * The generator itself, not a hand-written list: the screen's promise is that the write-up
 * it renders is the one generated from the recommendation objects, and a fixture that wrote
 * its own claims could not tell the difference.
 */
export const generatedWriteUp = (
  document: Recommendations,
  aggregate: Aggregate = finishedAggregate(),
): WriteUpClaim[] =>
  writeUp({
    run: seedRun(),
    aggregate,
    recommendations: document.recommendations,
    findings: seedFindings(),
    sample: document.sample,
  });

/** A document with the write-up generated from it: what a finished, analysed run carries. */
export const written = (
  patch: Partial<Recommendations> = {},
  aggregate: Aggregate = finishedAggregate(),
): Recommendations => {
  const document = baseDocument(patch);
  return recommendationsSchema.parse({
    ...document,
    writeUp: generatedWriteUp(document, aggregate),
  });
};

/** What a test wants served: a run, its aggregate, and its recommendations file. */
export interface AnalysisData {
  readonly run?: Run;
  /** The aggregate, or `null` for a run that computed none. */
  readonly aggregate?: Aggregate | null;
  /**
   * The recommendations, or `null` for a run that produced none. A **string** is served
   * verbatim, which is how a file the contract refuses reaches the screen at all.
   */
  readonly recommendations?: Recommendations | string | null;
  /**
   * Anything else to serve verbatim, by URL, applied last: how a file the viewer cannot
   * parse at all — rather than one that is simply not there — reaches the screen.
   */
  readonly files?: Record<string, string>;
}

export interface OpenedAnalysis extends ServedRunData {
  readonly container: HTMLElement;
  readonly unmount: () => void;
  readonly run: Run;
  readonly aggregate: Aggregate | null;
}

/** Whether the screen fell to the shell's run-not-found state, which is one of its ends. */
export const refusedOn = (container: HTMLElement): boolean =>
  [...container.querySelectorAll('h2')].some((heading) =>
    (heading.textContent ?? '').includes('could not be read'),
  );

/**
 * The Analysis screen, mounted on `/runs/:runId/analysis` over the data a test asks for.
 *
 * The default is the finished run with its write-up: the screen as `#screen-analysis` draws
 * it. It settles when the card is no longer holding its height, which is when every file
 * the screen reads — the run, the recommendations, the aggregate and the sessions the
 * excluded count is read from — has arrived.
 */
export async function openAnalysis(data: AnalysisData = {}): Promise<OpenedAnalysis> {
  const run = data.run ?? seedRun();
  const aggregate = data.aggregate === undefined ? finishedAggregate() : data.aggregate;
  const document =
    data.recommendations === undefined ? written({}, aggregate ?? undefined) : data.recommendations;

  const files: Record<string, string> = { [url.run]: JSON.stringify(run) };
  const missing: string[] = [];
  if (aggregate === null) missing.push(url.aggregate);
  else files[url.aggregate] = JSON.stringify(aggregate);
  if (document === null) missing.push(url.recommendations);
  else {
    files[url.recommendations] = typeof document === 'string' ? document : JSON.stringify(document);
  }

  // A file given verbatim is served whatever else was asked for: unreadable is not absent.
  for (const [path, body] of Object.entries(data.files ?? {})) files[path] = body;
  const served = await serveRunData({
    files,
    missing: missing.filter((path) => !(path in files)),
  });
  const mounted = mountApp(paths.analysis(RUN_ID));

  // Settled is either of the two ends: the screen with nothing holding its height, or the
  // run-not-found screen a file the contract refuses falls to.
  await waitFor(() => {
    const drawn = mounted.container.querySelector('[data-screen="analysis"]');
    expect(drawn === null ? refusedOn(mounted.container) : true).toBe(true);
    if (drawn !== null) {
      expect(mounted.container.querySelector('[data-analysis="loading"]')).toBeNull();
    }
  });

  return { ...served, ...mounted, run, aggregate };
}

/** One part of the rendered screen, by the name it declares. */
export const part = (container: HTMLElement, name: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(
    `[data-part="${name}"], [data-section="${name}"], [data-shell="${name}"]`,
  );
  if (found === null) throw new Error(`the screen drew no ${name}`);
  return found;
};

/** Every claim the screen published, in page order. */
export const claimsOn = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-part="claim"]'),
];

/** What one claim reads: its heading, its paragraph, and the chips under it. */
export const claimWords = (claim: HTMLElement): string => claim.textContent ?? '';

/** Every link on the screen, as `href`s. */
export const hrefsOn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-screen="analysis"] a')].map(
    (link) => link.getAttribute('href') ?? '',
  );
