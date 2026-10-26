/**
 * `@personavision/personas` — the audience, and the people generated from it.
 *
 * An audience is the product's first-class object: the user describes the customers their
 * business serves, and PersonaVision generates the simulated people a test runs with from
 * that description (`docs/FLOW.md` section 1). This package is where that generation lives.
 * The audience's *shape* is `@personavision/contract`'s, because a run artifact carries a
 * copy of it; what lives here is the behaviour — which audience field moves which trait, how
 * the spread around the audience's centre is drawn, and how the device mix is honoured.
 *
 * `README.md` states each choice in the derivation and why it is that way.
 */

export { generatePersonas } from './generate.js';
export type { GeneratePersonasOptions } from './generate.js';

export {
  AudienceValidationError,
  GENERATOR_VERSION,
  parseAudience,
  traitCentre,
} from './audience.js';
export type { AudienceIssue } from './audience.js';

export { ARCHETYPES, TRAIT_NAMES } from './archetypes.js';
export type { Archetype } from './archetypes.js';

export { CONCRETE_DEVICES, concreteDeviceFor, deviceQuota } from './devices.js';
export type { ConcreteDevice } from './devices.js';

export { DEMO_AUDIENCE_SEED, OUTDOOR_GEAR_SHOPPERS } from './presets.js';
