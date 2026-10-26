import { describe, expect, it } from 'vitest';
import { buildAois, heuristicSegmenter } from '../src/aois/index.js';
import type { ImageReader, RasterImage } from '../src/aois/index.js';
import type { Aoi } from '../src/aggregate.js';
import { defaultEngineConfig } from '../src/config.js';
import type { EngineConfigOverrides } from '../src/config.js';
import type { BoundingBox, Capture, CaptureElement } from '../src/types.js';
import { CARD_GRID_REGION, loadFixture } from './fixtures/index.js';

/**
 * #66, the offline heuristic segmenter.
 *
 * Two kinds of test here, deliberately.
 *
 * The acceptance criteria that are about *this page* — the card grid partitions, the plain
 * prose does not — run against the committed fixtures (#61) through `sharp`, because they
 * are claims about real image bytes and a synthetic raster would be the test grading its
 * own homework. The criteria that are about the *rules* — which candidates a filter throws
 * away, how the cut to `maxRegions` chooses, that every bound comes from the configuration
 * — run against rasters painted here and handed over by `readImage`, because each one needs
 * a page built to isolate exactly one rule and none of them needs a file on disk.
 */

type Rgb = readonly [number, number, number];

interface Block {
  readonly bbox: BoundingBox;
  readonly colour: Rgb;
}

/** A page painted as raw pixels, as `sharp`'s `raw()` would hand them over. */
const raster = (
  width: number,
  height: number,
  background: Rgb,
  blocks: readonly Block[],
  channels = 3,
): RasterImage => {
  const data = new Uint8Array(width * height * channels);
  for (let at = 0; at < data.length; at += channels) {
    data[at] = background[0];
    data[at + 1] = background[1];
    data[at + 2] = background[2];
    if (channels === 4) data[at + 3] = 255;
  }
  for (const { bbox, colour } of blocks) {
    for (let y = bbox.y; y < bbox.y + bbox.height; y += 1) {
      for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) {
        const at = (y * width + x) * channels;
        data[at] = colour[0];
        data[at + 1] = colour[1];
        data[at + 2] = colour[2];
      }
    }
  }
  return { width, height, channels, data };
};

const PAPER: Rgb = [250, 250, 250];

const box = (x: number, y: number, width: number, height: number): BoundingBox => ({
  x,
  y,
  width,
  height,
});

/** A capture of a page with nothing reported on it but the elements named. */
const capture = (
  width: number,
  height: number,
  elements: readonly CaptureElement[] = [],
): Capture => ({
  step: 'catalogue',
  screenshot: 'screenshots/A/catalogue.png',
  viewport: { width, height },
  pageHeight: height,
  foldY: height,
  elements,
});

const element = (bbox: BoundingBox, name = 'Filter by size'): CaptureElement => ({
  id: `dom-${bbox.x}-${bbox.y}`,
  source: 'dom',
  role: 'link',
  name,
  text: name,
  bbox,
  isPrimaryAction: false,
  belowFold: false,
  selector: '.filter',
});

/** An area of interest as `buildAois` hands one to a segmenter. */
const explainedArea = (bbox: BoundingBox): Aoi => ({
  id: `a-catalogue-link-filter-${bbox.x}-${bbox.y}`,
  variant: 'A',
  step: 'catalogue',
  label: 'Filter by size',
  source: 'dom',
  role: 'link',
  bbox,
  isPrimaryAction: false,
  belowFold: false,
});

/** Runs the segmenter over a painted page, with no file and no `sharp` in the way. */
const segment = async (
  image: RasterImage,
  screen: Capture,
  explained: readonly Aoi[] = [],
  config?: EngineConfigOverrides,
): Promise<readonly { label: string; bbox: BoundingBox; id: string; role: string | null }[]> => {
  const segmenter = heuristicSegmenter({ config, readImage: () => image });
  const regions = await segmenter.segment({ capture: screen, variant: 'A', explained });
  return regions.map((region) => ({
    label: region.label,
    bbox: region.bbox,
    id: region.id,
    role: region.role,
  }));
};

