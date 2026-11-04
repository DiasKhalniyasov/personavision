/**
 * Bakes the slide data the front page's carousel reads out of committed run directories
 * (#427, from the owner's input on #1).
 *
 * The carousel shows what kind of audience PersonaVision generates and, at a glance, how
 * one person moved through a site. That has to be a **rendering of a real test** rather than
 * a page of prose about one, so the page reads a file this script produced and nothing is
 * ever typed into it by hand: one slide is one generated person on one screen of one
 * session, and every value on it is a copy of something the run artifact already holds.
 *
 * ```
 * pnpm bake:landing-slides <runs root> <output file> <runId:sessionId:screenIndex> …
 * ```
 *
 * The run is read through `@personavision/contract` — the same reader every screen uses —
 * and the script **refuses, naming the run and the field, and writes nothing** when a
 * triple names a session the run does not have, a screen index the session does not have,
 * or a screenshot the run directory does not hold. A half-baked set is worse than none: the
 * page would render a person who looked at a picture that is not there.
 *
 * Nothing under `runs/` is read for writing and no file is written inside a run directory.
 */

import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { landingSlidesSchema, readRun } from '@personavision/contract';
import { stepWalk } from '@personavision/scoring';
import type {
  LandingSlide,
  LandingSlides,
  Persona,
  Run,
  RunArtifact,
  Session,
} from '@personavision/contract';
import type { StepSpan } from '@personavision/scoring';

const COMMAND = 'pnpm bake:landing-slides';

/** One `runId:sessionId:screenIndex` argument, parsed. */
interface Triple {
  readonly runId: string;
  readonly sessionId: string;
  readonly screenIndex: number;
}

/**
 * The two traits every slide shows, whatever their values.
 *
 * The owner's input asked for "the two or three traits that drive their behaviour (tech
 * confidence, patience, price sensitivity)". Two of those three are a person's: tech
 * confidence is `interfaceFamiliarity` under the name a reader knows it by, and `patience`
 * is itself. The third is not — `personaTraitsSchema` has six traits and price sensitivity
 * is none of them; it is the **audience's** reading, so it sits once on the set instead
 * (decision 178).
 */
const ALWAYS_SHOWN = ['interfaceFamiliarity', 'patience'] as const;

/**
 * The third trait a slide shows: of the four left, the one furthest from the middle of the
 * scale, with ties broken by field name so the choice is the same on every machine.
 *
 * Furthest from 0.5 because that is the one that *drives behaviour*: a trait sitting at the
 * middle says nothing about the person, and the point of the three rows is to explain why
 * this person did something the person on the next slide did not.
 */
const thirdTrait = (traits: Persona['traits']): keyof Persona['traits'] | undefined => {
  const distance = (key: keyof Persona['traits']): number => Math.abs(traits[key] - 0.5);
  const rest = (Object.keys(traits) as (keyof Persona['traits'])[])
    .filter((key) => !(ALWAYS_SHOWN as readonly string[]).includes(key))
    .sort((a, b) => distance(b) - distance(a) || (a < b ? -1 : 1));
  return rest[0];
};

const traitsOf = (traits: Persona['traits']): LandingSlide['person']['traits'] => {
  const third = thirdTrait(traits);
  const keys = third === undefined ? ALWAYS_SHOWN : [...ALWAYS_SHOWN, third];
  return keys.map((key) => ({ key, value: traits[key] }));
};

/**
 * The screen a click belongs to.
 *
 * A session's `actions[]` carries no `screenIndex` and no coordinates — only a `tMs` and the
 * `aoiId` of what was pressed — so both questions a slide asks of a click are answered from
 * the area it landed on. **Which screen**: the area is declared for one step of one variant,
 * so the click happened on a screen of that step; where a session walked that step more than
 * once, it is the last such screen that had already started by then — and the first of them
 * for a click that precedes them all, which a click on a screen nobody looked at can, since
 * such a screen's span begins at the next screen's first fixation. **Where on the page**:
 * the area's own `bbox`, which is why a click naming no area is left out of a slide
 * altogether — it has no position anything could draw.
 *
 * Placing it by its area and not by the session clock alone is deliberate. The clock only
 * advances on fixations, so a click made on a screen nobody looked at carries a time inside
 * the *previous* screen's span, and reading the span alone would credit the press to a
 * control that is not on that screen (found by review on #291).
 */
const screenOfClick = (
  walk: readonly StepSpan[],
  step: string,
  tMs: number,
): number | undefined => {
  const candidates = walk.filter((span) => span.step === step);
  let found = candidates[0];
  for (const span of candidates) {
    if (span.startMs > tMs) break;
    found = span;
  }
  return found?.screenIndex;
};

/**
 * An area's measured row as a slide carries it: everything but `aoiId`, because the area it
 * is nested inside already carries that id and a slide states nothing twice.
 */
