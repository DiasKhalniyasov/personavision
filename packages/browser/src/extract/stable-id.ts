/**
 * Element ids that are the same in every session over the same screen.
 *
 * Area-of-interest metrics are aggregated across sessions, seeds, personas **and the two
 * device viewports**, so the id of a control has to be a function of the screen and not of
 * the visit. It is minted from what the page is — the variant and step the screen belongs
 * to, where the element was found, its role, its accessible name and its position in the
 * document — and never read off an attribute: the fixture site deliberately carries no
 * `data-aoi`, because an id handed out by a page would test the wrong thing.
 *
 * Two things are deliberately **not** in the material:
 *
 * - **The element's box.** A pixel position moves with the viewport, and the same control
 *   is read at 390x844 and at 1440x900 in the same run. An id built from a box would mint
 *   two ids for one control and split its dwell between them.
 * - **A hash of the page.** That moves with any edit anywhere on the screen, so a one-word
 *   copy change would retire every id on it.
 *
 * The document position is what tells two otherwise identical controls apart — the fixture
 * site's two `Remove` buttons are the same role and the same name in two places — and it
 * changes only when the markup around the element changes.
 *
 * The name is in the material because a control is partly what it is called, and that has a
 * cost worth stating: a DOM-sourced candidate is named by the words it holds, so a price, a
 * quantity or a countdown that changes mid-session is a new id from that source. The
 * accessibility-sourced candidate for the same control keeps its id as long as the browser's
 * accessible name holds, which is what the aggregated metrics are keyed on.
 */

import { createHash } from 'node:crypto';
import type { CaptureElement } from '../types.js';

/** How much of the hash the id carries: 12 hex characters, 48 bits. */
const ID_LENGTH = 12;

export interface StableElementIdParts {
  /**
   * The variant whose screen this is. `run.json`'s `aoiMetrics` key on the id alone, so two
   * variants of the same markup have to be two areas of interest rather than one.
   */
  readonly variant: string;
  /** The step the screen is, or `null` when the page is on none of the task's. */
  readonly step: string | null;
  readonly source: CaptureElement['source'];
  readonly role: string | null;
  readonly name: string | null;
  /**
   * Where the element sits in the document: the chain of child indexes from the root, which
   * is the same at every viewport and in every session over the same markup.
   */
  readonly path: string;
  /**
   * Which of the otherwise identical elements this is. Nothing on a page should need it —
   * a document position is unique — so the extractor uses it only to step past a hash that
   * is already taken, which keeps the ids of one capture distinct by construction.
   */
  readonly ordinal?: number;
}

/** `e-<12 hex>`, stable for one element of one screen. */
export const stableElementId = (parts: StableElementIdParts): string => {
  const material = [
    parts.variant,
    parts.step ?? '',
    parts.source,
    parts.role ?? '',
    (parts.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
    parts.path,
    String(parts.ordinal ?? 0),
  ].join('\u0000');

  return `e-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, ID_LENGTH)}`;
};
