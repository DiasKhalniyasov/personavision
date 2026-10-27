// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forget, mountApp, readSeedSession, SEED_RUN, serveRunData, sessionPath } from './harness';

/**
 * What is on the Session replay screen at a given scrubber position.
 *
 * Every assertion is about what a reader sees and can do — the words in the header, the
 * screenshot in the frame and where it is scrolled to, which fixations are drawn and what
 * they are numbered, what the clock and the label read, and what the keyboard moves. None
 * of them reaches into component state.
 *
 * The session is `S-15`, beat 6 of `docs/FLOW.md` section 7: the rushed buyer on mobile,
 * variant B, seed 3, who abandons on the review step. It is the seed run's own numbering,
 * so the sibling tickets test the same person.
 */

const replay = (sessionId: string, query = ''): string =>
  `/runs/${SEED_RUN}/sessions/${sessionId}${query}`;

beforeEach(loadDesignTokens);
afterEach(forget);

/**
 * The screen, with this person's session read: the clock is on the page only once the
 * scrubber has a session to be a position in, so it is what "loaded" means here.
 */
const ready = async (): Promise<void> => {
  await waitFor(() => {
    expect(document.querySelector('#rp-clock')).not.toBeNull();
  });
};

const pageHeading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

/** Whether a control is off: the two step buttons stop at the ends of the session. */
const disabled = (name: string): boolean =>
  (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;

/** A percentage this screen set from the run's own numbers. */
const percent = (value: string): number => Number.parseFloat(value);

describe('the header', () => {
  it('states who this was, and that those three facts reproduce them', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15'));

    await ready();
    expect(pageHeading()).toBe('S-15 · Rushed buyer · Redesign candidate · seed 3');

    // The header's own tags: the outcome card below carries one of its own (#25).
    const tags = [...container.querySelectorAll('.lede .tag')].map((tag) =>
      tag.textContent?.trim(),
    );
    expect(tags).toEqual(['B Redesign candidate', 'Abandoned at 0:38', 'Product at fault']);

    const lede = container.querySelectorAll('.lede');
    expect(lede[0]?.textContent).toContain('iPhone 15 · 390 × 844 · 23 fixations · 3 screens');
    expect(lede[0]?.textContent).toContain('ended on the Review screen');
    expect(lede[0]?.textContent).toContain(
      'generated from the Outdoor-gear shoppers audience, reproducible from that audience, seed 3 and the Redesign candidate pages',
    );
    expect(lede[1]?.textContent).toContain(
      'persistence 0.25 · patience 0.15 · scanning over reading 0.9',
    );
  });

  it('leads back to the people in this test', async () => {
    await serveRunData();
    mountApp(replay('S-15'));
    await ready();

    expect(screen.getByRole('link', { name: 'People' }).getAttribute('href')).toBe(
      `/runs/${SEED_RUN}/sessions`,
    );
  });

  it('names the person while their session is being read, and holds the frame', async () => {
    await serveRunData();
    const served = globalThis.fetch;
    // The one file this screen waits for never arrives, so the loading state stays up.
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input instanceof Request ? input.url : input));
      if (pathname === sessionPath('S-15')) return new Promise<Response>(() => {});
      return served(input);
    });

    const { container } = mountApp(replay('S-15'));

    expect(await screen.findByRole('link', { name: 'People' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('S-15');
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    // Nothing that needs the session itself is on screen yet.
    expect(container.querySelector('#rp-clock')).toBeNull();
  });

  it('states a not-found rather than throwing on a person this test does not hold', async () => {
    await serveRunData();
    mountApp(replay('S-99'));

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'No person with that id',
    );
    expect(screen.getByText(/S-99/)).toBeTruthy();
  });

  it('states a session file that could not be read, and says what is wrong with it', async () => {
    await serveRunData({ files: { [sessionPath('S-15')]: '{ "sessionId": "S-15" }' } });
    mountApp(replay('S-15'));

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'That person’s session could not be read',
    );
  });
});