const figuresOf = ({
  timeToFirstFixationMs,
  firstFixationDurationMs,
  totalDwellMs,
  fixationCount,
  revisits,
  lookedAtShare,
  sessionCount,
}: Run['aoiMetrics'][number]): LandingSlide['areas'][number]['metrics'] => ({
  timeToFirstFixationMs,
  firstFixationDurationMs,
  totalDwellMs,
  fixationCount,
  revisits,
  lookedAtShare,
  sessionCount,
});

/**
 * A refusal, as an `Error` the caller throws: the run and the field, so the triple that is
 * wrong is the one named. Returned rather than thrown so that every refusal in this file is
 * a `throw` the compiler can see, and no call of it needs a `continue` behind it.
 */
const refusal = (runId: string, field: string, what: string): Error =>
  new Error(`${runId}: ${field} — ${what}`);

const parseTriple = (argument: string): Triple => {
  const parts = argument.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `"${argument}" is not a slide: a slide is \`runId:sessionId:screenIndex\`, such as 2026-10-24-1402-northwind-demo:S-03:2`,
    );
  }
  const [runId, sessionId, index] = parts as [string, string, string];
  const screenIndex = Number(index);
  if (!Number.isInteger(screenIndex) || screenIndex < 0) {
    throw new Error(`"${argument}": ${index} is not a screen index — 0, 1, 2 … in walk order`);
  }
  return { runId, sessionId, screenIndex };
};

/**
 * The one value every run of a set agrees on, or a refusal naming the two that disagree.
 *
 * A set carries its task and its audience once rather than per slide, so two runs that were
 * asked different things cannot be baked into one set: the slides would be read as a
 * comparison of people when they are a comparison of tasks.
 */
const sharedAcross = <T>(
  runs: readonly [Run, ...Run[]],
  field: string,
  read: (run: Run) => T,
): T => {
  const [first, ...rest] = runs;
  const value = read(first);
  for (const other of rest) {
    if (JSON.stringify(read(other)) !== JSON.stringify(value)) {
      throw refusal(
        other.runId,
        field,
        `a slide set carries one ${field} for every slide, and this run's ${JSON.stringify(read(other))} is not ${first.runId}'s ${JSON.stringify(value)}`,
      );
    }
  }
  return value;
};

/** One slide, built out of a run and one screen of one of its sessions. */
const slideOf = (run: Run, session: Session, screenIndex: number): LandingSlide => {
  const screen = session.screens[screenIndex];
  if (screen === undefined) {
    throw refusal(
      run.runId,
      `sessions/${session.sessionId}.json screens[${screenIndex}]`,
      `that session walked ${session.screens.length} ${session.screens.length === 1 ? 'screen' : 'screens'}, so there is no screen ${screenIndex}`,
    );
  }

  const persona = run.personas.find((candidate) => candidate.id === session.persona?.id);
  if (persona === undefined) {
    throw refusal(
      run.runId,
      `sessions/${session.sessionId}.json persona`,
      `a slide is one generated person, and this session names ${session.persona === null ? 'no persona at all' : `a persona "${session.persona.id}" the run does not carry`}`,
    );
  }

  const capture = run.screenshots.find(
    (shot) => shot.variant === session.variant && shot.step === screen.step,
  );
  if (capture === undefined) {
    throw refusal(
      run.runId,
      `screenshots[] ${session.variant} / ${screen.step}`,
      `this run records no capture of the screen ${session.sessionId}'s screen ${screenIndex} is on`,
    );
  }

  const fixations = session.fixations.filter((fixation) => fixation.screenIndex === screenIndex);
  if (fixations.length === 0) {
    throw refusal(
      run.runId,
      `sessions/${session.sessionId}.json fixations screenIndex=${screenIndex}`,
      'nobody looked at that screen, so there is no attention for a slide to draw',
    );
  }
  const drawn = new Set(fixations.map((fixation) => fixation.index));

  const areas = run.aois
    .filter((aoi) => aoi.variant === session.variant && aoi.step === screen.step)
    .map((aoi) => {
      const metrics = run.aoiMetrics.find((row) => row.aoiId === aoi.id);
      if (metrics === undefined) {
        throw refusal(
          run.runId,
          `aoiMetrics[] ${aoi.id}`,
          'every area carries its own measured row, and this one has none',
        );
      }
      return { ...aoi, metrics: figuresOf(metrics) };
    });
  const areaIds = new Set(areas.map((area) => area.id));

  const walk = stepWalk(session);
  const clicks = session.actions
    .filter((action) => action.type === 'click')
    .filter(
      (action): action is Session['actions'][number] & { aoiId: string } =>
        action.aoiId !== null && areaIds.has(action.aoiId),
    )
    .filter((action) => screenOfClick(walk, screen.step, action.tMs) === screenIndex)
    .map(({ tMs, target, aoiId, value, ok }) => ({ tMs, target, aoiId, value, ok }));

  // The pinning rule, and the whole of it: a screen's `intent` is pinned to its **first**
  // fixation and its `decidedAction` to its **last**, because those are the two moments the
  // strings are about — what the agent was looking for when it arrived, and what it did once
  // it had looked. No other claim about which fixation a sentence belongs to can be read off
  // the artifact: `screens[]` carries two strings and no times, so any finer pinning would be
  // this script's invention rather than the run's measurement.
  const [firstLook] = fixations as [
    Session['fixations'][number],
    ...Session['fixations'][number][],
  ];
  const lastLook = fixations[fixations.length - 1] ?? firstLook;
  const pin = (text: string, fixationIndex: number) =>
    text === '' ? undefined : { text, fixationIndex };
  const intent = pin(screen.intent, firstLook.index);
  const decidedAction = pin(screen.decidedAction, lastLook.index);

  return {
    runId: run.runId,
    sessionId: session.sessionId,
    screenIndex,
    person: {
      name: persona.name,
      segment: persona.segment,
      device: {
        name: persona.device.name,
        viewport: persona.device.viewport,
        touch: persona.device.touch,
      },
      ...(persona.profile === undefined ? {} : { ageYears: persona.profile.age }),
      traits: traitsOf(persona.traits),
    },
    screenshot: {
      path: capture.path,
      viewport: capture.viewport,
      pageHeight: capture.pageHeight,
    },
    fixations,
    saccades: session.saccades.filter(
      (saccade) => drawn.has(saccade.fromFixation) && drawn.has(saccade.toFixation),
    ),
    clicks,
    areas,
    thoughts: {
      ...(intent === undefined ? {} : { intent }),
      ...(decidedAction === undefined ? {} : { decidedAction }),
    },
    outcome: {
      status: session.outcome.status,
      step: session.outcome.step,
      reason: session.outcome.reason,
      excludedFromScores: session.outcome.excludedFromScores,
    },
  };
};

