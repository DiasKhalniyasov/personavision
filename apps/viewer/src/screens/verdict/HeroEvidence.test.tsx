// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';
import { HeroEvidence } from './HeroEvidence';

/**
 * The one piece of evidence on the Verdict screen, over the repository's own committed
 * example run.
 *
 * What is asserted is the thing the business reader is looking at: the version and step the
 * run itself named, the page as the audience saw it, the heat drawn by #71's layer, the
 * outline of the area the verdict turns on, the fold where the capture says the first
 * viewport ended, and one click into Attention for exactly this evidence. Never a painted
 * pixel — the geometry is read off the rendered attributes, and whether a fixation is still
 * on its element is read as containment between two boxes in one coordinate space.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = /Where your audience looked/;

/** `screenshots/B/review.png`: what the seed run's own `heroEvidence` points at. */
const HERO = { variant: 'B', step: 'review' } as const;
/** An area of that step the audience did look at, in a tight band below the fold. */
const FEE_ROW = 'B-review-fee-row';
/** The completing action of that step, which no fixation ever landed in. */
const COMPLETE = 'B-review-complete';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const serveChangedRun = async (change: (run: Run) => Run) => {
  const changed = change(seedRun());
  await serveRunData({ files: { [`/runs/${RUN_ID}/run.json`]: JSON.stringify(changed) } });
  return changed;
};

/** The same run with a different verdict block — the field this ticket renders. */
const withHero = (run: Run, hero: Partial<Run['verdict']['heroEvidence']>): Run => ({
  ...run,
  verdict: { ...run.verdict, heroEvidence: { ...run.verdict.heroEvidence, ...hero } },
});

const verdict = () => mountApp(paths.run(RUN_ID));

const block = (container: HTMLElement) =>
  container.querySelector('[data-section="hero-evidence"]') as HTMLElement;
const frameOf = (container: HTMLElement) => container.querySelector('#vd-frame') as HTMLElement;
const imageOf = (container: HTMLElement) =>
  container.querySelector('#vd-page img') as HTMLImageElement;
const captionOf = (container: HTMLElement) =>
  block(container).querySelector('figcaption') as HTMLElement;

/** The screen, once the run has been read and the block has a heading to show. */
const shown = () => screen.findByRole('heading', { level: 2, name: HEADING });

/** The block, once every session file has settled: an aggregate is all of them or none. */
const aggregated = async () => {
  await shown();
  await waitFor(() => {
    expect(screen.queryByText(/reading the sessions/)).toBeNull();
  });
};

/** The page as it is once its screenshot has arrived, which jsdom never does on its own. */
const decoded = (container: HTMLElement) => {
  fireEvent.load(imageOf(container));
};

/** Every place the heat layer drew, in the overlay units it drew them in. */
const heatBlobs = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-overlay-layer="heat"] circle')].map((circle) => ({
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
    step: circle.getAttribute('data-heat-step'),
  }));

/** The one box this screen outlines, in the same overlay units. */
const outlineBox = (container: HTMLElement, aoiId: string) => {
  const rect = container.querySelector(`[data-never-looked="${aoiId}"]`) as SVGRectElement;
  const read = (name: string) => Number(rect.getAttribute(name));
  return { x: read('x'), y: read('y'), w: read('width'), h: read('height') };
};

type Box = ReturnType<typeof outlineBox>;
type Blob = ReturnType<typeof heatBlobs>[number];

const inside = (blob: Blob, box: Box): boolean =>
  blob.x >= box.x && blob.x <= box.x + box.w && blob.y >= box.y && blob.y <= box.y + box.h;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('which heatmap is the run’s decision and not this screen’s', () => {
  it('renders the version and step verdict.heroEvidence names', async () => {
    await serveRunData();
    const { container } = verdict();
    await shown();

    expect(imageOf(container).getAttribute('src')).toContain(
      `/runs/${RUN_ID}/screenshots/B/review.png`,
    );
    expect(block(container).textContent).toContain('Redesign candidate');
    expect(block(container).textContent).toContain('Review step');
  });

  it('renders a different step when that field names a different one', async () => {
    await serveChangedRun((run) => withHero(run, { variant: 'A', step: 'cart', aoiId: null }));
    const { container } = verdict();
    await shown();

    expect(imageOf(container).getAttribute('src')).toContain(
      `/runs/${RUN_ID}/screenshots/A/cart.png`,
    );
    expect(block(container).textContent).toContain('Current checkout');
    expect(block(container).textContent).toContain('Cart step');
  });
});

