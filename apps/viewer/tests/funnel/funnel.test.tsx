// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { funnelLink, heatmapLink, paths } from '../../src/shell/paths';
import { forgetRuns } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { ruleIn, rulesOf } from '../cssom';
import type { Rule } from '../cssom';
import { loadDesignTokens } from '../setup';
import {
  AGGREGATE_URL,
  RUN_ID,
  cells,
  fixtureAggregate,
  funnelRow,
  funnelRows,
  openFunnel,
  segmentSlices,
  settled,
  sliceOf,
  slowestRow,
  timingRow,
  withSlice,
} from './fixture';

/**
 * `/runs/:runId/funnel` over the fixture run's own aggregate: the funnel by step, the
 * time-per-step distribution, the slowest sessions, and the segment filter — *where did they
 * drop out, and what took them so long* (`#screen-funnel`, `docs/FLOW.md` section 14.5).
 *
 * The suite is written around one claim, because it is the claim the screen exists to keep:
 * **every figure is a field the pipeline stored.** So each figure is asserted twice — once
 * against the fixture's aggregate, and once against an aggregate the test changed. A number
 * that does not move with the file is a number the browser worked out, which is the one
 * thing `docs/adr/0001` forbids.
 */

const MOBILE = 'mobile · in a hurry';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the funnel by screen and step', () => {
  it('draws one row per stored step, in the run words for it', async () => {
    await openFunnel();

    const rows = await funnelRows();
    expect(rows.map((row) => row.dataset['step'])).toEqual([
      'cart',
      'payment',
      'review',
      'confirm',
    ]);
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Cart',
      'Payment',
      'Review',
      'Confirmation',
    ]);
  });

  it('states reached, completed, abandoned and failed, with the stored share', async () => {
    await openFunnel();

    const row = await funnelRow('cart');
    // `aggregate.json`: 22 reached of 22, a stored share of 1, then 19 / 3 / 0.
    expect(row.textContent).toContain('22 reached · 100%');
    expect(row.textContent).toContain('19 completed · 3 abandoned · 0 failed');
  });

  it('draws each bar at the stored share, and marks no other row as the drop', async () => {
    await openFunnel();

    const confirm = await funnelRow('confirm');
    // The stored `reachedShare` of the last step is 0.5, and the bar is that and nothing else.
    expect(confirm.querySelector<HTMLElement>('i')?.style.width).toBe('50%');
    // A stored share times a hundred is a binary float, and that noise does not reach the
    // DOM: `0.8182` is `81.82%`, not `81.82000000000001%`.
    expect((await funnelRow('review')).querySelector<HTMLElement>('i')?.style.width).toBe('81.82%');
    for (const bar of document.querySelectorAll<HTMLElement>('[data-funnel="spread"] i')) {
      expect(bar.style.height).toMatch(/^\d+(\.\d{1,2})?%$/);
    }
    expect((await funnelRows()).filter((row) => row.querySelector('i[data-drop]')).length).toBe(1);
  });

  it('moves every one of the four figures when the stored slice moves', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      funnel: slice.funnel.map((row) =>
        row.step === 'cart'
          ? { ...row, reached: 20, completed: 14, abandoned: 5, failed: 1, reachedShare: 0.9091 }
          : row,
      ),
    }));
    await openFunnel({ aggregate: changed });

    const row = await funnelRow('cart');
    expect(row.textContent).toContain('20 reached · 91%');
    expect(row.textContent).toContain('14 completed · 5 abandoned · 1 failed');
    expect(row.querySelector<HTMLElement>('i')?.style.width).toBe('90.91%');
  });
});

