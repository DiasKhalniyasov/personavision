// @vitest-environment jsdom
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { landingSlidesSchema } from '@personavision/contract';
import type { LandingSlides } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp } from '../../../tests/app';
import { SLIDE_SETS, chosenSlideSet, screenshotBase } from './slideSets';
import type { SlideSet } from './slideSets';

/**
 * Which slide set the front page shows, and what has to be true of every set it could show
 * (#429).
 *
 * #427 bakes a set and #428 renders one. The third thing is the rule, and this suite is about
 * the rule: **`/` reads the first entry of `SLIDE_SETS`, the committed example run's set is
 * last and so is the fallback**, and every set in that list is a set the page can actually
 * draw — both viewports, an outcome that is not a success, no automation failure, and every
 * capture it names reachable from this app's own origin.
 *
 * It is written as a loop over the registry rather than over a list of file names, so that
 * the day a template set is registered it is asserted here with no new test: a set that
 * cannot be drawn fails this suite rather than shipping a front page with a broken frame.
 *
 * The front-page half mocks `./slideSets` and not the JSON module, for the same reason: a
 * test that reached for `./slides.json?raw` could only ever assert the one set.
 */

const run$ = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
// `fileURLToPath(new URL(…))` is not available here: under jsdom the global `URL` is jsdom's
// own and Node refuses it, so the repository root is walked up from this file's directory.
const ROOT = resolve(here, '../../../../..');
const RUNS_ROOT = join(ROOT, 'runs');
/** Where `--assets` copies a set's captures, as `vite.config.ts` serves them: the app's own. */
const PUBLIC_DIR = join(ROOT, 'apps/viewer/public');
const EXAMPLE_RUN = '2026-10-24-1402-northwind-demo';

/** The widest a phone is drawn at and the narrowest a desktop is (#427's own thresholds). */
const PHONE_WIDTH = 500;
const DESKTOP_WIDTH = 1000;

/** Long enough for `tsx` to start, read a 3 MB run directory and parse it. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** The set every mount of `/` in this file is handed. */
let chosen: SlideSet = SLIDE_SETS[0];

vi.mock('./slideSets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slideSets')>();
  return { ...actual, chosenSlideSet: () => chosen };
});

const SIGNED_OUT = { status: 'signed-out' } as const;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every registered set, read and parsed the way the page parses it. */
const parsed = await Promise.all(
  SLIDE_SETS.map(async (set) => ({
    set,
    data: landingSlidesSchema.parse(JSON.parse(await set.read())) as LandingSlides,
  })),
);

