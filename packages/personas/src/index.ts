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
 * What is exported is what a caller outside this package needs, and no more: generation, the
 * committed preset, the generator's version for anyone building an audience, and the
 * validation an audience form reports field by field. The archetype table, the trait centres
 * and the device apportionment are the derivation, not an interface — `README.md` states each
 * of their choices, and `tests/` reaches them by module.
 */

export { generatePersonas } from './generate.js';
export type { GeneratePersonasOptions } from './generate.js';

export { AudienceValidationError, GENERATOR_VERSION, parseAudience } from './audience.js';
export type { AudienceIssue } from './audience.js';

export { DEMO_AUDIENCE_SEED, OUTDOOR_GEAR_SHOPPERS } from './presets.js';
