/**
 * What the swarm does, proved on committed fixture pages rather than asserted.
 *
 * This is step #8's behavioural acceptance (#55). Every session here is a real one — the
 * run loop, the attention engine and the offline decision policy, over captures recorded
 * from `../fixtures/site/` — walked with every way of launching a process and every way of
 * opening a socket broken, so the suite holds the project's promise that a cold clone with
 * no API key and no network runs the whole of it.
 *
 * **Assertions are on observable session behaviour**: the element clicked, the outcome and
 * the attribution reached, the fixations behind them. Nothing here asserts a prompt string,
 * a provider's internals, or anything a designer could not read off the session.
 *
 * **Where a claim is statistical it is bounded.** A swarm is a spread, and whether a small
 * grey control is found at all is part of what the tedious fixture is for: the claims below
 * are counts over `SEED_BAND`, a fixed band of eight seeds, against tolerances written here
 * with room under what the band actually produces. Nothing in this file samples a seed,
 * reads a clock or asks the machine anything, so a count is the same on every machine.
 */

import { readRun, validate } from '@personavision/contract';
import { createOfflineDeterministicProvider } from '@personavision/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSession, runSwarm } from '../src/index.js';
import {
  BEHAVIOUR_DEVICE,
  BEHAVIOUR_TASK,
  behaviourSource,
  DOGGED,
  MISLABELLED_SCREEN_CAP,
  PAIRED_SEED,
  RUSHED,
  scenarioVariant,
  SEED_BAND,
} from './fixtures.js';
import { sweep, temporaryRunDir, withNothingRunning, writeOpenRun } from './harness.js';
import type { CaptureSource } from '@personavision/browser';
import type { Persona, Run, Session } from '@personavision/contract';

const RUN_ID = '2026-10-27-1200-behaviour';

/** A time that does not move: a reproducible session is reproducible in every field. */
const NOON = '2026-10-27T12:00:00.000Z';

/** The task's two steps, as a run declares them. */
const STEPS = BEHAVIOUR_TASK.steps.map((step) => ({ id: step.id, label: step.label }));

let runDir: string;
let source: CaptureSource;
/** Every session the suite walked, addressed by scenario, person and seed. */
const suite = new Map<string, Session>();
let walked = 0;

const key = (variant: string, persona: Persona, seed: number): string =>
  `${variant}/${persona.id}/${seed}`;

/** One session the suite walks: who, on which page, from which seed, under which cap. */
interface Planned {
  readonly variant: string;
  readonly persona: Persona;
  readonly seed: number;
  readonly maxScreens?: number;
}

/**
 * Every session of the suite, planned before any of them runs — each person on each page on
 * each seed of the band. The plan is what the reproducibility claim re-walks, so "every
 * session in the suite" is a list and not a description of one.
 */
const PLAN: readonly Planned[] = SEED_BAND.flatMap((seed) =>
  [RUSHED, DOGGED].flatMap((persona) => [
    { variant: 'tedious', persona, seed },
    { variant: 'mislabelled', persona, seed, maxScreens: MISLABELLED_SCREEN_CAP },
    { variant: 'vanishing', persona, seed },
  ]),
);

/** One session: one person, one seed, one scenario page, written into the run directory. */
const walk = (
  variant: string,
  persona: Persona,
  seed: number,
  over: { maxScreens?: number; into?: string; sessionId?: string } = {},
): Promise<Session> => {
  const { maxScreens, into, sessionId } = over;
  walked += 1;
  return runSession({
    runDir: into ?? runDir,
    runId: RUN_ID,
    sessionId: sessionId ?? `S-${String(walked).padStart(2, '0')}`,
    variant: scenarioVariant(variant),
    persona,
    seed,
    task: BEHAVIOUR_TASK,
    source,
    providers: { decision: createOfflineDeterministicProvider({ seed }) },
    startedAt: NOON,
    ...(maxScreens === undefined ? {} : { maxScreens }),
  });
};

const session = (variant: string, persona: Persona, seed: number): Session => {
  const found = suite.get(key(variant, persona, seed));
  if (found === undefined) throw new Error(`the suite walked no ${key(variant, persona, seed)}`);
  return found;
};

/** How the band ended for one person on one page, seed by seed. */
const statuses = (variant: string, persona: Persona): string[] =>
  SEED_BAND.map((seed) => session(variant, persona, seed).outcome.status);

const howMany = (variant: string, persona: Persona, status: string): number =>
  statuses(variant, persona).filter((ended) => ended === status).length;

beforeAll(async () => {
  runDir = await temporaryRunDir();
  source = await behaviourSource();

  // The whole suite, with nothing running: a session that reached for Chromium or for a
  // model fails inside this call rather than quietly succeeding on a machine with both.
  await withNothingRunning(async () => {
    for (const planned of PLAN) {
      const { variant, persona, seed, maxScreens } = planned;
      suite.set(key(variant, persona, seed), await walk(variant, persona, seed, { maxScreens }));
    }
  });
}, 120_000);

