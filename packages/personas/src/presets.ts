import type { Audience } from '@personavision/contract';
import { GENERATOR_VERSION } from './audience.js';

/**
 * The one committed audience: the demo shop's customers.
 *
 * It is the audience the seeded demo workspace opens on and the one the committed example
 * run was tested for, and it is stated here field for field as `docs/design/prototype.html`'s
 * `AUDIENCE` constant states it — with `size` as the number of people it generates, which is
 * what the contract asserts a run's `personas[]` against (decision 1 on #105). The prototype
 * writes `24` in that field and means the sessions a test runs: 4 people × 2 versions ×
 * 3 seeds. The people are four.
 *
 * `tests/preset.test.ts` asserts this object equals the committed example run's own audience
 * block, so the preset and the demo cannot drift into two different audiences, and asserts
 * that generating from it at `DEMO_AUDIENCE_SEED` returns the four people the prototype, the
 * example run and every fixture already name.
 */
export const DEMO_AUDIENCE_SEED = 20_261_024;

export const OUTDOOR_GEAR_SHOPPERS: Audience = {
  id: 'outdoor-gear-shoppers',
  name: 'Outdoor-gear shoppers',
  ageRange: { min: 25, max: 45 },
  roles: ['First-time buyer', 'Returning customer'],
  regions: ['United Kingdom', 'Ireland'],
  goals: ['Buy one item quickly', 'Compare prices first'],
  devices: [
    {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
      share: 0.6,
    },
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 0.4,
    },
  ],
  techSavviness: 0.55,
  priceSensitivity: 0.75,
  size: 4,
  generatedFrom: { seed: DEMO_AUDIENCE_SEED, generatorVersion: GENERATOR_VERSION },
};
