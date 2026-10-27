import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths, validate } from '@personavision/contract';
import { GENERATOR_VERSION } from '@personavision/personas';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands/run.js';
import { serveFixtureSite } from '../../browser/test/helpers/static-site.js';
import type { Audience, Run } from '@personavision/contract';
import type { FixtureSite } from '../../browser/test/helpers/static-site.js';

/**
 * The command, end to end, against a page in a browser — with **no API key and no network
 * beyond localhost**.
 *
 * This is the one suite here that drives Chromium. It is also the only place the *derived*
 * task is exercised against a real page: no `--steps`, so the command makes the page the
 * task's single step, which is what a run of an arbitrary URL is and what the New test form
 * can express. Everything else about the command is asserted in `run.test.ts` over a
 * replayed capture set.
 *
 * See `packages/browser/test/geometry.test.ts`: a developer without the browser is skipped,
 * CI is not.
 */

const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** A whole session is a navigation, a capture and a screenshot, so it gets its own cap. */
const RUN_TIMEOUT_MS = 60_000;

/** One page, with one control on it: the smallest thing a test can be run against. */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hiking boots</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }
      h1 { font-size: 28px; }
      button { display: block; margin-top: 24px; padding: 12px 20px; font-size: 16px; }
    </style>
  </head>
  <body>
    <h1>Hiking boots</h1>
    <p>Waterproof leather boots, $129.00. Free returns within 30 days.</p>
    <button type="button">Buy now</button>
  </body>
</html>
`;

/** One person on one desktop viewport: one session, which is a whole run. */
const ONE_PERSON: Audience = {
  id: 'one-shopper',
  name: 'One shopper',
  ageRange: { min: 30, max: 40 },
  roles: ['Returning customer'],
  regions: ['United Kingdom'],
  goals: ['Buy one item quickly'],
  devices: [
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 1,
    },
  ],
  techSavviness: 0.6,
  priceSensitivity: 0.5,
  size: 1,
  generatedFrom: { seed: 3, generatorVersion: GENERATOR_VERSION },
};

describeWithChromium('personavision run against a page in a browser', () => {
  let dir: string;
  let site: FixtureSite;
  let audience: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personavision-run-live-'));
    const pages = join(dir, 'site');
    await mkdir(pages, { recursive: true });
    await writeFile(join(pages, 'boots.html'), PAGE);
    site = await serveFixtureSite({ root: pages });
    audience = join(dir, 'audience.json');
    await writeFile(audience, JSON.stringify(ONE_PERSON, null, 2));
  });

  afterAll(async () => {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it(
    'walks the page offline with no key and leaves a run directory that validates',
    async () => {
      const runsRoot = join(dir, 'runs');
      const printed: string[] = [];

      await runCommand({
        runsRoot,
        url: [`${site.url}/boots.html`],
        task: 'Buy the hiking boots',
        audience,
        repeats: '1',
        seed: '3',
        mode: 'contributor',
        // No key, so the offline deterministic engine: the cold-start promise of step #8.
        env: {},
        log: (line) => void printed.push(line),
        onStop: () => (): void => undefined,
      });

      const [runId] = await readdir(runsRoot);
      const runDir = join(runsRoot, String(runId));
      expect(await validate(runDir)).toEqual([]);

      const run = JSON.parse(await readFile(runPaths(runDir).run, 'utf8')) as Run;
      expect(run.status).toBe('finished');
      expect(run.engine.mode).toBe('offline');
      expect(run.usage?.calls).toBe(0);
      // The page is the task's one step, as the derived task declares it.
      expect(run.steps).toEqual([{ id: 'page', label: 'The page' }]);
      expect(run.sessionIds).toEqual(['S-01']);
      // A real capture of a real page: the screenshot is on disk with the geometry the
      // overlays register to, and the fold is a line on the page rather than in the image.
      const captured = run.screenshots[0];
      expect(captured?.step).toBe('page');
      // The **concrete** device the person was on, which is not the audience's nominal
      // viewport: an audience declares device classes and a person runs on one of them
      // (`packages/personas`' `CONCRETE_DEVICES`).
      expect(captured?.viewport).toEqual({ width: 1440, height: 900 });
      expect(captured?.foldY).toBe(900);
      expect(existsSync(join(runDir, String(captured?.path)))).toBe(true);
      // A real walk of a real page: the areas are the page's own elements, and the person
      // looked at them.
      expect(run.aois.map((aoi) => aoi.label)).toContain('Buy now');
      const session = JSON.parse(await readFile(runPaths(runDir).session('S-01'), 'utf8')) as {
        screens: { step: string }[];
        fixations: unknown[];
      };
      expect(session.screens.map((screen) => screen.step)).toEqual(['page']);
      expect(session.fixations.length).toBeGreaterThan(0);
      // One line for the one session that ran, in the Running log's wording.
      expect(printed.filter((line) => /^\d\d:\d\d:\d\d {2}S-01 /.test(line))).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );
});
