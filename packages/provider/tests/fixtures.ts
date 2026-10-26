import type { DecisionContext, FixatedElement, PersonaTraits } from '../src/types.js';

/** Mid-scale on every trait, so a test can move exactly one of them. */
export const MIDDLING: PersonaTraits = {
  persistence: 0.5,
  scanningVsReading: 0.5,
  detailOrientation: 0.5,
  interfaceFamiliarity: 0.5,
  patience: 0.5,
  riskTolerance: 0.5,
};

export const traitsWith = (overrides: Partial<PersonaTraits>): PersonaTraits => ({
  ...MIDDLING,
  ...overrides,
});

export const element = (
  id: string,
  text: string,
  role: string | null,
  overrides: Partial<FixatedElement> = {},
): FixatedElement => ({ id, text, role, fixationCount: 2, dwellMs: 400, ...overrides });

/** The demo shop's goal, and a screen with one answer to it and two distractors. */
export const GOAL = { text: 'Find the price of the waterproof jacket' } as const;

export const MATCHING_SCREEN: readonly FixatedElement[] = [
  element('el-jacket', 'Waterproof jacket — £129', 'link'),
  element('el-newsletter', 'Newsletter signup', 'button'),
  element('el-home', 'Home', 'link'),
];

/** Nothing on this screen has anything to do with the goal. */
export const BARREN_SCREEN: readonly FixatedElement[] = [
  element('el-cookies', 'Cookie preferences', null),
];

export const contextOf = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  goal: GOAL,
  traits: MIDDLING,
  step: { id: 'browse', index: 1, label: 'Browse the catalogue' },
  fixatedElements: MATCHING_SCREEN,
  history: [],
  ...overrides,
});

/** A fixed band of seeds: every assertion over it is reproducible, so none can flake. */
export const seedBand = (size: number): readonly number[] =>
  Array.from({ length: size }, (_, index) => index);