/** The card grid fixture, with the screenshot where the committed image actually is. */
const cardGrid = (): Capture => {
  const { capture: fixture, screenshotPath } = loadFixture('card-grid-unexplained');
  return { ...fixture, screenshot: screenshotPath };
};

const plainText = (): Capture => {
  const { capture: fixture, screenshotPath } = loadFixture('plain-text-control');
  return { ...fixture, screenshot: screenshotPath };
};

/** Through `buildAois`, so the regions arrive as areas of interest the way a run gets them. */
const segmentedAreasOf = async (
  screen: Capture,
  segmenter = heuristicSegmenter(),
): Promise<Aoi[]> =>
  (await buildAois({ capture: screen, variant: 'A', segmenter })).filter(
    (area) => area.source === 'sam',
  );

const overlaps = (a: BoundingBox, b: BoundingBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('the card grid the DOM does not explain', () => {
  it('partitions the unexplained grid into one area per card', async () => {
    const areas = await segmentedAreasOf(cardGrid());

    // Six cards: three columns, two rows, inside CARD_GRID_REGION and nowhere else.
    expect(areas).toHaveLength(6);
    for (const area of areas) {
      expect(overlaps(area.bbox, CARD_GRID_REGION)).toBe(true);
      expect(area.bbox.x).toBeGreaterThanOrEqual(CARD_GRID_REGION.x);
      expect(area.bbox.y).toBeGreaterThanOrEqual(CARD_GRID_REGION.y);
      expect(area.bbox.x + area.bbox.width).toBeLessThanOrEqual(
        CARD_GRID_REGION.x + CARD_GRID_REGION.width,
      );
      expect(area.bbox.y + area.bbox.height).toBeLessThanOrEqual(
        CARD_GRID_REGION.y + CARD_GRID_REGION.height,
      );
    }
  });

  it('puts each area within a grid cell of the card it stands for', async () => {
    const areas = await segmentedAreasOf(cardGrid());
    const { cellPx } = defaultEngineConfig.segmentation;

    // The generator's own geometry, re-derived rather than copied: three columns and two
    // rows filling CARD_GRID_REGION, with a 14px column gap and a 24px row gap.
    const cardWidth = (CARD_GRID_REGION.width - 14 * 2) / 3;
    const cardHeight = (CARD_GRID_REGION.height - 24) / 2;
    const cards = [0, 1].flatMap((row) =>
      [0, 1, 2].map((column) =>
        box(
          CARD_GRID_REGION.x + column * (cardWidth + 14),
          CARD_GRID_REGION.y + row * (cardHeight + 24),
          cardWidth,
          cardHeight,
        ),
      ),
    );

    for (const card of cards) {
      const matching = areas.filter((area) => overlaps(area.bbox, card));
      expect(matching).toHaveLength(1);
      const [area] = matching;
      // Snapped to the analysis grid, so an edge is off by at most one cell either way.
      expect(Math.abs(area.bbox.x - card.x)).toBeLessThanOrEqual(cellPx);
      expect(Math.abs(area.bbox.y - card.y)).toBeLessThanOrEqual(cellPx);
      expect(Math.abs(area.bbox.width - card.width)).toBeLessThanOrEqual(2 * cellPx);
      expect(Math.abs(area.bbox.height - card.height)).toBeLessThanOrEqual(2 * cellPx);
    }
  });

  it('overlaps none of the areas the capture’s elements already explained', async () => {
    const screen = cardGrid();
    const explained = (await buildAois({ capture: screen, variant: 'A' })).filter(
      (area) => area.source !== 'sam',
    );
    const areas = await segmentedAreasOf(screen);

    expect(explained.length).toBeGreaterThan(0);
    for (const area of areas) {
      for (const control of explained) expect(overlaps(area.bbox, control.bbox)).toBe(false);
    }
  });

  it('reads as something a designer would recognise, not as region-7', async () => {
    const areas = await segmentedAreasOf(cardGrid());

    expect(areas.map((area) => area.label)).toEqual([
      'Left card',
      'Centre card',
      'Right card',
      'Bottom left card',
      'Bottom card',
      'Bottom right card',
    ]);
  });

  it('is the segmenter buildAois uses when the caller names none', async () => {
    const screen = cardGrid();

    const fromDefault = await buildAois({ capture: screen, variant: 'A' });
    const fromHeuristic = await buildAois({
      capture: screen,
      variant: 'A',
      segmenter: heuristicSegmenter(),
    });

    expect(fromDefault).toEqual(fromHeuristic);
    expect(fromDefault.filter((area) => area.source === 'sam')).toHaveLength(6);
  });

  it('tags its regions as segmented, with no role and never the primary action', async () => {
    const areas = await segmentedAreasOf(cardGrid());

    for (const area of areas) {
      expect(area.source).toBe('sam');
      // The heuristic reads colour, and colour does not say a region is a price or a menu.
      expect(area.role).toBeNull();
      expect(area.isPrimaryAction).toBe(false);
    }
  });
});

describe('the page with nothing the elements left over', () => {
  it('returns nothing on plain prose rather than inventing an area per paragraph', async () => {
    expect(await segmentedAreasOf(plainText())).toEqual([]);
  });

  it('returns nothing on the three fixtures whose ink is all inside an element box', async () => {
    for (const name of ['high-contrast-banner', 'below-fold-primary-action', 'price-and-fees']) {
      const { capture: fixture, screenshotPath } = loadFixture(name);
      const areas = await segmentedAreasOf({ ...fixture, screenshot: screenshotPath });
      expect({ name, areas }).toEqual({ name, areas: [] });
    }
  });

  it('finds nothing on a page that is all background', async () => {
    const screen = capture(400, 400);
    expect(await segment(raster(400, 400, PAPER, []), screen)).toEqual([]);
  });
});

describe('what a candidate has to clear', () => {
  /**
   * One page, four blocks, each built to fail exactly one filter and pass the others — so
   * relaxing one bound in the configuration admits one block and no other. The sizes are
   * read off the defaults: `minAreaShare` 1% of a 400x400 viewport is 1,600 px.
   */
  const KEEP = { bbox: box(8, 8, 80, 80), colour: [180, 120, 90] as Rgb };
  /** Side 32 clears `minSidePx`, but 1,024 px is under `minAreaShare`. */
  const TOO_SMALL = { bbox: box(120, 8, 32, 32), colour: [90, 140, 190] as Rgb };
  /** 5,760 px and a 24px side both clear; 24/240 is under `minAspectRatio`. */
  const SLIVER = { bbox: box(200, 8, 24, 240), colour: [150, 180, 110] as Rgb };
  /** 1,600 px and a 0.16 aspect both clear; a 16px side is under `minSidePx`. */
  const THIN = { bbox: box(300, 8, 16, 100), colour: [190, 160, 80] as Rgb };
  const BLOCKS = [KEEP, TOO_SMALL, SLIVER, THIN];

  const filtered = (config?: EngineConfigOverrides): Promise<readonly { bbox: BoundingBox }[]> =>
    segment(raster(400, 400, PAPER, BLOCKS), capture(400, 400), [], config);

  it('discards a region below the minimum size, a sliver and a hairline', async () => {
    expect((await filtered()).map((region) => region.bbox)).toEqual([KEEP.bbox]);
  });

  it('admits the small one when minAreaShare is lowered, and nothing else', async () => {
    const regions = await filtered({ segmentation: { minAreaShare: 1024 / 160000 } });
    expect(regions.map((region) => region.bbox)).toEqual([KEEP.bbox, TOO_SMALL.bbox]);
  });

  it('admits the sliver when minAspectRatio is lowered, and nothing else', async () => {
    const regions = await filtered({ segmentation: { minAspectRatio: 0.05 } });
    expect(regions.map((region) => region.bbox)).toEqual([KEEP.bbox, SLIVER.bbox]);
  });

  it('admits the hairline when minSidePx is lowered, and nothing else', async () => {
    const regions = await filtered({ segmentation: { minSidePx: 16 } });
    expect(regions.map((region) => region.bbox)).toEqual([KEEP.bbox, THIN.bbox]);
  });

  it('discards a shape whose rectangle is mostly not the shape', async () => {
    // An L: 500 of the 900 cells its rectangle covers, which is under minRectangularity.
    const arm: Rgb = [120, 90, 170];
    const page = raster(400, 400, PAPER, [
      { bbox: box(8, 8, 120, 40), colour: arm },
      { bbox: box(8, 8, 40, 120), colour: arm },
    ]);

    expect(await segment(page, capture(400, 400))).toEqual([]);
    expect(
      (
        await segment(page, capture(400, 400), [], { segmentation: { minRectangularity: 0.5 } })
      ).map((region) => region.bbox),
    ).toEqual([box(8, 8, 120, 120)]);
  });

  it('never returns a region that extends outside the page', async () => {
    // A page whose width and height are not whole numbers of cells, with ink in the
    // bottom-right corner, so the last column and row of the grid overhang the page.
    const screen = capture(402, 402);
    const regions = await segment(
      raster(402, 402, PAPER, [{ bbox: box(320, 320, 82, 82), colour: [100, 100, 160] }]),
      screen,
    );

    expect(regions).toHaveLength(1);
    for (const { bbox } of regions) {
      expect(bbox.x).toBeGreaterThanOrEqual(0);
      expect(bbox.y).toBeGreaterThanOrEqual(0);
      expect(bbox.x + bbox.width).toBeLessThanOrEqual(screen.viewport.width);
      expect(bbox.y + bbox.height).toBeLessThanOrEqual(screen.pageHeight);
    }
  });
});

describe('the areas the elements already explain', () => {
  it('keeps off a region of ink an element covers half of', async () => {
    const ink = box(100, 100, 160, 80);
    const control = box(100, 100, 80, 80);
    const screen = capture(400, 400, [element(control)]);

    const regions = await segment(
      raster(400, 400, PAPER, [{ bbox: ink, colour: [170, 110, 100] }]),
      screen,
      [explainedArea(control)],
    );

    expect(regions.map((region) => region.bbox)).toEqual([box(180, 100, 80, 80)]);
    for (const { bbox } of regions) expect(overlaps(bbox, control)).toBe(false);
  });

  it('returns nothing when an element explains the ink entirely', async () => {
    const ink = box(100, 100, 120, 120);
    const screen = capture(400, 400, [element(ink)]);

    expect(
      await segment(raster(400, 400, PAPER, [{ bbox: ink, colour: [170, 110, 100] }]), screen, [
        explainedArea(ink),
      ]),
    ).toEqual([]);
  });
});

describe('how many regions one screen may yield', () => {
  /** Five blocks, each separated from the others, in descending size. */
  const BLOCKS: readonly Block[] = [
    { bbox: box(8, 8, 120, 120), colour: [180, 120, 90] },
    { bbox: box(160, 8, 100, 100), colour: [90, 140, 190] },
    { bbox: box(280, 8, 80, 80), colour: [150, 180, 110] },
    { bbox: box(8, 160, 60, 60), colour: [190, 160, 80] },
    { bbox: box(340, 160, 48, 48), colour: [160, 120, 180] },
  ];

  const busy = (config?: EngineConfigOverrides) =>
    segment(raster(400, 400, PAPER, BLOCKS), capture(400, 400), [], config);

  it('returns all of them while they fit under the cap', async () => {
    expect((await busy()).map((region) => region.bbox)).toEqual(
      [...BLOCKS].map((block) => block.bbox).sort((a, b) => a.y - b.y || a.x - b.x),
    );
  });

  it('honours the cap on a busy image, keeping the largest regions', async () => {
    const regions = await busy({ segmentation: { maxRegions: 3 } });

    expect(regions.map((region) => region.bbox)).toEqual([
      box(8, 8, 120, 120),
      box(160, 8, 100, 100),
      box(280, 8, 80, 80),
    ]);
  });

  it('keeps exactly the largest one when the cap is one', async () => {
    expect((await busy({ segmentation: { maxRegions: 1 } })).map((region) => region.bbox)).toEqual([
      box(8, 8, 120, 120),
    ]);
  });
});

describe('the similarity and background bounds', () => {
  it('coalesces two touching blocks of near-identical colour into one region', async () => {
    const left: Rgb = [160, 120, 100];
    const nearlyLeft: Rgb = [165, 125, 105];
    const page = raster(400, 400, PAPER, [
      { bbox: box(80, 80, 80, 120), colour: left },
      { bbox: box(160, 80, 80, 120), colour: nearlyLeft },
    ]);

    expect((await segment(page, capture(400, 400))).map((region) => region.bbox)).toEqual([
      box(80, 80, 160, 120),
    ]);
  });

  it('splits them when the similarity bound is tightened past their difference', async () => {
    const page = raster(400, 400, PAPER, [
      { bbox: box(80, 80, 80, 120), colour: [160, 120, 100] },
      { bbox: box(160, 80, 80, 120), colour: [165, 125, 105] },
    ]);

    const regions = await segment(page, capture(400, 400), [], {
      segmentation: { similarity: { luminanceDistance: 1, colourDistance: 1 } },
    });

    expect(regions.map((region) => region.bbox)).toEqual([
      box(80, 80, 80, 120),
      box(160, 80, 80, 120),
    ]);
  });

  it('ignores ink the background bound calls paper, and finds it when the bound drops', async () => {
    // Eight levels off the paper: inside the default background bound, so not ink at all.
    const page = raster(400, 400, PAPER, [
      { bbox: box(80, 80, 120, 120), colour: [242, 242, 242] },
    ]);
    const screen = capture(400, 400);

    expect(await segment(page, screen)).toEqual([]);
    expect(
      (
        await segment(page, screen, [], {
          segmentation: { background: { luminanceDistance: 4, colourDistance: 4 } },
        })
      ).map((region) => region.bbox),
    ).toEqual([box(80, 80, 120, 120)]);
  });

  it('takes the page background to be its most common colour, not its mean', async () => {
    // Most of this page is the dark block, so a mean-based estimate would call the paper
    // ink and hand back the margins. The modal colour is still the paper.
    const page = raster(400, 400, PAPER, [{ bbox: box(40, 40, 320, 240), colour: [40, 40, 48] }]);

    expect((await segment(page, capture(400, 400))).map((region) => region.bbox)).toEqual([
      box(40, 40, 320, 240),
    ]);
  });

  it('reads a four-channel raster the same as a three-channel one', async () => {
    const blocks: readonly Block[] = [{ bbox: box(80, 80, 120, 120), colour: [170, 110, 100] }];
    const screen = capture(400, 400);

    expect(await segment(raster(400, 400, PAPER, blocks, 4), screen)).toEqual(
      await segment(raster(400, 400, PAPER, blocks, 3), screen),
    );
  });
});

describe('determinism', () => {
  it('produces byte-identical regions from the same screenshot twice', async () => {
    const screen = cardGrid();

    const first = JSON.stringify(await segmentedAreasOf(screen, heuristicSegmenter()));
    const second = JSON.stringify(await segmentedAreasOf(screen, heuristicSegmenter()));

    expect(second).toBe(first);
    // Named rather than only compared, so a change in the partition is visible in a diff
    // rather than only in a pass or a fail.
    expect(JSON.parse(first)).toMatchObject([
      { id: 'a-card-grid-unexplained-region-left-card-16-112-140x104', label: 'Left card' },
      { id: 'a-card-grid-unexplained-region-centre-card-172-112-136x104', label: 'Centre card' },
      { id: 'a-card-grid-unexplained-region-right-card-324-112-140x104', label: 'Right card' },
      {
        id: 'a-card-grid-unexplained-region-bottom-left-card-16-240-140x104',
        label: 'Bottom left card',
      },
      { id: 'a-card-grid-unexplained-region-bottom-card-172-240-136x104', label: 'Bottom card' },
      {
        id: 'a-card-grid-unexplained-region-bottom-right-card-324-240-140x104',
        label: 'Bottom right card',
      },
    ]);
  });

  it('gives the same ids and labels on a repainted raster, so nothing carries over', async () => {
    const blocks: readonly Block[] = [
      { bbox: box(8, 8, 120, 120), colour: [180, 120, 90] },
      { bbox: box(160, 8, 100, 100), colour: [90, 140, 190] },
    ];
    const screen = capture(400, 400);

    expect(await segment(raster(400, 400, PAPER, blocks), screen)).toEqual(
      await segment(raster(400, 400, PAPER, blocks), screen),
    );
  });

  it('puts the variant and the step in an id, so two variants never collide', async () => {
    const screen = cardGrid();
    const segmenter = heuristicSegmenter();

    const onA = await segmenter.segment({ capture: screen, variant: 'A', explained: [] });
    const onB = await segmenter.segment({ capture: screen, variant: 'B', explained: [] });

    expect(onA.map((region) => region.bbox)).toEqual(onB.map((region) => region.bbox));
    expect(onA.map((region) => region.id)).not.toEqual(onB.map((region) => region.id));
    for (const region of onB) expect(region.id.startsWith('b-card-grid-unexplained-')).toBe(true);
  });
});

describe('finding the screenshot', () => {
  const recording = (): { readonly paths: string[]; readonly readImage: ImageReader } => {
    const paths: string[] = [];
    return {
      paths,
      readImage: (screenshotPath) => {
        paths.push(screenshotPath);
        return raster(400, 400, PAPER, []);
      },
    };
  };

  it('resolves the capture’s run-directory-relative path against runDir', async () => {
    const { paths, readImage } = recording();
    const segmenter = heuristicSegmenter({ runDir: '/runs/2026-01-01-0900-demo', readImage });

    await segmenter.segment({ capture: capture(400, 400), variant: 'A', explained: [] });

    expect(paths).toEqual(['/runs/2026-01-01-0900-demo/screenshots/A/catalogue.png']);
  });

  it('takes an absolute screenshot path as given, runDir or not', async () => {
    const { paths, readImage } = recording();
    const absolute = '/elsewhere/shot.png';

    await heuristicSegmenter({ runDir: '/runs/demo', readImage }).segment({
      capture: { ...capture(400, 400), screenshot: absolute },
      variant: 'A',
      explained: [],
    });
    await heuristicSegmenter({ readImage }).segment({
      capture: { ...capture(400, 400), screenshot: absolute },
      variant: 'A',
      explained: [],
    });

    expect(paths).toEqual([absolute, absolute]);
  });

  it('lets a screenshot it cannot open leave the element-derived areas alone', async () => {
    const screen = { ...cardGrid(), screenshot: '/no/such/screenshot.png' };

    const withBroken = await buildAois({ capture: screen, variant: 'A' });
    const withNone = await buildAois({
      capture: screen,
      variant: 'A',
      segmenter: { segment: () => [] },
    });

    expect(withBroken).toEqual(withNone);
    expect(withBroken.every((area) => area.source !== 'sam')).toBe(true);
  });
});

describe('the thresholds are the configuration’s', () => {
  it('changes its answer on one screenshot when one threshold changes, with no code change', async () => {
    const screen = cardGrid();

    const withDefaults = await segmentedAreasOf(screen, heuristicSegmenter());
    const capped = await segmentedAreasOf(
      screen,
      heuristicSegmenter({ config: { segmentation: { maxRegions: 2 } } }),
    );
    const coarse = await segmentedAreasOf(
      screen,
      heuristicSegmenter({ config: { segmentation: { minAreaShare: 0.5 } } }),
    );

    expect(withDefaults).toHaveLength(6);
    expect(capped).toHaveLength(2);
    expect(coarse).toEqual([]);
  });

  it('leaves the thresholds it was not given at the engine defaults', async () => {
    const screen = cardGrid();

    expect(await segmentedAreasOf(screen, heuristicSegmenter({ config: { alpha: 2 } }))).toEqual(
      await segmentedAreasOf(screen, heuristicSegmenter()),
    );
  });

  it('declares every bound that changes which regions exist', () => {
    expect(Object.keys(defaultEngineConfig.segmentation).sort()).toEqual([
      'background',
      'cellPx',
      'maxRegions',
      'minAreaShare',
      'minAspectRatio',
      'minRectangularity',
      'minSidePx',
      'similarity',
    ]);
  });
});
