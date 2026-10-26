/**
 * The areas of interest of a captured screen, and the segmentation seam.
 *
 * `buildAois` is the engine's entry point here; `Segmenter` is the interface the offline
 * heuristic segmenter (#66) and the SAM 3.1 segmenter (#69) implement, each in its own
 * module beside this one.
 */

export { aoiId, buildAois } from './build-aois.js';
export type { AoiIdentity, BuildAoisInput } from './build-aois.js';

export { defaultSegmenter, noSegmenter } from './segmenter.js';
export type { Awaitable, SegmentedArea, Segmenter, SegmenterInput } from './segmenter.js';
