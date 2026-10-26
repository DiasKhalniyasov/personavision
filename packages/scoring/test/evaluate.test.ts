import { describe, expect, it } from 'vitest';
import {
  evaluateAgainstPlantedDefects,
  FINDING_RULE_IDS,
  type Finding,
  type PlantedDefect,
} from '../src/index.js';
import { plantedDefects } from './fixtures/index.js';
import {
  automationNote,
  defectiveFindings,
  defectsDeclaredTwice,
  feeChangedBetweenSteps,
  imperfectRun,
  neverFixatedPlaceOrder,
  promoTakesFirstLook,
} from './fixtures/planted-defects.js';

/**
 * Planted-defect precision and recall, over findings a run really produced.
 *
 * Every number asserted below is computed by hand in the test that asserts it, from a
 * findings list and a defect list small enough to count on paper. That is the point of the
 * measurement: it exists so that "the top three findings are the three planted defects" is
 * computed rather than asserted, and a test that asserted whatever the function returned
 * would put the claim back where it started.
 *
 * The fixtures are in `./fixtures/planted-defects.js`, which takes the real findings of the
 * defective checkout and picks subsets of them by id.
 */

/** The same findings with every claim and evidence sentence replaced. */
const reworded = (findings: readonly Finding[]): Finding[] =>
  findings.map((finding) => ({
    ...finding,
    claim: 'Something entirely different happened on this page.',
    evidence: 'A sentence with no numbers in it at all.',
  }));

/** The same findings renumbered the way the committed example run's hand-authored ids are. */
const renumbered = (findings: readonly Finding[]): Finding[] =>
  findings.map((finding, index) => ({ ...finding, id: `F-${index + 1}` }));

const findingIdFor = (
  evaluation: ReturnType<typeof evaluateAgainstPlantedDefects>,
  defectId: string,
): string | null | undefined =>
  evaluation.matched.find((entry) => entry.defectId === defectId)?.findingId;

describe('the defective checkout, which carries all three declared defects', () => {
  const evaluation = evaluateAgainstPlantedDefects(defectiveFindings, plantedDefects);

  it('recalls all three, and names the finding each one was credited to', () => {
    expect(evaluation.recall).toBe(1);
    expect(evaluation.matched).toEqual([
      { defectId: 'D-1', findingId: neverFixatedPlaceOrder.id },
      { defectId: 'D-2', findingId: feeChangedBetweenSteps.id },
      { defectId: 'D-3', findingId: promoTakesFirstLook.id },
    ]);
  });

  it('counts the other findings about the product against precision', () => {
    // Six findings: five about the product, of which three name a declared defect. The
    // other two — the step people give up on and the step the task fails at — are true of
    // the run and were not planted, and the informational note is attributed to automation
    // and is not counted at all.
    expect(defectiveFindings).toHaveLength(6);
    expect(defectiveFindings.filter((f) => f.attribution !== 'automation')).toHaveLength(5);
    expect(evaluation.precision).toBeCloseTo(3 / 5, 12);
  });

  it('is unchanged when every claim and evidence sentence is rewritten', () => {
    const afterRewording = evaluateAgainstPlantedDefects(
      reworded(defectiveFindings),
      plantedDefects,
    );
    expect(afterRewording.precision).toBe(evaluation.precision);
    expect(afterRewording.recall).toBe(evaluation.recall);
    expect(afterRewording.matched).toEqual(evaluation.matched);
  });

  it('recalls nothing from positional ids this generator did not write', () => {
    // The committed example run's findings are hand-authored `F-1 … F-6`, so the rule
    // behind them cannot be read back and an evaluation over that artifact as it stands
    // recalls nothing. Matching is on the rule id, and no other field can stand in for it.
    const evaluated = evaluateAgainstPlantedDefects(renumbered(defectiveFindings), plantedDefects);
    expect(evaluated.recall).toBe(0);
    expect(evaluated.precision).toBe(0);
    expect(evaluated.matched.map((entry) => entry.findingId)).toEqual([null, null, null]);
  });
});

describe('a run that missed one defect and found something else besides', () => {
  const evaluation = evaluateAgainstPlantedDefects(imperfectRun, plantedDefects);

  it('scores two thirds on both numbers', () => {
    // Four findings in, three of them about the product: the two hits and the abandonment
    // finding, which names no declared defect. Two of three declared defects found.
    expect(imperfectRun).toHaveLength(4);
    expect(evaluation.precision).toBeCloseTo(2 / 3, 12);
    expect(evaluation.recall).toBeCloseTo(2 / 3, 12);
  });

  it('says which defect nothing found', () => {
    expect(findingIdFor(evaluation, 'D-2')).toBeNull();
    expect(findingIdFor(evaluation, 'D-1')).toBe(neverFixatedPlaceOrder.id);
    expect(findingIdFor(evaluation, 'D-3')).toBe(promoTakesFirstLook.id);
  });
});

