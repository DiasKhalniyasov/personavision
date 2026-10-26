import type { Session } from '@personavision/contract';
import type { Aoi, AoiMetric } from '../../src/index.js';
import { buildAoiMetrics, buildSession, type SessionSpec } from './build.js';

/**
 * A third session set, for the three rules the clean and defective checkouts have no
 * situation for.
 *
 * `CLEAN` and `DEFECTIVE` in `./index.ts` are tuned so that the real friction formula reads
 * what `docs/FLOW.md` section 5's acceptance table requires, and they are the project's one
 * quantitative gate. Nothing here touches them. These sessions exist so that
 * **primary-action-below-fold**, **slow-primary-action-fixation** and
 * **low-looked-at-share** are each exercised through the public `findings()` function on
 * data that genuinely reads that way, rather than by reaching into a rule:
 *
 * 1. **The control that completes the task is below the fold and most people never find
 *    it.** `s-basket-pay` is `belowFold: true` and two of ten sessions look at it, so its
 *    share is 0.2 — under `thresholds.lowLookedAtShare` and above zero, which is what
 *    separates this from the critical never-looked-at rule.
 * 2. **The control on the first step is found, but slowly.** `s-shelf-add` is first looked
 *    at after four seconds, over `thresholds.slowPrimaryActionSeconds` and under the
 *    six-second cap the score normalises over, so it is late rather than invisible.
 * 3. **Something the task needs is never looked at.** `s-basket-help` is a link, and it is
 *    the third area the basket step declares — the builder's gaze alternates between the
 *    first two, so nobody ever reaches it.
 */

const box = (y: number): Aoi['bbox'] => ({ x: 24, y, width: 300, height: 56 });

interface AoiSpec {
  readonly name: string;
  readonly label: string;
  readonly role: string | null;
  readonly y: number;
  readonly isPrimaryAction?: boolean;
  readonly belowFold?: boolean;
}

/** Each step's areas, in the order the gaze meets them: the first is where the step opens. */
const PAGES: Record<string, readonly AoiSpec[]> = {
  shelf: [
    { name: 'banner', label: 'Free delivery this week', role: 'img', y: 60 },
    { name: 'note', label: 'Stock note', role: 'text', y: 200 },
    { name: 'add', label: 'Add to basket', role: 'button', y: 400, isPrimaryAction: true },
  ],
  basket: [
    { name: 'summary', label: 'Basket summary', role: 'text', y: 100 },
    { name: 'terms', label: 'Delivery terms', role: 'text', y: 220 },
    // A link the task needs somebody to use, that the gaze never reaches.
    { name: 'help', label: 'Change delivery date', role: 'link', y: 320 },
    {
      name: 'pay',
      label: 'Pay now',
      role: 'button',
      y: 1200,
      isPrimaryAction: true,
      belowFold: true,
    },
  ],
};

export const RULES_VARIANT = 'S';

export const rulesAois: Aoi[] = Object.entries(PAGES).flatMap(([step, specs]) =>
  specs.map((spec) => ({
    id: `${RULES_VARIANT.toLowerCase()}-${step}-${spec.name}`,
    variant: RULES_VARIANT,
    step,
    label: spec.label,
    source: 'dom' as const,
    role: spec.role,
    bbox: box(spec.y),
    isPrimaryAction: spec.isPrimaryAction ?? false,
    belowFold: spec.belowFold ?? false,
  })),
);

/** Seconds before the control of each step was first looked at; `null` where it never was. */
const SECONDS_TO_CONTROL: readonly (readonly [number, number | null])[] = [
  [4.2, 1],
  [3.8, null],
  [4.1, null],
  [4, null],
  [4.3, null],
  [3.9, 1],
  [4.2, null],
  [4, null],
  [4.1, null],
  [3.8, null],
];

const toSpec = (
  position: number,
  [shelf, basket]: readonly [number, number | null],
): SessionSpec => ({
  sessionId: `S-${String(position + 1).padStart(2, '0')}`,
  variant: RULES_VARIANT,
  seed: position < 5 ? 1 : 2,
  personaId: `P-${(position % 4) + 1}`,
  status: 'success',
  steps: [
    { step: 'shelf', primaryAfterSeconds: shelf, deadEndReturns: 0 },
    { step: 'basket', primaryAfterSeconds: basket, deadEndReturns: 0 },
  ],
});

export const rulesSessions: Session[] = SECONDS_TO_CONTROL.map((row, position) =>
  buildSession(toSpec(position, row), rulesAois),
);

export const rulesAoiMetrics: AoiMetric[] = buildAoiMetrics(rulesSessions, rulesAois);

export const rulesTask = { id: 'buy-a-tent', prompt: 'Buy the two-person tent' };
