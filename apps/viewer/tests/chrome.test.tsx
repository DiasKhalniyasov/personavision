// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from './app';
import { paths } from '../src/shell/paths';
import { testMeta } from '../src/shell/TestPicker';

/**
 * The product chrome over the repository's own committed example run: `#chrome` and
 * `#tabbar` of `docs/design/prototype.html`.
 */

const chrome = (): HTMLElement => document.querySelector('[data-shell="chrome"]') as HTMLElement;

/** The committed example run, as the contract parses it. */
const exampleRun = async () => {
  const { runIds } = await serveRunData();
  const runId = runIds[0] as string;
  return { runId, run: runSchema.parse(readRunFile(runId)) };
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the chrome names whose data this is', () => {
  it('shows the product name, the workspace, and the test with its date and people', async () => {
    const { runId, run } = await exampleRun();
    mountApp(paths.run(runId));

    const bar = within(await waitFor(() => chrome()));
    expect(bar.getByRole('link', { name: 'PersonaVision' }).getAttribute('href')).toBe(paths.home);
    expect(bar.getByText('Northwind Outdoors')).toBeTruthy();

    const picker = await waitFor(() => {
      const found = document.querySelector('[data-shell="test-picker"]') as HTMLElement;
      expect(found.textContent).toContain(run.task.prompt);
      return found;
    });
    // The test's own name, date and number of people, from the run and nowhere else.
    expect(picker.textContent).toBe(`${run.task.prompt}${testMeta(run)}`);
    expect(picker.textContent).toContain('4 people');
  });

  it('counts the people the audience generates, not the sessions they ran', async () => {
    const { run } = await exampleRun();

    // 4 people × 2 versions × 3 seeds is 24 sessions; the chrome says 4 people.
    expect(run.sessionIds).toHaveLength(24);
    expect(testMeta(run)).toContain('4 people');
    expect(testMeta(run)).not.toContain('24 people');
  });

  it('reads the date from the run, not from the clock', () => {
    const run = runSchema.parse(readRunFile('2026-10-24-1402-northwind-demo'));
    const earlier = { ...run, createdAt: '2026-03-05T09:30:00.000Z' };

    expect(testMeta(run)).not.toBe(testMeta(earlier));
    expect(testMeta(earlier)).toContain('Mar');
  });

  it('offers New test, and names the account whose menu #103 builds', async () => {
    const { runId } = await exampleRun();
    mountApp(paths.run(runId));

    const bar = within(await waitFor(() => chrome()));
    expect(bar.getByRole('link', { name: 'New test' }).getAttribute('href')).toBe(paths.newTest);
    // The avatar says who is signed in and does nothing yet: there is no account screen
    // to reach, and the corner must not send a signed-in reader back to sign-in.
    expect(bar.getByText('Signed in as Workspace owner of Northwind Outdoors')).toBeTruthy();

    // Everything in the chrome that does something is a link or a button, so the whole bar
    // is operable with the keyboard alone and nothing needs a pointer.
    const interactive = [...chrome().querySelectorAll('a, button, [tabindex], input, select')];
    expect(interactive.length).toBeGreaterThan(0);
    for (const element of interactive) {
      expect(['A', 'BUTTON'], element.outerHTML).toContain(element.tagName);
    }
  });
});

describe('the simulated-audience badge', () => {
  it('reads the gaze similarity out of the run’s calibration block', async () => {
    const { runId } = await exampleRun();
    mountApp(paths.run(runId));

    const badge = await waitFor(() => {
      const found = document.querySelector('[data-shell="simulated-badge"]') as HTMLElement;
      expect(found.textContent).toContain('gaze similarity');
      return found;
    });
    expect(badge.textContent).toContain('Simulated audience · gaze similarity 0.68');
  });

  it('carries the benchmark figures as text, not only as a title tooltip', async () => {
    const { runId } = await exampleRun();
    mountApp(paths.run(runId));

    const badge = await waitFor(() => {
      const found = document.querySelector('[data-shell="simulated-badge"]') as HTMLElement;
      expect(found.textContent).toContain('gaze similarity');
      return found;
    });

    expect(badge.getAttribute('title')).toBeNull();
    expect(badge.textContent).toContain(
      'Similarity to real human gaze on the UEyes benchmark: CC 0.68 / NSS 1.9 / ScanMatch 0.54.',
    );
  });

  it('says plainly that nothing is recorded when the run has no calibration', async () => {
    const runId = '2026-10-24-1402-northwind-demo';
    const run = readRunFile(runId);
    await serveRunData({
      files: { [`/runs/${runId}/run.json`]: JSON.stringify({ ...run, calibration: null }) },
    });
    mountApp(paths.run(runId));

    const badge = await waitFor(() => {
      const found = document.querySelector('[data-shell="simulated-badge"]') as HTMLElement;
      expect(found.textContent).toContain('calibration');
      return found;
    });
    expect(badge.textContent).toContain('Simulated audience · no calibration recorded');
    expect(badge.textContent).toContain('No calibration against real human gaze has been recorded');
    expect(badge.textContent).not.toContain('0');
  });
});

describe('the tabs', () => {
  it('are links, in the prototype’s order, with Audiences at the end', async () => {
    const { runId, run } = await exampleRun();
    mountApp(paths.run(runId));

    const bar = await waitFor(() => {
      const found = document.querySelector('[data-shell="tabbar"]') as HTMLElement;
      expect(found.querySelectorAll('a')).toHaveLength(5);
      return found;
    });

    const tabs = [...bar.querySelectorAll('a')].map((tab) => [
      tab.textContent,
      tab.getAttribute('href'),
    ]);
    expect(tabs).toEqual([
      ['Verdict', paths.run(runId)],
      ['Score breakdown', paths.breakdown(runId)],
      [
        'Attention',
        paths.attention(runId, run.verdict.heroEvidence.variant, run.verdict.heroEvidence.step),
      ],
      ['Sessions', paths.sessions(runId)],
      ['Audiences', paths.audiences],
    ]);
  });

  it('marks the one you are on, including a screen under it', async () => {
    const { runId } = await exampleRun();
    mountApp(paths.session(runId, 'S-01'));

    const bar = await waitFor(() => {
      const found = document.querySelector('[data-shell="tabbar"]') as HTMLElement;
      expect(found.querySelectorAll('a')).toHaveLength(5);
      return found;
    });
    const current = [...bar.querySelectorAll('a[aria-current="page"]')].map(
      (tab) => tab.textContent,
    );
    expect(current).toEqual(['Sessions']);
  });
});

describe('while the test is being read', () => {
  it('holds the picker and the badge in a quiet placeholder state', async () => {
    const { runId } = await exampleRun();
    mountApp(paths.run(runId));

    // The first paint, before the run comes back: both slots are already there, so the bar
    // does not shift when they resolve.
    const picker = document.querySelector('[data-shell="test-picker"]') as HTMLElement;
    const badge = document.querySelector('[data-shell="simulated-badge"]') as HTMLElement;
    expect(picker.getAttribute('aria-hidden')).toBe('true');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.textContent).toBe('Simulated audience');
    expect(picker.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);

    await waitFor(() => {
      expect(
        (document.querySelector('[data-shell="test-picker"]') as HTMLElement).getAttribute(
          'aria-hidden',
        ),
      ).toBeNull();
    });
  });
});
