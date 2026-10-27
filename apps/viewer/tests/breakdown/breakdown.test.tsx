// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readFindingsFile, serveRunData } from '../app';
import { Breakdown } from '../../src/screens/breakdown/BreakdownPage';
import { paths } from '../../src/shell/paths';
import { SEED_RUN_ID, seedRun, show } from '../verdict/fixture';

/**
 * The Score breakdown screen as a whole: how it is reached, what frames the figures, and
 * the full findings list the Verdict screen's three were taken from.
 *
 * The cards are `cards.test.tsx` and the verdict line is `verdict.test.tsx`. What is here
 * is the page — the breadcrumb and the three doors into it, the test metadata row, the
 * findings in the pipeline's order with no cap, and the disclaimer every results screen
 * ends with.
 */

const linksTo = (path: string): HTMLElement[] =>
  screen.getAllByRole('link').filter((link) => link.getAttribute('href') === path);

const meta = (): HTMLElement => document.querySelector('[data-section="run-meta"]') as HTMLElement;

/** The metadata row's cells, keyed by the label each one opens with. */
const metaCells = (): Record<string, string> =>
  Object.fromEntries(
    [...meta().querySelectorAll('span')].map((cell) => {
      const label = cell.querySelector('b')?.textContent ?? '';
      return [label, (cell.textContent ?? '').slice(label.length).trim()];
    }),
  );

/** The same run, on a model rather than on the offline engine. */
const onModel = (run: Run, modelMode: 'contributor' | 'standard', usage?: Run['usage']): Run => ({
  ...run,
  engine: { ...run.engine, mode: 'model', modelMode },
  ...(usage === undefined ? {} : { usage }),
});

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('getting to the breakdown, and back', () => {
  it('is reached from the Verdict screen’s door, its findings link and its tab', async () => {
    await serveRunData();
    mountApp(paths.run(SEED_RUN_ID));

    // The three ways in of `docs/FLOW.md` section 3: the tab in the chrome, the labelled
    // door, and the way out of the three findings to all of them.
    await waitFor(() => {
      expect(linksTo(paths.breakdown(SEED_RUN_ID)).length).toBe(3);
    });
    const names = linksTo(paths.breakdown(SEED_RUN_ID)).map((link) => link.textContent ?? '');
    expect(names.some((name) => name === 'Score breakdown')).toBe(true);
    expect(
      names.some((name) => name.startsWith('Score breakdown') && name.includes('spread')),
    ).toBe(true);
    expect(names.some((name) => name.includes('findings and the full score breakdown'))).toBe(true);
  });

  it('opens the screen when the door is clicked', async () => {
    await serveRunData();
    mountApp(paths.run(SEED_RUN_ID));

    const door = await waitFor(() => {
      const found = linksTo(paths.breakdown(SEED_RUN_ID)).find((link) =>
        (link.textContent ?? '').includes('spread'),
      );
      expect(found).not.toBeUndefined();
      return found as HTMLElement;
    });
    await userEvent.click(door);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'How sure is this, and what drove it' }),
    ).toBeTruthy();
  });

  it('returns to the Verdict from the breadcrumb', async () => {
    await serveRunData();
    const { container } = mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => {
      expect(container.querySelector('.breadcrumb')).not.toBeNull();
    });
    const crumb = container.querySelector('.breadcrumb a') as HTMLElement;
    expect(crumb.textContent).toBe('Verdict');
    expect(crumb.getAttribute('href')).toBe(paths.run(SEED_RUN_ID));

    await userEvent.click(crumb);
    expect(
      await screen.findByRole('heading', { level: 1, name: seedRun().verdict.audienceSentence }),
    ).toBeTruthy();
  });

  it('reserves the cards’ height while the run is read', () => {
    const { container } = mountApp(paths.breakdown(SEED_RUN_ID));

    // Before the run comes back: the two cards hold their place, so the verdict line under
    // them does not jump once it does.
    const loading = container.querySelector('[data-section="score-cards-loading"]') as HTMLElement;
    expect(loading).not.toBeNull();
    expect(loading.children).toHaveLength(2);
  });

  it('is the shell’s not-found state for a test this workspace does not hold', async () => {
    await serveRunData();
    mountApp(paths.breakdown('2026-01-01-0000-nothing-here'));

    expect(await screen.findByRole('heading', { name: 'No test with that id' })).toBeTruthy();
    expect(document.body.textContent).toContain('2026-01-01-0000-nothing-here');
    expect(document.querySelector('[data-section="score-cards"]')).toBeNull();
  });
});

