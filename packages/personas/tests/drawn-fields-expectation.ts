import type { Audience } from '@personavision/contract';
import { GENERATOR_VERSION } from '../src/audience.js';

/**
 * A committed expectation: the hundred people one audience and one seed draw, field by field
 * for the three fields `docs/FLOW.md` section 12 added.
 *
 * It is here rather than re-derived because a generator can only be *checked* against
 * something it did not produce in the same run. Two calls agreeing with each other says the
 * code is a function; this says it is **the same** function it was last month, which is the
 * promise the Audience screen prints beside the people — *same audience and seed, same
 * people* — and the reason a test re-run next month compares like with like. A diff here is
 * either a bug or a deliberate change to the generator, and a deliberate one has to move
 * `GENERATOR_VERSION` with it.
 *
 * The audience is section 12's own worked example — *"busy parents in Almaty who shop on
 * their phones"*, 100 people, 72% on phones, 28 to 44, Almaty, Russian and Kazakh — with a
 * 54/46 split, which is the ticket's own arithmetic: 54 and 46, not 54 and 45.
 */
export const ALMATY_PARENTS: Audience = {
  id: 'busy-parents-almaty',
  name: 'Busy parents in Almaty',
  ageRange: { min: 28, max: 44 },
  roles: ['Returning customer'],
  regions: ['Almaty'],
  languages: ['Russian', 'Kazakh'],
  genderSplit: { male: 0.46, female: 0.54 },
  ageGroups: [
    { group: '25–34', share: 0.55 },
    { group: '35–44', share: 0.45 },
  ],
  goals: ['Buy one item quickly'],
  devices: [
    {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      touch: true,
      share: 0.72,
    },
    {
      name: 'desktop',
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      touch: false,
      share: 0.28,
    },
  ],
  techSavviness: 0.45,
  priceSensitivity: 0.7,
  size: 100,
  generatedFrom: { seed: 20_261_103, generatorVersion: GENERATOR_VERSION },
};

/**
 * One row per person, in the order the generator returns them:
 * `id|gender|age group|age|language`.
 *
 * The age group is the bracket the person was dealt, which the persona itself does not carry
 * — an age group moves the person's own `patience` and `scanningVsReading` and is not a field
 * of theirs (`README.md` section 4) — so it is read from `drawnAges` and pinned here beside
 * the two fields that are.
 */
