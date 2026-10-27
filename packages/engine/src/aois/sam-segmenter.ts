import { resolveEngineConfig } from '../config.js';
import type { EngineConfigOverrides } from '../config.js';
import type { BoundingBox, Capture } from '../types.js';
import { aoiId } from './aoi-id.js';
import { defaultSegmenter } from './segmenter.js';
import type { SegmentedArea, Segmenter, SegmenterInput } from './segmenter.js';

/**
 * The SAM 3.1 `Segmenter`: the regions the DOM does not explain, from the Meta Model API.
 *
 * It is the **second** implementation of the seam and strictly additive. The offline
 * heuristic segmenter (#66) stays the default — the demo, CI and a cold clone with no
 * credential build exactly the areas they built before this module existed — and nothing
 * here is required for a green build, a passing test run or the demo. Two rules make that
 * true rather than hoped for, and both are tested:
 *
 * **Unavailable is a sentence, not a crash and not an empty answer.** `samSegmenter` is a
 * factory that returns a *result*: either the SAM segmenter, or a stated
 * `SamUnavailable` — a reason and a readable message — beside the offline segmenter to use
 * instead. A run with no credential, a run that never asked for the model path, a timeout,
 * a network error and a reply that will not parse all take that road. None of them throws,
 * and none of them answers "no regions", which would read as a screen with nothing on it
 * rather than as segmentation that did not happen.
 *
 * **The engine opens no socket and reads no file.** `packages/engine` is pure, and
 * `tests/config.test.ts` asserts it over these sources: no module here may name
 * the file-system module, a socket, or the global that sends an HTTP request — and the scan
 * is a plain substring check, so this sentence may not spell those names either. The HTTP
 * call and the
 * screenshot read are *injected* — `SamTransport` and `SamScreenshotReader` — which is
 * also what makes the mapping testable against a recorded response with no network. A run
 * loop passes a transport built on Node's built-in `fetch` and a reader built on
 * `readFile`; `docs/sam-segmenter.md` carries both, and the one live test in this package
 * builds them itself.
 *
 * **Deterministic.** Everything but the call is a function of the response and the
 * capture: the same recorded reply gives byte-identical areas, ids and order. The one
 * ordering input that is *not* the geometry — the order the service happened to list its
 * masks in — is discarded by the largest-first cut and the reading-order sort, exactly as
 * #66 discards its traversal order.
 *
 * **The wire shape is provisional.** The owner has deferred SAM 3.1 (#69), so the request
 * and response shape below is written from the responses protocol and the model's
 * documented output and has *not* been confirmed against a live call. Everything in this
 * module is additive, so an envelope that turns out to differ costs one `unavailable`
 * result and a corrected parser — never a failed run. `docs/sam-segmenter.md` says so in
 * the same words, and the live test is opt-in so that no key alone can start calling it.
 */

/**
 * The environment variable the credential lives in — the *name*, which is public. The
 * engine never reads it: `tests/workspace.test.ts` sanctions exactly one place in the
 * project to read a credential out of the environment, and this is not it. The caller
 * reads it there and hands the value to `samSegmenter` as `credential`, which puts it in
 * one `Authorization` header; it appears in no message this module emits, no error it
 * throws and no area it returns. See `docs/sam-segmenter.md` and #43.
 */
export const SAM_CREDENTIAL_ENV = 'MODEL_API_KEY';

/** The responses protocol: https://dev.meta.ai/docs/protocols/responses */
export const SAM_RESPONSES_ENDPOINT = 'https://api.meta.ai/v1/responses';

/** How long one screen's segmentation may take before it is our own timeout. */
export const DEFAULT_SAM_TIMEOUT_MS = 60_000;

/** What a label reads when the response named a mask nothing at all. */
export const UNNAMED_SEGMENT_LABEL = 'Unnamed segment';

/** The image media types a screenshot may be sent as, by file extension. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const DEFAULT_MEDIA_TYPE = MEDIA_TYPES['png'] as string;

/** One part of the message sent: the instruction, or the screenshot as a data URL. */
export type SamContentPart =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string };

export interface SamRequestBody {
  /** The segmentation model id, exactly as `run.json`'s `engine.models.segmentation` spells it. */
  readonly model: string;
  readonly input: readonly { readonly role: 'user'; readonly content: readonly SamContentPart[] }[];
}