describe('the biggest drop', () => {
  it('marks the stored step and prints the stored reason beside it', async () => {
    await openFunnel();
    const slice = sliceOf(fixtureAggregate(), null);
    const drop = slice.biggestDrop;
    if (drop === null) throw new Error('the fixture slice stores a biggest drop');

    const marked = await funnelRow(drop.step);
    expect(marked.querySelector('i[data-drop]')).not.toBeNull();
    const notice = await settled('[data-funnel="drop-reason"]');
    expect(notice.textContent).toContain('The biggest drop is the Review screen: 7 of 18.');
    expect(notice.textContent).toContain(drop.reason);
  });

  it('links to that step’s heatmap, built where every link in the product is', async () => {
    await openFunnel();

    const notice = await settled('[data-funnel="drop-reason"]');
    const link = within(notice).getByRole('link', { name: 'See where they clicked' });
    expect(link.getAttribute('href')).toBe(heatmapLink(RUN_ID, 'A', 'review'));
  });

  it('names the step and the figures the changed file names, and infers neither', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      biggestDrop: { step: 'payment', left: 1, ofReached: 19, reason: 'Payment — card form' },
    }));
    await openFunnel({ aggregate: changed });

    const notice = await settled('[data-funnel="drop-reason"]');
    expect(notice.textContent).toContain('The biggest drop is the Payment screen: 1 of 19.');
    expect(notice.textContent).toContain('Payment — card form');
    expect((await funnelRow('payment')).querySelector('i[data-drop]')).not.toBeNull();
    expect((await funnelRow('review')).querySelector('i[data-drop]')).toBeNull();
  });

  it('prints no notice for a slice the pipeline stored no drop for', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      biggestDrop: null,
    }));
    await openFunnel({ aggregate: changed });

    await funnelRow('cart');
    expect(document.querySelector('[data-funnel="drop-reason"]')).toBeNull();
  });
});

describe('how long each screen took', () => {
  it('prints the four stored quantiles per step, and no fifth figure', async () => {
    await openFunnel();

    // `aggregate.json`'s cart distribution: 8079 / 10751 / 13991 / 17768 ms.
    expect(cells(await timingRow('cart'))).toEqual(['Cart', '0:08', '0:10', '0:13', '0:17', '']);
  });

  it('draws the distribution with the stored median bar marked', async () => {
    await openFunnel();
    const distribution = sliceOf(fixtureAggregate(), null).timing.perStep.find(
      (row) => row.step === 'cart',
    )?.distribution;
    if (distribution === undefined) throw new Error('the fixture stores a cart distribution');

    const spread = (await timingRow('cart')).querySelector('[data-funnel="spread"]');
    expect(spread?.querySelectorAll('i').length).toBe(distribution.bins.length);
    const bars = [...(spread?.querySelectorAll('i') ?? [])];
    expect(bars.findIndex((bar) => bar.hasAttribute('data-median'))).toBe(distribution.medianBin);
  });

  it('says the distribution in words, with the same numbers the bars are drawn from', async () => {
    await openFunnel();
    const distribution = sliceOf(fixtureAggregate(), null).timing.perStep.find(
      (row) => row.step === 'cart',
    )?.distribution;
    if (distribution === undefined) throw new Error('the fixture stores a cart distribution');

    const spread = (await timingRow('cart')).querySelector('[data-funnel="spread"]');
    const words = spread?.getAttribute('aria-label') ?? '';
    for (const bin of distribution.bins) expect(words).toContain(String(bin));
    expect(words).toContain(`median is in bar ${String(distribution.medianBin + 1)}`);
    expect(words).toContain('the median 0:10');
  });

  it('moves the printed quantiles when the stored distribution moves', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      timing: {
        ...slice.timing,
        perStep: slice.timing.perStep.map((row) =>
          row.step === 'cart'
            ? {
                step: 'cart',
                distribution: {
                  sampleCount: 4,
                  p25Ms: 61000,
                  p50Ms: 95000,
                  p75Ms: 121000,
                  p90Ms: 150000,
                  binWidthMs: 20000,
                  bins: [0, 0, 0, 0, 1, 2, 0, 1],
                  medianBin: 4,
                },
              }
            : row,
        ),
      },
    }));
    await openFunnel({ aggregate: changed });

    expect(cells(await timingRow('cart'))).toEqual(['Cart', '1:01', '1:35', '2:01', '2:30', '']);
  });

  it('says in words that a step nothing was timed on has no spread', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      timing: {
        ...slice.timing,
        perStep: slice.timing.perStep.filter((row) => row.step !== 'confirm'),
      },
    }));
    await openFunnel({ aggregate: changed });

    const line = await settled('[data-funnel="untimed"]');
    expect(line.textContent).toContain('Nothing was timed on Confirmation');
    expect(document.querySelector('[data-funnel="timing"] tbody [data-step="confirm"]')).toBeNull();
  });

  it('prints no average anywhere on the screen', async () => {
    await openFunnel();

    await funnelRow('cart');
    const text = (await settled('[data-screen="funnel"]')).textContent ?? '';
    expect(text).not.toMatch(/\baverage\b/i);
    expect(text).not.toMatch(/\bmeans?\b/i);
    // The one word for the middle of a distribution this screen uses is the median's.
    expect(text).toContain('the median is the dark bar');
  });
});

