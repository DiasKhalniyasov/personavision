import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { landingSlidesSchema, readRun, runPaths } from '@personavision/contract';
import { stepWalk } from '@personavision/scoring';
import type { LandingSlides, Run, Session } from '@personavision/contract';

/**
 * The slide data the front page's carousel reads (#427).
 *
 * Two things are tested, and they are the two ways a baked file goes wrong. **It is a copy**:
 * every number, name and sentence on a slide is checked against the committed example run it
 * was baked from, so a changed fixture that nobody re-baked fails here rather than shipping a
 * stale front page. And **it is reproducible**: the command in `README.md` is run into a
 * temporary directory and compared with the committed bytes, so the file, the script and the
 * documented command cannot drift apart.
 *
 * The two rules the script applies rather than copies get a test each — which traits a slide
 * shows, and which screen a click belongs to — restated here rather than imported, so that
 * changing either has to be done twice on purpose. Plus the refusals, because the page would
 * rather have no carousel than a person who looked at a picture that is not there.
 */

const run$ = promisify(execFile);

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SLIDES_FILE = 'apps/viewer/src/screens/landing/slides.json';
const RUNS_ROOT = join(ROOT, 'runs');
const EXAMPLE_RUN = '2026-10-24-1402-northwind-demo';

/** The widest a phone is drawn at and the narrowest a desktop is, for the contrast above. */
const PHONE_WIDTH = 500;
const DESKTOP_WIDTH = 1000;

/** Long enough for `tsx` to start, read a 3 MB run directory and parse it. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

const committedText = await readFile(join(ROOT, SLIDES_FILE), 'utf8');
const committed: LandingSlides = landingSlidesSchema.parse(JSON.parse(committedText));

/**
 * The command that produced the committed file, read out of `README.md` rather than restated
 * here: the documented line is the one under test, so a reader who rebuilds the file by copying
 * it out of the README gets the committed bytes back.
 */
const documentedCommand = (readme: string): string[] => {
  const line = /^pnpm bake:landing-slides .+$/m.exec(readme);
  expect(line, 'README.md documents the command that bakes the committed slide set').not.toBeNull();
  // Past `pnpm bake:landing-slides` itself: the runs root, the output file, the triples.
  return (line as RegExpExecArray)[0].split(/\s+/).slice(2);
};

const bake = async (
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly output: string }> => {
  try {
    const { stdout } = await run$('pnpm', ['-s', 'bake:landing-slides', ...args], { cwd: ROOT });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
};

/** Every file under a directory, with a digest of its bytes: the listing a test compares. */
const listing = async (dir: string): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    found.set(
      relative(dir, file),
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    );
  }
  return found;
};

describe('the committed slide set', () => {
  it('parses as a slide set', () => {
    // Parsed above, at the top, because every other test reads the parsed value. Asserting
    // the count here is what the acceptance criterion asks of the committed file.
    expect(committed.slides.length).toBeGreaterThanOrEqual(5);
  });

  it('contrasts a phone and a desktop, and somebody who did not succeed', () => {
    // On the person's device, which is what the slide draws the frame from — not on the
    // capture's, because every capture of the committed run is 390 px wide, the ones the
    // desktop people walked included.
    const widths = committed.slides.map((slide) => slide.person.device.viewport.width);
    expect(
      committed.slides.filter(
        (slide) => slide.person.device.touch && slide.person.device.viewport.width <= PHONE_WIDTH,
      ).length,
      `at least one slide is a person on a phone viewport (widths: ${widths.join(', ')})`,
    ).toBeGreaterThan(0);
    expect(
      committed.slides.filter(
        (slide) =>
          !slide.person.device.touch && slide.person.device.viewport.width >= DESKTOP_WIDTH,
      ).length,
      `at least one slide is a person on a desktop viewport (widths: ${widths.join(', ')})`,
    ).toBeGreaterThan(0);
    expect(
      committed.slides.filter((slide) => slide.outcome.status !== 'success').length,
      'at least one slide is somebody the site did not work for',
    ).toBeGreaterThan(0);
  });

  it('names only runs that are committed, and only one task', async () => {
    expect(committed.runIds).toEqual([EXAMPLE_RUN]);
    await expect(stat(join(RUNS_ROOT, EXAMPLE_RUN))).resolves.toBeDefined();
  });

  it('loads a capture the run directory holds', async () => {
    for (const slide of committed.slides) {
      await expect(
        stat(join(RUNS_ROOT, slide.runId, slide.screenshot.path)),
        `${slide.sessionId}'s capture`,
      ).resolves.toBeDefined();
    }
  });
});