/**
 * One HTTP call, as this module hands it to whatever sends it. The headers are here
 * because the sender needs them and nowhere else: the credential is in them, so a request
 * is never handed to anything but the transport.
 */
export interface SamHttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: SamRequestBody;
  /** Aborted when this module's own timeout runs out. */
  readonly signal: AbortSignal;
}

export interface SamHttpResponse {
  readonly status: number;
  /** The parsed body, or the raw text when it was not JSON — whatever came back, verbatim. */
  readonly body: unknown;
}

/**
 * How a request is sent. A test passes a function and asserts against what it was given; a
 * run passes one built on Node's built-in `fetch`. There is no default, because a default
 * would put a socket inside a package that promises not to open one.
 */
export type SamTransport = (request: SamHttpRequest) => Promise<SamHttpResponse>;

/**
 * How the screenshot's bytes are obtained — the encoded file, not pixels, since they are
 * sent as they are. Injected for the same reason the transport is.
 */
export type SamScreenshotReader = (screenshotPath: string) => Uint8Array | Promise<Uint8Array>;

/** Every way the SAM path can be unavailable. Each one ends in the offline segmenter. */
export const SAM_UNAVAILABLE_REASONS = [
  /** The run did not ask for the model path: `engine.mode` is not `model`. */
  'mode',
  /** No segmentation model id, no transport or no screenshot reader was given. */
  'configuration',
  /** No credential in the environment. */
  'credential',
  /** The transport rejected: DNS, connection, TLS — anything that never reached a reply. */
  'transport',
  /** Our own timeout ran out first. */
  'timeout',
  /** A reply arrived, with a status that is not 2xx. */
  'http_status',
  /** A 2xx reply that holds no mask this module can turn into a rectangle. */
  'unparseable',
] as const;

export type SamUnavailableReason = (typeof SAM_UNAVAILABLE_REASONS)[number];

/**
 * Why the SAM path is not being used, in a form a caller can log, show or assert on.
 *
 * `message` is written here and never quotes a header, so no credential can reach a log
 * line through it.
 */
export interface SamUnavailable {
  readonly reason: SamUnavailableReason;
  readonly message: string;
}

/**
 * What `samSegmenter` answers. `segmenter` is usable either way — the SAM one when it is
 * available, the offline one when it is not — so a caller that does not care can use it
 * without branching, and one that does reports `unavailable.message`.
 */
export type SamSegmentation =
  | {
      readonly available: true;
      readonly modelId: string;
      readonly segmenter: Segmenter;
    }
  | {
      readonly available: false;
      readonly unavailable: SamUnavailable;
      /** The offline heuristic segmenter, or whatever `fallback` named. */
      readonly segmenter: Segmenter;
    };

