// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import {
  AGGREGATE_URL,
  RUN_ID,
  fixtureAggregate,
  openFunnel,
  settled,
} from '../../../tests/funnel/fixture';
import { loadDesignTokens } from '../../../tests/setup';

/**
 * The states of `/runs/:runId/funnel` that are not a funnel: a run that recorded none, a run
 * that scored nobody, an aggregate that cannot be read, and the moment before either file
 * has arrived.
 *
 * The screen keeps the owner's stated card in all of the first two, rather than drawing a
 * zeroed funnel — a tab that changes shape from test to test hides what the product can do,
 * and a zero reads as a measurement somebody took. The funnel itself, over a run that did
 * record one, is `tests/funnel/funnel.test.tsx`.
 */

const HEADING = 'Where the hundred of them went';

const card = async (): Promise<HTMLElement> => settled('[data-section="no-funnel"]');

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the funnel of a test that did not record one', () => {
  it('keeps the screen, states the absence, and offers the way on', async () => {
    await openFunnel({ aggregate: null });

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
    await openFunnel({ aggregate: null });

    const stated = await card();
    expect(stated.textContent).not.toMatch(/\d/);
    expect(stated.querySelector('svg, canvas, table, progress, meter')).toBeNull();
    expect(document.querySelector('[data-funnel="rows"]')).toBeNull();
    expect(document.querySelector('[data-funnel="filter"]')).toBeNull();
  });

  it('does not say an aggregated test never measured anything', async () => {
    const aggregate = fixtureAggregate();
    await openFunnel({
      aggregate: {
        ...aggregate,
        scoredSessionCount: 0,
        excludedAutomationFailures: 4,
        funnelSlices: [],
        screenSlices: [],
      },
    });

    // A run whose every session our automation broke computed an aggregate and scored
    // nobody, which is not the same fact as a run that recorded no funnel — and the sentence
    // for it names the reason the screen is empty rather than claiming the test is old.
    const stated = within(await settled('[data-section="scored-nobody"]'));
    expect(stated.getByRole('heading', { name: 'This test scored nobody.' })).toBeTruthy();
    expect(stated.getByText(/broken by our own automation/)).toBeTruthy();
    expect(stated.getByText(/4 sessions/)).toBeTruthy();
    expect(document.querySelector('[data-section="no-funnel"]')).toBeNull();
    expect(document.querySelector('[data-funnel="rows"]')).toBeNull();
    expect(
      stated.getByRole('link', { name: 'Run this test again' }).getAttribute('href'),
    ).toBeTruthy();
  });

  it('is clean under axe', async () => {
    await openFunnel({ aggregate: null });

    await card();
    const violations = await axeViolations(await settled('[data-screen="funnel"]'));
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('ends with the simulated line, and claims no lift', async () => {
    await openFunnel({ aggregate: null });

    const line = await settled('[data-shell="simulated-disclaimer"]');
    expect(line.textContent).toContain('simulated');
    expect(line.textContent).toContain('not a conversion-lift estimate');
  });
});

describe('the funnel of a run it cannot read', () => {
  it('leads a run with no directory to the not-found screen, not to a funnel of its own', async () => {
    await serveRunData();
    mountApp(paths.funnel('2026-01-01-0000-no-such-test'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(document.querySelector('[data-section="no-funnel"]')).toBeNull();
  });

  it('leads an aggregate that will not parse to the same screen, rather than half a funnel', async () => {
    await serveRunData({ files: { [AGGREGATE_URL]: '{"schemaVersion":1}' } });
    mountApp(paths.funnel(RUN_ID));

    expect(
      await screen.findByRole('heading', { name: 'That test could not be read' }),
    ).toBeTruthy();
    expect(document.querySelector('[data-funnel="rows"]')).toBeNull();
  });
});

describe('while the run and its aggregate are being read', () => {
  it('holds the header, and reserves the height the funnel will take', async () => {
    await openFunnel();

    // The first paint, before either file comes back: the header is there and the card below
    // it is already the height of the funnel, so the page does not jump when it arrives.
    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeTruthy();
    const holding = document.querySelector('[data-funnel="loading"]');
    expect(holding).not.toBeNull();
    expect(holding?.getAttribute('aria-busy')).toBe('true');
    expect(holding?.firstElementChild?.className).toMatch(/reserve/);
  });
});
