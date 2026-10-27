// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';
import { StepFilmstrip } from './StepFilmstrip';
import type { AttentionSelection } from './useAttentionSelection';
import type { AttentionStepSessions } from './useAttentionStepSessions';

/**
 * The step filmstrip of `#screen-attention`, over the repository's own committed example
 * run: 24 sessions, two versions, one of each lost to our own automation.
 *
 * Two kinds of test are here, and deliberately. The strip on the screen is mounted through
 * the app, so what is asserted is the counts a designer really reads above the heatmaps and
 * the URL a press writes. The three states a count can be in instead of a number — nobody
 * reached it, still being read, could not be read — are asserted on the component with the
 * read handed to it, because the one thing this strip must never do is print a zero that
 * later becomes a nine, and a test that waited on a real read could not see that.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const runFile = `/runs/${RUN_ID}/run.json`;
const HEADING = 'Where your audience looked';

const layout = runPaths('');
const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../runs');

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/** Every session file of the committed run, as the screen's hook has them once read. */
const seedSessions = (run: Run): Session[] =>
  run.sessionIds.map((sessionId) =>
    sessionSchema.parse(
      JSON.parse(readFileSync(join(runsRoot, RUN_ID, layout.session(sessionId)), 'utf8')),
    ),
  );

/** The committed run with something changed in it, served in its place. */
const serveChangedRun = async (change: (run: Run) => Run) => {
  const changed = change(seedRun());
  await serveRunData({ files: { [runFile]: JSON.stringify(changed) } });
  return changed;
};

const attention = (variant: string, step: string, query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

const strip = (): HTMLElement => screen.getByRole('group', { name: 'Step' });

const frames = (): HTMLElement[] => within(strip()).getAllByRole('button');

const frameFor = (step: string): HTMLElement =>
  strip().querySelector(`[data-step="${step}"]`) as HTMLElement;

/** What each frame says, in the strip's order. */
const linesOf = (): string[] => frames().map((frame) => frame.textContent?.trim() ?? '');

/** The screen, once every session file has been read and the counts have settled. */
const counted = async () => {
  await screen.findByRole('heading', { level: 1, name: HEADING });
  await waitFor(() => {
    expect(strip().querySelectorAll('[data-reach="counted"], [data-reach="zero"]')).toHaveLength(
      frames().length,
    );
  });
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the frames', () => {
  it('is one frame per step of the artifact, in its order, with the step’s label', async () => {
    await serveRunData();
    attention('B', 'review');
    await counted();

    expect(frames().map((frame) => frame.dataset.step)).toEqual([
      'cart',
      'payment',
      'review',
      'confirm',
    ]);
    expect(linesOf()[0]).toContain('Cart');
    expect(linesOf()[3]).toContain('Confirmation');
  });

  it('reads how many of this version’s audience reached each step', async () => {
    await serveRunData();
    attention('B', 'review');
    await counted();

    // The redesign's own funnel: everybody at the cart, two people confirming.
    expect(linesOf()).toEqual([
      'Cart11 of 11 reached it',
      'Payment10 of 11 reached it',
      'Review9 of 11 reached it',
      'Confirmation2 of 11 reached it',
    ]);
  });

  it('marks the step the screen is showing, and only that one', async () => {
    await serveRunData();
    attention('B', 'review');
    await counted();

    expect(frames().map((frame) => frame.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
  });

  it('counts the version now shown, without a reload', async () => {
    await serveRunData();
    const { router } = attention('A', 'review');
    await counted();

    expect(linesOf()[3]).toBe('Confirmation9 of 11 reached it');

    await userEvent.click(screen.getByRole('button', { name: /^B/ }));
    await waitFor(() => {
      expect(linesOf()[3]).toBe('Confirmation2 of 11 reached it');
    });
    // One navigation, in the same document: the strip re-projected sessions already read.
    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'review'));
  });

  it('raises no accessibility violation', async () => {
    await serveRunData();
    attention('B', 'review');
    await counted();

    const violations = await axeViolations(strip());
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

describe('pressing a frame', () => {
  it('moves the step in the URL', async () => {
    await serveRunData();
    const { router } = attention('B', 'review');
    await counted();

    await userEvent.click(frameFor('payment'));

    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'payment'));
  });

  it('drops the isolated area, which belonged to the step being left', async () => {
    await serveRunData();
    const isolated = seedRun().aois.find(
      (aoi) => aoi.variant === 'B' && aoi.step === 'review',
    ) as Run['aois'][number];
    const { router } = attention('B', 'review', `?aoi=${isolated.id}`);
    await counted();

    await userEvent.click(frameFor('cart'));

    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'cart'));
    expect(router.state.location.search).toBe('');
  });

  it('changes nothing when the step already shown is pressed', async () => {
    await serveRunData();
    const { router } = attention('B', 'review');
    await counted();
    const before = router.state.location.key;

    await userEvent.click(frameFor('review'));

    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'review'));
    expect(router.state.location.key).toBe(before);
  });

  it('is reachable and pressable with the keyboard alone', async () => {
    await serveRunData();
    const { router } = attention('B', 'review');
    await counted();

    frameFor('cart').focus();
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(frameFor('payment'));

    await userEvent.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'payment'));
  });
});

