/**
 * Which step of the task a page is on, and which element advances it.
 *
 * Step detection is declarative: a step matches on its URL pattern **and** its required
 * element, both declared by the task. Nothing is inferred from page text, so a session's
 * screens are labelled `cart`, `payment`, `review` or `confirmation` rather than guessed at.
 *
 * **Neutral seam.** Detection returns `null` — the page is on no known step — and the
 * primary action resolves to nothing, leaving the elements as they were. The step-detection
 * ticket of this step fills this file and no other.
 */

import type { CaptureElement, PageHandle, TaskDefinition } from './types.js';

export type DetectStep = (page: PageHandle, task: TaskDefinition) => Promise<string | null>;

export type ResolvePrimaryAction = (
  page: PageHandle,
  elements: readonly CaptureElement[],
  step: string | null,
) => Promise<CaptureElement[]>;

/** The id of the step the page is on, or `null` when it matches none of the task's. */
export const detectStep: DetectStep = async () => null;

/**
 * The same elements, with `isPrimaryAction` set on the one the step declares. A step whose
 * primary action cannot be resolved is an automation failure for the caller to raise, never
 * a silent zero.
 */
export const resolvePrimaryAction: ResolvePrimaryAction = async (_page, elements) => [...elements];