describe('the heat is #71’s layer and the geometry is #58’s transform', () => {
  it('mounts the dwell-weighted layer, carrying the figures it drew from', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();
    decoded(container);

    const blobs = heatBlobs(container);
    expect(blobs.length).toBeGreaterThan(0);
    // The layer's own attributes: a step on the `--heat-*` ramp and the dwell behind it.
    for (const blob of blobs) expect(Number(blob.step)).toBeGreaterThanOrEqual(2);
    expect(
      container.querySelector('[data-overlay-layer="heat"] circle[data-dwell-ms]'),
    ).not.toBeNull();
  });

  it('accumulates no heat and converts no coordinate in this screen’s own files', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'HeroEvidence.tsx'), 'utf8');

    // What it imports rather than reimplements.
    expect(source).toContain("from '@/screens/attention/stage/HeatmapLayer'");
    expect(source).toContain("from '@/screens/attention/stage/overlayTransform'");
    // And what it therefore never touches: a fixation's page coordinates, its dwell, or
    // the ramp a place is drawn in. A second accumulation would drift from the first.
    for (const forbidden of ['pageX', 'pageY', 'durationMs', 'accumulateHeat', 'heatStep']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps a fixation inside its own element at two different frame widths', async () => {
    /**
     * The frame is `width: 100%` of whatever the mat gives it, so the window's width is
     * the frame's. What this asserts is that neither the heat nor the outline is computed
     * from it: the same run draws the same numbers in a 1440px window and in a 420px one,
     * and the fixations the run records inside the service fee row are drawn inside the
     * box the run records for that row in both.
     */
    const drawnAt = async (windowWidth: number) => {
      window.innerWidth = windowWidth;
      await serveChangedRun((run) => withHero(run, { aoiId: FEE_ROW }));
      const { container, unmount } = verdict();
      await aggregated();
      decoded(container);

      const box = outlineBox(container, FEE_ROW);
      const blobs = heatBlobs(container);
      const viewBoxes = new Set(
        [...container.querySelectorAll('#vd-frame svg')].map((svg) => svg.getAttribute('viewBox')),
      );
      unmount();
      forgetRuns();
      return { box, blobs, within: blobs.filter((blob) => inside(blob, box)).length, viewBoxes };
    };

    const wide = await drawnAt(1440);
    const narrow = await drawnAt(420);

    // The run puts six places of dwell inside that row; all six are drawn inside the box
    // it recorded for the row, at either width.
    expect(wide.within).toBeGreaterThan(0);
    expect(narrow.within).toBe(wide.within);
    expect(narrow.box).toEqual(wide.box);
    expect(narrow.blobs).toEqual(wide.blobs);
    // One coordinate space for every layer in the frame, so a width cannot scale a blob
    // and the box it sits in apart.
    expect([...wide.viewBoxes]).toHaveLength(1);
    expect([...narrow.viewBoxes]).toEqual([...wide.viewBoxes]);
  });

  it('lays the image and every layer over one box, so the zoomless frame scales as one', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rule = ruleIn(rulesOf(readFileSync(join(here, 'heroEvidence.module.css'), 'utf8')));

    // The page fills the frame, the image fills the page, and a layer's `viewBox` is
    // stretched over the same box: that is what makes registration structural rather than
    // arithmetic, as #58's transform asks.
    expect(rule('.page')['inset']).toBe('0px');
    expect(rule('.page img')['width']).toBe('100%');
    expect(rule('.page img')['height']).toBe('100%');
    expect(rule('.layer')['inset']).toBe('0px');
    expect(rule('.layer svg')['width']).toBe('100%');
    expect(rule('.layer svg')['height']).toBe('100%');
  });
});

