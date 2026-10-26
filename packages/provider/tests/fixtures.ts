import { element, MIDDLING } from '../src/testing.js';
import type { FixatedElement, PersonaTraits } from '../src/types.js';

/**
 * The package's own tests build on the fixtures the exported contract suite scores, so a
 * screen or a trait added to one is added to both. What is here is what only these tests
 * need.
 */
export {
  contextOf,
  element,
  GOAL,
  MATCHING_SCREEN,
  MIDDLING,
  seedBand,
  SESSION_STEPS,
  walkSession,
} from '../src/testing.js';

export const traitsWith = (overrides: Partial<PersonaTraits>): PersonaTraits => ({
  ...MIDDLING,
  ...overrides,
});

/** Nothing on this screen has anything to do with the goal, and none of it is a control. */
export const BARREN_SCREEN: readonly FixatedElement[] = [
  element('el-cookies', 'Cookie preferences', null),
];

/** A screen of navigation: every element is a control, and none of it answers the goal. */
export const NAVIGATION_SCREEN: readonly FixatedElement[] = [
  element('el-about', 'About us', 'link'),
  element('el-careers', 'Careers', 'link'),
  element('el-contact', 'Contact', 'button'),
];