afterAll(async () => {
  await sweep(runDir);
});

describe('giving up is in character', () => {
  it('gives up where a rushed person would and finishes where a dogged one would', () => {
    const rushedGaveUp = howMany('tedious', RUSHED, 'abandoned');
    const doggedFinished = howMany('tedious', DOGGED, 'success');
    const rushedFinished = howMany('tedious', RUSHED, 'success');

    // The band produces six and six; the tolerances are five, so the claim is the
    // behaviour and not the exact scanpaths eight seeds happen to draw.
    expect(rushedGaveUp).toBeGreaterThanOrEqual(5);
    expect(doggedFinished).toBeGreaterThanOrEqual(5);
    // And the two people are not the same person: the dogged one finishes the tedious page
    // on at least three more seeds of the band than the rushed one.
    expect(doggedFinished - rushedFinished).toBeGreaterThanOrEqual(3);
    // Nothing of ours broke on any of it: giving up is the person's, not the simulation's.
    for (const persona of [RUSHED, DOGGED]) {
      expect(statuses('tedious', persona)).not.toContain('automation_failure');
    }
  });

  it('names the step and the reason on both sides of one seed', () => {
    const gaveUp = session('tedious', RUSHED, PAIRED_SEED).outcome;
    const finished = session('tedious', DOGGED, PAIRED_SEED).outcome;

    expect(gaveUp).toMatchObject({
      status: 'abandoned',
      step: 'list',
      attribution: 'product',
      excludedFromScores: false,
    });
    // Why it stopped trying, and what it had spent: the agent said so, or a budget ran out.
    expect(gaveUp.reason).toMatch(/^(Gave up|Patience spent|Persistence spent) on the "list" step/);
    expect(gaveUp.reason).toMatch(/since it last got anywhere/);

    expect(finished).toMatchObject({
      status: 'success',
      step: 'done',
      attribution: 'product',
      excludedFromScores: false,
    });
    expect(finished.reason).toContain('Completed the task on the "done" step');
  });
});

describe('an agent cannot act on what it never saw', () => {
  it('targets no element absent from the fixations of the screen it acted on', () => {
    expect(suite.size).toBeGreaterThan(0);

    for (const [addressed, walkedSession] of suite) {
      const targeted = walkedSession.actions.filter((action) => action.aoiId !== null);
      for (const action of targeted) {
        // The screen an action was decided on is the one the last fixation before it landed
        // on: the session's clock is the end of that screen's last fixation.
        const before = walkedSession.fixations.filter((fixation) => fixation.tMs <= action.tMs);
        const screenIndex = before.at(-1)?.screenIndex;
        expect(
          screenIndex,
          `${addressed}: an action at ${action.tMs}ms with no screen behind it`,
        ).toBeDefined();
        const looked = walkedSession.fixations.some(
          (fixation) => fixation.screenIndex === screenIndex && fixation.aoiId === action.aoiId,
        );
        expect(
          looked,
          `${addressed}: acted on ${action.aoiId} on screen ${String(screenIndex)}, which has no fixation on it`,
        ).toBe(true);
      }
    }
  });
});

describe('a product defect reads as the product’s', () => {
  it('ends the mislabelled page with the task not done, and counts it', () => {
    for (const seed of SEED_BAND) {
      const walkedSession = session('mislabelled', DOGGED, seed);
      expect(walkedSession.outcome, `seed ${seed}`).toMatchObject({
        status: 'failed',
        step: 'list',
        attribution: 'product',
        excludedFromScores: false,
      });
      expect(walkedSession.outcome.reason).toContain('with the task not done');
      // Nothing it clicked got it anywhere, which is the page's defect and not a cut-off
      // session: the loud control says every word of the task and does nothing, and what
      // would have advanced the step says "Gift options" and is not marked as a control at
      // all. The session ends on the suite's screen cap — `MISLABELLED_SCREEN_CAP` says why
      // — with the agent still on the step it started on.
      expect(
        walkedSession.actions
          .filter((action) => action.type === 'click')
          .every((click) => !click.ok),
        `seed ${seed}: a click got the agent somewhere on a page nothing can finish`,
      ).toBe(true);
      expect(walkedSession.screens.map((screen) => screen.step)).not.toContain('done');
      expect(walkedSession.integrity.selectorFailures).toBe(0);
    }

    // And it is a page the agent tries rather than one it only reads: seven of the eight
    // sessions click at least once, all of them for nothing. One seed spends its ten
    // screens reading, which is also what this person does.
    const tried = SEED_BAND.filter((seed) =>
      session('mislabelled', DOGGED, seed).actions.some((action) => action.type === 'click'),
    );
    expect(tried.length).toBeGreaterThanOrEqual(6);
  });

  it('is still the product’s when the rushed person leaves instead', () => {
    for (const seed of SEED_BAND) {
      const walkedSession = session('mislabelled', RUSHED, seed);
      // The same defect, read by somebody with no patience: a different status, the same
      // attribution, and counted towards the scores either way.
      expect(walkedSession.outcome, `seed ${seed}`).toMatchObject({
        status: 'abandoned',
        attribution: 'product',
        excludedFromScores: false,
      });
    }
  });
});