describe('findings attributed to automation', () => {
  it('are neither a hit nor a false positive', () => {
    const withTheNote = evaluateAgainstPlantedDefects(
      [neverFixatedPlaceOrder, automationNote],
      [plantedDefects[0]!],
    );
    // One finding about the product, and it is the hit: precision is 1, not 1/2.
    expect(automationNote.attribution).toBe('automation');
    expect(withTheNote.precision).toBe(1);
    expect(withTheNote.recall).toBe(1);
    expect(withTheNote.matched).toEqual([
      { defectId: 'D-1', findingId: neverFixatedPlaceOrder.id },
    ]);
  });

  it('are never credited with a defect, even one declared against their own rule', () => {
    const noteShaped: PlantedDefect = {
      id: 'D-X',
      ruleId: 'informational-note',
      variant: automationNote.variant ?? 'B',
      step: automationNote.step,
      aoiId: automationNote.aoiId,
      description: 'A defect nobody should be able to declare: the run reporting on itself.',
    };
    const evaluated = evaluateAgainstPlantedDefects([automationNote], [noteShaped]);
    expect(evaluated.recall).toBe(0);
    expect(evaluated.matched).toEqual([{ defectId: 'D-X', findingId: null }]);
    // Nothing about the product was claimed, so nothing claimed was wrong.
    expect(evaluated.precision).toBe(1);
  });
});

describe('the degenerate inputs', () => {
  it('no findings: precision is 1 because nothing was claimed, and recall carries the story', () => {
    const evaluated = evaluateAgainstPlantedDefects([], plantedDefects);
    expect(evaluated.precision).toBe(1);
    expect(evaluated.recall).toBe(0);
    expect(evaluated.matched).toEqual([
      { defectId: 'D-1', findingId: null },
      { defectId: 'D-2', findingId: null },
      { defectId: 'D-3', findingId: null },
    ]);
  });

  it('no declared defects: recall is 1 because there was nothing to find', () => {
    const evaluated = evaluateAgainstPlantedDefects(defectiveFindings, []);
    expect(evaluated.recall).toBe(1);
    // Five findings about the product and no defect any of them could name.
    expect(evaluated.precision).toBe(0);
    expect(evaluated.matched).toEqual([]);
  });

  it('neither: both are 1 and neither is NaN', () => {
    const evaluated = evaluateAgainstPlantedDefects([], []);
    expect(evaluated.precision).toBe(1);
    expect(evaluated.recall).toBe(1);
    expect(evaluated.matched).toEqual([]);
  });

  it('one finding naming two declared defects: both credited, counted once', () => {
    const evaluated = evaluateAgainstPlantedDefects([neverFixatedPlaceOrder], defectsDeclaredTwice);
    expect(evaluated.recall).toBe(1);
    expect(evaluated.precision).toBe(1);
    expect(evaluated.matched).toEqual([
      { defectId: 'D-1', findingId: neverFixatedPlaceOrder.id },
      { defectId: 'D-1b', findingId: neverFixatedPlaceOrder.id },
    ]);
  });
});

describe('the declared-defect shape the demo shop writes its defects against', () => {
  it('names a rule the findings generator has', () => {
    for (const defect of plantedDefects) {
      expect(FINDING_RULE_IDS, defect.id).toContain(defect.ruleId);
    }
  });

  it('identifies an area of interest by variant, step and area, so two steps cannot look alike', () => {
    // `high-abandonment-at-step` reports `aoiId: null`. A defect declared for it on one
    // step must not be credited to the same rule firing on another.
    const abandonment = defectiveFindings.find((f) => f.id === 'high-abandonment-at-step@B')!;
    const elsewhere: PlantedDefect = {
      id: 'D-Y',
      ruleId: 'high-abandonment-at-step',
      variant: 'B',
      step: 'cart',
      aoiId: null,
      description: 'People give up on the basket step.',
    };
    expect(abandonment.step).toBe('review');
    expect(evaluateAgainstPlantedDefects([abandonment], [elsewhere]).recall).toBe(0);
  });
});
