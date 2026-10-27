/**
 * The areas of interest of a captured screen, and the segmentation seam.
 *
 * `buildAois` is the engine's entry point here; `Segmenter` is the interface the offline
 * heuristic segmenter (#66, the default) and the SAM 3.1 segmenter (#69) implement, each
 * in its own module beside this one. `aoiId` is the id composition both sides share.
 *
 * `samSegmenter` is a factory rather than a segmenter: it answers either the SAM path or a
 * stated reason it is unavailable, beside the offline segmenter to use instead. It is
 * additive and nothing here requires it — see `../../docs/sam-segmenter.md`.
 */

export { aoiId, aoiRegionId } from './aoi-id.js';
export type { AoiIdentity } from './aoi-id.js';

export { buildAois } from './build-aois.js';
export type { BuildAoisInput } from './build-aois.js';

export { heuristicSegmenter } from './heuristic-segmenter.js';
export type { HeuristicSegmenterOptions, ImageReader, RasterImage } from './heuristic-segmenter.js';

export {
  DEFAULT_SAM_TIMEOUT_MS,
  SAM_CREDENTIAL_ENV,
  SAM_RESPONSES_ENDPOINT,
  SAM_UNAVAILABLE_REASONS,
  samSegmenter,
  UNNAMED_SEGMENT_LABEL,
} from './sam-segmenter.js';
export type {
  SamContentPart,
  SamHttpRequest,
  SamHttpResponse,
  SamRequestBody,
  SamScreenshotReader,
  SamSegmentation,
  SamSegmenterOptions,
  SamTransport,
  SamUnavailable,
  SamUnavailableReason,
} from './sam-segmenter.js';

export { defaultSegmenter, noSegmenter } from './segmenter.js';
export type { SegmentedArea, Segmenter, SegmenterInput } from './segmenter.js';
