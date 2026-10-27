// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations, describeViolations } from '../axe';
import { loadDesignTokens } from '../setup';
import { forget, mountApp, SEED_RUN, serveRunData } from './harness';

/**
 * The card that closes the Session replay: how this person's session ended, whose fault
 * that was, which of the run's findings it is evidence for, and whether our own harness
 * held up while it happened.
 *
 * Every assertion is about the words a reader sees and where its links land, over the
 * committed example run — a product-at-fault session (`S-15`, beat 6 of `docs/FLOW.md`
 * section 7), a success, a failure and an automation failure — so the four outcomes are
 * checked as they are actually rendered rather than as a component's state.
 */

const replay = (sessionId: string): string => `/runs/${SEED_RUN}/sessions/${sessionId}`;

beforeEach(loadDesignTokens);
afterEach(forget);

/** The card itself, once the session has been read. */
const card = async (): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(document.querySelector('[data-outcome]')).not.toBeNull();
  });
  return document.querySelector('[data-outcome]') as HTMLElement;
};

/** What one row of the card's `.kv` list says, by the word in its term. */
const row = (element: HTMLElement, term: string): string => {
  const terms = [...element.querySelectorAll('dt')];
  const at = terms.findIndex((dt) => dt.textContent?.trim() === term);
  expect(at, term).toBeGreaterThanOrEqual(0);
  return element.querySelectorAll('dd')[at]?.textContent?.trim() ?? '';
};

const heading = (element: HTMLElement): string =>
  element.querySelector('h2')?.textContent?.trim() ?? '';

describe('how the session ended', () => {
  it('names the outcome, the step it ended on and the attribution, and gives the reason', async () => {
    await serveRunData();
    mountApp(replay('S-15'));

    const outcome = await card();
    expect(heading(outcome)).toBe(
      'Abandoned at the Review step · the product was at fault, not our simulation',
    );
    expect(outcome.querySelector('p')?.textContent).toBe(
      'Review — service fee revealed, left without ordering',
    );
  });

  it('keeps abandoned, failed and automation failure apart, in words and in colour', async () => {
    await serveRunData();

    const read = async (sessionId: string): Promise<[string, string]> => {
      const { unmount } = mountApp(replay(sessionId));
      const outcome = await card();
      const words = heading(outcome);
      const colour = outcome.querySelector('h2')?.getAttribute('style') ?? '';
      unmount();
      return [words, colour];
    };

    const [abandoned, abandonedColour] = await read('S-15');
    const [failed, failedColour] = await read('S-13');
    const [broken, brokenColour] = await read('S-09');

    expect(abandoned).toBe(
      'Abandoned at the Review step · the product was at fault, not our simulation',
    );
    expect(failed).toBe('Failed at the Review step · the product was at fault, not our simulation');
    expect(broken).toBe(
      'Automation failure at the Payment step · our own automation was at fault, not the product',
    );

    expect(abandonedColour).toContain('--outcome-abandoned');
    expect(failedColour).toContain('--outcome-failed');
    expect(brokenColour).toContain('--attr-automation');
    expect(new Set([abandonedColour, failedColour, brokenColour]).size).toBe(3);
  });

  it('does not dress a success as an abandonment', async () => {
    await serveRunData();
    mountApp(replay('S-01'));

    const outcome = await card();
    expect(heading(outcome)).toBe(
      'Success at the Confirmation step · this is the product’s own result, not our simulation’s',
    );
    expect(outcome.getAttribute('style')).toContain('--outcome-success-bg');
  });
});

describe('the findings this person supports', () => {
  it('lists every finding citing this session, best-ranked first, each to its own evidence', async () => {
    await serveRunData();
    mountApp(replay('S-15'));
    await card();

    // The findings file is read after the run, so the row's own words are what is waited for.
    const first = await screen.findByRole('link', { name: /^#1 / });
    const named = [...(await card()).querySelectorAll('a')].map((link) => link.textContent);
    expect(named).toEqual([
      '#1 Nobody in your audience ever looked at the button that completes the order on the redesign.',
      '#2 A $9.95 service fee only appears after the card is entered, and 4 of 9 people left within 5 seconds of seeing it.',
      '#3 The sale banner takes the first look in 9 of 10 people, about 1.3 s before they look at any form field.',
    ]);

    expect(first.getAttribute('href')).toBe(
      `/runs/${SEED_RUN}/attention/B/review?aoi=B-review-complete`,
    );
    expect(screen.getByRole('link', { name: /^#3 / }).getAttribute('href')).toBe(
      `/runs/${SEED_RUN}/attention/B/payment?aoi=B-payment-promo`,
    );
  });

  it('says so in a sentence when no finding cites this person', async () => {
    await serveRunData();
    mountApp(replay('S-01'));

    const outcome = await card();
    await waitFor(() => {
      expect(row(outcome, 'Supports findings')).toBe('No finding in this test cites this person.');
    });
  });

  it('never shows the row blank while the findings are still being read', async () => {
    await serveRunData();
    const served = globalThis.fetch;
    // The findings file never arrives, so the row stays in its loading state.
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input instanceof Request ? input.url : input));
      if (pathname.endsWith('/findings.json')) return new Promise<Response>(() => {});
      return served(input);
    });

    mountApp(replay('S-15'));

    const outcome = await card();
    expect(row(outcome, 'Supports findings')).toBe('Reading this test’s findings.');
  });

  it('states that the link could not be resolved when the findings file is unreadable', async () => {
    await serveRunData({ files: { [`/runs/${SEED_RUN}/findings.json`]: '{ "runId": 7 }' } });
    mountApp(replay('S-15'));

    const outcome = await card();
    await waitFor(() => {
      expect(row(outcome, 'Supports findings')).toContain(
        'The findings this person supports could not be resolved',
      );
    });
  });
});

describe('whether our own automation held up', () => {
  it('claims the outcome for the product with the counts beside the claim', async () => {
    await serveRunData();
    mountApp(replay('S-15'));

    expect(row(await card(), 'Automation integrity')).toBe(
      'no selector failures every action resolved, with no retries, so the outcome is the product’s and not the harness’s.',
    );
  });

  it('states the counts and the exclusion when our own browsing broke', async () => {
    await serveRunData();
    mountApp(replay('S-09'));

    expect(row(await card(), 'Automation integrity')).toBe(
      'automation failure our own browsing broke on this session — 1 selector failure, 1 retry — so this person is excluded from the friction score and from every area-of-interest metric.',
    );
  });
});

describe('checking the claim', () => {
  it('names the session file under the run directory', async () => {
    await serveRunData();
    mountApp(replay('S-15'));

    expect(row(await card(), 'Reproduce')).toBe(`runs/${SEED_RUN}/sessions/S-15.json`);
  });

  it('passes axe', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15'));
    await card();
    await screen.findByRole('link', { name: /^#1 / });

    const violations = await axeViolations(container);
    expect(describeViolations(violations)).toBe('');
  }, 30_000);
});
