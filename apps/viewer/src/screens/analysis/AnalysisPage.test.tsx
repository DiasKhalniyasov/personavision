// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPaths } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';

/**
 * `/runs/:runId/analysis` over a run that carries no `recommendations.json`: the header of
 * `#screen-analysis` and the stated card the owner's decision put under it. The write-up
 * itself is #277's.
 *
 * The fixture directory on disk has carried a `recommendations.json` of its own since #262,
 * so that one file is answered 404 here — what these tests are about is a test that did not
 * record an analysis, and serving what is on disk would make the premise false the moment
 * #277 reads the file.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';

/** The one file of the run this suite's subject does not have. */
const NO_ANALYSIS = { missing: [`/runs/${RUN_ID}/${runPaths('').recommendations}`] };
const HEADING = 'What Muse Wonder makes of it';

/** One element of the rendered screen, once the run has been read. */
const settled = async (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found as HTMLElement;
  });

const card = async (): Promise<HTMLElement> => settled('[data-section="no-analysis"]');

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the analysis of a test that did not record one', () => {
  it('keeps the screen, states the absence, and offers the way on', async () => {
    await serveRunData(NO_ANALYSIS);
    mountApp(paths.analysis(RUN_ID));

    expect(await screen.findByRole('heading', { level: 1, name: HEADING })).toBeTruthy();
    const stated = within(await card());
    expect(
      stated.getByRole('heading', { name: 'This test did not record an analysis.' }),
    ).toBeTruthy();
    expect(stated.getByText(/no write-up and no recommendations/)).toBeTruthy();
    expect(stated.getByRole('link', { name: 'Run this test again' }).getAttribute('href')).toBe(
      paths.newTest,
    );
  });

  it('shows no figure at all: not a zero, and not an empty write-up', async () => {
    await serveRunData(NO_ANALYSIS);
    mountApp(paths.analysis(RUN_ID));

    const stated = await card();
    expect(stated.textContent).not.toMatch(/\d/);
    expect(stated.querySelector('svg, canvas, table, progress, meter')).toBeNull();
  });

  it('ends with the simulated line, and claims no lift', async () => {
    await serveRunData(NO_ANALYSIS);
    mountApp(paths.analysis(RUN_ID));

    const line = await settled('[data-shell="simulated-disclaimer"]');
    expect(line.textContent).toContain('simulated');
    expect(line.textContent).toContain('not a conversion-lift estimate');
  });

  it('leads a run it cannot read to the not-found screen, not to a write-up of its own', async () => {
    await serveRunData(NO_ANALYSIS);
    mountApp(paths.analysis('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(document.querySelector('[data-section="no-analysis"]')).toBeNull();
  });

  it('holds the header while the run is read, and is clean under axe once it is', async () => {
    await serveRunData(NO_ANALYSIS);
    mountApp(paths.analysis(RUN_ID));

    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeTruthy();

    // Scoped to the screen's own content: the chrome above it is `chrome.test.tsx`'s.
    const violations = await axeViolations(await settled('[data-screen="analysis"]'));
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