describe('the slowest sessions', () => {
  it('lists the stored rows slowest first, with the person, the segment and the time', async () => {
    await openFunnel();

    const row = await slowestRow('S-16');
    await waitFor(() => {
      expect(row.textContent).toContain('Careful comparer');
    });
    expect(cells(row)).toEqual([
      'S-16',
      'Careful comparer',
      'desktop · compares carefully',
      '0:58',
      '0:24 of it on Payment',
      'Watch',
    ]);
    const ids = [...document.querySelectorAll('[data-funnel="slowest"] tbody tr')].map(
      (tr) => (tr as HTMLElement).dataset['session'],
    );
    expect(ids).toEqual(sliceOf(fixtureAggregate(), null).timing.slowest.map((s) => s.sessionId));
  });

  it('links each row to its replay', async () => {
    await openFunnel();

    const row = await slowestRow('S-16');
    expect(within(row).getByRole('link', { name: 'Watch' }).getAttribute('href')).toBe(
      paths.session(RUN_ID, 'S-16'),
    );
  });

  it('reads only the sessions it names: the browser re-aggregates nothing', async () => {
    const served = await openFunnel();

    await slowestRow('S-16');
    await waitFor(() => {
      expect(document.querySelector('[data-funnel="slowest"] tbody')?.textContent).toContain(
        'Careful comparer',
      );
    });
    const sessions = served.requests.filter((path) => path.includes('/sessions/'));
    expect([...new Set(sessions)].sort()).toEqual(
      sliceOf(fixtureAggregate(), null)
        .timing.slowest.map((session) => `/runs/${RUN_ID}/sessions/${session.sessionId}.json`)
        .sort(),
    );
    expect(served.requests.filter((path) => path === AGGREGATE_URL).length).toBe(1);
  });

  it('states the absence when the stored slice lists none', async () => {
    const changed = withSlice(fixtureAggregate(), null, (slice) => ({
      ...slice,
      timing: { ...slice.timing, slowest: [] },
    }));
    await openFunnel({ aggregate: changed });

    const line = await settled('[data-funnel="no-slowest"]');
    expect(line.textContent).toContain('no slowest session to list');
    expect(document.querySelector('[data-funnel="slowest"] tbody')).toBeNull();
  });
});

