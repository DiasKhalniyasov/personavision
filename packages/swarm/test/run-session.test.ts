/**
 * `runSession`, over the committed capture set.
 *
 * The suite starts nothing: every screen comes from the capture set `packages/browser`
 * recorded once from its fixture site, and the decisions come from the offline
 * deterministic policy, so there is no browser, no socket and no credential anywhere in it
 * — and one test holds that by hand rather than by intention. The trajectory block runs the
 * model provider over an injected fake transport and a key-shaped string that is not a key,
 * so it opens no socket either (#139).
 *
 * What it asserts is behaviour a person could check: the session parses and round-trips,
 * its fixations are numbered as one continuous sequence, one decision was asked for per
 * screen, the agent was never shown an element it had not looked at, every action it
 * decided went to the driver, and the same persona and seed produce the same session twice.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendFinishedSession, runPaths, sessionSchema, validate } from '@personavision/contract';
import { createFixtureSource, createLiveSource, toScreenshotEntries } from '@personavision/browser';
import {
  auditRunTrajectories,
  auditTrajectory,
  createOfflineDeterministicProvider,
  FREE_USAGE,
  MODEL_ID_BY_MODE,
  totalUsage,
  trajectoryPath,
} from '@personavision/provider';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideOutcome, runSession } from '../src/index.js';
import type { ActResult, Capture, CaptureSource } from '@personavision/browser';
import type { Decision } from '@personavision/provider';
import type { Session } from '@personavision/contract';
import type { Aoi } from '@personavision/engine';
import type { SessionScreen, SessionTrace } from '../src/index.js';
import {
  clicksTheLinkSaying,
  COMMITTED,
  DESKTOP,
  MOBILE,
  SPA,
  spaTask,
  TASK,
  metaProviderOverFake,
  personaWho,
  providerThat,
  recording,
  runVariant,
  sessionOver,
  sweep,
  temporaryRunDir,
  variantFor,
  watchingActs,
  writeOpenRun,
} from './harness.js';
import { CHROMIUM_INSTALLED } from '../../browser/test/helpers/chromium.js';
import { serveFixtureSite } from '../../browser/test/helpers/static-site.js';
import type { FixtureSite } from '../../browser/test/helpers/static-site.js';

/** The action types the browser driver performs; the other two are the agent's own. */
const PAGE_ACTIONS = new Set<Session['actions'][number]['type']>(['click', 'scroll', 'back']);

/** The whole of `DecisionContext` for a provider that does not read images. */
const CONTEXT_FIELDS = ['fixatedElements', 'goal', 'history', 'step', 'task', 'traits'];

/** The whole of a `FixatedElement`: what the agent took in, and what its eyes did. */
const FIXATED_ELEMENT_FIELDS = ['dwellMs', 'fixationCount', 'id', 'name', 'role', 'text'];

const readSessionFile = async (runDir: string, sessionId: string): Promise<unknown> =>
  JSON.parse(await readFile(runPaths(runDir).session(sessionId), 'utf8'));

