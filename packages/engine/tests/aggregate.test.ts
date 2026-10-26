import { describe, expect, it } from 'vitest';
import type { Session } from '@personavision/contract';
import { runSchema, SCHEMA_VERSION, sessionSchema } from '@personavision/contract';
import type { Aoi, AoiMetric } from '../src/index.js';
import { aggregate } from '../src/index.js';

/**
 * Sessions are built here rather than read from the committed example run: this module
 * reads contract-shaped sessions and nothing else, so its fixtures are its own. Every one
 * of them is parsed by `sessionSchema` below, so a fixture that drifts from the contract
 * fails loudly instead of quietly proving nothing.
 */

const CART = 'cart';
const CONFIRM = 'confirm';
const CHECKOUT = 'a-cart-checkout';
const COMPLETE = 'a-cart-complete';
const PROMO = 'a-cart-promo';

const aoi = (id: string, overrides: Partial<Aoi> = {}): Aoi => ({
  id,
  variant: 'A',
  step: CART,
  label: id,
  source: 'dom',
  role: null,
  bbox: { x: 0, y: 0, width: 120, height: 40 },
  isPrimaryAction: false,
  belowFold: false,
  ...overrides,
});

/** One fixation: the area it landed in (`null` is outside every area), its time and its duration. */
type Look = readonly [string | null, number, number];

interface SessionSpec {
  id: string;
  variant?: string;
  steps?: readonly string[];
  excluded?: boolean;
  looks?: readonly Look[];
}

const session = ({
  id,
  variant = 'A',
  steps = [CART],
  excluded = false,
  looks = [],
}: SessionSpec): Session => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: id,
  runId: '2026-10-26-1100-aggregate-fixture',
  variant,
  taskId: 'buy-boots',
  kind: 'simulated',
  persona: {
    id: 'rushed-buyer',
    traits: {
      persistence: 0.6,
      scanningVsReading: 0.4,
      detailOrientation: 0.5,
      interfaceFamiliarity: 0.7,
      patience: 0.3,
      riskTolerance: 0.5,
    },
    device: {
      name: 'Desktop 1440',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      touch: false,
    },
  },
  participant: null,
  seed: 1,
  startedAt: '2026-10-26T11:00:00.000Z',
  durationMs: 30_000,
  screens: steps.map((step, index) => ({
    index,
    step,
    screenshot: `screenshots/${variant}/${step}.png`,
    scrollY: 0,
    intent: 'Find the way to pay.',
    decidedAction: 'click Checkout',
  })),
  fixations: looks.map(([aoiId, tMs, durationMs], index) => ({
    index,
    screenIndex: 0,
    tMs,
    durationMs,
    x: 100,
    y: 100,
    pageX: 100,
    pageY: 100,
    aoiId,
  })),
  saccades: [],
  actions: [],
  outcome: {
    status: excluded ? 'automation_failure' : 'success',
    step: steps[steps.length - 1],
    reason: excluded ? 'The browser lost the page.' : 'Order placed.',
    attribution: excluded ? 'automation' : 'product',
    excludedFromScores: excluded,
  },
  integrity: { selectorFailures: 0, retries: 0 },
});

const row = (metrics: readonly AoiMetric[], aoiId: string): AoiMetric => {
  const found = metrics.find((metric) => metric.aoiId === aoiId);
  if (found === undefined) throw new Error(`no metric row for ${aoiId}`);
  return found;
};

