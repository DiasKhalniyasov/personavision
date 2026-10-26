// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import axe from 'axe-core';
import type { Run } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { DetailDoors } from '../../src/screens/verdict/DetailDoors';
import { paths } from '../../src/shell/paths';

/**
 * The four doors to the detail.
 *
 * They are the whole reason the Verdict screen can be quiet: everything taken off it is
 * one click away. So these tests assert that each door is there, that it says what is
 * behind it in words a non-technical reader understands, and where it lands.
 */

const SEED = '2026-10-24-1402-northwind-demo';
const seedRun = (): Run => readRunFile(SEED) as unknown as Run;

const doorsOf = (container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>('[data-section="detail-doors"]')!;

const renderDoors = (run: Run) =>
  render(
    <MemoryRouter>
      <DetailDoors run={run} />
    </MemoryRouter>,
  );

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the doors to the detail', () => {
  it('renders four doors, each naming what is behind it', () => {
    const { container } = renderDoors(seedRun());
    const doors = within(doorsOf(container));

    expect(doors.getAllByRole('heading')).toHaveLength(4);
    expect(doors.getByRole('heading', { name: 'Score breakdown' })).toBeTruthy();
    expect(doors.getByRole('heading', { name: 'Attention' })).toBeTruthy();
    expect(doors.getByRole('heading', { name: 'People' })).toBeTruthy();
    expect(doors.getByRole('heading', { name: 'Watch one person' })).toBeTruthy();

    // A door that does not say what it opens defeats the point of having one.
    expect(
      doors.getByText(/friction score, its four parts and the run-to-run spread/),
    ).toBeTruthy();
    expect(doors.getByText(/Every heatmap, the order attention moved in/)).toBeTruthy();
    expect(doors.getByText(/All 24 simulated people/)).toBeTruthy();
    expect(doors.getByText(/Replay a single person's gaze/)).toBeTruthy();
  });

  it('points each door at its own route', () => {
    const run = seedRun();
    const { container } = renderDoors(run);
    const hrefs = [...doorsOf(container).querySelectorAll('a')].map((door) =>
      door.getAttribute('href'),
    );

    expect(hrefs).toEqual([
      paths.breakdown(SEED),
      // The version and step the verdict turns on, from the run's own `heroEvidence`.
      paths.attention(SEED, 'B', 'review'),
      paths.sessions(SEED),
      paths.session(SEED, 'S-01'),
    ]);
  });

  it('navigates when a door is activated from the screen', async () => {
    await serveRunData();
    const { container, router } = mountApp(paths.run(SEED));
    await waitFor(() => expect(doorsOf(container).querySelectorAll('a')).toHaveLength(4));

    await userEvent.click(within(doorsOf(container)).getByRole('link', { name: /^People/ }));
    expect(router.state.location.pathname).toBe(paths.sessions(SEED));
  });

  it('is operable by keyboard: every door takes focus and opens on Enter', async () => {
    await serveRunData();
    const { container, router } = mountApp(paths.run(SEED));
    await waitFor(() => expect(doorsOf(container).querySelectorAll('a')).toHaveLength(4));

    const doors = [...doorsOf(container).querySelectorAll<HTMLAnchorElement>('a')];
    for (const door of doors) {
      door.focus();
      expect(document.activeElement).toBe(door);
    }
    doors[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe(paths.breakdown(SEED));
  });

  it('counts the people it promises from the run itself', () => {
    const run = seedRun();
    const { container } = renderDoors({ ...run, sessionIds: ['S-01'] });

    expect(within(doorsOf(container)).getByText(/All 1 simulated person/)).toBeTruthy();
  });

  it('offers no replay when the test simulated nobody, and says why', () => {
    const { container } = renderDoors({ ...seedRun(), sessionIds: [] });
    const doors = doorsOf(container);

    // Three doors still open; the fourth says there is nobody to watch rather than
    // offering a click that leads nowhere.
    expect(doors.querySelectorAll('a')).toHaveLength(3);
    expect(within(doors).getByText('Nobody was simulated in this test')).toBeTruthy();
    expect(within(doors).getByRole('heading', { name: 'Watch one person' })).toBeTruthy();
  });

  it('is clean under axe', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));
    await waitFor(() => expect(doorsOf(container).querySelectorAll('a')).toHaveLength(4));

    const results = await axe.run(doorsOf(container), { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('keeps the doors beside the findings, under the same strip', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));
    await waitFor(() => expect(doorsOf(container).querySelectorAll('a')).toHaveLength(4));

    const sections = [...container.querySelectorAll('[data-section]')].map((section) =>
      section.getAttribute('data-section'),
    );
    expect(sections.indexOf('detail-doors')).toBe(sections.indexOf('headline-findings') + 1);
    expect(screen.getByRole('link', { name: /See all 6 findings/ })).toBeTruthy();
  });
});