describe('the frame, the mat and the fold', () => {
  it('draws the fold where the capture says the first viewport ended, labelled with it', async () => {
    await serveRunData();
    const { container } = verdict();
    await shown();

    const fold = container.querySelector('#vd-frame [data-fold]') as HTMLElement;
    // The seed run's redesign review step: an 844-tall viewport over a 1540px page.
    expect(fold.style.top).toBe(`${(844 / 1540) * 100}%`);
    expect(fold.textContent).toBe('fold · 390 × 844');
  });

  it('names the device and the viewport above the page, in the audience’s own words', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();

    const label = block(container).querySelector('.microlabel') as HTMLElement;
    // `mobile` is the name the audience's device mix gives that viewport, not a word this
    // screen inferred from a width.
    expect(label.textContent).toContain('mobile 390 × 844');
    expect(label.textContent).toContain('9 people');
  });

  it('reserves the frame’s box before the screenshot decodes, so nothing below it jumps', async () => {
    await serveRunData();
    const { container } = verdict();
    await shown();

    // jsdom loads no image, so this *is* the state before the decode.
    const before = frameOf(container);
    expect(before.dataset.screenshot).toBe('loading');
    expect(before.style.aspectRatio).toBe('390 / 1540');
    expect(before.style.maxWidth).toBe('390px');

    decoded(container);
    const after = frameOf(container);
    expect(after.dataset.screenshot).toBe('shown');
    expect(after.style.aspectRatio).toBe('390 / 1540');
    expect(after.style.maxWidth).toBe('390px');
  });

  it('takes the mat, the scrim and the never-looked outline from the tokens', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rule = ruleIn(rulesOf(readFileSync(join(here, 'heroEvidence.module.css'), 'utf8')));

    expect(rule('.mat')['background']).toBe('var(--color-surface-sunken)');
    expect(rule('.mat')['padding']).toBe('var(--frame-mat-pad)');
    expect(rule('.mat')['border-radius']).toBe('var(--radius-xl)');
    expect(rule('.head')['margin-bottom']).toBe('var(--frame-mat-pad)');
    expect(rule('.frame[data-dim] .page::after')['background']).toBe('var(--screenshot-scrim)');
    expect(rule('.neverLooked')['stroke']).toBe('var(--sev-critical)');
    expect(rule('.cap')['margin-top']).toBe('var(--frame-mat-pad)');
  });
});

describe('one heatmap and nothing else', () => {
  it('draws no scanpath, no numbered fixations and no second chart', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();
    decoded(container);

    const layers = [...container.querySelectorAll('#vd-frame [data-overlay-layer]')].map((layer) =>
      layer.getAttribute('data-overlay-layer'),
    );
    // The seed run names no area, so the heatmap is the only layer on the page.
    expect(layers).toEqual(['heat']);
    // No scanpath, and nothing numbered: the order attention moved in is Attention's.
    expect(container.querySelectorAll('#vd-frame line')).toHaveLength(0);
    expect(container.querySelectorAll('#vd-frame text')).toHaveLength(0);
    expect(container.querySelectorAll('[data-section="hero-evidence"] table')).toHaveLength(0);
  });

  it('outlines the area the run named, in the critical colour, and names it in the caption', async () => {
    const run = await serveChangedRun((changed) => withHero(changed, { aoiId: COMPLETE }));
    const { container } = verdict();
    await aggregated();
    decoded(container);

    expect(container.querySelector(`[data-never-looked="${COMPLETE}"]`)).not.toBeNull();
    const area = run.aois.find((aoi) => aoi.id === COMPLETE);
    expect(captionOf(container).textContent).toContain(area?.label);
    expect(captionOf(container).textContent).toContain('Nothing at all lands on');
    expect(captionOf(container).textContent).toContain('which sits below the fold');
  });
});

/**
 * Two areas a run of the real pipeline carries and this block must not speak about: a box
 * from another device's rendering of the same step, and a box the page gave no name to.
 * `aois` is keyed by version and step rather than by device, and the pipeline falls back to
 * an element's accessibility role when it has no accessible name, so both reach a screen
 * reading a generated artifact (`runs/`) even though the hand-authored fixture has neither.
 */