describe('runSession', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await temporaryRunDir();
  });

  afterEach(async () => {
    await sweep(runDir);
  });

  describe('the session it produces', () => {
    it('parses against the contract and round-trips through disk unchanged', async () => {
      const session = await runSession(sessionOver(runDir));

      expect(() => sessionSchema.parse(session)).not.toThrow();
      expect(await readSessionFile(runDir, 'S-01')).toEqual(session);
    });

    it('is written at sessions/S-NN.json under the run directory', async () => {
      const session = await runSession(sessionOver(runDir, { sessionId: 'S-07' }));

      expect(session.sessionId).toBe('S-07');
      expect(runPaths(runDir).session('S-07')).toBe(`${runDir}/sessions/S-07.json`);
      expect(await readSessionFile(runDir, 'S-07')).toEqual(session);
    });

    it('records it as simulated, with the persona, the device and the seed it ran', async () => {
      const persona = personaWho('careful', DESKTOP);

      const session = await runSession(
        sessionOver(runDir, { persona, seed: 3, variant: variantFor('B') }),
      );

      expect(session).toMatchObject({
        kind: 'simulated',
        runId: '2026-10-27-1200-fixture',
        variant: 'B',
        taskId: TASK.id,
        seed: 3,
        participant: null,
        persona: { id: persona.id, traits: persona.traits, device: DESKTOP },
      });
      // The whole of a persona is not a session's business: a name, an audience and a
      // segment belong to `run.json`'s `personas`, and the session names the person by id.
      expect(Object.keys(session.persona ?? {}).sort()).toEqual(['device', 'id', 'traits']);
    });
  });

  describe('the fixations', () => {
    it('numbers them continuously across the session, not restarted per screen', async () => {
      const session = await runSession(sessionOver(runDir));

      expect(session.screens.length).toBeGreaterThan(1);
      expect(session.fixations.map((fixation) => fixation.index)).toEqual(
        session.fixations.map((_, position) => position),
      );
      // More than one screen contributed, and no screen started its numbering again.
      const screens = new Set(session.fixations.map((fixation) => fixation.screenIndex));
      expect(screens.size).toBe(session.screens.length);
    });

    it('orders by index, so no consumer has to sort by timestamp', async () => {
      const session = await runSession(sessionOver(runDir));

      const times = session.fixations.map((fixation) => fixation.tMs);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      const screenIndexes = session.fixations.map((fixation) => fixation.screenIndex);
      expect(screenIndexes).toEqual([...screenIndexes].sort((a, b) => a - b));
    });

    it('carries saccades that point inside the session it belongs to', async () => {
      const session = await runSession(sessionOver(runDir));

      expect(session.saccades.length).toBeGreaterThan(0);
      for (const saccade of session.saccades) {
        expect(saccade.fromFixation).toBeLessThan(session.fixations.length);
        expect(saccade.toFixation).toBeLessThan(session.fixations.length);
      }
    });
  });

  describe('the screens', () => {
    it('each carry their step, the agent’s stated intent and its decided action', async () => {
      const session = await runSession(sessionOver(runDir));

      const declared = new Set(TASK.steps.map((step) => step.id));
      session.screens.forEach((screen, position) => {
        expect(screen.index).toBe(position);
        expect(declared.has(screen.step)).toBe(true);
        expect(screen.intent.trim()).not.toBe('');
        expect(screen.decidedAction.trim()).not.toBe('');
        expect(screen.screenshot).toBe(runPaths('').screenshot(session.variant, screen.step));
      });
    });
  });

  describe('the decisions', () => {
    it('asks for exactly one per screen across a multi-screen walk', async () => {
      const watched = recording(createOfflineDeterministicProvider({ seed: 11 }));

      const session = await runSession(
        sessionOver(runDir, { providers: { decision: watched.provider } }),
      );

      expect(session.screens.length).toBeGreaterThan(3);
      expect(watched.contexts).toHaveLength(session.screens.length);
      expect(watched.contexts.map((context) => context.step.index)).toEqual(
        session.screens.map((screen) => screen.index),
      );
      expect(watched.contexts.map((context) => context.step.id)).toEqual(
        session.screens.map((screen) => screen.step),
      );
    });

    it('hands over only the elements the agent fixated on that screen', async () => {
      const watched = recording(createOfflineDeterministicProvider({ seed: 11 }));
      const built: SessionScreen[] = [];

      const session = await runSession(
        sessionOver(runDir, {
          providers: { decision: watched.provider },
          onScreen: (screen) => built.push(screen),
        }),
      );

      let unfixatedSeen = 0;
      watched.contexts.forEach((context, index) => {
        const looked = new Set(
          session.fixations
            .filter((fixation) => fixation.screenIndex === index)
            .map((fixation) => fixation.aoiId),
        );
        const offered = new Set(context.fixatedElements.map((element) => element.id));
        expect([...offered].sort()).toEqual([...looked].sort());

        // The test has teeth only if the screen held areas the agent never looked at.
        const unfixated = (built[index]?.aois ?? []).filter((aoi: Aoi) => !looked.has(aoi.id));
        unfixatedSeen += unfixated.length;
        for (const aoi of unfixated) expect(offered.has(aoi.id)).toBe(false);
      });
      expect(unfixatedSeen).toBeGreaterThan(0);
    });

    it('tells the agent nothing but its goal, traits, step, looks and history', async () => {
      const watched = recording(createOfflineDeterministicProvider({ seed: 11 }));

      await runSession(sessionOver(runDir, { providers: { decision: watched.provider } }));

      for (const context of watched.contexts) {
        expect(Object.keys(context).sort()).toEqual(CONTEXT_FIELDS);
        for (const element of context.fixatedElements) {
          expect(Object.keys(element).sort().join(',')).toMatch(
            new RegExp(
              `^${FIXATED_ELEMENT_FIELDS.filter((field) => field !== 'name').join(',')}$|^${FIXATED_ELEMENT_FIELDS.join(',')}$`,
            ),
          );
        }
      }
    });

    it('grows the agent’s history one action at a time, and never ahead of itself', async () => {
      const watched = recording(createOfflineDeterministicProvider({ seed: 11 }));

      const session = await runSession(
        sessionOver(runDir, { providers: { decision: watched.provider } }),
      );

      // One action per screen behind it, and never the one it is about to take: a context
      // that grew with the session would let a provider read its own future.
      expect(watched.contexts.map((context) => context.history.length)).toEqual(
        watched.contexts.map((_, position) => position),
      );
      // One action per screen, bar the one the walk ended on when that was the task's last
      // step: there the agent is still asked what it makes of the screen, and nothing is done
      // to it, because the task declares no step after it to walk to.
      const endedOnTheLastStep = session.screens.at(-1)?.step === TASK.steps.at(-1)?.id;
      expect(session.actions).toHaveLength(session.screens.length - (endedOnTheLastStep ? 1 : 0));
    });

    it('ends the session as our own breakage when a decision names an element nobody looked at', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          providers: {
            decision: providerThat(() => ({
              intent: 'Clicking something that was never on this screen.',
              action: { kind: 'click', targetElementId: 'not-an-area-of-this-screen' },
              usage: FREE_USAGE,
            })),
          },
        }),
      );

      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      // The screen it broke on is kept: a trace is worth having even when a session is not.
      expect(session.screens).toHaveLength(1);
      expect(session.actions).toEqual([]);
    });
  });

  describe('a decision layer that does not hold up its end', () => {
    it('writes the session when the provider throws, keeping what it had collected', async () => {
      let asked = 0;

      const session = await runSession(
        sessionOver(runDir, {
          providers: {
            decision: providerThat(() => {
              asked += 1;
              if (asked > 2) throw new Error('the model answered 429');
              return {
                intent: 'Looking further down.',
                action: { kind: 'scroll', targetElementId: null },
                usage: FREE_USAGE,
              };
            }),
          },
        }),
      );

      // The screens, fixations and actions it had already collected are on disk, not lost.
      expect(session.screens).toHaveLength(3);
      expect(session.fixations.length).toBeGreaterThan(0);
      expect(await readSessionFile(runDir, 'S-01')).toEqual(session);
      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      expect(session.outcome.reason).toContain('429');
      // The screen it never got an answer for says so rather than quoting words nobody said.
      expect(session.screens.at(-1)).toMatchObject({ intent: '' });
      expect(session.screens.at(-1)?.decidedAction.trim()).not.toBe('');
    });

    it('writes the session when a decision carries an action kind outside the six', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          providers: {
            decision: providerThat(
              () =>
                ({
                  intent: 'Teleporting to the end.',
                  action: { kind: 'teleport', targetElementId: null },
                  usage: FREE_USAGE,
                }) as unknown as Decision,
            ),
          },
        }),
      );

      expect(() => sessionSchema.parse(session)).not.toThrow();
      expect(await readSessionFile(runDir, 'S-01')).toEqual(session);
      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      // The agent's own words are kept; what it decided is not quoted, because nothing it
      // decided was a thing this session could do.
      expect(session.screens.at(-1)).toMatchObject({ intent: 'Teleporting to the end.' });
    });
  });

  describe('the actions', () => {
    it('executes every one it decides through the driver, and records whether it worked', async () => {
      const watched = watchingActs(createFixtureSource(COMMITTED));

      // A seed on which the careful person fumbles once before finishing, so that both
      // answers are in one session: since #78 gave the task's steps their own goals the
      // walk is no longer a scramble, and most seeds now produce a session in which
      // everything the agent tried worked.
      const session = await runSession(sessionOver(runDir, { source: watched.source, seed: 1 }));

      const onThePage = session.actions.filter((action) => PAGE_ACTIONS.has(action.type));
      expect(watched.acts).toHaveLength(onThePage.length);
      expect(onThePage.length).toBeGreaterThan(0);
      // Both answers are recorded: a click that advanced, and one the page did nothing with.
      expect(onThePage.some((action) => action.ok)).toBe(true);
      expect(onThePage.some((action) => !action.ok)).toBe(true);
    });

    it('aims a click at the element behind the area the agent chose', async () => {
      const watched = watchingActs(createFixtureSource(COMMITTED));
      const built: SessionScreen[] = [];

      await runSession(
        sessionOver(runDir, { source: watched.source, onScreen: (screen) => built.push(screen) }),
      );

      const clicks = watched.acts.filter((action) => action.type === 'click');
      expect(clicks.length).toBeGreaterThan(0);
      const captured: Capture[] = built.map((screen) => screen.capture);
      for (const click of clicks) {
        expect(
          captured.some((capture) =>
            capture.elements.some((element) => element.id === click.elementId),
          ),
        ).toBe(true);
      }
    });

    it('records an action the driver refuses as our breakage, keeping the screens before it', async () => {
      const refusing: CaptureSource = {
        ...createFixtureSource(COMMITTED),
        act: async (): Promise<ActResult> => ({
          ok: false,
          action: { type: 'click' },
          url: 'https://fixture.test/cart.html',
          scrollY: 0,
          step: 'cart',
          failure: 'selector_not_found',
        }),
      };

      const session = await runSession(
        sessionOver(runDir, {
          source: refusing,
          providers: {
            decision: providerThat((context) => ({
              intent: 'Clicking the first thing I looked at.',
              action: { kind: 'click', targetElementId: context.fixatedElements[0]?.id ?? null },
              usage: FREE_USAGE,
            })),
          },
          // One attempt: the element is missing and it will be missing again.
          maxScreens: 4,
        }),
      );

      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        step: 'cart',
        attribution: 'automation',
        excludedFromScores: true,
      });
      expect(session.screens).toHaveLength(1);
      expect(session.actions.at(-1)).toMatchObject({ type: 'click', ok: false });
      // The driver answers a target it could not resolve rather than throwing one, so the
      // budget never counts it: the integrity card would otherwise read "every action
      // resolved" on the session a selector failure ended.
      expect(session.integrity.selectorFailures).toBe(1);
    });

    it('carries on past a click on an area with no control under it', async () => {
      const REGION = 'a-region-nobody-could-name';
      const session = await runSession(
        sessionOver(runDir, {
          // A segmented region: the agent can look at it, and the DOM explains no element
          // beneath it for a click to land on.
          segmenter: {
            segment: () => [
              {
                id: REGION,
                label: 'A region nobody could name',
                role: null,
                bbox: { x: 1, y: 1, width: 301, height: 301 },
              },
            ],
          },
          providers: {
            decision: providerThat((context) =>
              context.fixatedElements.some((element) => element.id === REGION)
                ? {
                    intent: 'Trying the part of the page I cannot name.',
                    action: { kind: 'click', targetElementId: REGION },
                    usage: FREE_USAGE,
                  }
                : {
                    intent: 'Looking further down.',
                    action: { kind: 'scroll', targetElementId: null },
                    usage: FREE_USAGE,
                  },
            ),
          },
          maxScreens: 6,
        }),
      );

      const onTheRegion = session.actions.filter((action) => action.aoiId === REGION);
      expect(onTheRegion.length).toBeGreaterThan(0);
      // Nothing happened, which is the page's answer and not our breakage: a run that
      // segments must not lose every session in which a persona looked hardest at a region.
      expect(onTheRegion.every((action) => !action.ok)).toBe(true);
      expect(session.outcome.status).not.toBe('automation_failure');
      expect(session.outcome.attribution).toBe('product');
      expect(session.screens.length).toBeGreaterThan(onTheRegion.length);
    });
  });

  describe('a back the driver refuses', () => {
    /**
     * A source that reports what this rule reads and nothing else: a click lands on the
     * next step, and a back never works. The capture set replays one recorded walk, so the
     * two answers are stubbed rather than driven — the rule turns on what `act` reports.
     */
    const backNeverWorks = (clicksAdvance: boolean): CaptureSource => ({
      ...createFixtureSource(COMMITTED),
      act: async (_page, action): Promise<ActResult> =>
        action.type === 'back'
          ? {
              ok: false,
              action,
              url: 'https://fixture.test/cart.html',
              scrollY: 0,
              step: 'cart',
              failure: 'navigation_error',
            }
          : {
              ok: true,
              action,
              url: 'https://fixture.test/payment.html',
              scrollY: 0,
              step: clicksAdvance ? 'payment' : 'cart',
            },
    });

    /** Clicks once if it can, then presses Back for the rest of the session. */
    const clicksThenGoesBack = (): ReturnType<typeof providerThat> => {
      let clicked = false;
      return providerThat((context) => {
        const target = context.fixatedElements[0];
        if (!clicked && target !== undefined) {
          clicked = true;
          return {
            intent: 'Getting on with it.',
            action: { kind: 'click' as const, targetElementId: target.id },
            usage: FREE_USAGE,
          };
        }
        return {
          intent: 'That was not it — back.',
          action: { kind: 'backtrack' as const, targetElementId: null },
          usage: FREE_USAGE,
        };
      });
    };

    it('is the agent leaving when there is nothing behind the screen it started on', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          source: backNeverWorks(false),
          providers: {
            decision: providerThat(() => ({
              intent: 'This is not where I meant to be.',
              action: { kind: 'backtrack', targetElementId: null },
              usage: FREE_USAGE,
            })),
          },
          maxScreens: 4,
        }),
      );

      expect(session.actions.every((action) => action.type === 'back' && !action.ok)).toBe(true);
      expect(session.outcome.status).not.toBe('automation_failure');
      expect(session.outcome.attribution).toBe('product');
      expect(session.outcome.excludedFromScores).toBe(false);
    });

    it('is our breakage once the session has somewhere behind it to go', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          source: backNeverWorks(true),
          providers: { decision: clicksThenGoesBack() },
          maxScreens: 4,
        }),
      );

      expect(session.actions.map((action) => action.type)).toEqual(['click', 'back']);
      expect(session.outcome).toMatchObject({
        status: 'automation_failure',
        attribution: 'automation',
        excludedFromScores: true,
      });
      expect(session.outcome.reason).toContain('navigation_error');
    });
  });

  describe('the outcome', () => {
    it('is the one decideOutcome returns, unmodified', async () => {
      const built: SessionScreen[] = [];

      const session = await runSession(
        sessionOver(runDir, { onScreen: (screen) => built.push(screen) }),
      );

      const trace: SessionTrace = {
        screens: session.screens.map((screen) => ({ index: screen.index, step: screen.step })),
        fixations: session.fixations,
        actions: session.actions.map((action) => ({
          tMs: action.tMs,
          type: action.type,
          aoiId: action.aoiId,
          ok: action.ok,
        })),
        durationMs: session.durationMs,
        taskCompleted: session.screens.at(-1)?.step === TASK.steps.at(-1)?.id,
        primaryActionAoiId: built.at(-1)?.aois.find((aoi: Aoi) => aoi.isPrimaryAction)?.id ?? null,
        automationFailure: null,
        // This walk ends at the task's last step and not at its cap, so nothing stopped it:
        // a session the budget had stopped would carry the figure here, and the two outcomes
        // would disagree if it did and this trace said otherwise (#413).
        stoppedOnBudget: null,
        wallClockBudgetMs: null,
      };

      expect(session.outcome).toEqual(decideOutcome(trace, personaWho('careful')));
    });

    it('lets the agent give up in character rather than at a cap', async () => {
      // Seed 2 of the band: the rushed person misses the small grey control on the cart and
      // spends its patience looking. On most seeds it now finds it and finishes, which is
      // what a step goal buys the agent (#78) — giving up is in character, not inevitable.
      const rushed = await runSession(
        sessionOver(runDir, { persona: personaWho('rushed'), seed: 2, sessionId: 'S-02' }),
      );

      expect(rushed.outcome.status).toBe('abandoned');
      expect(rushed.outcome.attribution).toBe('product');
      expect(rushed.outcome.excludedFromScores).toBe(false);
      // It stopped well inside the cap: the budget that ran out was the persona's.
      expect(rushed.screens.length).toBeLessThan(8 * TASK.steps.length);
    });

    it('says the budget stopped it rather than calling it an abandonment', async () => {
      // An agent that only ever reads further down: it never gets to the task's last step,
      // and nothing of its own ends the walk — so the cap is what ends it, three screens in.
      const scrolling = providerThat(() => ({
        intent: 'Reading further down before I decide.',
        action: { kind: 'scroll', targetElementId: null },
        usage: FREE_USAGE,
      }));

      const session = await runSession(
        sessionOver(runDir, {
          persona: personaWho('rushed'),
          providers: { decision: scrolling },
          maxScreens: 3,
        }),
      );

      expect(session.screens).toHaveLength(3);
      // The dwell and the fruitless scrolls of its last screens are ours and not the
      // person's: we took the screens away, so this is never written up as giving up.
      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.status).not.toBe('abandoned');
      expect(session.outcome.reason).toContain(
        'The session was stopped after its 3 actions on the "cart" step with the task not done',
      );
      expect(session.outcome).toMatchObject({ attribution: 'product', excludedFromScores: false });
    });

    it('walks the four-step task to its end when the persona sees it through', async () => {
      const session = await runSession(
        sessionOver(runDir, { persona: personaWho('careful'), seed: 1 }),
      );

      expect(session.screens.map((screen) => screen.step)).toContain('confirmation');
      expect(session.outcome.status).toBe('success');
      expect(session.outcome.step).toBe('confirmation');
    });
  });

  describe('the criterion the run was given', () => {
    /**
     * The fixture site's own four screens, and a criterion only the last of them shows: the
     * confirmation page names an image *A printed receipt*, and no page before it says either
     * word, so this criterion needs the clicks that get there before it becomes true.
     */
    const NEEDS_A_CLICK = 'A printed receipt is visible.';

    /** And one the cart satisfies the moment it loads, which is the defect being removed. */
    const TRUE_ON_LANDING = 'The cart is visible.';

    /** A criterion `readCriterion` refuses: nothing a session captures can answer it. */
    const A_FEELING = 'The page feels trustworthy.';

    /** An agent that looks and operates nothing: no click, no scroll, no keystroke. */
    const hesitating = providerThat(() => ({
      intent: 'I will take this in before doing anything.',
      action: { kind: 'hesitate', targetElementId: null },
      usage: FREE_USAGE,
    }));

    it('fails a session that lands where the criterion is not met and never acts', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          task: { ...TASK, successCriterion: NEEDS_A_CLICK },
          providers: { decision: hesitating },
          maxScreens: 1,
        }),
      );

      expect(session.screens.map((screen) => screen.step)).toStrictEqual(['cart']);
      expect(session.actions.filter((action) => action.type === 'click')).toStrictEqual([]);
      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.status).not.toBe('success');
      expect(session.outcome.step).toBe('cart');
      // The reason names the criterion it looked for, the words it did not find and the step.
      expect(session.outcome.reason).toContain(
        `the criterion “${NEEDS_A_CLICK}” was never observed`,
      );
      expect(session.outcome.reason).toContain('"cart" step');
      expect(session.outcome).toMatchObject({ attribution: 'product', excludedFromScores: false });
    });

    it('succeeds the same session once the clicks have revealed it', async () => {
      const session = await runSession(
        sessionOver(runDir, {
          task: { ...TASK, successCriterion: NEEDS_A_CLICK },
          persona: personaWho('careful'),
          seed: 1,
        }),
      );

      expect(session.screens.map((screen) => screen.step)).toContain('confirmation');
      expect(session.actions.some((action) => action.type === 'click' && action.ok)).toBe(true);
      expect(session.outcome.status).toBe('success');
      expect(session.outcome.step).toBe('confirmation');
      expect(session.outcome.reason).toContain(`the criterion “${NEEDS_A_CLICK}” was observed`);
    });

    it('fails a session whose criterion was already true on landing and acted on nothing', async () => {
      // The one-URL run this exists for: the criterion holds the moment the page loads, so
      // the walk ends with the agent having done nothing. A success here would be a
      // completion rate counting pages that rendered.
      const session = await runSession(
        sessionOver(runDir, { task: { ...TASK, successCriterion: TRUE_ON_LANDING } }),
      );

      expect(session.actions).toStrictEqual([]);
      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.status).not.toBe('success');
      expect(session.outcome.reason).toContain('was already true when the agent arrived');
      expect(session.outcome.reason).toContain('nothing was acted on');
    });

    it('fails a criterion it cannot evaluate rather than falling back to the step', async () => {
      // A one-step task is the shape a one-URL run derives, and its only step matches the
      // moment the page loads: before #400 that made every such session a success.
      const session = await runSession(
        sessionOver(runDir, {
          task: {
            ...TASK,
            steps: [TASK.steps[0] as (typeof TASK.steps)[number]],
            successCriterion: A_FEELING,
          },
          providers: { decision: hesitating },
          maxScreens: 1,
        }),
      );

      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.status).not.toBe('success');
      expect(session.outcome.reason).toContain('the criterion could not be observed');
      expect(session.outcome.reason).toContain('is a judgement');
      expect(session.outcome).toMatchObject({ attribution: 'product', excludedFromScores: false });
    });

    it('still ends a declared multi-step walk at its last step', async () => {
      // A declared task says where its end is, and that does not change because a goal was
      // given: the criterion decides whether the session *succeeded*, not how far it walks.
      // Walking on would drive the session onto a page the task recognises as no step, which
      // this loop can only record as our own breakage — turning a product failure into an
      // automation failure that no score counts.
      const session = await runSession(
        sessionOver(runDir, {
          task: { ...TASK, successCriterion: 'A tractor icon is visible.' },
          persona: personaWho('careful'),
          seed: 1,
        }),
      );

      expect(session.screens.at(-1)?.step).toBe('confirmation');
      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.status).not.toBe('automation_failure');
      expect(session.outcome.attribution).toBe('product');
      expect(session.outcome.excludedFromScores).toBe(false);
      expect(session.outcome.reason).toContain('was never observed');
    });

    it('leaves a run with no goal decided by the step it reached', async () => {
      // The same walk, with and without a criterion: a `--steps` run, the committed example
      // and the demo carry no goal and keep the rule they have.
      const withNoGoal = await runSession(
        sessionOver(runDir, { persona: personaWho('careful'), seed: 1 }),
      );
      const withGoal = await runSession(
        sessionOver(runDir, {
          task: { ...TASK, successCriterion: NEEDS_A_CLICK },
          persona: personaWho('careful'),
          seed: 1,
          sessionId: 'S-02',
        }),
      );

      expect(withNoGoal.outcome.status).toBe('success');
      expect(withNoGoal.outcome.reason).toContain('Completed the task on the "confirmation" step.');
      expect(withNoGoal.outcome.reason).not.toContain('criterion');
      // The two agree on the walk — the same screens, the same actions — and differ only in
      // what the reason says the session was judged by.
      expect(withGoal.screens).toStrictEqual(withNoGoal.screens);
      expect(withGoal.actions).toStrictEqual(withNoGoal.actions);
      expect(withGoal.outcome.reason).toContain('criterion');
    });
  });

  describe('reproducibility', () => {
    it('produces an identical session from the same persona, seed and page', async () => {
      const first = await runSession(sessionOver(runDir));
      const second = await runSession(sessionOver(runDir));

      expect(second).toEqual(first);
    });

    it('produces a different session from a different seed', async () => {
      const first = await runSession(sessionOver(runDir, { seed: 11 }));
      const second = await runSession(
        sessionOver(runDir, {
          seed: 12,
          providers: { decision: createOfflineDeterministicProvider({ seed: 12 }) },
        }),
      );

      expect(second.fixations).not.toEqual(first.fixations);
      expect(second.seed).not.toBe(first.seed);
    });

    it('produces a different session on the other variant’s device', async () => {
      const mobile = await runSession(
        sessionOver(runDir, { persona: personaWho('careful', MOBILE) }),
      );
      const desktop = await runSession(
        sessionOver(runDir, {
          variant: variantFor('B'),
          persona: personaWho('careful', DESKTOP),
          sessionId: 'S-02',
        }),
      );

      expect(desktop.fixations).not.toEqual(mobile.fixations);
    });
  });

  describe('the trajectory it writes', () => {
    it('writes trajectories/S-NN.jsonl for a model-mode session, interleaved and parseable', async () => {
      const session = await runSession(
        sessionOver(runDir, { providers: { decision: metaProviderOverFake() } }),
      );

      const path = trajectoryPath(runDir, session.sessionId);
      const lines = (await readFile(path, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { kind: string; turn: number; modelId: string });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.filter((line) => line.kind === 'request')).toHaveLength(session.screens.length);
      expect(lines.map((line) => line.kind)).toEqual(
        session.screens.flatMap(() => ['request', 'response']),
      );
      expect(new Set(lines.map((line) => line.modelId))).toEqual(
        new Set([MODEL_ID_BY_MODE.contributor]),
      );
      // Written as they happened: the turns climb, and each turn's request precedes its answer.
      expect(lines.map((line) => line.turn)).toEqual(
        session.screens.flatMap((_screen, index) => [index + 1, index + 1]),
      );
    });

    it('audits to the usage its decisions reported', async () => {
      const screens: SessionScreen[] = [];
      const session = await runSession(
        sessionOver(runDir, {
          providers: { decision: metaProviderOverFake() },
          onScreen: (screen) => void screens.push(screen),
        }),
      );

      const audit = await auditTrajectory({ runDir, sessionId: session.sessionId });

      expect(audit.recorded).toBe(true);
      expect(audit.turns).toHaveLength(session.screens.length);
      expect(audit.totals).toEqual(
        totalUsage(
          screens
            .map((screen) => screen.decision)
            .filter((decision): decision is Decision => decision !== null)
            .map((decision) => decision.usage),
        ),
      );
    });

    it('writes none at all for an offline session, and the audit says so', async () => {
      const session = await runSession(sessionOver(runDir));

      expect(await readdir(runDir)).not.toContain('trajectories');
      expect(await auditRunTrajectories(runDir)).toEqual([]);
      expect(await auditTrajectory({ runDir, sessionId: session.sessionId })).toMatchObject({
        recorded: false,
        turns: [],
      });
    });

    it('leaves the run directory valid, and writes nothing but the run directory', async () => {
      const screens: SessionScreen[] = [];
      await writeOpenRun(runDir, {
        personas: [personaWho('careful')],
        variants: [runVariant('A')],
        seedGroups: [11],
        engine: {
          mode: 'model',
          provider: 'meta-model-api',
          modelMode: 'contributor',
          models: {
            decision: MODEL_ID_BY_MODE.contributor,
            segmentation: 'none',
            planning: 'none',
          },
          weights: { alpha: 1, beta: 1, gamma: 1 },
          version: 'test',
        },
      });
      const session = await runSession(
        sessionOver(runDir, {
          providers: { decision: metaProviderOverFake() },
          onScreen: (screen) => void screens.push(screen),
        }),
      );
      // The run has to declare the areas its session's actions name, exactly as `runSwarm`
      // declares them when it appends a finished session.
      await appendFinishedSession(runDir, session, {
        aois: screens.flatMap((screen) => screen.aois),
        screenshots: toScreenshotEntries(screens.map((screen) => screen.capture)),
      });

      expect(await validate(runDir)).toEqual([]);
      // Everything the session wrote, and nothing else: the trajectory is a directory of the
      // run and not a cache somewhere else on the machine.
      expect((await readdir(runDir)).sort()).toEqual([
        'findings.json',
        'run.json',
        'screenshots',
        'sessions',
        'trajectories',
      ]);
      expect(await readdir(join(runDir, 'trajectories'))).toEqual([`${session.sessionId}.jsonl`]);
    });
  });
});

