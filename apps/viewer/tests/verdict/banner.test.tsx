// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPaths } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { paths } from '../../src/shell/paths';

/**
 * The honest edges of the Verdict screen: the banner above the headline and the disclaimer
 * at the foot.
 *
 * Both are read from the run as the pipeline wrote it. The banner's count comes from the
 * `excludedFromScores` and `attribution` fields stored on each session — the two tests
 * below that rewrite one session prove it is those fields and not the outcome status — and
 * the disclaimer carries the run's own calibration figures.
 */

const SEED = '2026-10-24-1402-northwind-demo';
const LAYOUT = runPaths('');

/** The two people the example run excluded: our automation timed out on the card iframe. */
const EXCLUDED = ['S-09', 'S-23'];
const AUDIENCE = 'Outdoor-gear shoppers';

const sessionUrl = (sessionId: string): string => `/runs/${SEED}/${LAYOUT.session(sessionId)}`;

/** One session of the example run, with its outcome rewritten. */
const withOutcome = (sessionId: string, outcome: Record<string, unknown>): string => {
  const session = readRunFile(SEED, LAYOUT.session(sessionId));
  return JSON.stringify({
    ...session,
    outcome: { ...(session.outcome as Record<string, unknown>), ...outcome },
  });
};

const find = async (selector: string): Promise<HTMLElement> =>
  await waitFor(() => {
    const element = document.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    return element as HTMLElement;
  });

/** The screen with its sessions read: the banner is either there or deliberately absent. */
const settled = async (): Promise<void> => {
  await find('[data-section="headline"]');
  await waitFor(() => {
    expect(
      document.querySelector('[data-section="excluded-banner"][data-state="loading"]'),
    ).toBeNull();
  });
};

/** The footnote, once the run whose audience and calibration it names has arrived. */
const disclaimer = async (): Promise<HTMLElement> => {
  const footnote = await find('[data-shell="simulated-disclaimer"]');
  await waitFor(() => {
    expect(footnote.textContent).toContain(AUDIENCE);
  });
  return footnote;
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the excluded-people banner', () => {
  it('names how many of how many, and says they count against neither version', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    const banner = await find('.notice[data-section="excluded-banner"]');
    expect(banner.textContent).toContain(`${EXCLUDED.length} of the 24 people`);
    expect(banner.textContent).toContain('excluded from both figures');
    expect(banner.textContent).toContain('not counted against either version');
    // Where it broke, named by the label the run gives that step.
    expect(banner.textContent).toContain('our own browser automation broke on the Payment step');
  });

  it("leaves the pipeline's own words for the screen one click deeper", async () => {
    // `docs/FLOW.md` section 8: on the Verdict screen the words are the user's. The reason
    // the pipeline stores is a sentence of its own, which would state the banner's claim
    // twice inside its own sentence.
    const stored =
      'Our own browsing broke on the "payment" step: selector timeout on the card iframe.';
    await serveRunData({
      files: Object.fromEntries(
        EXCLUDED.map((sessionId) => [
          sessionUrl(sessionId),
          withOutcome(sessionId, { reason: stored }),
        ]),
      ),
    });
    mountApp(paths.run(SEED));

    const banner = await find('.notice[data-section="excluded-banner"]');
    expect(banner.textContent).toContain('our own browser automation broke on the Payment step');
    expect(banner.textContent).not.toContain('Our own browsing broke');
  });

  it('names no step when the excluded people stopped in different places', async () => {
    await serveRunData({
      files: { [sessionUrl('S-09')]: withOutcome('S-09', { step: 'cart' }) },
    });
    mountApp(paths.run(SEED));

    const banner = await find('.notice[data-section="excluded-banner"]');
    expect(banner.textContent).toContain('our own browser automation broke. They are');
    expect(banner.textContent).toContain('2 of the 24 people');
  });

  it('links to the Sessions route filtered to exactly those sessions', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    const link = await find('.notice[data-section="excluded-banner"] a');
    expect(link.getAttribute('href')).toBe(`${paths.sessions(SEED)}?outcome=automation_failure`);
  });

  it('sits above the headline and is not announced as an error', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    const banner = await find('.notice[data-section="excluded-banner"]');
    const headline = await find('[data-section="headline"]');

    // The reading order of `#screen-verdict`: the banner, then the headline it qualifies.
    expect(
      banner.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(banner.getAttribute('role')).toBeNull();
    expect(banner.getAttribute('aria-live')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders no banner at all for a run that excluded nobody', async () => {
    await serveRunData({
      files: Object.fromEntries(
        EXCLUDED.map((sessionId) => [
          sessionUrl(sessionId),
          withOutcome(sessionId, {
            status: 'abandoned',
            attribution: 'product',
            excludedFromScores: false,
          }),
        ]),
      ),
    });
    mountApp(paths.run(SEED));

    await settled();
    expect(document.querySelector('[data-section="excluded-banner"]')).toBeNull();
    expect(document.querySelector('.notice')).toBeNull();
  });

  it('counts the stored exclusion rather than re-deriving it from the outcome status', async () => {
    // Still an automation failure by its status, and stored as the product's and scored: a
    // banner that counted statuses would say two.
    await serveRunData({
      files: {
        [sessionUrl('S-09')]: withOutcome('S-09', {
          attribution: 'product',
          excludedFromScores: false,
        }),
      },
    });
    mountApp(paths.run(SEED));

    const banner = await find('.notice[data-section="excluded-banner"]');
    expect(banner.textContent).toContain('1 of the 24 people');
    expect(banner.textContent).toContain('See that person');
  });
});

describe('the simulated-data disclaimer', () => {
  it('names the audience, the simulation and what the figures are not', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    const footnote = await disclaimer();
    expect(footnote.textContent).toContain('simulated');
    expect(footnote.textContent).toContain('not a conversion-lift estimate');
    expect(footnote.textContent).toContain('does not replace a test on real customers');
  });

  it('carries the run calibration figures, so the claim has a number behind it', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    const footnote = await disclaimer();
    expect(footnote.textContent).toContain(
      'Similarity to real human gaze on the UEyes benchmark: CC 0.68 / NSS 1.9 / ScanMatch 0.54.',
    );
  });

  it('says so plainly when the run records no calibration', async () => {
    await serveRunData({
      files: {
        [`/runs/${SEED}/${LAYOUT.run}`]: JSON.stringify({
          ...readRunFile(SEED),
          calibration: null,
        }),
      },
    });
    mountApp(paths.run(SEED));

    const footnote = await disclaimer();
    expect(footnote.textContent).toContain(
      'No calibration against real human gaze is recorded for this test.',
    );
  });

  it('is the foot of the screen, and no run metadata row is on it', async () => {
    await serveRunData();
    mountApp(paths.run(SEED));

    await settled();
    // The task, people, devices, engine and run directory belong to the Score breakdown
    // screen (#107) now.
    expect(document.querySelector('.runmeta')).toBeNull();
  });
});