const OFF_PAGE = 'B-review-desktop-rail';
const UNNAMED = 'B-review-unnamed';

const withExtraAreas = (run: Run): Run => ({
  ...run,
  aois: [
    ...run.aois,
    {
      id: OFF_PAGE,
      variant: HERO.variant,
      step: HERO.step,
      label: 'Desktop order rail',
      source: 'dom',
      role: 'complementary',
      // 960 wide, on a page the capture says is 390 wide: another device's rendering.
      bbox: { x: 0, y: 100, width: 960, height: 400 },
      isPrimaryAction: false,
      belowFold: false,
    },
    {
      id: UNNAMED,
      variant: HERO.variant,
      step: HERO.step,
      // The page gave this element no accessible name, so the run labels it by its role.
      label: 'generic',
      source: 'dom',
      role: 'generic',
      bbox: { x: 20, y: 200, width: 350, height: 60 },
      isPrimaryAction: false,
      belowFold: false,
    },
  ],
  aoiMetrics: [
    ...run.aoiMetrics,
    // Hotter than anything the fixture records, so only the filters can keep them out.
    ...[OFF_PAGE, UNNAMED].map((aoiId) => ({
      aoiId,
      timeToFirstFixationMs: 1_000,
      firstFixationDurationMs: 200,
      totalDwellMs: 99_999,
      fixationCount: 40,
      revisits: 3,
      lookedAtShare: 1,
      sessionCount: 9,
    })),
  ],
});

describe('the block speaks only about the page in its frame', () => {
  it('names neither another device’s box nor one the run has no name for', async () => {
    await serveChangedRun(withExtraAreas);
    const { container } = verdict();
    await aggregated();

    const caption = captionOf(container).textContent ?? '';
    // Both are hotter than every area of this page, and neither is a thing this picture
    // can be said to show.
    expect(caption).not.toContain('Desktop order rail');
    expect(caption).not.toContain('generic');
    expect(caption).toContain('Order summary');
  });

  it('outlines nothing when the area the run named is not on this capture', async () => {
    await serveChangedRun((run) => withHero(withExtraAreas(run), { aoiId: OFF_PAGE }));
    const { container } = verdict();
    await aggregated();

    expect(container.querySelector(`[data-never-looked="${OFF_PAGE}"]`)).toBeNull();
    // And the caption falls back to the absence it can still show: the completing action.
    expect(captionOf(container).textContent).toContain('Confirm purchase');
  });
});

describe('the caption, and the one click to beat 5', () => {
  it('states what the heat shows and what it does not land on', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();

    const caption = captionOf(container).textContent ?? '';
    // The two areas of this step the audience held on longest, by the run's own
    // `totalDwellMs` — order summary, then the planted service fee.
    expect(caption).toContain('Attention burns on');
    expect(caption).toContain('Order summary');
    expect(caption).toContain('Service fee row');
    // And the absence that is the point: the completing action nobody ever looked at.
    expect(caption).toContain('Nothing at all lands on');
    expect(caption).toContain('Confirm purchase');
  });

  it('links to Attention for exactly this version, step and area', async () => {
    await serveChangedRun((run) => withHero(run, { aoiId: COMPLETE }));
    const { container } = verdict();
    await shown();

    const link = captionOf(container).querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      `${paths.attention(RUN_ID, HERO.variant, HERO.step)}?aoi=${COMPLETE}`,
    );
  });

  it('carries no area when the run named none', async () => {
    await serveRunData();
    const { container } = verdict();
    await shown();

    const link = captionOf(container).querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(paths.attention(RUN_ID, HERO.variant, HERO.step));
  });

  it('lands on Attention showing that version, step and isolated area', async () => {
    await serveChangedRun((run) => withHero(run, { aoiId: COMPLETE }));
    const { container, router } = verdict();
    await shown();

    await userEvent.click(captionOf(container).querySelector('a') as HTMLAnchorElement);

    await screen.findByRole('heading', { level: 1, name: HEADING });
    expect(router.state.location.pathname).toBe(paths.attention(RUN_ID, HERO.variant, HERO.step));
    expect(router.state.location.search).toBe(`?aoi=${COMPLETE}`);
    // The screen says which area it is isolated to, so the link really arrived there.
    const isolated = await screen.findByText('Isolated');
    expect(isolated.nextElementSibling?.textContent).toContain('Confirm purchase');
  });
});