/** See `packages/browser/test/geometry.test.ts`: without the browser, skipped; CI is not. */
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** One live session is a browser launch, a few captures and a model-shaped decision each. */
const LIVE_TIMEOUT_MS = 60_000;

/**
 * A live session of a single-page application, where the address is the only thing that
 * moves (#441) — the owner's own run, as a fixture.
 *
 * Five sessions over `http://127.0.0.1:5176/` with the criterion *"The address bar reads
 * /signup."*: two clicked a react-router `<Link to="/signup">`, arrived on the sign-up view
 * — the next screen's intent quoted words only that view has — and were recorded
 * `abandoned` with the criterion never observed. A third did exactly the same thing and was
 * a success. The criterion was read against an address nothing ever re-read: the walk kept
 * one, set from the variant and replaced only by what an action reported, and a same-document
 * navigation makes no request for an action's wait to see. On a one-URL run the derived step
 * matched both views and the scroll position did not move either, so nothing in the session
 * contradicted it.
 *
 * The pages are `packages/browser/test/fixtures/spa/`, which pushes its address 50 ms after
 * the click — long after the click's own promise — for exactly that reason.
 */
describeWithChromium('a live session of a single-page application', () => {
  /** The criterion the owner's run was given, word for word. */
  const READS_SIGNUP = 'The address bar reads /signup.';

  /** The control that moves the address, as the owner's own site words it. */
  const SIGN_UP = 'Sign up to try it on your project';

  /** And the one that moves it to a path which *extends* the one the criterion asks for. */
  const NOT_NOW = 'Not now';

  let site: FixtureSite;
  let runDir: string;

  beforeAll(async () => {
    site = await serveFixtureSite({ root: SPA });
  });

  afterAll(async () => {
    await site.close();
  });

  beforeEach(async () => {
    runDir = await temporaryRunDir();
  });

  afterEach(async () => {
    await sweep(runDir);
  });

  /** One live session over this application, opened at a path of it. */
  const walk = (
    over: Partial<Parameters<typeof sessionOver>[1]> & { readonly at?: string } = {},
  ): Promise<Session> => {
    const { at, ...rest } = over;
    return runSession(
      sessionOver(runDir, {
        source: createLiveSource(),
        variant: { id: 'A', url: `${site.url}${at ?? '/app.html'}` },
        task: spaTask(READS_SIGNUP),
        providers: { decision: clicksTheLinkSaying(SIGN_UP) },
        ...rest,
      }),
    );
  };

  it(
    'succeeds on the view a client-side navigation reached, and records where it was',
    async () => {
      const session = await walk();

      expect(session.outcome.status).toBe('success');
      expect(session.outcome.reason).toContain(`the criterion “${READS_SIGNUP}” was observed`);

      // The one action of this session is a click recorded as having got the agent somewhere,
      // which is what the give-up budgets read (#442). `decideOutcome` charges a fruitless
      // action to patience and to persistence and resets both on an `ok` click — `outcome.ts`'s
      // `PROGRESS_ACTIONS` — so recorded `ok: false`, which is what not reading the address
      // left it, the one action of the owner's session that worked was spending the patience of
      // an agent that was in fact making progress.
      const clicks = session.actions.filter((action) => action.type === 'click');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]?.ok).toBe(true);

      // The screen captured after the click is on the address the click pushed, and the
      // application loaded no document to get there.
      expect(session.screens.map((screen) => screen.url)).toStrictEqual([
        `${site.url}/app.html`,
        `${site.url}/signup`,
      ]);
      // And the rest of the screen is held still: the same step, the same scroll position.
      // The address is the only thing that moved, which is the whole of what this walk had
      // to notice and the whole of what it used to miss.
      expect(session.screens.map((screen) => screen.step)).toStrictEqual(['page', 'page']);
      expect(session.screens.map((screen) => screen.scrollY)).toStrictEqual([0, 0]);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'succeeds where the click was on the last screen the cap allows',
    async () => {
      const session = await walk({ maxScreens: 1 });

      // One screen, captured before the click, so no captured screen was ever at /signup:
      // the criterion is read against the address the action reached and not only against a
      // screen that is never captured.
      expect(session.screens).toHaveLength(1);
      expect(session.screens[0]?.url).toBe(`${site.url}/app.html`);
      expect(session.actions.some((action) => action.type === 'click' && action.ok)).toBe(true);
      expect(session.outcome.status).toBe('success');
      expect(session.outcome.reason).toContain(`the criterion “${READS_SIGNUP}” was observed`);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'succeeds where the agent gave up on the turn after the click',
    async () => {
      const session = await walk({
        providers: { decision: clicksTheLinkSaying(SIGN_UP, 'abandon') },
      });

      // Observed is observed. `docs/FLOW.md` section 8's order of outcomes is untouched: a
      // give-up after the task was done is not a give-up on the task (`findGiveUp`).
      expect(session.actions.map((action) => action.type)).toStrictEqual(['click', 'abandon']);
      expect(session.screens.at(-1)?.url).toBe(`${site.url}/signup`);
      expect(session.outcome.status).toBe('success');
      expect(session.outcome.status).not.toBe('abandoned');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'reads the criterion at an address the page moved itself to, with nobody acting',
    async () => {
      // The application pushes `/signup` as its document is parsed, so the session lands on
      // a page that is already somewhere else. No action reported that move and no action
      // ever could: this is the navigation only a capture that asks the page where it is
      // can see.
      const session = await walk({ at: '/app.html?move=/signup', maxScreens: 1 });

      expect(session.screens[0]?.url).toBe(`${site.url}/signup`);
      // Observed, and still not a success: nothing was tested, because nothing was acted on.
      // That rule is #400's and is not loosened here.
      expect(session.actions).toStrictEqual([]);
      expect(session.outcome.status).toBe('failed');
      expect(session.outcome.reason).toContain('was already true when the agent arrived');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'does not observe a criterion on a path that extends the one it asks for',
    async () => {
      const session = await walk({
        providers: { decision: clicksTheLinkSaying(NOT_NOW) },
        maxScreens: 2,
      });

      expect(session.screens.map((screen) => screen.url)).toStrictEqual([
        `${site.url}/app.html`,
        `${site.url}/signup-cancelled`,
      ]);
      expect(session.outcome.status).not.toBe('success');
      expect(session.outcome.reason).toContain('was never observed');
      expect(session.outcome.reason).toContain('no “/signup”');
    },
    LIVE_TIMEOUT_MS,
  );
});
