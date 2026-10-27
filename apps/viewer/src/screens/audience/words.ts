import type { Audience } from '@personavision/contract';

/**
 * The words an audience's facts are stated in.
 *
 * `#screen-audiences` in `docs/design/prototype.html` prints an audience as five short
 * lines — the age range and the regions, the device split, the roles, how price-aware and
 * tech-confident they are, and how many people it generates — and those lines are prose,
 * not fields. This module is where the prose is made, so the card and the form say the same
 * thing and neither spells a band of its own.
 *
 * Nothing here computes a product figure: the two behaviour values are the audience's own,
 * and what is chosen is the **word** for them. The bands are the prototype's: it draws an
 * audience at `techSavviness` 0.55 as *moderately tech-confident* and one at
 * `priceSensitivity` 0.75 as *price-aware*, so those two readings fix the middle band and
 * the ends sit either side of it.
 */

/** Where *price-aware* becomes *price-led*, and where it becomes *price-insensitive*. */
const PRICE_LED = 0.8;
const PRICE_AWARE = 0.4;

/** The same two edges for how tech-confident an audience is. */
const TECH_HIGH = 0.8;
const TECH_MODERATE = 0.4;

/** How much price matters to them, in the prototype's own words. */
export const priceWords = (priceSensitivity: number): string => {
  if (priceSensitivity >= PRICE_LED) return 'Price-led';
  return priceSensitivity >= PRICE_AWARE ? 'Price-aware' : 'Price-insensitive';
};

/** How tech-confident they are, as the second clause of the same line. */
export const techWords = (techSavviness: number): string => {
  if (techSavviness >= TECH_HIGH) return 'highly tech-confident';
  return techSavviness >= TECH_MODERATE ? 'moderately tech-confident' : 'not very tech-confident';
};

/** `Price-aware · moderately tech-confident` — the card's fourth line. */
export const behaviourWords = (audience: Audience): string =>
  `${priceWords(audience.priceSensitivity)} · ${techWords(audience.techSavviness)}`;

/** `25–45`, with the en dash the prototype sets it with. */
export const ageWords = (ageRange: Audience['ageRange']): string =>
  `${String(ageRange.min)}–${String(ageRange.max)}`;

/**
 * A list of things in a sentence: `United Kingdom & Ireland`, `Buy one item quickly,
 * compare prices first and check delivery`. An empty list is not a sentence, so it is the
 * caller's job to say what nothing means — the card prints a dash.
 */
export const listWords = (items: readonly string[], conjunction: string): string => {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] as string}`;
};

/** What the card prints where the audience names none of something. */
export const NOTHING = '—';

/** `60% mobile · 40% desktop`, loudest share first, as the prototype orders it. */
export interface DeviceShare {
  readonly name: string;
  /** The share as whole percentage points, which is how the form takes it too. */
  readonly percent: number;
}

export const deviceShares = (devices: Audience['devices']): readonly DeviceShare[] =>
  [...devices]
    .sort((left, right) => right.share - left.share)
    .map((device) => ({ name: device.name, percent: Math.round(device.share * 100) }));

/** `4 people generated`, which is `size` and is never a session count (decision 1 on #105). */
export const peopleWords = (count: number): string =>
  `${String(count)} ${count === 1 ? 'person' : 'people'} generated`;
