/**
 * The engine's fixture captures, by name.
 *
 * Every later ticket in the attention-engine step tests against these five captures rather
 * than inventing its own page, so a behavioural claim ("what stands out attracts an early
 * fixation") is made about material the whole step shares. The bytes are committed and
 * `packages/engine/scripts/make-fixtures.ts` is the deterministic generator that produces
 * them: see the fixtures section of `packages/engine/README.md`.
 *
 * A test names a fixture; it never builds a path. The screenshot is read from
 * `screenshotPath`, an absolute path to the committed image — `capture.screenshot` is the
 * run-directory-relative path the type promises, which no fixture file lives at.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoundingBox, Capture } from '../../src/types.js';

/**
 * The committed fixtures, and the property each one exists for. The generator builds this
 * exact set: it keys its specs by `FixtureName`, so adding a name here without generating
 * the capture fails to compile rather than at some later ticket's first read.
 */
export const FIXTURE_NAMES = [
  /** A saturated promotional banner above ordinary text: bottom-up salience has a target. */
  'high-contrast-banner',
  /** A tall page whose primary action sits below the fold: the never-fixated case. */
  'below-fold-primary-action',
  /** A total, a line price and a service fee: a cheapest-option goal has something to pull to. */
  'price-and-fees',
  /** Image-like cards with no elements reported: the segmenter has unexplained area. */
  'card-grid-unexplained',
  /** Low contrast, evenly spread, no primary action: the null case. */
  'plain-text-control',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

/**
 * The page-space region `card-grid-unexplained` paints its cards in, and reports no
 * element for. Declared here rather than in the generator so the generator paints the
 * region the test asserts against, instead of the two sides carrying copies of it.
 */
export const CARD_GRID_REGION: BoundingBox = { x: 16, y: 112, width: 448, height: 232 };

/** The directory the fixture files are committed in. */
export const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url));

export interface LoadedFixture {
  readonly name: FixtureName;
  readonly capture: Capture;
  /** Absolute path to the committed screenshot. */
  readonly screenshotPath: string;
  /** Absolute path to the committed capture JSON. */
  readonly capturePath: string;
}

const isFixtureName = (name: string): name is FixtureName =>
  (FIXTURE_NAMES as readonly string[]).includes(name);

const REGENERATE = 'regenerate with `pnpm -F @personavision/engine fixtures`';

/**
 * Checks the committed JSON still is a capture, field by field, so a missing one is named
 * here. The generator types every fixture as a `Capture`, so this only catches a
 * hand-edited or half-written file — and it catches it here, named,
 * rather than as a `TypeError` inside whichever ticket read it next.
 */
const asCapture = (value: unknown, path: string): Capture => {
  const capture = value as Capture;
  const shaped =
    typeof capture?.step === 'string' &&
    typeof capture.screenshot === 'string' &&
    typeof capture.viewport?.width === 'number' &&
    typeof capture.viewport?.height === 'number' &&
    typeof capture.pageHeight === 'number' &&
    typeof capture.foldY === 'number' &&
    Array.isArray(capture.elements) &&
    capture.elements.length > 0 &&
    capture.elements.every(
      (element) =>
        typeof element?.id === 'string' &&
        typeof element.source === 'string' &&
        (typeof element.role === 'string' || element.role === null) &&
        typeof element.name === 'string' &&
        typeof element.text === 'string' &&
        typeof element.selector === 'string' &&
        typeof element.isPrimaryAction === 'boolean' &&
        typeof element.belowFold === 'boolean' &&
        typeof element.bbox?.x === 'number' &&
        typeof element.bbox.y === 'number' &&
        typeof element.bbox.width === 'number' &&
        typeof element.bbox.height === 'number',
    );
  if (!shaped) throw new Error(`${path} is not a capture — ${REGENERATE}.`);
  return capture;
};

/** The fixture called `name`, or a thrown error naming the fixtures that do exist. */
export const loadFixture = (name: string): LoadedFixture => {
  if (!isFixtureName(name)) {
    throw new Error(
      `Unknown engine fixture "${name}". The fixtures are: ${FIXTURE_NAMES.join(', ')}.`,
    );
  }
  const capturePath = join(FIXTURES_DIR, `${name}.json`);
  const screenshotPath = join(FIXTURES_DIR, `${name}.png`);
  if (!existsSync(capturePath)) throw new Error(`${capturePath} is missing — ${REGENERATE}.`);
  if (!existsSync(screenshotPath)) {
    throw new Error(`${screenshotPath} is missing — ${REGENERATE}.`);
  }
  return {
    name,
    capture: asCapture(JSON.parse(readFileSync(capturePath, 'utf8')), capturePath),
    screenshotPath,
    capturePath,
  };
};

/** Every fixture, in the order `FIXTURE_NAMES` declares. */
export const loadAllFixtures = (): readonly LoadedFixture[] => FIXTURE_NAMES.map(loadFixture);
