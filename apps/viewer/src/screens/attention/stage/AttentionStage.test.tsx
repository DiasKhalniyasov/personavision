// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../../tests/app';
import { axeViolations, describeViolations } from '../../../../tests/axe';
import { ruleIn, rulesOf } from '../../../../tests/cssom';
import { loadDesignTokens } from '../../../../tests/setup';

/**
 * `#att-frame` and `#att-page` over the repository's own committed example run.
 *
 * What is asserted is the page a designer is looking at and whether what is drawn over it
 * is still on the element it belongs to: the screenshot the run names, at the size it was
 * captured, the fold where the capture says the first viewport ended, and the outlines in
 * register with both through a zoom. Never a canvas pixel — the geometry is read off the
 * transform and off the rendered attributes, as `docs/FLOW.md` and #4 ask.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = 'Where your audience looked';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const serveChangedRun = async (change: (run: Run) => Run) => {
  const changed = change(seedRun());
  await serveRunData({ files: { [`/runs/${RUN_ID}/run.json`]: JSON.stringify(changed) } });
  return changed;
};

const attention = (variant = 'B', step = 'review', query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

/** The screen, once the run has been read. The stage needs nothing of the sessions. */
const ready = () => screen.findByRole('heading', { level: 1, name: HEADING });

const frameOf = (container: HTMLElement) => container.querySelector('#att-frame') as HTMLElement;
const pageOf = (container: HTMLElement) => container.querySelector('#att-page') as HTMLElement;
const imageOf = (container: HTMLElement) =>
  container.querySelector('#att-page img') as HTMLImageElement;

/** The page as it is once its screenshot has arrived, which jsdom never does on its own. */
const decoded = (container: HTMLElement) => {
  fireEvent.load(imageOf(container));
};

const outlineToggle = () => screen.getByRole('button', { name: /Areas of interest/ });
const zoomTo = (level: string) => userEvent.click(screen.getByRole('radio', { name: level }));

const boxOf = (container: HTMLElement, aoiId: string) => {
  const rect = container.querySelector(`[data-aoi="${aoiId}"]`) as SVGRectElement;
  return {
    x: rect.getAttribute('x'),
    y: rect.getAttribute('y'),
    width: rect.getAttribute('width'),
    height: rect.getAttribute('height'),
  };
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the page as the audience saw it', () => {
  it('renders the screenshot the run names, from the path the artifact itself records', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    expect(imageOf(container).getAttribute('src')).toContain(
      `/runs/${RUN_ID}/screenshots/B/review.png`,
    );
  });

  it('follows the artifact when the capture is stored somewhere else', async () => {
    await serveChangedRun((run) => ({
      ...run,
      screenshots: run.screenshots.map((shot) =>
        shot.variant === 'B' && shot.step === 'review'
          ? { ...shot, path: 'screenshots/B/review-2.png' }
          : shot,
      ),
    }));
    const { container } = attention();
    await ready();

    expect(imageOf(container).getAttribute('src')).toContain('/screenshots/B/review-2.png');
  });

  it('gives the page the box the capture recorded, so the whole page is there to scroll', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    // The redesign's review step: a 390-wide mobile viewport over a 1540px page.
    expect(pageOf(container).style.width).toBe('390px');
    expect(pageOf(container).style.height).toBe('1540px');
  });

  it('reserves that box before the screenshot decodes, so nothing below it jumps', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    // jsdom loads no image, so this *is* the state before the decode.
    expect(frameOf(container).dataset.screenshot).toBe('loading');
    expect(pageOf(container).style.height).toBe('1540px');
    expect(container.querySelector('[data-overlay-layer]')).toBeNull();

    decoded(container);
    expect(frameOf(container).dataset.screenshot).toBe('shown');
    expect(pageOf(container).style.height).toBe('1540px');
  });

  it('names what the page is, so the screenshot is not a picture of nothing', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    expect(imageOf(container).getAttribute('alt')).toBe(
      'The Review step of Redesign candidate, the whole page as your audience saw it',
    );
  });
});

