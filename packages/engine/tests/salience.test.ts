import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * Every `sharp(...)` call, counted.
 *
 * The acceptance criterion on #65 asks for the decode to be asserted by counting decode
 * calls, so the module under test is given the real `sharp` wrapped in a counter rather
 * than a stub: the statistics are still computed from real decoded pixels, and the count
 * is the number of times a screenshot was handed to `sharp`. The counter is reset
 * immediately before the call being measured, because these tests build their images with
 * `sharp` too.
 */
const decodes = vi.hoisted(() => ({ count: 0 }));

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  const counted = (...args: Parameters<typeof actual.default>) => {
    decodes.count += 1;
    return actual.default(...args);
  };
  return { ...actual, default: Object.assign(counted, actual.default) };
});

const { default: sharp } = await import('sharp');

const { defaultEngineConfig, resolveEngineConfig } = await import('../src/config.js');
const { SALIENCE_TERMS, readScreenshotPixels, salienceByArea, salienceTermsByArea } =
  await import('../src/salience.js');

type Aoi = import('../src/aggregate.js').Aoi;
type BoundingBox = import('../src/types.js').BoundingBox;
type EngineConfig = import('../src/config.js').EngineConfig;
type PersonaTraits = import('../src/persona.js').PersonaTraits;
type SalienceTerm = import('../src/salience.js').SalienceTerm;

/**
 * The images are built here with `sharp` rather than read from the shared capture
 * fixtures (#61): a bright rectangle on a flat field is enough to prove a contrast term,
 * and building it in the test keeps this suite independent of the fixtures and of
 * `buildAois`.
 */
const PAGE = { width: 200, height: 200 } as const;

/** Mid grey. Every rectangle below is measured against this field. */
const FIELD = { r: 128, g: 128, b: 128 };

/** Bright and saturated: both contrast terms have something to find. */
const BRIGHT = { r: 255, g: 230, b: 0 };

/**
 * A saturated red whose Rec. 709 luma is within half a percent of `FIELD`'s, so the
 * colour term can be shown to find something the luminance term cannot.
 */
const EQUAL_LUMA = { r: 255, g: 92, b: 92 };

const flatField = async (): Promise<Uint8Array> =>
  sharp({ create: { width: PAGE.width, height: PAGE.height, channels: 3, background: FIELD } })
    .png()
    .toBuffer();

const withRectangle = async (
  colour: { r: number; g: number; b: number },
  rect: BoundingBox,
): Promise<Uint8Array> => {
  const patch = await sharp({
    create: { width: rect.width, height: rect.height, channels: 3, background: colour },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: PAGE.width, height: PAGE.height, channels: 3, background: FIELD },
  })
    .composite([{ input: patch, left: rect.x, top: rect.y }])
    .png()
    .toBuffer();
};

/**
 * The left half of the page holds the rectangle; `OVER_FIELD` is its mirror image about
 * the page's centre, so the two areas agree on size, on distance from the centre and on
 * how far down the page they sit. Only the pixels under them differ, which is what lets
 * the first acceptance criterion be read with the default weights rather than with five of
 * them switched off.
 */
const RECTANGLE: BoundingBox = { x: 20, y: 75, width: 50, height: 50 };
const OVER_FIELD: BoundingBox = { x: 130, y: 75, width: 50, height: 50 };

/** Mid-scale on every trait, as `tests/persona.test.ts` spells it. */
const MIDDLING: PersonaTraits = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

const areaAt = (id: string, bbox: BoundingBox, role: string | null = null): Aoi => ({
  id,
  variant: 'a',
  step: 'cart',
  label: id,
  source: 'dom',
  role,
  bbox,
  isPrimaryAction: false,
  belowFold: false,
});

const ZEROED = {
  luminanceContrast: 0,
  colourContrast: 0,
  relativeArea: 0,
  centreBias: 0,
  topBias: 0,
  rolePrior: 0,
} as const;

/** Every salience weight zeroed but one, so a test reads exactly one term. */
const onlyTerm = (term: SalienceTerm): EngineConfig =>
  resolveEngineConfig({ salience: { weights: { ...ZEROED, [term]: 1 } } }).config;

const scored = async (
  screenshot: Uint8Array,
  aois: readonly Aoi[],
  config?: EngineConfig,
  traits: PersonaTraits = MIDDLING,
): Promise<Map<string, number>> => salienceByArea({ screenshot, page: PAGE, aois, traits, config });

const valueOf = (byArea: Map<string, number>, id: string): number => {
  const value = byArea.get(id);
  if (value === undefined) throw new Error(`no salience for ${id}`);
  return value;
};