const bake = async (
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly output: string }> => {
  try {
    const { stdout } = await run$('pnpm', ['-s', 'bake:landing-slides', ...args], {
      cwd: ROOT,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
};

afterEach(() => {
  chosen = SLIDE_SETS[0];
  forgetRuns();
});

describe('which set the front page reads', () => {
  it('is the first of the declared order', () => {
    expect(chosenSlideSet()).toBe(SLIDE_SETS[0]);
  });

  it('is named in one file, and in no other source on this page', async () => {
    // A second place that reached for a set — the page, the read, the carousel — is the thing
    // this ticket exists to prevent, so the front page's own sources are swept for one.
    const sources = (await readdir(here)).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes('.test.') && name !== 'slideSets.ts',
    );
    expect(sources.length).toBeGreaterThan(0);

    for (const name of sources) {
      const text = await readFile(join(here, name), 'utf8');
      const named = [...text.matchAll(/\bimport\(\s*(['"])([^'"]*slides[^'"]*)\1\s*\)/g)];
      expect(
        named.map((match) => match[2]),
        `${name} imports a slide set of its own`,
      ).toEqual([]);
    }
  });

  it('ends with the committed example run, which is the fallback', () => {
    const last = SLIDE_SETS[SLIDE_SETS.length - 1] as SlideSet;
    expect(last.id).toBe('northwind-demo');
    expect(last.screenshots).toEqual({ kind: 'run-data' });
  });

  it('names every set once', () => {
    const ids = SLIDE_SETS.map((set) => set.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('every registered set is one the page can draw', () => {
  for (const { set, data } of parsed) {
    describe(`${set.id} (${set.site})`, () => {
      it('parses as a slide set and carries at least five slides', () => {
        expect(data.slides.length).toBeGreaterThanOrEqual(5);
      });

      it('shows a phone and a desktop', () => {
        const widths = data.slides.map((slide) => slide.person.device.viewport.width);
        expect(widths.some((width) => width <= PHONE_WIDTH)).toBe(true);
        expect(widths.some((width) => width >= DESKTOP_WIDTH)).toBe(true);
      });

      it('shows at least one outcome that is not a success, and no automation failure', () => {
        const statuses = data.slides.map((slide) => slide.outcome.status);
        expect(statuses.some((status) => status !== 'success')).toBe(true);
        // Our own breakage is not a person's behaviour, so it is never a slide (#428).
        expect(statuses).not.toContain('automation_failure');
      });

      it('loads every capture from this app’s own origin', () => {
        for (const slide of data.slides) {
          const url = new URL(
            slide.screenshot.path,
            new URL(screenshotBase(set.screenshots, slide.runId), 'https://example.test/'),
          );
          expect(url.origin).toBe('https://example.test');
        }
      });

      // Narrowed once, so every assertion below reads `assets.base` rather than re-narrowing
      // a field inside a closure.
      const assets = set.screenshots.kind === 'assets' ? set.screenshots : null;

      it('holds every capture it names on disk', async () => {
        const where = (runId: string): string =>
          assets === null ? join(RUNS_ROOT, runId) : join(PUBLIC_DIR, assets.base, runId);
        for (const slide of data.slides) {
          await expect(
            stat(join(where(slide.runId), slide.screenshot.path)),
            `${set.id}: ${slide.runId}/${slide.screenshot.path}`,
          ).resolves.toBeDefined();
        }
      });

      if (assets !== null) {
        it('records the triples it was baked from, beside the set', async () => {
          const record = JSON.parse(
            await readFile(join(here, 'slides', `${set.id}.bake.json`), 'utf8'),
          ) as {
            triples: string[];
            screenshots: { runId: string; path: string; sha256: string }[];
          };

          // One triple per slide, naming that slide: the set's provenance is the set's own
          // shape, because the run it came from is not in the repository to check against.
          expect(record.triples).toEqual(
            data.slides.map(
              (slide) => `${slide.runId}:${slide.sessionId}:${String(slide.screenIndex)}`,
            ),
          );

          for (const shot of record.screenshots) {
            const bytes = await readFile(join(PUBLIC_DIR, assets.base, shot.runId, shot.path));
            expect(sha256(bytes), `${shot.runId}/${shot.path}`).toBe(shot.sha256);
          }
        });
      }

      it('is rendered by the front page, slide by slide', async () => {
        chosen = set;
        const { container } = mountApp(paths.home, { session: SIGNED_OUT });

        const section = await waitFor(() => {
          const found = container.querySelector<HTMLElement>(
            '[data-section="landing-carousel"] [data-slide]',
          );
          if (found === null) throw new Error('no slide yet');
          return found.closest('[data-section="landing-carousel"]') as HTMLElement;
        });

        // The task once, above the slides, and the audience's own line beside it.
        expect(section.textContent).toContain(data.task);
        expect(section.textContent).toContain(data.audience.name);

        // One dot per slide, one slide mounted, and it is the first of the set.
        expect(section.querySelectorAll('[role="tab"]')).toHaveLength(data.slides.length);
        const slides = section.querySelectorAll('[data-slide]');
        expect(slides).toHaveLength(1);
        const first = data.slides[0] as LandingSlides['slides'][number];
        expect(slides[0]?.getAttribute('data-slide')).toBe(first.sessionId);

        // The person, their device and the capture they are drawn on, all read off the file.
        expect(section.textContent).toContain(first.person.name);
        expect(section.textContent).toContain(first.person.device.name);
        const image = section.querySelector('img') as HTMLImageElement;
        const src = new URL(image.getAttribute('src') as string, window.location.href);
        expect(src.pathname).toBe(
          `${screenshotBase(set.screenshots, first.runId)}${first.screenshot.path}`,
        );
        expect(src.origin).toBe(window.location.origin);
      });
    });
  }
});

describe('a set baked from a run that is not committed', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'pv-slide-sets-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const TRIPLES = [`${EXAMPLE_RUN}:S-03:2`, `${EXAMPLE_RUN}:S-09:1`] as const;

  it('copies every capture it names into the assets, under the run’s own id', async () => {
    const out = join(work, 'trial.json');
    const assets = join(work, 'assets');
    const baked = await bake(['runs', out, '--assets', assets, ...TRIPLES]);
    expect(baked.ok, baked.output).toBe(true);

    const set = landingSlidesSchema.parse(JSON.parse(await readFile(out, 'utf8'))) as LandingSlides;
    for (const slide of set.slides) {
      const copied = await readFile(join(assets, slide.runId, slide.screenshot.path));
      const original = await readFile(join(RUNS_ROOT, slide.runId, slide.screenshot.path));
      expect(copied.equals(original), slide.screenshot.path).toBe(true);
    }
  });

  it('records the triples and the captures’ hashes beside the set', async () => {
    const out = join(work, 'trial.json');
    const assets = join(work, 'assets');
    await bake(['runs', out, '--assets', assets, ...TRIPLES]);

    const record = JSON.parse(await readFile(join(work, 'trial.bake.json'), 'utf8')) as {
      triples: string[];
      screenshots: { runId: string; path: string; sha256: string }[];
    };
    expect(record.triples).toEqual([...TRIPLES]);
    expect(record.screenshots.length).toBeGreaterThan(0);
    for (const shot of record.screenshots) {
      expect(shot.runId).toBe(EXAMPLE_RUN);
      expect(sha256(await readFile(join(RUNS_ROOT, shot.runId, shot.path)))).toBe(shot.sha256);
    }
  });

  it('bakes the same bytes and the same record twice over', async () => {
    const first = join(work, 'one.json');
    const second = join(work, 'two.json');
    await bake(['runs', first, '--assets', join(work, 'a'), ...TRIPLES]);
    await bake(['runs', second, '--assets', join(work, 'b'), ...TRIPLES]);

    expect(await readFile(second, 'utf8')).toBe(await readFile(first, 'utf8'));
    expect(await readFile(join(work, 'two.bake.json'), 'utf8')).toBe(
      await readFile(join(work, 'one.bake.json'), 'utf8'),
    );
  });

  it('is the same slide set with or without the copy: only the captures move', async () => {
    const withCopy = join(work, 'with.json');
    const without = join(work, 'without.json');
    await bake(['runs', withCopy, '--assets', join(work, 'assets'), ...TRIPLES]);
    await bake(['runs', without, ...TRIPLES]);

    // A slide's `screenshot.path` stays run-relative, exactly as the contract spells it: where
    // it is loaded from is the set's business (`slideSets.ts`), never the slide's.
    expect(await readFile(without, 'utf8')).toBe(await readFile(withCopy, 'utf8'));
    await expect(stat(join(work, 'without.bake.json'))).rejects.toThrow();
  });

  it('refuses --assets with no directory, and writes nothing', async () => {
    const out = join(work, 'trial.json');
    const baked = await bake(['runs', out, '--assets']);
    expect(baked.ok).toBe(false);
    expect(baked.output).toContain('--assets needs a directory');
    await expect(stat(out)).rejects.toThrow();
  });

  it('refuses --assets that swallowed a slide, rather than baking a smaller set', async () => {
    const out = join(work, 'trial.json');
    const baked = await bake(['runs', out, '--assets', ...TRIPLES]);
    expect(baked.ok).toBe(false);
    expect(baked.output).toContain(`"${TRIPLES[0]}" is a slide`);
    await expect(stat(out)).rejects.toThrow();
  });

  it('changes no file under runs/', async () => {
    const before = await readdir(join(RUNS_ROOT, EXAMPLE_RUN), { recursive: true });
    await bake(['runs', join(work, 'trial.json'), '--assets', join(work, 'assets'), ...TRIPLES]);
    expect((await readdir(join(RUNS_ROOT, EXAMPLE_RUN), { recursive: true })).sort()).toEqual(
      before.sort(),
    );
  });
});

describe('where a capture is loaded from', () => {
  it('is the run-data mount for a run committed under runs/', () => {
    expect(screenshotBase({ kind: 'run-data' }, EXAMPLE_RUN)).toBe(`/runs/${EXAMPLE_RUN}/`);
  });

  it('is the set’s own assets directory for a run that is not', () => {
    expect(screenshotBase({ kind: 'assets', base: '/landing-slides/x/' }, EXAMPLE_RUN)).toBe(
      `/landing-slides/x/${EXAMPLE_RUN}/`,
    );
  });

  it('encodes a run id the same way either place does', () => {
    const odd = '2026-11-05-0900-a b';
    expect(screenshotBase({ kind: 'assets', base: '/landing-slides/x/' }, odd)).toBe(
      `/landing-slides/x/${encodeURIComponent(odd)}/`,
    );
    expect(screenshotBase({ kind: 'run-data' }, odd)).toContain(encodeURIComponent(odd));
  });
});