/**
 * The slide set the triples name, read out of the runs root and parsed before it is anything
 * a caller could write.
 */
const bakeLandingSlides = async (
  runsRoot: string,
  triples: readonly Triple[],
): Promise<LandingSlides> => {
  // Each run is read once however many of its screens are slides, in the order the triples
  // first name it — which is the order the set's `runIds` ends up in.
  const loaded = new Map<string, RunArtifact>();
  const readOnce = async (runId: string): Promise<RunArtifact> => {
    const seen = loaded.get(runId);
    if (seen !== undefined) return seen;
    const artifact = await readRun(join(runsRoot, runId));
    loaded.set(runId, artifact);
    return artifact;
  };

  const slides: LandingSlide[] = [];
  for (const { runId, sessionId, screenIndex } of triples) {
    const { run, sessions } = await readOnce(runId);
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) {
      throw refusal(
        runId,
        `sessions/${sessionId}.json`,
        `this run carries ${run.sessionIds.length} sessions and "${sessionId}" is not one of them`,
      );
    }
    const slide = slideOf(run, session, screenIndex);

    // The capture has to be on disk, not only in `run.json`: the carousel loads the file,
    // and a slide naming a picture the run directory does not hold is a broken image on the
    // front page rather than a run that measured nothing.
    const file = join(runsRoot, runId, slide.screenshot.path);
    try {
      await stat(file);
    } catch {
      throw refusal(
        runId,
        slide.screenshot.path,
        `the run directory does not hold the capture ${sessionId}'s screen ${screenIndex} is drawn on`,
      );
    }
    slides.push(slide);
  }

  const runs = [...loaded.values()].map((artifact) => artifact.run) as [Run, ...Run[]];
  const set = {
    runIds: runs.map((run) => run.runId),
    task: sharedAcross(runs, 'task', (run) => run.task.prompt),
    audience: sharedAcross(runs, 'audience', (run) => ({
      name: run.audience.name,
      priceSensitivity: run.audience.priceSensitivity,
    })),
    slides,
  };

  // Parsed here, before the caller can write it: the contract is what a slide set is, and a
  // file that does not parse has no business on disk.
  return landingSlidesSchema.parse(set);
};

/** The set as the repository formats JSON, so the committed file is `prettier --check` clean. */
const serialize = async (set: LandingSlides, file: string): Promise<string> =>
  format(JSON.stringify(set, null, 2), {
    ...(await resolveConfig(file)),
    parser: 'json',
  });

const main = async (): Promise<void> => {
  const [runsRoot, output, ...rest] = process.argv.slice(2);
  if (runsRoot === undefined || output === undefined || rest.length === 0) {
    throw new Error(
      `${COMMAND} <runs root> <output file> <runId:sessionId:screenIndex> …: which runs to read, where to write the slide set, and which screens are slides`,
    );
  }
  const set = await bakeLandingSlides(resolve(runsRoot), rest.map(parseTriple));
  await writeFile(resolve(output), await serialize(set, resolve(output)), 'utf8');
  process.stdout.write(
    `landing slides: wrote ${set.slides.length} slides from ${set.runIds.length} ${set.runIds.length === 1 ? 'run' : 'runs'} to ${resolve(output)}\n`,
  );
};

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