describe('the segment filter', () => {
  it('offers one option per stored slice, in the stored words, as links', async () => {
    await openFunnel();

    const filter = await settled('[data-funnel="filter"]');
    const links = [...filter.querySelectorAll('a')];
    expect(links.map((link) => link.textContent)).toEqual(
      segmentSlices(fixtureAggregate()).map((slice) => slice.label),
    );
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      segmentSlices(fixtureAggregate()).map((slice) =>
        funnelLink(RUN_ID, { segment: slice.segment ?? undefined }),
      ),
    );
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('narrows every figure on the screen to that segment’s own slice', async () => {
    await openFunnel({ narrowing: { segment: MOBILE } });
    const slice = sliceOf(fixtureAggregate(), MOBILE);

    const review = await funnelRow('review');
    // The slice of six, not the twenty-two: 6 reached, 3 completed, 1 abandoned, 2 failed.
    expect(review.textContent).toContain('6 reached · 100%');
    expect(review.textContent).toContain('3 completed · 1 abandoned · 2 failed');
    const drop = slice.biggestDrop;
    if (drop === null) throw new Error('the fixture slice stores a biggest drop');
    expect((await settled('[data-funnel="drop-reason"]')).textContent).toContain(
      `The biggest drop is the Review screen: ${String(drop.left)} of ${String(drop.ofReached)}.`,
    );
    expect(cells(await timingRow('payment'))[2]).toBe('0:10');
    expect((await slowestRow('S-15')).textContent).toContain('0:38');
  });

  it('renders the filter of a URL opened directly, and says which segment it shows', async () => {
    await openFunnel({ narrowing: { segment: MOBILE } });

    const showing = await settled('[data-funnel="showing"]');
    expect(showing.textContent).toContain(`Showing the ${MOBILE} segment`);
    expect(showing.textContent).toContain('6 of the 22 scored sessions');
    const current = (await settled('[data-funnel="filter"]')).querySelector('a[aria-current]');
    expect(current?.textContent).toBe('Mobile · in a hurry 6');
  });

  it('states a segment nobody is in rather than drawing an empty funnel', async () => {
    await openFunnel({ narrowing: { segment: 'nobody at all' } });

    const line = await settled('[data-funnel="no-segment"]');
    expect(line.textContent).toContain('No session of this test is in the “nobody at all” segment');
    expect(line.textContent).not.toMatch(/\d/);
    expect(document.querySelector('[data-funnel="rows"]')).toBeNull();
    // The way back to every segment stays on the screen.
    expect(screen.getByRole('link', { name: 'Show every segment' }).getAttribute('href')).toBe(
      paths.funnel(RUN_ID),
    );
  });
});

describe('the step a citation opens on', () => {
  it('marks the step the URL names, in the funnel and in the timing table', async () => {
    await openFunnel({ narrowing: { step: 'payment' } });

    expect((await funnelRow('payment')).getAttribute('aria-current')).toBe('step');
    expect((await timingRow('payment')).getAttribute('aria-current')).toBe('step');
    expect((await funnelRow('review')).getAttribute('aria-current')).toBeNull();
  });

  it('marks the stored biggest drop when the URL names no step', async () => {
    await openFunnel();

    expect((await funnelRow('review')).getAttribute('aria-current')).toBe('step');
  });

  it('falls back to the stored drop when the URL names a step this slice has not', async () => {
    await openFunnel({ narrowing: { step: 'a-step-renamed-since' } });

    // A stale citation marks nothing of its own, and must not cost the screen the step it is
    // about by default.
    expect((await funnelRow('review')).getAttribute('aria-current')).toBe('step');
    expect(
      [...(await funnelRows())].filter((row) => row.getAttribute('aria-current') === 'step').length,
    ).toBe(1);
  });

  it('carries the step out of a segment that matches nobody', async () => {
    await openFunnel({ narrowing: { segment: 'nobody at all', step: 'payment' } });

    await settled('[data-funnel="no-segment"]');
    expect(screen.getByRole('link', { name: 'Show every segment' }).getAttribute('href')).toBe(
      funnelLink(RUN_ID, { step: 'payment' }),
    );
  });

  it('keeps the step when the reader changes segment', async () => {
    await openFunnel({ narrowing: { step: 'payment' } });

    const filter = await settled('[data-funnel="filter"]');
    const mobile = within(filter).getByRole('link', { name: 'Mobile · in a hurry 6' });
    expect(mobile.getAttribute('href')).toBe(
      funnelLink(RUN_ID, { segment: MOBILE, step: 'payment' }),
    );
  });
});

describe('what the figures are over', () => {
  it('states the scored sessions, and the automation failures outside all of them', async () => {
    await openFunnel();

    const line = await settled('[data-funnel="scored"]');
    expect(line.textContent).toBe('22 scored sessions · the 2 our automation broke are excluded');
  });

  it('states the counts the changed file states', async () => {
    const aggregate = fixtureAggregate();
    await openFunnel({
      aggregate: { ...aggregate, scoredSessionCount: 22, excludedAutomationFailures: 0 },
    });

    expect((await settled('[data-funnel="scored"]')).textContent).toBe(
      '22 scored sessions · our automation broke none of them',
    );
  });

  it('ends with the simulated line, and claims no lift', async () => {
    await openFunnel();

    const line = await settled('[data-shell="simulated-disclaimer"]');
    expect(line.textContent).toContain('simulated');
    expect(line.textContent).toContain('not a conversion-lift estimate');
    // Nothing on the screen claims a lift: the only sentence carrying the word is the one
    // denying it, and it is the last thing on the page.
    const text = (await settled('[data-screen="funnel"]')).textContent ?? '';
    expect(text.match(/lift/g)).toEqual(['lift']);
  });
});

describe('the screen as a whole', () => {
  it('is clean under axe over the funnel, the distributions and both tables', async () => {
    await openFunnel();

    await slowestRow('S-16');
    const violations = await axeViolations(await settled('[data-screen="funnel"]'));
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('is clean under axe with a segment filter on', async () => {
    await openFunnel({ narrowing: { segment: MOBILE } });

    await slowestRow('S-15');
    const violations = await axeViolations(await settled('[data-screen="funnel"]'));
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('reaches every table and every link by keyboard', async () => {
    await openFunnel();

    await slowestRow('S-16');
    const regions = [...document.querySelectorAll('[data-screen="funnel"] [role="region"]')];
    expect(regions.length).toBe(2);
    for (const region of regions) expect(region.getAttribute('tabindex')).toBe('0');
    for (const link of document.querySelectorAll('[data-screen="funnel"] a')) {
      expect(link.getAttribute('href')).toBeTruthy();
    }
  });
});

describe('the stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const screenDir = join(here, '../../src/screens/funnel');
  const stylesheet = join(screenDir, 'funnel.module.css');
  let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

  beforeEach(() => {
    const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
    rule = ruleIn(rules);
  });

  it('draws the funnel bars on the prototype’s track, with the drop in the outcome colour', () => {
    expect(rule('.funnelBar')['background']).toBe('var(--color-surface-sunken)');
    expect(rule('.funnelBar i')['background']).toBe('var(--color-accent-grass)');
    expect(rule('.funnelBar i[data-drop]')['background']).toBe('var(--outcome-abandoned)');
  });

  it('draws the distribution as the prototype does, the median bar darker', () => {
    expect(rule('.dist')['align-items']).toBe('end');
    expect(rule('.dist i')['background']).toBe('var(--color-accent-soft)');
    expect(rule('.dist i[data-median]')['background']).toBe('var(--color-accent-strong)');
  });

  it('is one pill for the segment filter, with the current option on the accent', () => {
    expect(rule('.seg')['border-radius']).toBe('var(--radius-full)');
    expect(rule(".seg a[aria-current='page']")['background']).toBe('var(--color-accent)');
    expect(rule(".seg a[aria-current='page']")['color']).toBe('var(--color-on-accent)');
  });

  it('stacks the funnel rows at the prototype narrow width, so nothing is cut off at 390px', () => {
    expect(rule('.funnelRow', '(max-width: 30rem)')['grid-template-columns']).toBe('1fr');
  });

  it('animates nothing, so the bars are at their final widths under reduced motion', () => {
    const source = readFileSync(stylesheet, 'utf8');
    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });

  it('restates no visual value: every colour and every length is a token', () => {
    // One number cannot be a token: a media query cannot read a custom property, so the
    // queries themselves are taken out before the rest is read.
    const body = readFileSync(stylesheet, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*/g, '');

    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(/i);
    expect(body).not.toMatch(/\bhsla?\(/i);
    expect(body).not.toMatch(/\d\s*(px|rem|em)\b/i);
  });
});
