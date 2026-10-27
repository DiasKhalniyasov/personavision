/**
 * Determinism, which is the whole point of fixture mode.
 *
 * Every aggregated area-of-interest metric in the project is keyed on an element id and
 * computed over a box, so two captures of one screen that disagree about either would make
 * the numbers on the Attention screen a function of how many times the screen was visited.
 * Four things are asserted here:
 *
 * 1. two fixture-mode captures of the same recorded page are identical, element ids
 *    included — across sessions, and across two sources over the same directory;
 * 2. the committed capture set parses against this module's own types;
 * 3. the areas of interest projected from it parse against `packages/contract`'s schema, and
 *    the run directory a replay leaves holds the images those rows point at;
 * 4. recording twice over an unchanged site writes identical files, and the committed set is
 *    what this recorder produces from the fixture site as it stands.
 *
 * The fourth needs Chromium and the fixture server; the first three need neither, and run
 * with both down. Keeping the recorded data of (4) in step with the site is the same job
 * `fixture-site.test.ts` does for `LANDMARKS.md`: a capture set that has gone stale against
 * the pages it was recorded from is a fixture that tests the wrong screen.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPaths, runSchema } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureSource, toAoiEntries, toScreenshotEntries } from '../src/index.js';
import type { Capture, CaptureContext, Device } from '../src/index.js';
import { captureSetPaths, parseCapture, parseCaptureSet } from '../src/fixture-source.js';
import type { CaptureSet } from '../src/fixture-source.js';
import { COMMITTED_CAPTURES_DIR, recordCaptures } from '../scripts/record-captures.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/**
 * Two recordings of two variants, each four steps with a full-page screenshot: four browser
 * launches and sixteen captures. A browser test's usual minute is not enough for that.
 */
const RECORDING_TIMEOUT_MS = 300_000;

const COMMITTED = fileURLToPath(new URL('./fixtures/captures', import.meta.url));

/** The committed index, read the way the fixture source reads it. */
const committedSet = async (): Promise<CaptureSet> => {
  const index = captureSetPaths(COMMITTED).index;
  return parseCaptureSet(JSON.parse(await readFile(index, 'utf8')) as unknown, index);
};

/** Every file under a directory, by its path relative to it, in a stable order. */
const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
};

/**
 * Replays a whole recorded walk through the public interface, into a run directory.
 *
 * This is the call a consumer makes: open the variant under the device it was recorded at,
 * capture, click the step's primary action, capture again.
 */
const replay = async (variant: string, device: Device, runDir: string): Promise<Capture[]> => {
  const source = createFixtureSource(COMMITTED);
  const ctx: CaptureContext = {
    variant,
    device,
    task: { id: 'checkout', prompt: 'Buy the canvas tote bag', steps: [] },
    runDir,
  };
  const page = await source.openSession(
    { id: variant, url: 'https://shop.invalid/cart.html' },
    device,
  );
  const captures: Capture[] = [];

  try {
    for (;;) {
      const capture = await source.capture(page, ctx);
      captures.push(capture);
      const primary = capture.elements.find((element) => element.isPrimaryAction);
      if (primary === undefined) break;
      const advanced = await source.act(page, { type: 'click', elementId: primary.id }, ctx);
      if (!advanced.ok) break;
    }
  } finally {
    await source.close(page);
  }

  return captures;
};

