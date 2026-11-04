// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateRecommendations } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { mountApp } from '../app';
import { stubVideoPlayback } from '../replay/harness';
import { paths, sessionsWithOutcome } from '../../src/shell/paths';
import {
  excludedIds,
  forget,
  hundred,
  outcomeCounts,
  prose,
  RUN_ID,
  SCREENS,
  screenNamed,
  seedFindingsDocument,
  serveHundred,
  serveWhole,
} from './fixture';
import type { ResultScreen } from './fixture';

/**
 * **The people our own automation broke: visible, marked, and in no figure.**
 *
 * `docs/FLOW.md` section 11 makes three promises about them at once, and no single screen
 * can keep all three: an automation failure is **excluded from every figure**, it is
 * **never silently dropped** — it is on the grid and it is replayable — and **no
 * recommendation may rest on one**. Each of the six screens can be right about its own
 * figures and the page still be wrong, so the promises are asserted here, across the six,
 * over one run.
 *
 * The fixture is chosen so that the assertion has something to catch: eight of its hundred
 * sessions are our automation failing, and **counting them would move the headline figure**
 * — 76 of the 92 scored people completed the task, which reads 83%, where 76 of a hundred
 * would read 76%. A screen that quietly included them prints a different number, and the
 * negative below is what makes that a failure rather than a rounding.
 */

/** What one of the six screens reads, as one line. */
const screenWords = (container: HTMLElement): string => prose(container.textContent);

/**
 * The fixture run served and one of the six mounted on it, settled — with the sessions and
 * the aggregate **as they were served**, so an assertion is made against the very files the
 * screen read rather than against a second composition of the same run.
 */
const openOne = async (one: ResultScreen) => {
  const served = await serveWhole();
  const mounted = mountApp(one.path(RUN_ID));
  await one.settled();
  return { ...served, ...mounted };
};

beforeEach(() => {
  loadDesignTokens();
  stubVideoPlayback();
});
afterEach(forget);

describe('the fixture is one where counting them would change a figure', () => {
  it('scores 92 of the hundred, and the two denominators give two different figures', () => {
    const { run, sessions, aggregate } = hundred();
    const counts = outcomeCounts(sessions);
    const excluded = excludedIds(sessions);

    expect(sessions).toHaveLength(100);
    expect(excluded).toHaveLength(8);
    expect(aggregate.excludedAutomationFailures).toBe(excluded.length);
    expect(aggregate.scoredSessionCount).toBe(sessions.length - excluded.length);

    // The figure as the run states it, and the figure counting the excluded would give.
    const stated = Math.round((counts.success / aggregate.scoredSessionCount) * 100);
    const counted = Math.round((counts.success / sessions.length) * 100);
    expect(stated).toBe(83);
    expect(counted).toBe(76);
    expect(run.scores[0]?.scoredSessionCount).toBe(aggregate.scoredSessionCount);
  });

  it('keeps every slice of the aggregate to the scored people', () => {
    const { aggregate } = hundred();
    const scored = aggregate.scoredSessionCount;

    for (const slice of aggregate.funnelSlices) {
      expect(slice.sessionCount, slice.key).toBeLessThanOrEqual(scored);
      for (const step of slice.funnel) {
        expect(step.reached, `${slice.key} ${step.step}`).toBeLessThanOrEqual(scored);
      }
    }
    for (const slice of aggregate.screenSlices) {
      expect(slice.sessionCount, slice.key).toBeLessThanOrEqual(scored);
    }
    // The whole-run slice is of the scored people exactly: it is the denominator every
    // headline figure on the Summary is read against.
    const whole = aggregate.funnelSlices.find(
      (slice) => slice.variant === null && slice.segment === null,
    );
    expect(whole?.sessionCount).toBe(scored);
  });
});

