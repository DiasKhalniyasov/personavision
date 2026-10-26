/**
 * The areas of interest of a captured screen, and the segmentation seam.
 *
 * `buildAois` is the engine's entry point here; `Segmenter` is the interface the offline
 * heuristic segmenter (#66, the default) and the SAM 3.1 segmenter (#69) implement, each
 * in its own module beside this one. `aoiId` is the id composition both sides share.
 */

export { aoiId } from './aoi-id.js';
export type { AoiIdentity } from './aoi-id.js';

export { buildAois } from './build-aois.js';
export type { BuildAoisInput } from './build-aois.js';

export { heuristicSegmenter } from './heuristic-segmenter.js';
export type { HeuristicSegmenterOptions, ImageReader, RasterImage } from './heuristic-segmenter.js';

export { defaultSegmenter, noSegmenter } from './segmenter.js';
export type { SegmentedArea, Segmenter, SegmenterInput } from './segmenter.js';