/* ---- The three readings that are not a count -----------------------------
   The read handed to the component, so that a state the files settle out of in
   a microtask can be held still and looked at. */

const selectionFor = (step: string, setStep = vi.fn()): AttentionSelection => ({
  runId: RUN_ID,
  variant: 'B',
  step,
  aoi: null,
  setVariant: vi.fn(),
  setStep,
  setAoi: vi.fn(),
  fallback: null,
});

const read = (over: Partial<AttentionStepSessions>): AttentionStepSessions => ({
  status: 'ready',
  error: null,
  sessions: [],
  fixations: [],
  saccades: [],
  reachedCount: 0,
  scoredSessionCount: 11,
  ...over,
});

describe('a step nobody reached', () => {
  it('reads 0 with the prototype’s zero marker, never a blank or a dash', async () => {
    // A fifth step of the plan the run has no screen for on either version.
    await serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'thanks', label: 'Thank you' }],
    }));
    attention('B', 'review');
    await counted();

    const frame = frameFor('thanks');
    const reach = frame.querySelector('[data-reach]') as HTMLElement;
    expect(reach.dataset.reach).toBe('zero');
    expect(reach.textContent).toBe('0 of 11 reached it');
    // Still a frame a reader can press: the step's own words are the honest answer there.
    expect(frame.getAttribute('disabled')).toBeNull();
    expect(frame.getAttribute('aria-pressed')).toBe('false');
  });

  it('is pressable, and the screen then says nobody reached it', async () => {
    await serveChangedRun((run) => ({
      ...run,
      steps: [...run.steps, { id: 'thanks', label: 'Thank you' }],
    }));
    const { router } = attention('B', 'review');
    await counted();

    await userEvent.click(frameFor('thanks'));

    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, 'B', 'thanks'));
    expect(await screen.findByText(/Nobody in your audience reached this step/)).toBeTruthy();
  });

  it('draws the zero in the critical colour the prototype marks it with', () => {
    const stylesheet = join(dirname(fileURLToPath(import.meta.url)), 'stepFilmstrip.module.css');
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    expect(rule('.reach')['color']).toBe('var(--color-text-muted)');
    expect(rule('.reach.zero')['color']).toBe('var(--sev-critical)');
  });
});

describe('while the sessions are being read', () => {
  it('keeps the labels and says the count is coming, never a 0 that later changes', () => {
    const run = seedRun();
    render(
      <StepFilmstrip
        run={run}
        selection={selectionFor('review')}
        sessions={read({ status: 'loading', sessions: seedSessions(run) })}
      />,
    );

    expect(linesOf()).toEqual([
      'Cartreading the sessions…',
      'Paymentreading the sessions…',
      'Reviewreading the sessions…',
      'Confirmationreading the sessions…',
    ]);
    expect(strip().querySelector('[data-reach="zero"]')).toBeNull();
    expect(strip().querySelector('[data-reach="counted"]')).toBeNull();
  });

  it('still moves the step, so the strip is navigable before the counts land', async () => {
    const setStep = vi.fn();
    const run = seedRun();
    render(
      <StepFilmstrip
        run={run}
        selection={selectionFor('review', setStep)}
        sessions={read({ status: 'loading' })}
      />,
    );

    await userEvent.click(frameFor('cart'));

    expect(setStep).toHaveBeenCalledWith('cart');
  });
});

describe('when the sessions could not be read', () => {
  it('says so in words rather than rendering zeros', () => {
    const run = seedRun();
    render(
      <StepFilmstrip
        run={run}
        selection={selectionFor('review')}
        sessions={read({ status: 'error', error: 'sessions/S-15.json: 404' })}
      />,
    );

    expect(linesOf()).toEqual([
      'Cartno count: the sessions are unreadable',
      'Paymentno count: the sessions are unreadable',
      'Reviewno count: the sessions are unreadable',
      'Confirmationno count: the sessions are unreadable',
    ]);
    expect(strip().querySelector('[data-reach="zero"]')).toBeNull();
    expect(strip().textContent).not.toContain('reached it0');
  });
});

describe('the counts are read in one place', () => {
  it('derives them nowhere but `reachCounts`', () => {
    const component = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'StepFilmstrip.tsx'),
      'utf8',
    );

    expect(component).toContain("from './reachCounts'");
    // No second rule about who counts: not the exclusion, not `screens[].step`.
    expect(component).not.toContain('excludedFromScores');
    expect(component).not.toContain('screens');
  });
});