describe('they are never silently dropped', () => {
  it('appears on the grid, every one of them, marked excluded', async () => {
    const { sessions } = await serveHundred();
    const excluded = excludedIds(sessions);
    const { container } = mountApp(sessionsWithOutcome(RUN_ID, 'automation_failure'));

    const tiles = await waitFor(
      () => {
        const drawn = screen.getAllByRole('link', { name: /^S-\d+ · / });
        expect(drawn).toHaveLength(excluded.length);
        return drawn;
      },
      { timeout: 15_000 },
    );

    const named = tiles.map((tile) => (tile.getAttribute('aria-label') ?? '').split(' · ')[0]);
    expect([...named].sort()).toEqual([...excluded].sort());
    // Each one carries the word on the tile itself, not only in the filter above it.
    for (const tile of tiles) expect(prose(tile.textContent)).toContain('excluded');
    expect(screenWords(container)).toContain('excluded');
  }, 40_000);

  it('is replayable: one of them opens its own replay, marked as our breakage', async () => {
    const { sessions } = await serveHundred();
    const broken = excludedIds(sessions)[0] as string;
    mountApp(paths.session(RUN_ID, broken));
    await screenNamed('Session replay').settled();

    expect(prose(document.querySelector('h1')?.textContent)).toContain(broken);
    const card = document.querySelector('[data-outcome]');
    expect(card?.getAttribute('data-outcome')).toBe('automation_failure');
    // The recording is there: a session our automation broke is still watchable.
    expect(document.querySelector('video')).not.toBeNull();
  }, 40_000);
});

describe('they are in no figure on any of the six', () => {
  for (const one of SCREENS) {
    it(`prints no figure that counted them on ${one.name}`, async () => {
      const { aggregate, sessions, container } = await openOne(one);
      const words = screenWords(container);

      // 76%, which is 76 completions over all hundred: the figure this screen would print
      // if it had counted the eight our automation broke.
      expect(words, one.name).not.toMatch(/\b76\s?%/u);
      // And no figure is read against the hundred rather than against the scored people.
      expect(words, one.name).not.toContain(`of ${String(sessions.length)} people`);
      expect(aggregate.scoredSessionCount).toBe(92);
    }, 40_000);
  }

  it('reads the Summary’s headline against the scored people and no others', async () => {
    const { aggregate, container } = await openOne(screenNamed('Summary'));

    const figures = prose(
      container.querySelector('[data-section="headline-figures"]')?.textContent,
    );
    expect(figures).toContain('83%');
    expect(figures).toContain(`of ${String(aggregate.scoredSessionCount)} people`);
  }, 40_000);

  it('reads the funnel’s first step against the scored people', async () => {
    const { aggregate } = await openOne(screenNamed('Funnel and timing'));

    const whole = aggregate.funnelSlices.find(
      (slice) => slice.variant === null && slice.segment === null,
    );
    const first = whole?.funnel[0];
    expect(first?.reached).toBe(aggregate.scoredSessionCount);
    const row = document.querySelector(`[data-funnel="rows"] [data-step="${first?.step ?? ''}"]`);
    expect(prose(row?.textContent)).toContain(String(aggregate.scoredSessionCount));
  }, 40_000);
});

/**
 * Where one of them is named, and what is said **there**.
 *
 * The mark has to be beside the name rather than merely somewhere on the page: the Summary
 * and the Heatmaps both carry the word in a banner of their own, so a screen that listed an
 * excluded person unmarked underneath one would pass a test that only searched the whole
 * screen. So the search is the smallest block that names them — the row, card, list item or
 * link they are in — and that block, or the one above it, has to carry the word.
 */
const mentions = (
  container: HTMLElement,
  sessionId: string,
): { marked: boolean; words: string }[] =>
  [...container.querySelectorAll<HTMLElement>('tr, li, a, [data-part], [data-section]')]
    .filter((block) => prose(block.textContent).includes(sessionId))
    // The innermost blocks only: an ancestor names them because its child does.
    .filter(
      (block, _index, blocks) => !blocks.some((other) => other !== block && block.contains(other)),
    )
    .map((block) => {
      const around = prose(block.parentElement?.textContent ?? block.textContent);
      return { marked: /exclud/iu.test(around), words: prose(block.textContent) };
    });

