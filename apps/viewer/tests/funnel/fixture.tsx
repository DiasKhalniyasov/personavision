import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { aggregateSchema, runPaths } from '@personavision/contract';
import type { Aggregate, FunnelSlice } from '@personavision/contract';
import { funnelLink } from '../../src/shell/paths';
import { mountApp, readRunFile, serveRunData } from '../app';
import type { ServedRunData } from '../app';

/**
 * The Funnel and timing screen, mounted over an aggregate a test can change.
 *
 * The one thing this screen must prove is that **every figure on it is a field of
 * `aggregate.json`**, so the harness is built around changing that file: `openFunnel` takes
 * the fixture run's own aggregate, lets a test edit it, serves the edited file at the URL
 * the viewer reads, and mounts the screen on it. A figure that moves when the file moves is
 * a figure read from the file; one that does not is a figure the browser worked out.
 *
 * The run itself is the repository's hand-authored fixture run, as every screen suite reads
 * it (`tests/app.tsx`), so the people, the steps and their labels are the ones the rest of
 * the suites know.
 */

export const RUN_ID = '2026-10-24-1402-northwind-demo';

const AGGREGATE_FILE = runPaths('').aggregate;
/** Where the viewer reads the aggregate, as `docs/adr/0001` mounts a run directory. */
export const AGGREGATE_URL = `/runs/${RUN_ID}/${AGGREGATE_FILE}`;

/** The fixture run's own aggregate, parsed with the contract's schema. */
export function fixtureAggregate(): Aggregate {
  return aggregateSchema.parse(readRunFile(RUN_ID, AGGREGATE_FILE));
}

/** The slices this screen offers: every version together, by segment. */
export const segmentSlices = (aggregate: Aggregate): FunnelSlice[] =>
  aggregate.funnelSlices.filter((slice) => slice.variant === null);

/** One slice by the segment it narrows to — `null` for the whole run. */
export function sliceOf(aggregate: Aggregate, segment: string | null): FunnelSlice {
  const slice = segmentSlices(aggregate).find((candidate) => candidate.segment === segment);
  if (slice === undefined) throw new Error(`no slice for segment ${String(segment)}`);
  return slice;
}

/**
 * A copy of the aggregate with one slice changed, still valid under the contract's schema —
 * so a test proving a figure is read from the file cannot do it with a file the pipeline
 * could never have written.
 */
export function withSlice(
  aggregate: Aggregate,
  segment: string | null,
  change: (slice: FunnelSlice) => FunnelSlice,
): Aggregate {
  const wanted = sliceOf(aggregate, segment);
  return aggregateSchema.parse({
    ...aggregate,
    funnelSlices: aggregate.funnelSlices.map((slice) => (slice === wanted ? change(slice) : slice)),
  });
}

export interface OpenOptions {
  /**
   * The aggregate to serve: the fixture's own by default, `null` for a run directory with no
   * `aggregate.json` at all, which is a run that computed none.
   */
  readonly aggregate?: Aggregate | null;
  /** The funnel's query, as a link builder writes it: `{ segment }`, `{ step }`, both. */
  readonly narrowing?: Parameters<typeof funnelLink>[1];
}

/** The screen, mounted on its route over the aggregate a test asked for. */
export async function openFunnel(options: OpenOptions = {}): Promise<ServedRunData> {
  const aggregate = options.aggregate === undefined ? fixtureAggregate() : options.aggregate;
  const served = await serveRunData({
    files: { [AGGREGATE_URL]: aggregate === null ? null : JSON.stringify(aggregate) },
  });
  mountApp(funnelLink(RUN_ID, options.narrowing ?? {}));
  return served;
}

/** One element of the rendered screen, once the run and the aggregate have been read. */
export const settled = async (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found as HTMLElement;
  });

/** The funnel's rows, in the order they are drawn. */
export const funnelRows = async (): Promise<HTMLElement[]> => {
  await settled('[data-funnel="rows"]');
  return [...document.querySelectorAll<HTMLElement>('[data-funnel="rows"] [data-step]')];
};

/** One funnel row by the step it is of. */
export const funnelRow = async (step: string): Promise<HTMLElement> =>
  settled(`[data-funnel="rows"] [data-step="${step}"]`);

/** The timing table's row for one step. */
export const timingRow = async (step: string): Promise<HTMLElement> =>
  settled(`[data-funnel="timing"] tbody [data-step="${step}"]`);

/** The slowest-sessions row for one session. */
export const slowestRow = async (sessionId: string): Promise<HTMLElement> =>
  settled(`[data-funnel="slowest"] tbody [data-session="${sessionId}"]`);

/** The text of one row's cells, trimmed, in order. */
export const cells = (row: HTMLElement): string[] =>
  [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim());