describe('when there is no attention to show', () => {
  it('says so rather than drawing an empty frame, when no fixation landed on the step', async () => {
    // A step the run declares and captured, and that nobody in the audience ever stood on.
    await serveChangedRun((run) => ({
      ...withHero(run, { step: 'thanks', aoiId: null }),
      steps: [...run.steps, { id: 'thanks', label: 'Thank you' }],
      screenshots: [
        ...run.screenshots,
        {
          variant: HERO.variant,
          step: 'thanks',
          path: 'screenshots/B/thanks.png',
          viewport: { width: 390, height: 844 },
          pageHeight: 980,
          foldY: 844,
        },
      ],
    }));
    const { container } = verdict();
    await aggregated();

    expect(heatBlobs(container)).toHaveLength(0);
    expect(block(container).textContent).toContain('No fixation landed anywhere');
    // The frame is not empty: it holds the page and the sentence saying why there is no
    // heat on it, and it is not dimmed for a layer that drew nothing.
    expect(frameOf(container)).not.toBeNull();
    expect(frameOf(container).dataset.dim).toBeUndefined();
  });

  it('says so when the run names no moment for its verdict to turn on', () => {
    /**
     * `runSchema` holds every run to carrying a `heroEvidence`, so a run without one never
     * reaches the screen through `useRun` — the shell says the test could not be read, and
     * says which field. This mounts the block on its own over such a run, because the
     * state it has to be able to render is one the shell protects it from rather than one
     * it can never be handed: a pipeline writing an older artifact would hand it exactly
     * this, and a section that threw would take the whole Verdict screen with it.
     */
    const stored = seedRun();
    const withoutHero: Record<string, unknown> = { ...stored.verdict };
    delete withoutHero['heroEvidence'];
    const run = { ...stored, verdict: withoutHero } as unknown as Run;

    const { container } = render(<HeroEvidence run={run} />, { wrapper: MemoryRouter });

    expect(block(container).textContent).toContain('does not name the moment its verdict turns on');
    expect(frameOf(container)).toBeNull();
    expect(captionOf(container)).toBeNull();
  });

  it('names the path it looked for when the run holds no screenshot of that step', async () => {
    await serveChangedRun((run) => ({
      ...run,
      screenshots: run.screenshots.filter(
        (shot) => !(shot.variant === HERO.variant && shot.step === HERO.step),
      ),
    }));
    const { container } = verdict();

    await waitFor(() => {
      expect(block(container).textContent).toContain('holds no screenshot');
    });
    expect(block(container).textContent).toContain('screenshots/B/review.png');
    expect(frameOf(container)).toBeNull();
  });

  it('keeps the heat on the page it recorded when the screenshot will not load', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();
    fireEvent.error(imageOf(container));

    expect(frameOf(container).dataset.screenshot).toBe('unreadable');
    expect(block(container).textContent).toContain('could not be read');
    expect(block(container).textContent).toContain('390 by 1540 pixels');
    expect(heatBlobs(container).length).toBeGreaterThan(0);
  });
});

describe('the evidence is not sight-only', () => {
  it('gives the heatmap a text alternative naming where attention concentrated', async () => {
    await serveRunData();
    const { container } = verdict();
    await aggregated();

    // The figure's own caption: no second, hidden copy of the sentence to keep in step.
    const figure = block(container);
    expect(figure.tagName).toBe('FIGURE');
    expect(captionOf(container).textContent).toContain('Order summary');
    // And the page under it is named, so the screenshot is not a picture of nothing.
    expect(imageOf(container).getAttribute('alt')).toBe(
      'The Review step of Redesign candidate, the whole page as your audience saw it',
    );
  });

  it('passes an axe pass with the heat and the outline drawn', async () => {
    await serveChangedRun((run) => withHero(run, { aoiId: COMPLETE }));
    const { container } = verdict();
    await aggregated();
    decoded(container);

    const violations = await axeViolations(block(container));
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