describe('aggregate', () => {
  describe('the share of sessions that looked', () => {
    const sessions = [
      session({ id: 'S-01', looks: [[CHECKOUT, 1000, 300]] }),
      session({ id: 'S-02', looks: [[CHECKOUT, 2000, 500]] }),
      session({ id: 'S-03', looks: [[PROMO, 400, 200]] }),
    ];
    const metrics = aggregate(sessions, [aoi(CHECKOUT), aoi(PROMO)]);

    it('is the fraction of the sessions behind the row that fixated the area', () => {
      expect(row(metrics, CHECKOUT).lookedAtShare).toBe(2 / 3);
      expect(row(metrics, CHECKOUT).sessionCount).toBe(3);
    });

    it('takes time to first fixation over only the sessions that did fixate it', () => {
      expect(row(metrics, CHECKOUT).timeToFirstFixationMs).toBe(1500);
    });

    it('counts a session only against the areas of the variant and step it reached', () => {
      const elsewhere = [
        ...sessions,
        session({ id: 'S-04', variant: 'B', looks: [] }),
        session({ id: 'S-05', steps: [CONFIRM], looks: [] }),
      ];

      expect(aggregate(elsewhere, [aoi(CHECKOUT)])).toEqual(aggregate(sessions, [aoi(CHECKOUT)]));
    });
  });

  describe('an area no session fixated', () => {
    const metrics = aggregate(
      [
        session({ id: 'S-01', looks: [[CHECKOUT, 1000, 300]] }),
        session({ id: 'S-02', looks: [[CHECKOUT, 1200, 280]] }),
      ],
      [aoi(CHECKOUT), aoi(COMPLETE)],
    );
    const never = row(metrics, COMPLETE);

    it('reports null for time to first fixation and first-fixation duration', () => {
      expect(never.timeToFirstFixationMs).toBeNull();
      expect(never.firstFixationDurationMs).toBeNull();
    });

    it('substitutes no near-zero number for either null', () => {
      // A `0`, a `0.0001` or any other invented value is a number; the honest answer is not.
      expect(typeof never.timeToFirstFixationMs).not.toBe('number');
      expect(typeof never.firstFixationDurationMs).not.toBe('number');
    });

    it('reports a zero share and zeroes for dwell, fixation count and revisits', () => {
      expect(never.lookedAtShare).toBe(0);
      expect(never.totalDwellMs).toBe(0);
      expect(never.fixationCount).toBe(0);
      expect(never.revisits).toBe(0);
    });
  });

  describe('a session excluded from scores', () => {
    const aois = [aoi(CHECKOUT), aoi(COMPLETE)];
    const scored = [
      session({ id: 'S-01', looks: [[CHECKOUT, 1000, 300]] }),
      session({ id: 'S-02', looks: [[CHECKOUT, 1400, 320]] }),
      session({ id: 'S-03', looks: [[PROMO, 500, 200]] }),
    ];

    it('changes no field of any row, including sessionCount and lookedAtShare', () => {
      const before = aggregate(scored, aois);
      const after = aggregate(
        [
          ...scored,
          session({
            id: 'S-04',
            excluded: true,
            looks: [
              [COMPLETE, 100, 900],
              [CHECKOUT, 1100, 900],
            ],
          }),
        ],
        aois,
      );

      expect(after).toEqual(before);
    });
  });

  describe('the reported value', () => {
    // 100, 200 and 5400 have a median of 200 and a mean of 1900: an outlier the mean follows.
    const sessions = [
      session({ id: 'S-01', looks: [[CHECKOUT, 100, 200]] }),
      session({ id: 'S-02', looks: [[CHECKOUT, 200, 240]] }),
      session({ id: 'S-03', looks: [[CHECKOUT, 5400, 2800]] }),
    ];
    const checkout = row(aggregate(sessions, [aoi(CHECKOUT)]), CHECKOUT);

    it('is the median, not the mean', () => {
      expect(checkout.timeToFirstFixationMs).toBe(200);
      expect(checkout.timeToFirstFixationMs).not.toBe(1900);
      expect(checkout.firstFixationDurationMs).toBe(240);
      expect(checkout.totalDwellMs).toBe(240);
    });
  });

  describe('revisits', () => {
    const revisitsOf = (looks: readonly Look[]): number =>
      row(aggregate([session({ id: 'S-01', looks })], [aoi(CHECKOUT)]), CHECKOUT).revisits;

    it('count a return after the gaze left the area', () => {
      expect(
        revisitsOf([
          [CHECKOUT, 100, 200],
          [PROMO, 400, 200],
          [CHECKOUT, 700, 200],
          [PROMO, 1000, 200],
          [CHECKOUT, 1300, 200],
        ]),
      ).toBe(2);
    });

    it('count a run of consecutive fixations inside one area as one visit', () => {
      expect(
        revisitsOf([
          [CHECKOUT, 100, 200],
          [CHECKOUT, 400, 200],
          [CHECKOUT, 700, 200],
        ]),
      ).toBe(0);
    });

    it('count a return after a fixation outside every area', () => {
      expect(
        revisitsOf([
          [CHECKOUT, 100, 200],
          [null, 400, 200],
          [CHECKOUT, 700, 200],
        ]),
      ).toBe(1);
    });

    it('read the order from the continuous fixation index, not from a timestamp sort', () => {
      const outOfOrder = session({
        id: 'S-01',
        looks: [
          [CHECKOUT, 900, 200],
          [PROMO, 400, 200],
          [CHECKOUT, 1300, 200],
        ],
      });

      // By `tMs` the promo comes first and the two checkout fixations are consecutive;
      // by `index`, as the contract defines the order, the gaze left and came back.
      expect(row(aggregate([outOfOrder], [aoi(CHECKOUT)]), CHECKOUT).revisits).toBe(1);
      expect(row(aggregate([outOfOrder], [aoi(CHECKOUT)]), CHECKOUT).timeToFirstFixationMs).toBe(
        900,
      );
    });
  });

  describe('the rows it emits', () => {
    const aois = [aoi(CHECKOUT), aoi(PROMO), aoi(COMPLETE)];
    const sessions = [
      session({
        id: 'S-01',
        looks: [
          [PROMO, 300, 240],
          [CHECKOUT, 900, 420],
          [CHECKOUT, 1400, 180],
        ],
      }),
      session({ id: 'S-02', looks: [[PROMO, 280, 300]] }),
    ];
    const metrics = aggregate(sessions, aois);

    it('validate against the contract', () => {
      expect(runSchema.shape.aoiMetrics.parse(metrics)).toEqual(metrics);
    });

    it('cover every area passed in, in that order, including the ones no session reached', () => {
      expect(metrics.map((metric) => metric.aoiId)).toEqual([CHECKOUT, PROMO, COMPLETE]);
    });

    it('are deeply equal when the input sessions are shuffled', () => {
      expect(aggregate([...sessions].reverse(), aois)).toEqual(metrics);
    });
  });

  describe('dwell, fixation count and revisits', () => {
    const DEAD_END = 'a-cart-dead-end';
    // `docs/FLOW.md` section 5: dead-end revisits are the median returns *per session*, so
    // the seven sessions that never went near the area are the zeros they really are.
    const sessions = [
      ...Array.from({ length: 7 }, (_unused, index) =>
        session({ id: `S-0${index + 1}`, looks: [[CHECKOUT, 900, 300]] }),
      ),
      session({
        id: 'S-08',
        looks: [
          [DEAD_END, 300, 200],
          [CHECKOUT, 600, 200],
          [DEAD_END, 900, 200],
          [CHECKOUT, 1200, 200],
          [DEAD_END, 1500, 200],
          [CHECKOUT, 1800, 200],
          [DEAD_END, 2100, 200],
        ],
      }),
      session({
        id: 'S-09',
        looks: [
          [DEAD_END, 300, 300],
          [CHECKOUT, 600, 200],
          [DEAD_END, 900, 300],
          [CHECKOUT, 1200, 200],
          [DEAD_END, 1500, 300],
          [CHECKOUT, 1800, 200],
          [DEAD_END, 2100, 300],
        ],
      }),
    ];
    const deadEnd = row(aggregate(sessions, [aoi(DEAD_END)]), DEAD_END);

    it('are medians over every session behind the row, not only the ones that looked', () => {
      expect(deadEnd.sessionCount).toBe(9);
      expect(deadEnd.lookedAtShare).toBe(2 / 9);
      // Two sessions returned three times each; the other seven returned not at all.
      expect(deadEnd.revisits).toBe(0);
      expect(deadEnd.fixationCount).toBe(0);
      expect(deadEnd.totalDwellMs).toBe(0);
    });

    it('still report the first fixation over only the sessions that looked', () => {
      expect(deadEnd.timeToFirstFixationMs).toBe(300);
      expect(deadEnd.firstFixationDurationMs).toBe(250);
    });

    it('take dwell over every session behind the row', () => {
      const dwelt = [
        session({ id: 'S-01', looks: [[CHECKOUT, 900, 400]] }),
        session({ id: 'S-02', looks: [[CHECKOUT, 900, 600]] }),
        session({ id: 'S-03', looks: [[PROMO, 300, 200]] }),
      ];

      expect(row(aggregate(dwelt, [aoi(CHECKOUT)]), CHECKOUT).totalDwellMs).toBe(400);
    });

    it('round a fractional median down rather than claim a return nobody made', () => {
      const split = [
        session({
          id: 'S-01',
          looks: [
            [CHECKOUT, 300, 200],
            [PROMO, 600, 200],
            [CHECKOUT, 900, 200],
          ],
        }),
        session({ id: 'S-02', looks: [[CHECKOUT, 300, 200]] }),
      ];

      // One session returned once, the other never did: half a revisit is not a revisit.
      expect(row(aggregate(split, [aoi(CHECKOUT)]), CHECKOUT).revisits).toBe(0);
    });
  });

  describe('an area no session reached', () => {
    const unreached = row(
      aggregate([session({ id: 'S-01', steps: [CART] })], [aoi(COMPLETE, { step: CONFIRM })]),
      COMPLETE,
    );

    it('says so with a session count of zero rather than a share nobody is behind', () => {
      expect(unreached.sessionCount).toBe(0);
      expect(unreached.lookedAtShare).toBe(0);
      expect(unreached.timeToFirstFixationMs).toBeNull();
      expect(unreached.firstFixationDurationMs).toBeNull();
    });
  });

  it('reads sessions that the contract accepts', () => {
    const fixtures = [
      session({ id: 'S-01', looks: [[CHECKOUT, 900, 420]] }),
      session({ id: 'S-02', variant: 'B', steps: [CART, CONFIRM], excluded: true }),
    ];

    for (const fixture of fixtures) {
      expect(sessionSchema.parse(fixture)).toEqual(fixture);
    }
  });
});
