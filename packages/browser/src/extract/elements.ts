/**
 * The candidate elements of a page: interactive controls and text from the DOM and the
 * accessibility tree, each with a stable id, a role, its text and its page-space box.
 *
 * **Neutral seam.** This returns no elements yet, so a capture is geometry and a screenshot
 * and nothing else — which builds, tests and captures. The element-extraction ticket of
 * this step fills this file and no other: the signature below is the contract, and the
 * implementation takes its arguments once it has a use for them.
 */

import type { CaptureElement, Geometry, PageHandle } from '../types.js';

export type ExtractElements = (
  page: PageHandle,
  geometry: Geometry,
  step: string | null,
) => Promise<CaptureElement[]>;

export const extractElements: ExtractElements = async () => [];
