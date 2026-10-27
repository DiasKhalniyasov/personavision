import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Session } from '@personavision/contract';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { sessionTimeline } from '../../src/session/index.js';
import { eventLog, NOTHING_RECORDED } from '../../src/screens/replay/eventLog';

/**
 * The column's answers, over the committed seed example run.
 *
 * `S-15` is beat 6 of `docs/FLOW.md` section 7: the rushed buyer on mobile who believed
 * they had paid $129.00 and found $147.95 on the next screen. Everything asserted here is
 * a word or a figure a reader sees — the card headers, the intent sentences, the rows and
 * which one the scrubber is on — so the whole file is the rendering of these answers.
 */

const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../runs');
const SEED_RUN = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');

const read = (file: string): unknown =>
  JSON.parse(readFileSync(join(runsRoot, SEED_RUN, file), 'utf8'));

const run: Run = runSchema.parse(read(layout.run));
const seedSession = (sessionId: string): Session =>
  sessionSchema.parse(read(layout.session(sessionId)));

/** The column at one scrubber position, by the same clock the frame uses. */
const at = (session: Session, tMs: number) => {
  const timeline = sessionTimeline(session);
  return eventLog({ session, run, timeline, moment: timeline.at(tMs) });
};

const session = seedSession('S-15');
/** Fixation 12 of 23, where the sibling tests put the scrubber: 0:15 on the payment screen. */
const AT_FIXATION_12 = 15828;

const row = (log: ReturnType<typeof at>, card: number, key: string) =>
  log.cards[card]?.events.find((event) => event.key === key);

describe('one card per screen', () => {
  it('states the step, the fixations it covers and the stretch of clock it was on', () => {
    const log = at(session, AT_FIXATION_12);

    expect(log.cards.map((card) => card.title)).toEqual([
      'Screen 1 of 3 · Cart',
      'Screen 2 of 3 · Payment',
      'Screen 3 of 3 · Review',
    ]);
    expect(log.cards.map((card) => card.meta)).toEqual([
      'fixations 1–7 · 0:00–0:10',
      'fixations 8–19 · 0:10–0:29',
      'fixations 20–23 · 0:29–0:38',
    ]);
  });

  it('prints the intent the agent stated, in full and unchanged', () => {
    const log = at(session, AT_FIXATION_12);

    expect(log.cards.map((card) => card.intent)).toEqual([
      'See what the boots cost in total before I put a card in.',
      'Pay as fast as possible, the card is saved.',
      'I thought I had paid. Why is the total higher than it was?',
    ]);
    // Word for word what the session file records, not a shortened version of it.
    expect(log.cards.map((card) => card.intent)).toEqual(
      session.screens.map((screen) => screen.intent),
    );
  });

  it('says so rather than rendering a blank column when a session records no screens', () => {
    const log = at({ ...session, screens: [], fixations: [], saccades: [] }, 0);

    expect(log.cards).toEqual([]);
    expect(log.problem).toContain('records no screens');
  });
});

describe('the events of a screen', () => {
  it('lists them in time order, with a timestamp, a kind and what each was aimed at', () => {
    const log = at(session, AT_FIXATION_12);

    expect(log.cards[0]?.events.map((event) => [event.time, event.kind, event.target])).toEqual([
      ['0:01', 'read', 'Promo banner'],
      ['0:02', 'read', 'Promo banner'],
      ['0:03', 'read', 'Cart line item'],
      ['0:04', 'read', 'Cart total'],
      ['0:05', 'read', 'Cart total'],
      ['0:06', 'read', 'Promo banner'],
      ['0:08', 'click', 'Checkout'],
      ['0:08', 'read', '"Checkout" button'],
    ]);
  });

  it('carries the figure behind a row: a dwell, a scroll offset, what was typed', () => {
    const log = at(session, AT_FIXATION_12);

    expect(row(log, 1, 'read:20')).toBeUndefined();
    expect(row(log, 1, 'action:1')).toMatchObject({
      time: '0:14',
      kind: 'type',
      target: 'Card number',
      detail: 'autofilled',
    });
    expect(row(log, 1, 'action:2')).toMatchObject({
      kind: 'hesitate',
      target: null,
      detail: '1.9 s with no action',
    });
    expect(row(log, 1, 'action:4')).toMatchObject({ kind: 'scroll', detail: 'to 696 px' });
    expect(row(log, 2, 'read:20')).toMatchObject({
      kind: 'read',
      target: 'Service fee row — planted defect',
      detail: '631 ms held',
    });
  });

  it('puts the screen with nothing on it in words rather than leaving an empty list', () => {
    const oneScreenOnly = {
      ...session,
      // A fourth screen the person reached and did nothing on: no fixation, no action.
      screens: [...session.screens, { ...session.screens[2], index: 3, step: 'confirm' }],
    };
    const log = at(oneScreenOnly as Session, AT_FIXATION_12);

    expect(log.cards[3]?.events).toEqual([]);
    expect(log.cards[3]?.meta).toBe('no fixations · no time on the clock');
    // And the screen before it keeps its own stretch rather than being cut to an instant.
    expect(log.cards[2]?.meta).toBe('fixations 20–23 · 0:29–0:38');
    expect(NOTHING_RECORDED).toBe('no actions recorded on this screen');
  });

  it('shows an event that names a screen the session does not have, and says what is wrong', () => {
    const strayScreen = {
      ...session,
      fixations: session.fixations.map((fixation) =>
        fixation.index === 3 ? { ...fixation, screenIndex: 9 } : fixation,
      ),
    };
    const log = at(strayScreen as Session, AT_FIXATION_12);

    // Under the last card, where a reader will find it, rather than dropped.
    expect(row(log, 2, 'read:3')?.inconsistency).toBe(
      'recorded on screen 10, which this session does not have',
    );
    expect(log.cards.flatMap((card) => card.events).map((event) => event.key)).toContain('read:3');
  });

  it('names the action that did not resolve, since that is our failure and not the page’s', () => {
    const brokeOnce = {
      ...session,
      actions: session.actions.map((action, index) =>
        index === 0 ? { ...action, ok: false } : action,
      ),
    };

    expect(row(at(brokeOnce as Session, AT_FIXATION_12), 0, 'action:0')?.detail).toBe(
      'this action did not resolve',
    );
  });
});