describe('bottom-up salience over a bright rectangle on a flat field', () => {
  it('scores the area over the rectangle above an equally sized area over the field', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const byArea = await scored(screenshot, [
      areaAt('rectangle', RECTANGLE),
      areaAt('field', OVER_FIELD),
    ]);

    expect(valueOf(byArea, 'rectangle')).toBeGreaterThan(valueOf(byArea, 'field'));
  });

  it('finds the luminance contrast on its own', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const byArea = await scored(
      screenshot,
      [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)],
      onlyTerm('luminanceContrast'),
    );

    expect(valueOf(byArea, 'rectangle')).toBeGreaterThan(valueOf(byArea, 'field'));
  });

  it('finds the colour contrast on its own, and not as a proxy for luminance', async () => {
    const screenshot = await withRectangle(EQUAL_LUMA, RECTANGLE);
    const areas = [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)];

    const byColour = await scored(screenshot, areas, onlyTerm('colourContrast'));
    const byLuminance = await scored(screenshot, areas, onlyTerm('luminanceContrast'));

    expect(valueOf(byColour, 'rectangle')).toBeGreaterThan(valueOf(byColour, 'field'));
    /**
     * The rectangle is as bright as the field it sits on, so the luminance term has
     * almost nothing to report where the colour term has a great deal. A bound rather
     * than an equality, because the two luma values agree to within half a percent and
     * not exactly.
     */
    expect(valueOf(byLuminance, 'rectangle')).toBeLessThan(valueOf(byColour, 'rectangle'));
    expect(valueOf(byLuminance, 'rectangle')).toBeLessThan(0.05);
  });

  it('finds no contrast at all on a flat field', async () => {
    const screenshot = await flatField();
    const byArea = await scored(
      screenshot,
      [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)],
      resolveEngineConfig({
        salience: { weights: { ...ZEROED, luminanceContrast: 1, colourContrast: 1 } },
      }).config,
    );

    expect(valueOf(byArea, 'rectangle')).toBe(0);
    expect(valueOf(byArea, 'field')).toBe(0);
  });
});

/** One test per term, each with the other weights zeroed through the configuration. */
describe('the position and size terms', () => {
  it('scores a larger area above an otherwise identical smaller one', async () => {
    const screenshot = await flatField();
    const byArea = await scored(
      screenshot,
      [
        areaAt('large', { x: 50, y: 50, width: 100, height: 100 }),
        areaAt('small', { x: 50, y: 50, width: 20, height: 20 }),
      ],
      onlyTerm('relativeArea'),
    );

    expect(valueOf(byArea, 'large')).toBeGreaterThan(valueOf(byArea, 'small'));
  });

  it('scores an area near the page centre above an identical one at the margin', async () => {
    const screenshot = await flatField();
    const byArea = await scored(
      screenshot,
      [
        areaAt('centre', { x: 75, y: 75, width: 50, height: 50 }),
        areaAt('margin', { x: 0, y: 0, width: 50, height: 50 }),
      ],
      onlyTerm('centreBias'),
    );

    expect(valueOf(byArea, 'centre')).toBeGreaterThan(valueOf(byArea, 'margin'));
  });

  it('scores an area near the top above an identical one further down', async () => {
    const screenshot = await flatField();
    const byArea = await scored(
      screenshot,
      [
        areaAt('top', { x: 75, y: 0, width: 50, height: 50 }),
        areaAt('bottom', { x: 75, y: 150, width: 50, height: 50 }),
      ],
      onlyTerm('topBias'),
    );

    expect(valueOf(byArea, 'top')).toBeGreaterThan(valueOf(byArea, 'bottom'));
  });
});

describe('the role prior', () => {
  const sameBox: BoundingBox = { x: 75, y: 75, width: 50, height: 50 };

  const gapAtFamiliarity = async (interfaceFamiliarity: number): Promise<number> => {
    const screenshot = await flatField();
    const byArea = await scored(
      screenshot,
      [areaAt('button', sameBox, 'button'), areaAt('paragraph', { ...sameBox }, 'text')],
      onlyTerm('rolePrior'),
      { ...MIDDLING, interfaceFamiliarity },
    );
    return valueOf(byArea, 'button') - valueOf(byArea, 'paragraph');
  };

  it('scores a button-role area above a paragraph-role area with identical pixels', async () => {
    expect(await gapAtFamiliarity(MIDDLING.interfaceFamiliarity)).toBeGreaterThan(0);
  });

  /**
   * Across the whole trait, including its top end: a role prior merely clamped at 1 would
   * widen the gap over the bottom half of the trait and then stop, and the two halves of
   * the chain below are what tells the two apart.
   */
  it('widens the gap at every step as interfaceFamiliarity rises', async () => {
    const gaps = [
      await gapAtFamiliarity(0),
      await gapAtFamiliarity(0.5),
      await gapAtFamiliarity(1),
    ];

    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
  });
});