describe('the test metadata row', () => {
  it('names the audience, the people, the devices, the engine, the cost and the directory', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => expect(meta()).not.toBeNull());
    const cells = metaCells();
    expect(cells.Audience).toContain('Outdoor-gear shoppers');
    expect(cells.People).toBe('4 generated personas × 3 seeds = 12 per version');
    expect(cells.Devices).toBe('2 iPhone 15 · 2 MacBook Air 13');
    expect(cells.Engine).toBe('offline deterministic');
    expect(cells.Test).toBe(`runs/${SEED_RUN_ID}`);
  });

  it('says the cost is not recorded rather than reporting a zero nobody measured', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => expect(meta()).not.toBeNull());
    expect(metaCells().Cost).toBe('not recorded');
  });

  it('names the model and the mode, and reads the calls and the cost from the usage block', async () => {
    await serveRunData();
    show(
      <Breakdown
        run={onModel(seedRun(), 'standard', {
          calls: 48,
          inputTokens: 120_000,
          cachedInputTokens: 40_000,
          outputTokens: 9_000,
          reasoningTokens: 2_000,
          estimatedCostUsd: 1.237,
        })}
      />,
    );

    const cells = metaCells();
    expect(cells.Engine).toBe('Muse Spark 1.3 · standard mode');
    expect(cells.Cost).toBe('48 model calls · $1.24 estimated');
  });

  it('carries the training notice on a contributor test and on no other', async () => {
    await serveRunData();
    const notice = (): Element | null => document.querySelector('[data-section="training-notice"]');

    const { unmount } = show(<Breakdown run={onModel(seedRun(), 'contributor')} />);
    expect(notice()?.textContent).toContain('Meta may use its content to train its models');
    expect(notice()?.textContent).toContain('always runs on the standard model');
    unmount();

    const standard = show(<Breakdown run={onModel(seedRun(), 'standard')} />);
    expect(notice()).toBeNull();
    standard.unmount();

    // The committed example run is the offline deterministic engine: no model, no notice.
    show(<Breakdown run={seedRun()} />);
    expect(notice()).toBeNull();
  });
});

describe('the full findings list', () => {
  it('shows every finding, in the order the findings file holds them', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const stored = (readFindingsFile(SEED_RUN_ID) as { findings: { claim: string }[] }).findings;
    // The cap of three is the Verdict screen's; this screen is where it does not apply.
    expect(stored.length).toBeGreaterThan(3);

    await waitFor(() => {
      const rendered = [...document.querySelectorAll('[data-sev]')];
      expect(rendered).toHaveLength(stored.length);
    });
    const rendered = [...document.querySelectorAll('[data-sev]')].map(
      (finding) => finding.textContent ?? '',
    );
    for (const [position, finding] of stored.entries()) {
      expect(rendered[position], finding.claim).toContain(finding.claim);
    }
  });

  it('does not re-sort them by the rank it is handed', async () => {
    const stored = readFindingsFile(SEED_RUN_ID) as {
      findings: { id: string; claim: string; rank: number }[];
    };
    // The file's order is the pipeline's, whatever the rank numbers say: a viewer that
    // sorted by rank would put this file on screen in a different order than the one the
    // Verdict screen's three were taken from.
    const shuffled = {
      ...stored,
      findings: [...stored.findings].reverse().map((finding, position) => ({
        ...finding,
        rank: position + 1,
      })),
    };
    await serveRunData({
      files: { [`/runs/${SEED_RUN_ID}/findings.json`]: JSON.stringify(shuffled) },
    });
    mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => {
      expect([...document.querySelectorAll('[data-sev]')]).toHaveLength(shuffled.findings.length);
    });
    const rendered = [...document.querySelectorAll('[data-sev]')].map(
      (finding) => finding.textContent ?? '',
    );
    for (const [position, finding] of shuffled.findings.entries()) {
      expect(rendered[position], finding.id).toContain(finding.claim);
    }
  });
});

describe('what the screen says about its own numbers', () => {
  it('states that they are simulated for this audience and are not a conversion-lift estimate', async () => {
    await serveRunData();
    const { container } = mountApp(paths.breakdown(SEED_RUN_ID));

    // The audience it names is the run's own, so the assertion waits for the run and not
    // only for the sentence, which is on screen before the run has been read.
    const disclaimer = await waitFor(() => {
      const found = container.querySelector('[data-shell="simulated-disclaimer"]');
      expect(found?.textContent).toContain('Outdoor-gear shoppers');
      return found as HTMLElement;
    });
    expect(disclaimer.textContent).toContain('simulated');
    expect(disclaimer.textContent).toContain('not a conversion-lift estimate');
  });

  it('says the people our automation broke on are excluded from every figure here', async () => {
    await serveRunData();
    const { container } = mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => {
      expect(container.textContent).toContain('excluded from every figure on this screen');
    });
    expect(container.textContent).toContain('never evidence against your checkout');
  });

  it('is clean under axe', async () => {
    await serveRunData();
    const { container } = mountApp(paths.breakdown(SEED_RUN_ID));

    await waitFor(() => {
      expect(container.querySelector('[data-section="verdict"]')).not.toBeNull();
    });
    const results = await axe.run(container, { resultTypes: ['violations'] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