describe('a screenshot that is not there', () => {
  it('states the step and the version when the run holds no capture of it', async () => {
    await serveChangedRun((run) => ({
      ...run,
      screenshots: run.screenshots.filter(
        (shot) => !(shot.variant === 'B' && shot.step === 'review'),
      ),
    }));
    const { container } = attention();
    await ready();

    expect(frameOf(container).dataset.screenshot).toBe('missing');
    expect(
      screen.getByText(
        'This test holds no screenshot of the Review step on Redesign candidate, so there is no page to show the overlays over.',
      ),
    ).toBeDefined();
    expect(container.querySelector('#att-page img')).toBeNull();
  });

  it('draws no overlay over a page that is not there, however the switches are set', async () => {
    await serveChangedRun((run) => ({
      ...run,
      screenshots: run.screenshots.filter(
        (shot) => !(shot.variant === 'B' && shot.step === 'review'),
      ),
    }));
    const { container } = attention();
    await ready();

    await userEvent.click(outlineToggle());

    expect(outlineToggle().getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-overlay-layer]')).toBeNull();
  });

  it('keeps the overlays over a page whose file would not load, since its box is known', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    fireEvent.error(imageOf(container));

    expect(frameOf(container).dataset.screenshot).toBe('unreadable');
    expect(boxOf(container, 'B-review-complete').x).toBe(String((16 / 390) * 100));
  });

  it('names the path when the file is there but cannot be read', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    fireEvent.error(imageOf(container));

    expect(frameOf(container).dataset.screenshot).toBe('unreadable');
    const stated = screen.getByText(/could not be read/);
    expect(stated.textContent).toContain('screenshots/B/review.png');
    expect(stated.textContent).toContain('390 by 1540 pixels');
    expect(container.querySelector('#att-page img')).toBeNull();
    // The frame and its box stay: a blank stage would read as "your audience saw nothing".
    expect(pageOf(container).style.height).toBe('1540px');
  });

  it('gives the next step its own chance rather than remembering that one failed', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    fireEvent.error(imageOf(container));
    expect(frameOf(container).dataset.screenshot).toBe('unreadable');

    await userEvent.click(screen.getByRole('button', { name: 'A · Current checkout' }));

    expect(frameOf(container).dataset.screenshot).toBe('loading');
    expect(imageOf(container).getAttribute('src')).toContain('/screenshots/A/review.png');
  });
});

describe('the fold', () => {
  it('sits where the capture says the first viewport ended, and names that viewport', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    const fold = container.querySelector('[data-fold]') as HTMLElement;
    expect(fold.textContent).toBe('fold · 390 × 844');
    // 844 of the 1540px page.
    expect(fold.style.top).toBe(`${(844 / 1540) * 100}%`);
  });

  it('reads the same way for a desktop capture', async () => {
    await serveChangedRun((run) => ({
      ...run,
      screenshots: run.screenshots.map((shot) =>
        shot.variant === 'B' && shot.step === 'review'
          ? { ...shot, viewport: { width: 1280, height: 800 }, pageHeight: 1600, foldY: 800 }
          : shot,
      ),
    }));
    const { container } = attention();
    await ready();

    const fold = container.querySelector('[data-fold]') as HTMLElement;
    expect(fold.textContent).toBe('fold · 1280 × 800');
    expect(fold.style.top).toBe('50%');
    expect(pageOf(container).style.width).toBe('1280px');
  });
});

describe('the zoom', () => {
  it('opens the page at the size it was captured', async () => {
    await serveRunData();
    attention();
    await ready();

    expect(screen.getByRole('radio', { name: '100%' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: 'Zoom' })).toBeDefined();
  });

  it('scales the page the overlays are drawn on, and nothing else', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();

    await zoomTo('200%');
    expect(pageOf(container).style.width).toBe('780px');
    expect(pageOf(container).style.height).toBe('3080px');

    await zoomTo('50%');
    expect(pageOf(container).style.width).toBe('195px');
    expect(pageOf(container).style.height).toBe('770px');
  });
});