export interface SamSegmenterOptions {
  /** `run.json`'s `engine.mode`. Anything but `model` means the SAM path is not asked for. */
  readonly mode?: 'offline' | 'model';
  /** `run.json`'s `engine.models.segmentation`. Absent, blank or null is not configured. */
  readonly modelId?: string | null;
  /** How a request is sent. Absent means not configured — never a socket opened by default. */
  readonly transport?: SamTransport;
  /** How the screenshot's bytes are read. Absent means not configured. */
  readonly readScreenshot?: SamScreenshotReader;
  /**
   * The credential, as the caller's own sanctioned environment read handed it over —
   * `SAM_CREDENTIAL_ENV` names the variable it comes from. Absent or blank is reason
   * `credential`, which is the no-key road: a stated result and the offline segmenter.
   */
  readonly credential?: string;
  /** The run directory `capture.screenshot` is relative to, as #66's option of that name. */
  readonly runDir?: string;
  /** Defaults to `DEFAULT_SAM_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to `SAM_RESPONSES_ENDPOINT`. */
  readonly endpoint?: string;
  /** What is used instead when SAM is unavailable. Defaults to the offline segmenter. */
  readonly fallback?: Segmenter;
  /** Layered over the engine defaults; only `segmentation.maxRegions` is read here. */
  readonly config?: EngineConfigOverrides;
  /**
   * Where a *call's* unavailability goes. The factory's result states the ones it can see
   * up front; a timeout or a torn connection happens later, and this is how it is said
   * rather than swallowed. The call still answers with the fallback's areas.
   */
  readonly report?: (unavailable: SamUnavailable) => void;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const intersects = (a: BoundingBox, b: BoundingBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The first `masks` array in the reply, found depth-first in document order.
 *
 * The envelope around it is the part of the protocol this ticket could not confirm, so the
 * parser does not insist on one: whether the masks arrive at the top level, under
 * `output`, or inside a content part, they are found and they are found deterministically
 * — `JSON.parse` preserves document order, and this walks values in exactly that order.
 * No `masks` array at all is `unparseable`, which is the honest answer for a reply nobody
 * here understands.
 */
const findMasks = (body: unknown): readonly unknown[] | null => {
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = findMasks(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(body)) return null;
  if (Array.isArray(body['masks'])) return body['masks'] as readonly unknown[];
  for (const value of Object.values(body)) {
    const found = findMasks(value);
    if (found !== null) return found;
  }
  return null;
};

/** The bounding rectangle of a list of `[x, y]` points, or `null` if there are none. */
const rectangleOfPolygon = (points: readonly unknown[]): BoundingBox | null => {
  const pairs = points
    .map((point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      isFiniteNumber(point[0]) &&
      isFiniteNumber(point[1])
        ? ([point[0], point[1]] as const)
        : null,
    )
    .filter((pair): pair is readonly [number, number] => pair !== null);
  if (pairs.length === 0) return null;

  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/**
 * One mask as a rectangle in the screenshot's pixel space, in whichever of the three
 * spellings it arrived in: `[x0, y0, x1, y1]`, `{ x, y, width, height }`, or the mask's own
 * polygon. A run-length-encoded mask is *not* decoded — there is no pixel work in the
 * engine — so one that carries nothing but RLE is dropped, which is why a reply whose every
 * mask is undecodable is reported as `unparseable` rather than as an empty segmentation.
 */
const rectangleOfMask = (mask: Record<string, unknown>): BoundingBox | null => {
  const box = mask['box'] ?? mask['bbox'];
  if (Array.isArray(box) && box.length === 4 && box.every(isFiniteNumber)) {
    const [left = 0, top = 0, right = 0, bottom = 0] = box as readonly number[];
    return {
      x: Math.min(left, right),
      y: Math.min(top, bottom),
      width: Math.abs(right - left),
      height: Math.abs(bottom - top),
    };
  }
  if (isRecord(box) && [box['x'], box['y'], box['width'], box['height']].every(isFiniteNumber)) {
    return {
      x: box['x'] as number,
      y: box['y'] as number,
      width: box['width'] as number,
      height: box['height'] as number,
    };
  }
  const polygon = mask['polygon'] ?? mask['points'];
  return Array.isArray(polygon) ? rectangleOfPolygon(polygon) : null;
};

/**
 * The part of a mask's rectangle that is on the page, rounded to whole pixels.
 *
 * A model works in the image it was given and can answer half a pixel outside it, so a
 * rectangle is **clipped** to the page rather than trusted: `0, 0` to the viewport's width
 * and the capture's page height. One that lies wholly outside the page, or that has no
 * extent left once it is clipped and rounded, is dropped — the stated rule for a mask
 * outside the page. Rounding is here and not in the id, because a mask edge is a pixel
 * boundary and the area in the artifact should read the same as the id derived from it.
 */
const clippedToPage = (bbox: BoundingBox, capture: Capture): BoundingBox | null => {
  const left = Math.round(Math.max(bbox.x, 0));
  const top = Math.round(Math.max(bbox.y, 0));
  const right = Math.round(Math.min(bbox.x + bbox.width, capture.viewport.width));
  const bottom = Math.round(Math.min(bbox.y + bbox.height, capture.pageHeight));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * What the region is called: what the model called it, or `UNNAMED_SEGMENT_LABEL`.
 *
 * The model's own word is the readable label the ticket asks for — "hero image" reads in
 * the areas-of-interest table where "region-7" does not — and it is capitalised the way
 * #66 capitalises its geometric labels so the two sides of the seam read alike.
 */
const labelOfMask = (mask: Record<string, unknown>): string => {
  const named = trimmed(mask['label']) || trimmed(mask['name']) || trimmed(mask['category']);
  return named === '' ? UNNAMED_SEGMENT_LABEL : named.charAt(0).toUpperCase() + named.slice(1);
};

/** Largest first, then down the page and across, so the cut to `maxRegions` is total. */
const byAreaThenPosition = (a: SegmentedArea, b: SegmentedArea): number =>
  b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height ||
  a.bbox.y - b.bbox.y ||
  a.bbox.x - b.bbox.x ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const inReadingOrder = (a: SegmentedArea, b: SegmentedArea): number =>
  a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The outcome of reading one reply: the regions, or why the reply could not be read. */
type Mapped = { readonly areas: readonly SegmentedArea[] } | { readonly failed: SamUnavailable };

/**
 * A reply's masks as areas of interest — the whole of this module that a test without a
 * network exercises.
 *
 * The rules, each of them tested: a mask outside the page is dropped, one that straddles
 * the page edge is clipped, and one that **overlaps an area the capture's elements
 * explain** is dropped rather than shrunk — the same rule #66 states, because an area of
 * interest overlapping a control would split that control's dwell. Two masks that map to
 * one id are one region. What survives is cut to `segmentation.maxRegions`, largest first,
 * and returned in reading order.
 */
const mapMasks = (body: unknown, input: SegmenterInput, maxRegions: number): Mapped => {
  const masks = findMasks(body);
  if (masks === null) {
    return { failed: { reason: 'unparseable', message: 'the reply holds no masks array' } };
  }

  const explained = input.explained.map((area) => area.bbox);
  const byId = new Map<string, SegmentedArea>();
  let undecodable = 0;

  for (const mask of masks) {
    if (!isRecord(mask)) {
      undecodable += 1;
      continue;
    }
    const rectangle = rectangleOfMask(mask);
    if (rectangle === null) {
      undecodable += 1;
      continue;
    }
    const bbox = clippedToPage(rectangle, input.capture);
    if (bbox === null || explained.some((box) => intersects(bbox, box))) continue;

    const label = labelOfMask(mask);
    const id = aoiId({
      variant: input.variant,
      step: input.capture.step,
      role: null,
      label,
      bbox,
    });
    if (!byId.has(id)) byId.set(id, { id, label, role: null, bbox });
  }

  if (byId.size === 0 && undecodable > 0) {
    return {
      failed: {
        reason: 'unparseable',
        message: `none of the ${masks.length} masks in the reply carries a box or a polygon`,
      },
    };
  }

  return {
    areas: [...byId.values()]
      .sort(byAreaThenPosition)
      .slice(0, Math.max(0, Math.round(maxRegions)))
      .sort(inReadingOrder),
  };
};

const mediaTypeOf = (screenshotPath: string): string => {
  const extension = screenshotPath.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? DEFAULT_MEDIA_TYPE;
};

/** `capture.screenshot` resolved against the run directory, as #66 resolves it. */
const screenshotPathOf = (capture: Capture, runDir: string | undefined): string =>
  runDir === undefined || capture.screenshot.startsWith('/')
    ? capture.screenshot
    : `${runDir.replace(/\/+$/, '')}/${capture.screenshot}`;

/**
 * What the model is asked, in words: segment what the elements did not explain.
 *
 * The explained boxes are in the request because they are the question. Sending the
 * screenshot alone would ask for every region on the page, and the regions this seam wants
 * are the ones the DOM is silent about.
 */
const instructionFor = (input: SegmenterInput): string => {
  const { capture, explained } = input;
  const boxes = explained.map(
    (area) =>
      `${area.label}: ${Math.round(area.bbox.x)},${Math.round(area.bbox.y)} ${Math.round(area.bbox.width)}x${Math.round(area.bbox.height)}`,
  );
  return [
    'Segment the visually distinct regions of this web page screenshot that are NOT already',
    `covered by the listed elements. The image is the full page: ${capture.viewport.width} by`,
    `${capture.pageHeight} pixels, with the fold at y=${capture.foldY}.`,
    'Answer with a "masks" array; give every mask a "box" as [x0, y0, x1, y1] in image pixels',
    'and a short "label" a designer would recognise, such as "hero image" or "product card".',
    explained.length === 0
      ? 'No elements were reported for this screen.'
      : `Already explained (label: x,y WxH): ${boxes.join('; ')}.`,
  ].join(' ');
};

/** The message that carries the instruction and the screenshot. */
const requestBodyFor = (
  modelId: string,
  input: SegmenterInput,
  screenshot: Uint8Array,
  screenshotPath: string,
): SamRequestBody => ({
  model: modelId,
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: instructionFor(input) },
        {
          type: 'input_image',
          image_url: `data:${mediaTypeOf(screenshotPath)};base64,${Buffer.from(screenshot).toString('base64')}`,
        },
      ],
    },
  ],
});

/**
 * A thrown transport failure as a stated one. An abort is our own timeout; everything else
 * never reached a reply. The error's own message is kept — it is ours or the platform's,
 * and no request header passes through here — so a caller reading a log can see what
 * happened.
 */
const transportFailure = (error: unknown, signal: AbortSignal): SamUnavailable => {
  const message = error instanceof Error ? error.message : String(error);
  return signal.aborted
    ? { reason: 'timeout', message: `the segmentation call timed out: ${message}` }
    : { reason: 'transport', message: `the segmentation call failed: ${message}` };
};

/**
 * The SAM 3.1 segmentation path, or a stated reason it is unavailable and the offline
 * segmenter to use instead.
 *
 * Selection is by configuration and nothing ambient: a run gets this path only when it
 * asked for the model engine (`engine.mode: 'model'`), named a segmentation model
 * (`engine.models.segmentation`), was given a transport and a screenshot reader, and was
 * handed the credential. A miss on any one of those is a `SamUnavailable` with the reason —
 * not an exception, and not a segmenter that would quietly answer nothing.
 */
export const samSegmenter = (options: SamSegmenterOptions = {}): SamSegmentation => {
  const fallback = options.fallback ?? defaultSegmenter;
  const unavailable = (reason: SamUnavailableReason, message: string): SamSegmentation => ({
    available: false,
    unavailable: { reason, message },
    segmenter: fallback,
  });

  if (options.mode !== 'model') {
    return unavailable('mode', 'this run did not ask for the model engine, so SAM 3.1 is not used');
  }

  const modelId = trimmed(options.modelId);
  if (modelId === '') {
    return unavailable('configuration', 'no segmentation model is configured for this run');
  }

  const { transport, readScreenshot } = options;
  if (transport === undefined || readScreenshot === undefined) {
    return unavailable(
      'configuration',
      'the SAM 3.1 segmenter needs a transport and a screenshot reader, which the engine does not provide itself',
    );
  }

  const credential = trimmed(options.credential);
  if (credential === '') {
    return unavailable(
      'credential',
      `no ${SAM_CREDENTIAL_ENV} was handed to the segmenter, so the SAM 3.1 path is unavailable and the offline segmenter is used instead`,
    );
  }

  const { config } = resolveEngineConfig(options.config);
  const maxRegions = config.segmentation.maxRegions;
  const endpoint = options.endpoint ?? SAM_RESPONSES_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAM_TIMEOUT_MS;
  const report = options.report ?? ((): void => {});

  const segmenter: Segmenter = {
    segment: async (input: SegmenterInput): Promise<readonly SegmentedArea[]> => {
      const give = async (failure: SamUnavailable): Promise<readonly SegmentedArea[]> => {
        report(failure);
        return fallback.segment(input);
      };

      const screenshotPath = screenshotPathOf(input.capture, options.runDir);
      let body: SamRequestBody;
      try {
        body = requestBodyFor(modelId, input, await readScreenshot(screenshotPath), screenshotPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return give({
          reason: 'transport',
          message: `the screenshot could not be read: ${message}`,
        });
      }

      // The credential goes in one header and nowhere else: the request is handed to the
      // transport and to nothing that records, logs or reports.
      const signal = AbortSignal.timeout(timeoutMs);
      let response: SamHttpResponse;
      try {
        response = await transport({
          url: endpoint,
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
          },
          body,
          signal,
        });
      } catch (error) {
        return give(transportFailure(error, signal));
      }

      if (response.status < 200 || response.status >= 300) {
        return give({
          reason: 'http_status',
          message: `the segmentation call answered HTTP ${response.status}`,
        });
      }

      const mapped = mapMasks(response.body, input, maxRegions);
      return 'failed' in mapped ? give(mapped.failed) : mapped.areas;
    },
  };

  return { available: true, modelId, segmenter };
};
