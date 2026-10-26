import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { readRunFile } from '../app';

/**
 * The run these sections are read against, and the one way they are rendered.
 *
 * The run is the **repository's own** committed example run, parsed through
 * `packages/contract` — so a test reads what a reader reads, and a field this screen names
 * is a field the artifact really carries. A test that needs a different artifact changes a
 * copy of it: `withVerdict` and `withScore` below take the run somewhere the pipeline could
 * put it, including somewhere the schema forbids, which is how the screen's honest states
 * are reachable at all.
 */

/** The committed example run of `runs/`. #78 replaces it in place under the same schema. */
export const SEED_RUN_ID = '2026-10-24-1402-northwind-demo';

export const seedRun = (): Run => runSchema.parse(readRunFile(SEED_RUN_ID));

/** The same run with a different verdict block. */
export const withVerdict = (run: Run, patch: Partial<Run['verdict']>): Run => ({
  ...run,
  verdict: { ...run.verdict, ...patch },
});

/** The same run with one version's score changed, or dropped when `patch` is `null`. */
export const withScore = (
  run: Run,
  variant: string,
  patch: Partial<Run['scores'][number]> | null,
): Run => ({
  ...run,
  scores: run.scores.flatMap((score) => {
    if (score.variant !== variant) return [score];
    return patch === null ? [] : [{ ...score, ...patch }];
  }),
});

/**
 * One section, rendered on its own inside a router — the audience line links to the
 * audience, so every section is mounted the way the screen mounts it.
 */
export const show = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
