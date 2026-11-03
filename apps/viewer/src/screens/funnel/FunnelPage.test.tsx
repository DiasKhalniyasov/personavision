// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { loadDesignTokens } from '../../../tests/setup';

/**
 * `/runs/:runId/funnel` over the repository's own committed example run, which recorded no
 * funnel: the header of `#screen-funnel` and the stated card the owner's decision put under
 * it. What #274 mounts in its place is #274's to assert.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = 'Where the hundred of them went';

/** One element of the rendered screen, once the run has been read. */
const settled = async (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found as HTMLElement;
  });

const card = async (): Promise<HTMLElement> => settled('[data-section="no-funnel"]');

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the funnel of a test that did not record one', () => {
  it('keeps the screen, states the absence, and offers the way on', async () => {
    await serveRunData();
    mountApp(paths.funnel(RUN_ID));

    expect(await screen.findByRole('heading', { level: 1, name: HEADING })).toBeTruthy();
    const stated = within(await card());
    expect(
      stated.getByRole('heading', { name: 'This test did not record a funnel.' }),
    ).toBeTruthy();
    expect(stated.getByText(/no funnel and no timing distribution/)).toBeTruthy();
    // A link, so the way on is keyboard-operable and opens in a new window like any other.
    expect(stated.getByRole('link', { name: 'Run this test again' }).getAttribute('href')).toBe(
      paths.newTest,
    );
  });

  it('shows no figure at all: not a zero, and not an empty chart', async () => {
    await serveRunData();
    mountApp(paths.funnel(RUN_ID));

    const stated = await card();
    expect(stated.textContent).not.toMatch(/\d/);
    expect(stated.querySelector('svg, canvas, table, progress, meter')).toBeNull();
  });

  it('ends with the simulated line, and claims no lift', async () => {
    await serveRunData();
    mountApp(paths.funnel(RUN_ID));

    const line = await settled('[data-shell="simulated-disclaimer"]');
    expect(line.textContent).toContain('simulated');
    expect(line.textContent).toContain('not a conversion-lift estimate');
  });

  it('leads a run it cannot read to the not-found screen, not to a funnel of its own', async () => {
    await serveRunData();
    mountApp(paths.funnel('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(document.querySelector('[data-section="no-funnel"]')).toBeNull();
  });

  it('holds the header while the run is read, and is clean under axe once it is', async () => {
    await serveRunData();
    mountApp(paths.funnel(RUN_ID));

    // The first paint, before the run comes back: the header is already there.
    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeTruthy();

    // Scoped to the screen's own content: the chrome above it is `chrome.test.tsx`'s.
    const violations = await axeViolations(await settled('[data-screen="funnel"]'));
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