const artifact = await readRun(join(RUNS_ROOT, EXAMPLE_RUN));
const run: Run = artifact.run;
const sessionOf = (id: string): Session => {
  const session = artifact.sessions.find((candidate) => candidate.sessionId === id);
  if (session === undefined) throw new Error(`${id} is not a session of ${EXAMPLE_RUN}`);
  return session;
};

describe('every number, name and sentence is the example run’s own', () => {
  it('carries the run’s own task and audience', () => {
    expect(committed.task).toBe(run.task.prompt);
    expect(committed.audience).toEqual({
      name: run.audience.name,
      priceSensitivity: run.audience.priceSensitivity,
    });
  });

  it('copies each person off the run’s personas', () => {
    for (const slide of committed.slides) {
      const session = sessionOf(slide.sessionId);
      const persona = run.personas.find((candidate) => candidate.id === session.persona?.id);
      expect(persona, `${slide.sessionId}'s persona`).toBeDefined();
      const found = persona as NonNullable<typeof persona>;
      expect(slide.person.name).toBe(found.name);
      expect(slide.person.segment).toBe(found.segment);
      expect(slide.person.device).toEqual({
        name: found.device.name,
        viewport: found.device.viewport,
        touch: found.device.touch,
      });
      // An age only where the persona carries one — and these personas carry none, so the
      // field is absent rather than a placeholder somebody could read as a measurement.
      expect('ageYears' in slide.person).toBe(found.profile !== undefined);
      for (const trait of slide.person.traits) {
        expect(trait.value, trait.key).toBe(found.traits[trait.key]);
      }
    }
  });

  it('copies the capture, the attention and the areas off the run and the session', () => {
    for (const slide of committed.slides) {
      const session = sessionOf(slide.sessionId);
      const screen = session.screens[slide.screenIndex];
      expect(screen, `${slide.sessionId} screen ${slide.screenIndex}`).toBeDefined();
      const step = (screen as NonNullable<typeof screen>).step;

      const capture = run.screenshots.find(
        (shot) => shot.variant === session.variant && shot.step === step,
      );
      expect(slide.screenshot).toEqual({
        path: capture?.path,
        viewport: capture?.viewport,
        pageHeight: capture?.pageHeight,
      });

      expect(slide.fixations).toEqual(
        session.fixations.filter((fixation) => fixation.screenIndex === slide.screenIndex),
      );
      const drawn = new Set(slide.fixations.map((fixation) => fixation.index));
      expect(slide.saccades).toEqual(
        session.saccades.filter(
          (saccade) => drawn.has(saccade.fromFixation) && drawn.has(saccade.toFixation),
        ),
      );
      for (const click of slide.clicks) {
        expect(
          session.actions.filter(
            (action) =>
              action.type === 'click' &&
              action.tMs === click.tMs &&
              action.aoiId === click.aoiId &&
              action.target === click.target &&
              action.ok === click.ok,
          ).length,
          `${slide.sessionId}'s click on ${click.aoiId}`,
        ).toBe(1);
      }

      expect(slide.areas).toEqual(
        run.aois
          .filter((aoi) => aoi.variant === session.variant && aoi.step === step)
          .map((aoi) => {
            const row = run.aoiMetrics.find((metric) => metric.aoiId === aoi.id);
            const { aoiId, ...figures } = row as NonNullable<typeof row>;
            expect(aoiId, 'the measured row belongs to the area it is nested inside').toBe(aoi.id);
            return { ...aoi, metrics: figures };
          }),
      );
    }
  });

  it('pins the screen’s intent to its first fixation and its decision to its last', () => {
    for (const slide of committed.slides) {
      const session = sessionOf(slide.sessionId);
      const screen = session.screens[slide.screenIndex] as NonNullable<Session['screens'][number]>;
      const first = slide.fixations[0]?.index;
      const last = slide.fixations[slide.fixations.length - 1]?.index;
      expect(slide.thoughts.intent).toEqual(
        screen.intent === '' ? undefined : { text: screen.intent, fixationIndex: first },
      );
      expect(slide.thoughts.decidedAction).toEqual(
        screen.decidedAction === ''
          ? undefined
          : { text: screen.decidedAction, fixationIndex: last },
      );
    }
  });

  it('shows tech confidence, patience and whichever third trait is furthest from the middle', () => {
    for (const slide of committed.slides) {
      const session = sessionOf(slide.sessionId);
      const persona = run.personas.find((candidate) => candidate.id === session.persona?.id);
      const traits = (persona as NonNullable<typeof persona>).traits;
      const distance = (key: keyof typeof traits): number => Math.abs(traits[key] - 0.5);
      const rest = (Object.keys(traits) as (keyof typeof traits)[])
        .filter((key) => key !== 'interfaceFamiliarity' && key !== 'patience')
        .sort((a, b) => distance(b) - distance(a) || (a < b ? -1 : 1));

      expect(
        slide.person.traits.map((trait) => trait.key),
        `${slide.sessionId}'s trait rows`,
      ).toEqual(['interfaceFamiliarity', 'patience', rest[0]]);
    }
  });

  it('drops no click of the screen and borrows none from another', () => {
    for (const slide of committed.slides) {
      const session = sessionOf(slide.sessionId);
      const step = (session.screens[slide.screenIndex] as NonNullable<Session['screens'][number]>)
        .step;
      const areaIds = new Set(slide.areas.map((area) => area.id));

      // The script's own rule, restated: a click belongs to a screen of its area's step —
      // the last such screen that had already started, and the first of them for a click
      // that precedes them all. Restated rather than imported so that a change to the rule
      // has to be made twice on purpose.
      const spans = stepWalk(session).filter((span) => span.step === step);
      const placed = (tMs: number): number | undefined => {
        let found = spans[0];
        for (const span of spans) {
          if (span.startMs > tMs) break;
          found = span;
        }
        return found?.screenIndex;
      };

      expect(slide.clicks, `${slide.sessionId}'s clicks`).toEqual(
        session.actions
          .filter(
            (action) =>
              action.type === 'click' &&
              action.aoiId !== null &&
              areaIds.has(action.aoiId) &&
              placed(action.tMs) === slide.screenIndex,
          )
          .map(({ tMs, target, aoiId, value, ok }) => ({ tMs, target, aoiId, value, ok })),
      );
    }
  });

  it('copies the outcome off the session', () => {
    for (const slide of committed.slides) {
      const { status, step, reason, excludedFromScores } = sessionOf(slide.sessionId).outcome;
      expect(slide.outcome).toEqual({ status, step, reason, excludedFromScores });
    }
  });

  it('invents no value at all: every string and number is somewhere in the run', async () => {
    const known = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === 'object') {
        // The keys too: a slide names a trait by the contract's own field name
        // (`interfaceFamiliarity`), which is a name the artifact holds as a key.
        Object.keys(value).forEach(collect);
        Object.values(value).forEach(collect);
      } else known.add(JSON.stringify(value));
    };
    collect(run);
    for (const slide of committed.slides) collect(sessionOf(slide.sessionId));

    const unknown: string[] = [];
    const check = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(check);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(check);
      else if (!known.has(JSON.stringify(value))) unknown.push(JSON.stringify(value));
    };
    check(committed);
    expect(unknown).toEqual([]);
  });
});