describe('a screen the person never looked at', () => {
  /** S-15 with the gaze on the payment screen gone, which is a screen with no fixations. */
  const unlooked = (): Session => {
    const kept = session.fixations.filter((fixation) => fixation.screenIndex !== 1);
    return {
      ...session,
      fixations: kept.map((fixation, index) => ({ ...fixation, index })),
      saccades: [],
    };
  };

  it('still files its actions under it, because the run names the step each area is on', () => {
    const log = at(unlooked(), 0);

    // The clock cannot place them — it has no gaze on that screen to place them by — but
    // "Card number" is an area of the payment step, so the row belongs to the payment card.
    expect(log.cards[1]?.events.map((event) => `${event.time} ${event.kind}`)).toEqual([
      '0:14 type',
      '0:26 click',
    ]);
    expect(log.cards[1]?.meta).toBe('no fixations · no time on the clock');
    // And it is not claiming the person typed their card number on the cart.
    expect(log.cards[0]?.events.map((event) => event.kind)).not.toContain('type');
  });

  it('keeps the card before it on the clock for as long as the clock keeps it active', () => {
    // Nothing moved the clock on at 0:10, because nothing was looked at on the payment
    // screen, so the cart really was the screen the replay shows until 0:29.
    expect(at(unlooked(), 0).cards[0]?.meta).toBe('fixations 1–7 · 0:00–0:29');
    expect(at(unlooked(), 20000).cards.map((card) => card.active)).toEqual([true, false, false]);
  });
});

describe('a session that recorded no fixations', () => {
  const gazeless = (): Session => ({ ...session, fixations: [], saccades: [] });

  it('reads as a transcript, with no row offering to move a scrubber that cannot move', () => {
    const log = at(gazeless(), 0);

    expect(log.cards.flatMap((card) => card.events).map((event) => event.fixationNumber)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(log.cards[1]?.events.map((event) => event.target)).toEqual([
      'Card number',
      'Place order · $129.00',
    ]);
  });
});

describe('following the scrubber', () => {
  it('marks the card covering the moment, and only that one', () => {
    expect(at(session, AT_FIXATION_12).cards.map((card) => card.active)).toEqual([
      false,
      true,
      false,
    ]);
    expect(at(session, 1034).cards.map((card) => card.active)).toEqual([true, false, false]);
    expect(at(session, 35412).cards.map((card) => card.active)).toEqual([false, false, true]);
  });

  it('marks one row — the latest thing the session model reports for that moment', () => {
    const current = (tMs: number): string[] =>
      at(session, tMs)
        .cards.flatMap((card) => card.events)
        .filter((event) => event.current)
        .map((event) => `${event.time} ${event.kind}`);

    // On a fixation: the row for that fixation, which is the one the frame draws apart.
    expect(current(AT_FIXATION_12)).toEqual(['0:15 read']);
    // Just after an action: the action, which is what the model reports as the current row.
    expect(current(26500)).toEqual(['0:26 click']);
    // And it agrees with the model rather than being worked out again here.
    const moment = sessionTimeline(session).at(26500);
    expect(moment.eventLogRow?.type).toBe('click');
    expect(moment.eventLogRow?.target).toBe('Place order · $129.00');
  });

  it('sends a row click to the nearest moment the scrubber has, on the row’s own card', () => {
    const log = at(session, AT_FIXATION_12);

    // A fixation row goes to its own number, continuous across the session.
    expect(row(log, 2, 'read:19')?.fixationNumber).toBe(20);
    // An action carries no fixation of its own, so it goes to the nearest one on its card:
    // the click at 0:08 is 52 ms from fixation 7 and 1.3 s from fixation 6.
    expect(row(log, 0, 'action:0')?.fixationNumber).toBe(7);
    expect(row(log, 2, 'action:5')?.fixationNumber).toBe(23);
    expect(row(log, 1, 'action:3')?.fixationNumber).toBe(19);
  });

  it('prints an area the run does not declare rather than leaving the row with no object', () => {
    const strayArea = {
      ...session,
      actions: session.actions.map((action, index) =>
        index === 0 ? { ...action, target: null, aoiId: 'B-cart-gone' } : action,
      ),
    };

    expect(row(at(strayArea as Session, AT_FIXATION_12), 0, 'action:0')?.target).toBe(
      'B-cart-gone',
    );
  });
});