describe('every number comes from the configuration object', () => {
  const source = readFileSync(new URL('../src/salience.ts', import.meta.url), 'utf8');

  /** The source with its comments removed, so a `0..1` in prose is not read as a number. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  /**
   * Every numeric literal the module writes down, in any spelling JavaScript allows: a
   * tunable hidden as `3e-1`, `0x10` or `1_000` is still a tunable written inline, and a
   * check that only read `0.3` would be a check with a way around it.
   */
  const literals = new Set(
    (code.match(/\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b/g) ?? [])
      .map((literal) => literal.replace(/_/g, ''))
      .map(Number),
  );

  /**
   * The only numbers the module is allowed to write down, each a definition rather than a
   * tunable: the scale of a decoded sample, the Rec. 709 luma coefficients, how many
   * channels an RGB pixel has, the span of an opponent channel that runs from -1 to 1,
   * and the identities of clamping arithmetic.
   */
  const DEFINITIONAL = new Set([0, 1, 2, 3, 255, 0.2126, 0.7152, 0.0722]);

  it('writes down no number that is not a definition', () => {
    expect([...literals].filter((value) => !DEFINITIONAL.has(value))).toEqual([]);
  });

  it('writes down none of the configuration object salience values', () => {
    const configured = [
      ...Object.values(defaultEngineConfig.salience.weights),
      ...Object.values(defaultEngineConfig.salience.surround),
      ...Object.values(defaultEngineConfig.salience.rolePriors),
      ...Object.values(defaultEngineConfig.persona.rolePriorScale),
    ].filter((value) => !DEFINITIONAL.has(value));

    for (const value of configured) expect(literals).not.toContain(value);
  });

  it('weighs every configured salience weight, and nothing else', () => {
    expect([...SALIENCE_TERMS].sort()).toEqual(
      Object.keys(defaultEngineConfig.salience.weights).sort(),
    );
  });

  /**
   * This ticket's own half of the purity criterion. Reading no file and opening no socket
   * is held over every module in the package at once by `tests/config.test.ts`, which
   * scans `src/` recursively, so it is not scanned a second time here.
   */
  it('resolves no path of its own', () => {
    for (const forbidden of ['node:path', 'node:url', 'readFile', 'import.meta']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('a zeroed weight', () => {
  it('removes its term effect entirely, leaving the other terms untouched', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const areas = [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)];

    const withContrast = await scored(
      screenshot,
      areas,
      resolveEngineConfig({
        salience: { weights: { ...ZEROED, luminanceContrast: 1, relativeArea: 1 } },
      }).config,
    );
    const withoutContrast = await scored(screenshot, areas, onlyTerm('relativeArea'));

    expect(valueOf(withContrast, 'rectangle')).toBeGreaterThan(valueOf(withContrast, 'field'));
    /** The areas are the same size, so with contrast switched off nothing separates them. */
    expect(valueOf(withoutContrast, 'rectangle')).toBe(valueOf(withoutContrast, 'field'));
  });

  it('leaves no bottom-up salience at all when every weight is zero', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const byArea = await scored(
      screenshot,
      [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)],
      resolveEngineConfig({ salience: { weights: ZEROED } }).config,
    );

    for (const value of byArea.values()) expect(value).toBe(0);
  });
});

describe('the documented range', () => {
  /**
   * Areas no capture should produce, and areas every capture will: a box at the page edge
   * whose surrounding ring is clipped away, a box hanging off the page, and the degenerate
   * boxes a zero-width or zero-height element has. All of them are to be handled rather
   * than to crash, and none of them may leave the 0..1 the sampler is promised.
   */
  const awkward: readonly Aoi[] = [
    areaAt('top-left-corner', { x: 0, y: 0, width: 30, height: 30 }),
    areaAt('bottom-right-corner', { x: 170, y: 170, width: 30, height: 30 }),
    areaAt('whole-page', { x: 0, y: 0, width: PAGE.width, height: PAGE.height }),
    areaAt('off-the-left-edge', { x: -40, y: 50, width: 50, height: 50 }),
    areaAt('past-the-bottom', { x: 50, y: 190, width: 50, height: 60 }),
    areaAt('zero-width', { x: 100, y: 100, width: 0, height: 40 }),
    areaAt('zero-height', { x: 100, y: 100, width: 40, height: 0 }),
    areaAt('one-pixel', { x: 100, y: 100, width: 1, height: 1 }),
    areaAt('button', { x: 20, y: 75, width: 50, height: 50 }, 'button'),
  ];

  it.each([
    ['a flat field', flatField],
    ['a bright rectangle', async () => withRectangle(BRIGHT, RECTANGLE)],
    ['an equally bright colour', async () => withRectangle(EQUAL_LUMA, RECTANGLE)],
  ])('stays inside 0..1 on %s, for every area and every term', async (_name, image) => {
    const byArea = await salienceTermsByArea({
      screenshot: await image(),
      page: PAGE,
      aois: awkward,
      traits: MIDDLING,
    });

    expect(byArea.size).toBe(awkward.length);
    for (const area of byArea.values()) {
      expect(area.salience).toBeGreaterThanOrEqual(0);
      expect(area.salience).toBeLessThanOrEqual(1);
      for (const term of SALIENCE_TERMS) {
        expect(area.terms[term]).toBeGreaterThanOrEqual(0);
        expect(area.terms[term]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stays inside 0..1 when calibration has fitted a negative weight', async () => {
    const byArea = await scored(
      await withRectangle(BRIGHT, RECTANGLE),
      awkward,
      resolveEngineConfig({
        salience: { weights: { ...ZEROED, luminanceContrast: -1, centreBias: 1 } },
      }).config,
    );

    for (const value of byArea.values()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('the screenshot', () => {
  it('is decoded once per capture however many areas are scored', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const many = Array.from({ length: 12 }, (_unused, index) =>
      areaAt(`area-${String(index)}`, { x: index * 10, y: index * 10, width: 20, height: 20 }),
    );

    decodes.count = 0;
    const byArea = await scored(screenshot, many);

    expect(byArea.size).toBe(many.length);
    expect(decodes.count).toBe(1);
  });

  it('is not decoded again when a caller scores several personas over one capture', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);
    const areas = [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)];

    const pixels = await readScreenshotPixels(screenshot);

    decodes.count = 0;
    const familiar = await salienceByArea({
      screenshot: pixels,
      page: PAGE,
      aois: areas,
      traits: MIDDLING,
    });
    const unfamiliar = await salienceByArea({
      screenshot: pixels,
      page: PAGE,
      aois: areas,
      traits: { ...MIDDLING, interfaceFamiliarity: 1 },
    });

    expect(decodes.count).toBe(0);
    expect([...familiar]).toEqual([...(await scored(screenshot, areas))]);
    expect(unfamiliar.size).toBe(areas.length);
  });
});

describe('determinism', () => {
  const threeAreas: readonly Aoi[] = [
    areaAt('rectangle', RECTANGLE),
    areaAt('field', OVER_FIELD),
    areaAt('button', { x: 75, y: 10, width: 60, height: 24 }, 'button'),
  ];

  it('produces identical values across runs', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);

    expect([...(await scored(screenshot, threeAreas))]).toEqual([
      ...(await scored(screenshot, threeAreas)),
    ]);
  });

  it('does not depend on the order the areas arrive in', async () => {
    const screenshot = await withRectangle(BRIGHT, RECTANGLE);

    const inOrder = await scored(screenshot, threeAreas);
    const reversed = await scored(screenshot, [...threeAreas].reverse());

    for (const [id, value] of inOrder) expect(reversed.get(id)).toBe(value);
  });

  it('reads the same page from a screenshot at twice the device pixel ratio', async () => {
    const atOne = await withRectangle(BRIGHT, RECTANGLE);
    const atTwo = await sharp(atOne)
      .resize({ width: PAGE.width * 2, height: PAGE.height * 2, kernel: 'nearest' })
      .png()
      .toBuffer();
    const areas = [areaAt('rectangle', RECTANGLE), areaAt('field', OVER_FIELD)];

    const retina = await scored(atTwo, areas);

    /**
     * Area boxes are in page space and the screenshot carries the device pixel ratio, so
     * the same page at twice the resolution has to put the rectangle ahead of the field in
     * the same way: the module reads the ratio from the image rather than being told it.
     */
    expect(valueOf(retina, 'rectangle')).toBeGreaterThan(valueOf(retina, 'field'));
    expect(valueOf(retina, 'rectangle')).toBeCloseTo(
      valueOf(await scored(atOne, areas), 'rectangle'),
      2,
    );
  });
});