describe('every screen that mentions them marks them', () => {
  for (const one of SCREENS) {
    it(`names no excluded person on ${one.name} without the word`, async () => {
      const { sessions, container } = await openOne(one);
      const excluded = excludedIds(sessions);

      // Every place this screen names one of them, counted so that the walk below can say
      // whether it judged anything at all.
      const named = excluded.flatMap((sessionId) =>
        mentions(container, sessionId).map((place) => ({ sessionId, ...place })),
      );
      for (const place of named) {
        expect(place.marked, `${one.name} names ${place.sessionId} in “${place.words}”`).toBe(true);
      }
      // Four of the six name nobody, so this one is a negative and cannot anchor itself.
      // The positive is the test below, over the one screen that does name all eight.
    }, 40_000);
  }

  it('does name them somewhere: the grid lists all eight, each marked', async () => {
    // The per-screen tests above are negatives and four of the six name nobody, so the one
    // screen that does is held to the positive: every one of the eight is named, and the
    // mark is in the tile rather than only in the filter above it.
    await serveHundred();
    const { container } = mountApp(sessionsWithOutcome(RUN_ID, 'automation_failure'));
    await waitFor(
      () => {
        expect(screen.getAllByRole('link', { name: /^S-\d+ · / })).toHaveLength(8);
      },
      { timeout: 15_000 },
    );

    const excluded = excludedIds();
    for (const sessionId of excluded) {
      const places = mentions(container, sessionId);
      expect(places.length, `the grid does not name ${sessionId}`).toBeGreaterThan(0);
      for (const place of places) {
        expect(place.marked, `the grid names ${sessionId} in “${place.words}”`).toBe(true);
      }
    }
    expect(excluded).toHaveLength(8);
  }, 40_000);

  it('states the count above the reader’s own figures on the Summary', async () => {
    const { aggregate, sessions, container } = await openOne(screenNamed('Summary'));

    const banner = prose(container.querySelector('[data-section="excluded-banner"]')?.textContent);
    expect(banner).toContain(
      `${String(aggregate.excludedAutomationFailures)} of ${String(sessions.length)} sessions were our own automation failing`,
    );
    expect(banner).toContain('excluded from every figure on this page');
    expect(banner).toContain('from every recommendation');
  }, 40_000);

  it('states it beside the heatmap, in the line that says whose heatmap it is', async () => {
    const { aggregate, container } = await openOne(screenNamed('Heatmaps'));

    expect(screenWords(container)).toContain(
      `the ${String(aggregate.excludedAutomationFailures)} our automation broke are excluded`,
    );
  }, 40_000);

  it('states it under the write-up on the Analysis', async () => {
    const { aggregate, container } = await openOne(screenNamed('Analysis'));

    const footnote = prose(container.querySelector('[data-part="excluded-footnote"]')?.textContent);
    expect(footnote).toContain(String(aggregate.excludedAutomationFailures));
    expect(footnote.toLowerCase()).toContain('exclud');
  }, 40_000);
});

describe('no recommendation and no claim rests on one of them', () => {
  it('is a run the contract accepts, citations and exclusions resolved', () => {
    const { run, sessions, aggregate, recommendations } = hundred();

    expect(
      validateRecommendations({
        run,
        sessions: [...sessions],
        findings: seedFindingsDocument(),
        aggregate,
        recommendations,
      }),
    ).toEqual([]);
  });

  for (const name of ['Summary', 'Analysis'] as const) {
    it(`cites none of them on the rendered ${name}`, async () => {
      const { sessions, container } = await openOne(screenNamed(name));
      const excluded = excludedIds(sessions);

      const cited = [...container.querySelectorAll('[data-part="cites"] a')].map(
        (chip) => chip.getAttribute('href') ?? '',
      );
      expect(cited.length).toBeGreaterThan(0);
      for (const href of cited) {
        for (const sessionId of excluded) expect(href, href).not.toContain(sessionId);
      }
      // Nor in the prose beside the links: a sentence that argues from one of them is a
      // claim about our harness however it is cited.
      const sentences = [...container.querySelectorAll('[data-part="rec"], [data-part="claim"]')]
        .map((block) => prose(block.textContent))
        .join(' ');
      expect(sentences.length).toBeGreaterThan(0);
      for (const sessionId of excluded) expect(sentences, sessionId).not.toContain(sessionId);
    }, 40_000);
  }
});
