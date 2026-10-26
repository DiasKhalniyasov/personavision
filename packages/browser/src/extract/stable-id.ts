/**
 * Element ids that are the same in every session over the same screen.
 *
 * Area-of-interest metrics are aggregated across sessions, seeds and personas, so the id of
 * a control has to be a function of the screen and not of the visit. It is minted from what
 * the page is — where the element was found, its role, its accessible name and its
 * page-space box — and never read off an attribute: the fixture site deliberately carries
 * no `data-aoi`, because an id handed out by a page would test the wrong thing.
 *
 * The box is rounded to whole pixels before it is hashed. A sub-pixel layout difference
 * between two runs of the same page would otherwise mint two ids for one control, which
 * would split its dwell in half.
 */

import { createHash } from 'node:crypto';
import type { Box, CaptureElement } from '../types.js';

/** How much of the hash the id carries: 12 hex characters, 48 bits. */
const ID_LENGTH = 12;

export interface StableElementIdParts {
  readonly source: CaptureElement['source'];
  readonly role: string | null;
  readonly name: string | null;
  readonly bbox: Box;
  /**
   * Which of the otherwise identical elements this is, in document order. Two controls can
   * share a role, a name and a box — a duplicated banner, say — and still be two elements.
   */
  readonly ordinal?: number;
}

const round = (value: number): number => Math.round(value);

/** `e-<12 hex>`, stable for one element of one screen. */
export const stableElementId = (parts: StableElementIdParts): string => {
  const { bbox } = parts;
  const material = [
    parts.source,
    parts.role ?? '',
    (parts.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
    `${round(bbox.x)},${round(bbox.y)},${round(bbox.width)},${round(bbox.height)}`,
    String(parts.ordinal ?? 0),
  ].join('\u0000');

  return `e-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, ID_LENGTH)}`;
};