export const EXPECTED_DRAWN_FIELDS: readonly string[] = [
  'rushed|male|25–34|32|Kazakh',
  'careful|male|25–34|33|Kazakh',
  'firsttime|male|25–34|31|Kazakh',
  'price|female|35–44|42|Russian',
  'rushed-2|male|25–34|29|Russian',
  'careful-2|male|25–34|30|Kazakh',
  'firsttime-2|female|35–44|38|Russian',
  'price-2|female|25–34|28|Kazakh',
  'rushed-3|male|35–44|43|Kazakh',
  'careful-3|female|35–44|40|Kazakh',
  'firsttime-3|male|35–44|38|Russian',
  'price-3|male|25–34|28|Russian',
  'rushed-4|female|25–34|28|Russian',
  'careful-4|female|25–34|31|Russian',
  'firsttime-4|male|25–34|28|Kazakh',
  'price-4|female|25–34|30|Russian',
  'rushed-5|male|25–34|32|Kazakh',
  'careful-5|male|35–44|44|Kazakh',
  'firsttime-5|female|35–44|35|Russian',
  'price-5|female|25–34|33|Kazakh',
  'rushed-6|female|25–34|33|Russian',
  'careful-6|female|25–34|30|Russian',
  'firsttime-6|male|35–44|37|Kazakh',
  'price-6|male|25–34|33|Russian',
  'rushed-7|female|35–44|42|Russian',
  'careful-7|male|35–44|41|Kazakh',
  'firsttime-7|female|35–44|41|Russian',
  'price-7|female|35–44|35|Russian',
  'rushed-8|male|35–44|36|Russian',
  'careful-8|female|25–34|31|Kazakh',
  'firsttime-8|female|25–34|33|Kazakh',
  'price-8|female|25–34|31|Russian',
  'rushed-9|female|35–44|40|Russian',
  'careful-9|male|25–34|32|Kazakh',
  'firsttime-9|female|35–44|36|Kazakh',
  'price-9|female|35–44|39|Russian',
  'rushed-10|male|35–44|36|Kazakh',
  'careful-10|female|25–34|28|Kazakh',
  'firsttime-10|male|35–44|38|Kazakh',
  'price-10|female|25–34|30|Kazakh',
  'rushed-11|male|35–44|38|Russian',
  'careful-11|male|25–34|30|Russian',
  'firsttime-11|female|25–34|29|Russian',
  'price-11|male|35–44|40|Russian',
  'rushed-12|female|25–34|31|Kazakh',
  'careful-12|female|25–34|33|Kazakh',
  'firsttime-12|female|35–44|39|Kazakh',
  'price-12|male|25–34|30|Russian',
  'rushed-13|female|25–34|28|Russian',
  'careful-13|male|25–34|32|Kazakh',
  'firsttime-13|male|35–44|35|Russian',
  'price-13|female|25–34|32|Russian',
  'rushed-14|male|25–34|34|Russian',
  'careful-14|female|25–34|30|Kazakh',
  'firsttime-14|female|35–44|43|Russian',
  'price-14|female|35–44|43|Kazakh',
  'rushed-15|male|25–34|34|Kazakh',
  'careful-15|female|35–44|37|Kazakh',
  'firsttime-15|female|35–44|38|Russian',
  'price-15|female|35–44|42|Kazakh',
  'rushed-16|female|35–44|35|Russian',
  'careful-16|male|35–44|43|Russian',
  'firsttime-16|female|35–44|43|Kazakh',
  'price-16|male|25–34|34|Kazakh',
  'rushed-17|female|35–44|40|Russian',
  'careful-17|male|35–44|42|Russian',
  'firsttime-17|female|25–34|28|Russian',
  'price-17|male|35–44|41|Russian',
  'rushed-18|male|35–44|42|Kazakh',
  'careful-18|male|25–34|31|Russian',
  'firsttime-18|male|35–44|41|Russian',
  'price-18|female|25–34|33|Kazakh',
  'rushed-19|male|25–34|30|Russian',
  'careful-19|male|25–34|33|Kazakh',
  'firsttime-19|male|25–34|28|Russian',
  'price-19|female|25–34|30|Kazakh',
  'rushed-20|male|25–34|33|Kazakh',
  'careful-20|female|25–34|33|Russian',
  'firsttime-20|female|35–44|41|Kazakh',
  'price-20|female|35–44|38|Kazakh',
  'rushed-21|female|35–44|39|Russian',
  'careful-21|female|25–34|32|Kazakh',
  'firsttime-21|female|25–34|31|Kazakh',
  'price-21|female|25–34|32|Russian',
  'rushed-22|female|25–34|29|Russian',
  'careful-22|male|35–44|42|Kazakh',
  'firsttime-22|female|35–44|41|Kazakh',
  'price-22|female|25–34|32|Russian',
  'rushed-23|female|25–34|28|Kazakh',
  'careful-23|female|25–34|32|Russian',
  'firsttime-23|female|35–44|43|Kazakh',
  'price-23|female|25–34|29|Russian',
  'rushed-24|male|35–44|39|Kazakh',
  'careful-24|male|25–34|31|Russian',
  'firsttime-24|male|25–34|28|Kazakh',
  'price-24|male|25–34|28|Kazakh',
  'rushed-25|male|25–34|33|Kazakh',
  'careful-25|male|35–44|35|Russian',
  'firsttime-25|male|35–44|35|Russian',
  'price-25|male|35–44|42|Kazakh',
];