describe('the frame', () => {
  it('shows the screenshot of the screen the scrubber is on, at that screen’s scroll offset', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=20'));
    await ready();

    // Fixation 20 is the first on the review screen, which this person reached scrolled to 696px.
    const page = container.querySelector('#rp-page img') as HTMLImageElement;
    expect(page.getAttribute('src')).toContain(`/runs/${SEED_RUN}/screenshots/B/review.png`);
    expect(percent(page.style.top)).toBeCloseTo(-82.46, 2);
    expect(percent(page.style.height)).toBeCloseTo(182.46, 2);
  });

  it('swaps the screen at the boundary the session records', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const page = container.querySelector('#rp-page img') as HTMLImageElement;
    expect(page.getAttribute('src')).toContain('/screenshots/B/payment.png');
    // The payment screen was never scrolled, so the capture sits at the top of the frame.
    expect(percent(page.style.top)).toBe(0);
  });

  it('draws the fold where the first viewport ends, from the same offset', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=20'));
    await ready();

    const fold = container.querySelector('[data-fold]') as HTMLElement;
    expect(fold.textContent).toBe('fold');
    expect(percent(fold.style.top)).toBeCloseTo(17.54, 2);
  });

  it('states a screenshot that will not load, and keeps the gaze over the frame', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=20'));
    await ready();

    fireEvent.error(container.querySelector('#rp-page img') as HTMLImageElement);

    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    expect(container.querySelector('#rp-frame')).not.toBeNull();
    expect(container.querySelectorAll('#rp-vec [data-fixation]')).toHaveLength(1);
  });
});

describe('the gaze over the frame', () => {
  const drawn = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('#rp-vec [data-fixation]')].map(
      (mark) => mark.getAttribute('data-fixation') ?? '',
    );

  it('draws the fixations up to the scrubber, with the current one apart from the rest', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    expect(drawn(container)).toEqual(['8', '9', '10', '11', '12']);
    expect(
      [...container.querySelectorAll('#rp-vec [data-current]')].map((mark) =>
        mark.getAttribute('data-fixation'),
      ),
    ).toEqual(['12']);
    // Four saccades between five fixations: the hops that are on this screen.
    expect(container.querySelectorAll('#rp-vec line')).toHaveLength(4);
  });

  it('numbers them continuously across screens rather than restarting at each boundary', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=20'));
    await ready();

    // The first fixation of the third screen is the twentieth of the session.
    expect(drawn(container)).toEqual(['20']);
    expect(container.querySelector('#rp-vec text')?.textContent).toBe('20');
  });
});

