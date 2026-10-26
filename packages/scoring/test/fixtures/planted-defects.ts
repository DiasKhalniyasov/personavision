import { findings, score, type Finding, type PlantedDefect } from '../../src/index.js';
import {
  defectiveVariantSessions,
  fixtureAoiMetrics,
  fixtureAois,
  fixtureTask,
  plantedDefects,
} from './index.js';

/**
 * The findings lists the planted-defect evaluation is measured over.
 *
 * They are **real findings**, produced by `findings()` over the defective checkout of
 * `./index.js` — the same fixture that carries the three defects `plantedDefects`
 * declares. Nothing here is a hand-written finding object: a fixture that invented its own
 * findings would score an evaluation against a list no run could produce, and the one
 * thing this measurement is for is scoring the real list.
 *
 * Findings are picked out by id, written out in full below, rather than by searching for
 * the rule behind them. The evaluation under test is exactly the thing that pairs a rule
 * with a defect, so a fixture that paired them too would be marking its own homework.
 */

export const defectiveFindings: Finding[] = findings(
  defectiveVariantSessions,
  fixtureAois,
  fixtureAoiMetrics,
  score(defectiveVariantSessions, fixtureAois, fixtureAoiMetrics, fixtureTask),
);

const byId = (id: string): Finding => {
  const finding = defectiveFindings.find((candidate) => candidate.id === id);
  if (finding === undefined) {
    throw new Error(
      `fixture: no finding "${id}" in the defective checkout's list (${defectiveFindings
        .map((candidate) => candidate.id)
        .join(', ')})`,
    );
  }
  return finding;
};

/** D-1's finding: nobody ever looked at the button that places the order. */
export const neverFixatedPlaceOrder = byId('never-fixated-primary-action@B');

/** D-2's finding — the one `imperfectRun` leaves out, to make a missed defect. */
export const feeChangedBetweenSteps = byId('value-changed-between-steps@B');

/** D-3's finding: the promo banner takes the first look on the basket step. */
export const promoTakesFirstLook = byId('competing-first-fixation@B');

/**
 * A run that got two of the three and said one more thing besides.
 *
 * Four findings, hand-picked so that both failure modes are in one fixture and the two
 * numbers can be computed on paper:
 *
 * - `never-fixated-primary-action@B` names D-1 — a hit.
 * - `competing-first-fixation@B` names D-3 — a hit.
 * - `high-abandonment-at-step@B` is true of the run and names no declared defect. It is a
 *   false positive *for this measurement*, which is what the measurement is for: anything
 *   the shop did not plant counts against precision whether or not it is true.
 * - `informational-note@run` is attributed to automation, so it is neither a hit nor a
 *   false positive and is not in precision's denominator at all.
 *
 * D-2's finding is absent, so the fee that appears after the card details is missed.
 *
 * Against all three of `plantedDefects`: three findings about the product, two of them
 * hits, so precision is 2/3; three defects declared, two found, so recall is 2/3.
 */
export const imperfectRun: readonly Finding[] = [
  neverFixatedPlaceOrder,
  promoTakesFirstLook,
  byId('high-abandonment-at-step@B'),
  byId('informational-note@run'),
];

/** The one finding about the run itself, and the only one attributed to automation. */
export const automationNote = byId('informational-note@run');

/**
 * Two declared defects that the same finding names: the same rule, variant, step and area,
 * declared twice.
 *
 * The demo shop can do this honestly — the button below the fold and the button nobody
 * looked at are one situation described two ways — and the evaluation has to say what it
 * does about it rather than pick one arbitrarily.
 */
export const defectsDeclaredTwice: readonly PlantedDefect[] = [
  plantedDefects[0]!,
  {
    ...plantedDefects[0]!,
    id: 'D-1b',
    description: 'The button that places the order is past the fold on every device.',
  },
];
