/**
 * `runSession`, over the committed capture set.
 *
 * The suite starts nothing: every screen comes from the capture set `packages/browser`
 * recorded once from its fixture site, and the decisions come from the offline
 * deterministic policy, so there is no browser, no socket and no credential anywhere in it
 * — and one test holds that by hand rather than by intention.
 *
 * What it asserts is behaviour a person could check: the session parses and round-trips,
 * its fixations are numbered as one continuous sequence, one decision was asked for per
 * screen, the agent was never shown an element it had not looked at, every action it
 * decided went to the driver, and the same persona and seed produce the same session twice.
 */

import { readFile } from 'node:fs/promises';
import { runPaths, sessionSchema } from '@personavision/contract';
import { createFixtureSource } from '@personavision/browser';
import { createOfflineDeterministicProvider, FREE_USAGE } from '@personavision/provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideOutcome, runSession } from '../src/index.js';
import type { ActResult, Capture, CaptureSource } from '@personavision/browser';
import type { Session } from '@personavision/contract';
import type { Aoi } from '@personavision/engine';
import type { SessionScreen, SessionTrace } from '../src/index.js';
import {
  COMMITTED,
  DESKTOP,
  MOBILE,
  TASK,
  personaWho,
  providerThat,
  recording,
  sessionOver,
  sweep,
  temporaryRunDir,
  variantFor,
  watchingActs,
} from './harness.js';

/** The action types the browser driver performs; the other two are the agent's own. */
const PAGE_ACTIONS = new Set<Session['actions'][number]['type']>(['click', 'scroll', 'back']);

/** The whole of `DecisionContext` for a provider that does not read images. */
const CONTEXT_FIELDS = ['fixatedElements', 'goal', 'history', 'step', 'traits'];

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
      expect(session.actions.length).toBe(watched.contexts.length);
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

  describe('the actions', () => {
    it('executes every one it decides through the driver, and records whether it worked', async () => {
      const watched = watchingActs(createFixtureSource(COMMITTED));

      const session = await runSession(sessionOver(runDir, { source: watched.source }));

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
        wallClockBudgetMs: null,
      };

      expect(session.outcome).toEqual(decideOutcome(trace, personaWho('careful')));
    });

    it('lets the agent give up in character rather than at a cap', async () => {
      const rushed = await runSession(
        sessionOver(runDir, { persona: personaWho('rushed'), sessionId: 'S-02' }),
      );

      expect(rushed.outcome.status).toBe('abandoned');
      expect(rushed.outcome.attribution).toBe('product');
      expect(rushed.outcome.excludedFromScores).toBe(false);
      // It stopped well inside the cap: the budget that ran out was the persona's.
      expect(rushed.screens.length).toBeLessThan(8 * TASK.steps.length);
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
});