describe('the scrubber', () => {
  it('reads elapsed against total, and which fixation of how many', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    expect(container.querySelector('#rp-clock')?.textContent).toBe('0:15 / 0:38');
    expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 12 of 23');
  });

  it('is labelled and announces where it is', async () => {
    await serveRunData();
    mountApp(replay('S-15', '?fix=12'));
    await ready();

    const slider = screen.getByRole('slider', { name: 'Fixation' });
    expect(slider.getAttribute('aria-valuenow')).toBe('12');
    expect(slider.getAttribute('aria-valuemin')).toBe('1');
    expect(slider.getAttribute('aria-valuemax')).toBe('23');
    expect(slider.getAttribute('aria-valuetext')).toBe(
      'fixation 12 of 23, 0:15 of 0:38, on the Payment screen',
    );
  });

  it('steps by fixation from the keyboard', async () => {
    await serveRunData();
    const { container, router } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    screen.getByRole('slider', { name: 'Fixation' }).focus();
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 13 of 23');
    });
    expect(router.state.location.search).toBe('?fix=13');

    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 11 of 23');
    });
  });

  it('steps by fixation from the prev and next controls', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    await userEvent.click(screen.getByRole('button', { name: 'Next fixation' }));
    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 13 of 23');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Previous fixation' }));
    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 12 of 23');
    });
  });

  it('clamps at both ends', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=1'));
    await ready();

    expect(disabled('Previous fixation')).toBe(true);
    screen.getByRole('slider', { name: 'Fixation' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 1 of 23');

    await userEvent.keyboard('{End}');
    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 23 of 23');
    });
    expect(disabled('Next fixation')).toBe(true);
    await userEvent.keyboard('{ArrowRight}');
    expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 23 of 23');
  });

  it('keeps ?fix= in step without filling the history with one entry per step', async () => {
    await serveRunData();
    const { router } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    await userEvent.click(screen.getByRole('button', { name: 'Next fixation' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?fix=13');
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('clamps a ?fix= from outside the session rather than failing the link', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=400'));
    await ready();

    expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 23 of 23');
  });
});

describe('a session with no fixations', () => {
  const noFixations = (): Record<string, string> => {
    const session = readSeedSession('S-15');
    return {
      [sessionPath('S-15')]: JSON.stringify({ ...session, fixations: [], saccades: [] }),
    };
  };

  it('renders its first screen, disables the scrubber and says so', async () => {
    await serveRunData({ files: noFixations() });
    const { container } = mountApp(replay('S-15'));
    await ready();

    expect(container.querySelector('#rp-page img')?.getAttribute('src')).toContain(
      '/screenshots/B/cart.png',
    );
    expect(container.querySelectorAll('#rp-vec [data-fixation]')).toHaveLength(0);
    expect(screen.getByRole('slider', { name: 'Fixation' }).hasAttribute('data-disabled')).toBe(
      true,
    );
    expect(disabled('Next fixation')).toBe(true);
    expect(screen.getByText(/No fixations were recorded for this person/)).toBeTruthy();
  });

  it('still reads as a transcript, with rows that do not offer to move the scrubber', async () => {
    await serveRunData({ files: noFixations() });
    const { container } = mountApp(replay('S-15'));
    await ready();

    expect(rows(container, 1)).toEqual([
      '0:14 | type · Card number · autofilled',
      '0:26 | click · Place order · $129.00',
    ]);
    expect(container.querySelectorAll('[data-event]')).not.toHaveLength(0);
    expect(container.querySelectorAll('button[data-event]')).toHaveLength(0);
  });
});

/** The cards in the right-hand column, by the order they are rendered in. */
const cards = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('#rp-timeline [data-screen-card]'),
];

/** One card's event rows, as `timestamp | the rest of the row`. */
const rows = (container: HTMLElement, card: number): string[] =>
  [...(cards(container)[card]?.querySelectorAll('[data-event]') ?? [])].map((row) =>
    [...row.children].map((part) => part.textContent?.trim()).join(' | '),
  );

describe('the agent’s intent and the event log', () => {
  it('opens one card per screen, naming the step, the fixations and the stretch of clock', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    expect(cards(container).map((card) => card.querySelector('h2')?.textContent)).toEqual([
      'Screen 1 of 3 · Cart',
      'Screen 2 of 3 · Payment',
      'Screen 3 of 3 · Review',
    ]);
    expect(cards(container)[1]?.textContent).toContain('fixations 8–19 · 0:10–0:29');
  });

  it('prints the sentence the agent stated for each screen, in its own words', async () => {
    await serveRunData();
    mountApp(replay('S-15', '?fix=12'));
    await ready();

    // Word for word what the session file records. The quotation marks are the
    // stylesheet's, so the sentence itself is on the page unaltered.
    expect(
      screen.getByText('See what the boots cost in total before I put a card in.'),
    ).toBeTruthy();
    expect(screen.getByText('Pay as fast as possible, the card is saved.')).toBeTruthy();
    expect(
      screen.getByText('I thought I had paid. Why is the total higher than it was?'),
    ).toBeTruthy();
  });

  it('lists that screen’s events in time order, with the kind and what each was aimed at', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const payment = rows(container, 1);
    expect(payment).toHaveLength(16);
    expect(payment[0]).toBe('0:10 | read · Promo banner · 497 ms held');
    expect(payment[3]).toBe('0:14 | type · Card number · autofilled');
    expect(payment).toContain('0:23 | hesitate · 1.9 s with no action');
    expect(payment).toContain('0:26 | click · Place order · $129.00');
    expect(payment).toContain('0:28 | scroll · window · to 696 px');
    // The planted defect, on the screen where this person found it.
    expect(rows(container, 2)[1]).toBe(
      '0:31 | read · Service fee row — planted defect · 631 ms held',
    );
  });

  it('marks the card the scrubber is on, in a word as well as in colour', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    expect(cards(container).map((card) => card.getAttribute('data-active'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(cards(container)[1]?.getAttribute('aria-current')).toBe('true');
    expect(cards(container)[1]?.textContent).toContain('showing now');
    expect(cards(container)[0]?.textContent).not.toContain('showing now');
  });

  it('highlights the row the session model reports for that moment, and follows the scrubber', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const current = (): string[] =>
      [...container.querySelectorAll('[data-event][aria-current="true"]')].map((row) =>
        [...row.children].map((part) => part.textContent?.trim()).join(' | '),
      );

    expect(current()).toEqual(['0:15 | read · Expiry field · 202 ms held']);

    await userEvent.click(screen.getByRole('button', { name: /Next fixation/ }));
    await waitFor(() => {
      expect(current()).toEqual(['0:17 | read · CVC field · 181 ms held']);
    });
  });

  it('moves the scrubber to a row’s own moment when it is clicked, and the frame follows', async () => {
    await serveRunData();
    const { container, router } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const abandon = cards(container)[2]?.querySelector(
      '[data-event="action:5"]',
    ) as HTMLButtonElement;
    expect(abandon.textContent).toContain('abandon');
    await userEvent.click(abandon);

    await waitFor(() => {
      expect(router.state.location.search).toBe('?fix=23');
    });
    expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 23 of 23');
    expect(container.querySelector('#rp-page img')?.getAttribute('src')).toContain(
      '/screenshots/B/review.png',
    );
    expect(cards(container)[2]?.getAttribute('data-active')).toBe('true');
  });

  it('is navigable from the keyboard: every row is a control that moves the scrubber', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const row = cards(container)[0]?.querySelector('[data-event="read:0"]') as HTMLButtonElement;
    row.focus();
    expect(document.activeElement).toBe(row);

    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(container.querySelector('#rp-fixlabel')?.textContent).toBe('fixation 1 of 23');
    });
    expect(cards(container)[0]?.getAttribute('data-active')).toBe('true');
  });

  it('states a screen that recorded nothing rather than leaving an empty list', async () => {
    const session = readSeedSession('S-15');
    const screens = session.screens as Record<string, unknown>[];
    await serveRunData({
      files: {
        [sessionPath('S-15')]: JSON.stringify({
          ...session,
          // A fourth screen this person reached and did nothing on.
          screens: [...screens, { ...screens[2], index: 3, step: 'confirm' }],
        }),
      },
    });
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const last = cards(container)[3] as HTMLElement;
    expect(last.querySelector('h2')?.textContent).toBe('Screen 4 of 4 · Confirmation');
    expect(last.textContent).toContain('no fixations · no time on the clock');
    expect(last.textContent).toContain('no actions recorded on this screen');
    expect(last.querySelectorAll('[data-event]')).toHaveLength(0);
  });
});