describe('an overlay stays registered to the screenshot', () => {
  it('draws the same overlay coordinates at every zoom level', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    // `B-review-complete`: the button of the demo's whole finding, below the fold.
    const atCapturedSize = boxOf(container, 'B-review-complete');

    await zoomTo('50%');
    expect(boxOf(container, 'B-review-complete')).toEqual(atCapturedSize);
    await zoomTo('200%');
    expect(boxOf(container, 'B-review-complete')).toEqual(atCapturedSize);
    // Which is only registration if the box itself moved: at 200% it is twice as wide.
    expect(pageOf(container).style.width).toBe('780px');
  });

  it('is one object with the page, so scrolling the frame cannot separate them', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    const page = pageOf(container);
    // The frame is what scrolls; the image and every layer are inside the page box it
    // scrolls over, so there is no second thing for a scroll offset to move.
    expect(page.parentElement).toBe(frameOf(container));
    expect(imageOf(container).parentElement).toBe(page);
    expect(
      (container.querySelector('[data-overlay-layer="aoi"]') as HTMLElement).parentElement,
    ).toBe(page);
  });

  it('is the frame that scrolls, over the whole captured page', () => {
    const stylesheet = join(dirname(fileURLToPath(import.meta.url)), 'attentionStage.module.css');
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    expect(rule('.frame')['overflow']).toBe('auto');
    expect(rule('.frame')['aspect-ratio']).toBe('var(--frame-ratio-desktop)');
    expect(rule('.page')['position']).toBe('relative');
    expect(rule('.layer')['position']).toBe('absolute');
  });
});

describe('the area-of-interest outlines', () => {
  it('are off until the reader asks for them', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);

    expect(outlineToggle().getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-overlay-layer="aoi"]')).toBeNull();
  });

  it('draw a box and a label for every area of this version’s step', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    const run = seedRun();
    const here = run.aois
      .filter((aoi) => aoi.variant === 'B' && aoi.step === 'review')
      .map((aoi) => aoi.id);
    expect(here.length).toBeGreaterThan(1);

    const drawn = [...container.querySelectorAll('[data-aoi]')].map((box) =>
      box.getAttribute('data-aoi'),
    );
    expect(drawn).toEqual(here);
    const labelled = [...container.querySelectorAll('[data-aoi-label]')].map(
      (label) => label.textContent,
    );
    expect(labelled).toEqual(here);
  });

  it('place a box where the run recorded it, in the overlay’s own units', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    // bbox { x: 16, y: 1024, width: 358, height: 48 } over a 390px-wide capture.
    expect(boxOf(container, 'B-review-complete')).toEqual({
      x: String((16 / 390) * 100),
      y: String((1024 / 390) * 100),
      width: String((358 / 390) * 100),
      height: String((48 / 390) * 100),
    });
  });

  it('mark the area the URL isolates, and keep the rest drawn', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', '?aoi=B-review-fee-row');
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    const isolated = [...container.querySelectorAll('[data-aoi]')]
      .filter((box) => box.hasAttribute('data-isolated'))
      .map((box) => box.getAttribute('data-aoi'));

    expect(isolated).toEqual(['B-review-fee-row']);
    expect(container.querySelectorAll('[data-aoi]').length).toBeGreaterThan(1);
  });

  it('take their colour and their dash from the gaze tokens, and state neither itself', () => {
    const stylesheet = join(dirname(fileURLToPath(import.meta.url)), 'attentionStage.module.css');
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    expect(rule('.aoibox')['stroke']).toBe('var(--gaze-aoi)');
    expect(rule('.aoibox')['stroke-dasharray']).toBe('var(--gaze-aoi-dash)');
    expect(rule('.aoibox')['stroke-width']).toBe('var(--border-width)');
    // The isolated area is teal, which is this screen's word for data rather than action.
    expect(rule('.aoibox.isolated')['stroke']).toBe('var(--gaze-aoi-active)');
    expect(rule('.aoilabel')['fill']).toBe('var(--color-text-muted)');
  });
});

describe('accessibility', () => {
  it('passes axe over the stage with its overlays on', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    const stage = frameOf(container).parentElement as HTMLElement;
    expect(describeViolations(await axeViolations(stage))).toBe('');
  });

  it('leaves the drawing out of the accessibility tree, because it cannot be read out', async () => {
    await serveRunData();
    const { container } = attention();
    await ready();
    decoded(container);
    await userEvent.click(outlineToggle());

    const layer = container.querySelector('[data-overlay-layer="aoi"] svg') as SVGElement;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });
});