describe('our breakage reads as ours', () => {
  it('ends the vanishing page as an automation failure, excluded from every score', () => {
    for (const seed of SEED_BAND) {
      for (const persona of [RUSHED, DOGGED]) {
        const walkedSession = session('vanishing', persona, seed);
        expect(walkedSession.outcome, `${persona.id} on seed ${seed}`).toMatchObject({
          status: 'automation_failure',
          step: 'list',
          attribution: 'automation',
          excludedFromScores: true,
        });
        expect(walkedSession.outcome.reason).toContain('Our own browsing broke on the "list" step');
        // The driver answers a target it could not resolve rather than throwing one, so the
        // session's own integrity card has to count it.
        expect(walkedSession.integrity.selectorFailures).toBeGreaterThanOrEqual(1);
        // The screens it reached are kept: a trace is worth having even when a session is not.
        expect(walkedSession.screens.length).toBeGreaterThan(0);
        expect(walkedSession.fixations.length).toBeGreaterThan(0);
      }
    }
  });

  it('finishes the run that holds it, and writes its other sessions', async () => {
    const swarmDir = await temporaryRunDir();
    const variants: ReadonlyArray<Run['variants'][number]> = [
      { ...scenarioVariant('vanishing'), name: 'Vanishing control' },
      { ...scenarioVariant('tedious'), name: 'Tedious page' },
    ];
    const personas = [RUSHED, DOGGED];

    try {
      await writeOpenRun(swarmDir, {
        personas,
        variants,
        seedGroups: [PAIRED_SEED],
        task: { id: BEHAVIOUR_TASK.id, prompt: BEHAVIOUR_TASK.prompt },
        steps: STEPS,
        device: BEHAVIOUR_DEVICE,
        audienceId: RUSHED.audienceId,
      });

      const { sessions, run } = await withNothingRunning(() =>
        runSwarm({
          runDir: swarmDir,
          variants,
          personas,
          seedGroups: [PAIRED_SEED],
          task: BEHAVIOUR_TASK,
          source,
          providers: { decision: createOfflineDeterministicProvider({ seed: PAIRED_SEED }) },
          concurrency: 2,
          now: () => new Date(NOON),
        }),
      );

      expect(sessions).toHaveLength(4);
      const broken = sessions.filter((one) => one.variant === 'vanishing');
      expect(broken).toHaveLength(2);
      for (const one of broken) {
        expect(one.outcome).toMatchObject({
          status: 'automation_failure',
          attribution: 'automation',
          excludedFromScores: true,
        });
      }
      // The sessions the broken one was running beside are there, and they are the product's.
      const walkedOn = sessions.filter((one) => one.variant === 'tedious');
      expect(walkedOn).toHaveLength(2);
      for (const one of walkedOn) {
        expect(one.outcome.attribution).toBe('product');
        expect(one.outcome.excludedFromScores).toBe(false);
        expect(one.screens.length).toBeGreaterThan(0);
      }

      // The run finished, its own list leaves none of them out, and the directory validates.
      expect(run.status).toBe('finished');
      expect(run.sessionIds).toHaveLength(4);
      const { sessions: onDisk } = await readRun(swarmDir);
      expect(onDisk.map((one) => one.sessionId)).toEqual(run.sessionIds);
      expect(await validate(swarmDir)).toEqual([]);
    } finally {
      await sweep(swarmDir);
    }
  }, 60_000);
});

describe('a surprising session can be re-run', () => {
  it('comes back identical from its persona, seed and page', async () => {
    const again = await temporaryRunDir();

    try {
      // Every session the suite walked, not a sample of them.
      for (const { variant, persona, seed, maxScreens } of PLAN) {
        const already = session(variant, persona, seed);
        // The same session id, into a directory of its own: a re-run is the same session
        // again, not a second one, so every field of it is comparable — the trace, the
        // outcome, its reason, and the clock the session kept.
        const rerun = await withNothingRunning(() =>
          walk(variant, persona, seed, {
            maxScreens,
            into: again,
            sessionId: already.sessionId,
          }),
        );

        expect(rerun, `${variant}/${persona.id}/${seed}`).toEqual(already);
      }
    } finally {
      await sweep(again);
    }
  }, 60_000);
});