describe('the screen as a whole', () => {
  it('leaves the rest of the column to the outcome card', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15'));
    await ready();

    const column = container.querySelector('#rp-timeline');
    expect(column).not.toBeNull();
    // The three screen cards, and the outcome card that closes the column (#25).
    expect(column?.childElementCount).toBe(4);
    expect(column?.lastElementChild?.getAttribute('data-outcome')).toBe('abandoned');
  });

  it('passes axe at a scrubber position', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15', '?fix=12'));
    await ready();

    const audit = await axe.run(container, {
      // jsdom paints nothing, so contrast is not measurable here; the tokens' own pairs
      // are the design contract's and are asserted against a build in `theme.test.ts`.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(audit.violations.map((violation) => violation.id)).toEqual([]);
  }, 30_000);

  it('ends with the line that says the numbers are simulated', async () => {
    await serveRunData();
    const { container } = mountApp(replay('S-15'));
    await ready();

    // The sentence itself is the shell's, written once for every results screen (#14). The
    // audience in it is the run's, which the shell reads separately from the session this
    // screen waited for, so the line is awaited rather than read the moment the screen is up.
    const disclaimer = (): string =>
      container.querySelector('[data-shell="simulated-disclaimer"]')?.textContent ?? '';
    await waitFor(() => {
      expect(disclaimer()).toContain('Outdoor-gear shoppers');
    });
    expect(disclaimer()).toContain('simulated');
  });
});