describe('two fixture-mode captures of one recorded page', () => {
  let runDir: string;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-determinism-'));
  });

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('return identical geometry and identical element ids', async () => {
    const set = await committedSet();
    const variant = set.variants[0]!;
    const ctx = (dir: string): CaptureContext => ({
      variant: variant.id,
      device: variant.device,
      task: { id: 'checkout', prompt: 'Buy the canvas tote bag', steps: [] },
      runDir: dir,
    });

    // Two sources over the same directory, each with its own session: nothing is shared
    // between them but the bytes on disk.
    const first = createFixtureSource(COMMITTED);
    const second = createFixtureSource(COMMITTED);
    const onePage = await first.openSession(
      { id: variant.id, url: 'https://a.invalid/' },
      variant.device,
    );
    const otherPage = await second.openSession(
      { id: variant.id, url: 'https://b.invalid/' },
      variant.device,
    );

    try {
      const one = await first.capture(onePage, ctx(runDir));
      const other = await second.capture(otherPage, ctx(runDir));

      expect(other.viewport).toEqual(one.viewport);
      expect(other.pageHeight).toBe(one.pageHeight);
      expect(other.foldY).toBe(one.foldY);
      expect(other.elements.map((element) => element.id)).toEqual(
        one.elements.map((element) => element.id),
      );
      expect(other.elements.map((element) => element.bbox)).toEqual(
        one.elements.map((element) => element.bbox),
      );
      expect(other).toEqual(one);
    } finally {
      await first.close(onePage);
      await second.close(otherPage);
    }
  });

  it('give every element of one capture its own id', async () => {
    const set = await committedSet();

    for (const variant of set.variants) {
      for (const step of variant.steps) {
        const file = captureSetPaths(COMMITTED).capture(variant.id, step.step);
        const capture = parseCapture(JSON.parse(await readFile(file, 'utf8')) as unknown, file);
        const ids = capture.elements.map((element) => element.id);

        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});

describe('the committed capture set', () => {
  let runDir: string;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'personavision-committed-'));
  });

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('parses against this module own types, every file of it', async () => {
    const set = await committedSet();
    const paths = captureSetPaths(COMMITTED);

    expect(set.variants.map((variant) => variant.id)).toEqual(['A', 'B']);

    for (const variant of set.variants) {
      expect(variant.steps.map((step) => step.step)).toEqual([
        'cart',
        'payment',
        'review',
        'confirmation',
      ]);

      for (const step of variant.steps) {
        const file = paths.capture(variant.id, step.step);
        const capture = parseCapture(JSON.parse(await readFile(file, 'utf8')) as unknown, file);

        expect(capture.variant).toBe(variant.id);
        expect(capture.step).toBe(step.step);
        expect(capture.viewport).toEqual(variant.device.viewport);
        expect(capture.foldY).toBe(variant.device.viewport.height);
        expect(capture.screenshot).toBe(runPaths('').screenshot(variant.id, step.step));
        expect(capture.elements.filter((element) => element.isPrimaryAction)).toHaveLength(1);
        expect(existsSync(paths.screenshot(variant.id, step.step))).toBe(true);
      }
    }
  });

  it('projects areas of interest that parse against the contract schema', async () => {
    const set = await committedSet();
    const captures: Capture[] = [];
    for (const variant of set.variants) {
      captures.push(...(await replay(variant.id, variant.device, runDir)));
    }

    expect(captures).toHaveLength(set.variants.length * 4);

    const example = JSON.parse(
      await readFile(
        new URL('../../../runs/2026-10-24-1402-northwind-demo/run.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const run = runSchema.parse({
      ...example,
      screenshots: toScreenshotEntries(captures),
      aois: toAoiEntries(captures),
    });

    expect(run.screenshots).toHaveLength(set.variants.length * 4);
    expect(run.aois.length).toBeGreaterThan(0);
    expect(run.aois.every((aoi) => aoi.source === 'dom' || aoi.source === 'a11y')).toBe(true);
    expect(run.aois.filter((aoi) => aoi.isPrimaryAction)).toHaveLength(set.variants.length * 4);

    // Every row points at an image a screen can draw: the replay put the recorded
    // screenshots into the run directory as the live source would have written them.
    for (const row of run.screenshots) {
      expect(existsSync(join(runDir, row.path))).toBe(true);
    }
  });
});

describeWithChromium('recording the capture set', () => {
  let once: string;
  let twice: string;

  beforeAll(async () => {
    once = await mkdtemp(join(tmpdir(), 'personavision-record-1-'));
    twice = await mkdtemp(join(tmpdir(), 'personavision-record-2-'));
    await recordCaptures({ dir: once });
    await recordCaptures({ dir: twice });
  }, RECORDING_TIMEOUT_MS);

  afterAll(async () => {
    await rm(once, { recursive: true, force: true });
    await rm(twice, { recursive: true, force: true });
  });

  it('writes identical files when run twice over an unchanged site', async () => {
    const written = await filesUnder(once);

    expect(written).toEqual(await filesUnder(twice));
    expect(written).toContain('capture-set.json');

    for (const file of written) {
      const first = await readFile(join(once, file));
      const second = await readFile(join(twice, file));

      expect(first.equals(second), `${file} differs between two recordings`).toBe(true);
    }
  });

  it('is what the committed set was recorded by, over the site as it stands', async () => {
    const recorded = (await filesUnder(once)).filter((file) => file.endsWith('.json'));

    expect(recorded).toEqual(
      (await filesUnder(COMMITTED)).filter((file) => file.endsWith('.json')),
    );

    for (const file of recorded) {
      const fresh = await readFile(join(once, file), 'utf8');
      const committed = await readFile(join(COMMITTED_CAPTURES_DIR, file), 'utf8');

      expect(
        JSON.parse(fresh),
        `${file} is not what the recorder writes from the fixture site now: re-run pnpm -F @personavision/browser record:captures`,
      ).toEqual(JSON.parse(committed));
    }
  });
});