describe('the script', () => {
  it(
    'reproduces the committed file byte for byte, and adds, changes and removes no file under runs/',
    async () => {
      const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
      const [runsRoot, output, ...triples] = documentedCommand(readme);
      expect(output, 'the documented command writes the committed file').toBe(SLIDES_FILE);

      // The two assertions share one bake because they are two questions about the same run
      // of the same command: what it wrote, and what it left alone.
      const before = await listing(RUNS_ROOT);
      const dir = await mkdtemp(join(tmpdir(), 'landing-slides-'));
      try {
        const file = join(dir, 'slides.json');
        const baked = await bake([runsRoot as string, file, ...triples]);
        expect(baked.ok, baked.output).toBe(true);
        expect(await readFile(file, 'utf8')).toBe(committedText);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      expect([...(await listing(RUNS_ROOT))].sort()).toEqual([...before].sort());
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    'refuses a missing session, a missing screen and a missing capture, by name, writing nothing',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'landing-slides-refusals-'));
      try {
        // The missing capture is tested over a copy of the run directory with one picture
        // taken out: the committed run holds every capture it names, and this suite does not
        // touch `runs/` to make one go missing.
        const copiedRoot = join(dir, 'runs');
        await cp(RUNS_ROOT, copiedRoot, { recursive: true });
        const capture = runPaths('').screenshot('A', 'review');
        await unlink(join(copiedRoot, EXAMPLE_RUN, capture));

        const cases = [
          { root: 'runs', triple: `${EXAMPLE_RUN}:S-99:0`, named: 'S-99' },
          { root: 'runs', triple: `${EXAMPLE_RUN}:S-03:99`, named: 'screens[99]' },
          { root: copiedRoot, triple: `${EXAMPLE_RUN}:S-03:2`, named: capture },
        ];

        for (const { root, triple, named } of cases) {
          const file = join(dir, `${named.replace(/\W+/g, '-')}.json`);
          const refused = await bake([root, file, triple]);
          expect(refused.ok, `${triple} is refused`).toBe(false);
          expect(refused.output).toContain(EXAMPLE_RUN);
          expect(refused.output).toContain(named);
          await expect(stat(file), 'nothing is written on a refusal').rejects.toThrow();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
