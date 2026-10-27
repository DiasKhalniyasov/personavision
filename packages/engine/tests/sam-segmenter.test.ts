import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAois } from '../src/aois/build-aois.js';
import {
  DEFAULT_SAM_TIMEOUT_MS,
  SAM_CREDENTIAL_ENV,
  SAM_RESPONSES_ENDPOINT,
  samSegmenter,
  UNNAMED_SEGMENT_LABEL,
} from '../src/aois/sam-segmenter.js';
import type {
  SamHttpRequest,
  SamHttpResponse,
  SamSegmenterOptions,
  SamSegmentation,
  SamTransport,
  SamUnavailable,
} from '../src/aois/sam-segmenter.js';
import type { SegmentedArea, Segmenter, SegmenterInput } from '../src/aois/segmenter.js';
import { FIXTURES_DIR, loadFixture } from './fixtures/index.js';

/**
 * #69: the SAM 3.1 segmenter, additive and never required.
 *
 * Every test here runs with **no network and no credential of the owner's**: the HTTP call
 * is an injected transport and the screenshot read is an injected reader, so what is
 * asserted is the mapping, the stated rules and the fallback — the three things that have
 * to hold whether or not anybody ever turns the live path on. The one test that would call
 * the real service is opt-in and skips visibly; see the bottom of this file.
 *
 * The recorded reply is `sam-response.fixture.json`. It is written to the responses
 * protocol's envelope and the model's documented mask output, and the owner has deferred
 * SAM 3.1 (#69), so it has **not** been confirmed against a live call. That is exactly why
 * the parser is tolerant about the envelope and reports `unparseable` rather than
 * inventing areas, and why the live test cannot be started by a key alone.
 */

const TEST_KEY = 'sam-test-key-not-a-credential';

const RECORDED: unknown = JSON.parse(
  readFileSync(new URL('sam-response.fixture.json', import.meta.url), 'utf8'),
);

/** The shared fixture whose cards the DOM reports nothing for: the segmenter has work. */
const fixture = loadFixture('card-grid-unexplained');
const VARIANT = 'A';

/** The screenshot's bytes, without going near the committed file. */
const readScreenshot = (): Uint8Array => Uint8Array.from([137, 80, 78, 71]);

/** A transport that answers one recorded reply and records what it was asked. */
const answering = (
  body: unknown,
  status = 200,
): { readonly transport: SamTransport; readonly requests: SamHttpRequest[] } => {
  const requests: SamHttpRequest[] = [];
  const transport: SamTransport = async (request): Promise<SamHttpResponse> => {
    requests.push(request);
    return { status, body };
  };
  return { transport, requests };
};

/** A stand-in for the offline segmenter, so a fallback can be told apart by its answer. */
const FALLBACK_AREA: SegmentedArea = {
  id: 'fallback-region',
  label: 'Offline region',
  role: null,
  bbox: { x: 8, y: 300, width: 64, height: 40 },
};
const fallback: Segmenter = { segment: () => [FALLBACK_AREA] };

const input: SegmenterInput = {
  capture: fixture.capture,
  variant: VARIANT,
  explained: [],
};

/** The element-derived areas of the fixture, as `buildAois` hands them to a segmenter. */
const withExplained = async (): Promise<SegmenterInput> => ({
  ...input,
  explained: await buildAois({
    capture: fixture.capture,
    variant: VARIANT,
    segmenter: { segment: () => [] },
  }),
});

const configured = (overrides: Partial<SamSegmenterOptions> = {}): SamSegmentation =>
  samSegmenter({
    mode: 'model',
    modelId: 'sam-3.1',
    credential: TEST_KEY,
    readScreenshot,
    fallback,
    ...overrides,
  });

/** The SAM segmenter, or a failure naming why the factory would not give one. */
const available = (segmentation: SamSegmentation): Segmenter => {
  if (!segmentation.available) {
    throw new Error(`expected the SAM path to be available: ${segmentation.unavailable.message}`);
  }
  return segmentation.segmenter;
};

const unavailable = (segmentation: SamSegmentation): SamUnavailable => {
  if (segmentation.available) throw new Error('expected the SAM path to be unavailable');
  return segmentation.unavailable;
};

describe('selection: configuration, never ambient magic', () => {
  it('is unavailable with no credential, and hands back the offline segmenter', async () => {
    const { transport, requests } = answering(RECORDED);
    const segmentation = samSegmenter({
      mode: 'model',
      modelId: 'sam-3.1',
      transport,
      readScreenshot,
    });

    expect(unavailable(segmentation).reason).toBe('credential');
    expect(unavailable(segmentation).message).toContain(SAM_CREDENTIAL_ENV);
    expect(requests).toEqual([]);
  });

  it('falls back to an offline segmenter that can find the screenshot it is given', async () => {
    // The commonest road of the lot, and the one the fallback has to really work on: no
    // credential. A capture's screenshot path is run-directory-relative, so a fallback
    // built without the run directory would answer nothing and "falls back to the offline
    // segmenter" would mean no segmentation at all.
    const { transport } = answering(RECORDED);
    const segmentation = samSegmenter({
      mode: 'model',
      modelId: 'sam-3.1',
      transport,
      readScreenshot,
      runDir: FIXTURES_DIR,
    });

    expect(unavailable(segmentation).reason).toBe('credential');

    const areas = await buildAois({
      capture: { ...fixture.capture, screenshot: 'card-grid-unexplained.png' },
      variant: VARIANT,
      segmenter: segmentation.segmenter,
    });
    expect(areas.some((area) => area.source === 'sam')).toBe(true);
  });

  it('is unavailable when the run did not ask for the model engine', () => {
    expect(unavailable(configured({ mode: 'offline' })).reason).toBe('mode');
    expect(unavailable(samSegmenter()).reason).toBe('mode');
  });

  it('is unavailable with no segmentation model and with no transport', () => {
    const { transport } = answering(RECORDED);

    expect(unavailable(configured({ modelId: null, transport })).reason).toBe('configuration');
    expect(unavailable(configured({ modelId: '  ', transport })).reason).toBe('configuration');
    expect(unavailable(configured({ transport: undefined })).reason).toBe('configuration');
    expect(unavailable(configured({ transport, readScreenshot: undefined })).reason).toBe(
      'configuration',
    );
  });

  it('names the model it will call when everything is in place', () => {
    const { transport } = answering(RECORDED);
    const segmentation = configured({ transport });

    expect(segmentation.available).toBe(true);
    expect(segmentation.available && segmentation.modelId).toBe('sam-3.1');
  });
});

describe('the recorded reply, mapped with no network', () => {
  it('maps masks to areas inside the page, with stable ids and readable labels', async () => {
    const { transport, requests } = answering(RECORDED);
    const areas = await available(configured({ transport })).segment(await withExplained());

    expect(areas).toEqual([
      {
        id: 'a-card-grid-unexplained-region-promo-tile-300-60-120x40',
        label: 'Promo tile',
        role: null,
        bbox: { x: 300, y: 60, width: 120, height: 40 },
      },
      {
        id: 'a-card-grid-unexplained-region-product-card-grid-16-112-448x232',
        label: 'Product card grid',
        role: null,
        bbox: { x: 16, y: 112, width: 448, height: 232 },
      },
      {
        id: 'a-card-grid-unexplained-region-footer-strip-0-330-480x30',
        label: 'Footer strip',
        role: null,
        bbox: { x: 0, y: 330, width: 480, height: 30 },
      },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(SAM_RESPONSES_ENDPOINT);
    expect(requests[0]?.body.model).toBe('sam-3.1');
  });

  it('tags them source "sam" once buildAois has them', async () => {
    const { transport } = answering(RECORDED);
    const areas = await buildAois({
      capture: fixture.capture,
      variant: VARIANT,
      segmenter: available(configured({ transport })),
    });

    expect(areas.filter((area) => area.source === 'sam').map((area) => area.label)).toEqual([
      'Promo tile',
      'Product card grid',
      'Footer strip',
    ]);
    expect(areas.some((area) => area.source === 'sam' && area.isPrimaryAction)).toBe(false);
  });

  it('is deterministic: the same reply gives identical areas, ids and order', async () => {
    const first = await available(configured({ transport: answering(RECORDED).transport })).segment(
      input,
    );
    const second = await available(
      configured({ transport: answering(RECORDED).transport }),
    ).segment(input);

    expect(second).toEqual(first);
    expect(second.map((area) => area.id)).toEqual(first.map((area) => area.id));
  });

  it('drops a mask outside the page and clips one that straddles its edge', async () => {
    const { transport } = answering(RECORDED);
    const areas = await available(configured({ transport })).segment(input);
    const labels = areas.map((area) => area.label);

    // `off-page banner` is wholly past the page, and `hairline` has no extent at all.
    expect(labels).not.toContain('Off-page banner');
    expect(labels).not.toContain('Hairline');
    // `footer strip` reaches to x=-20 and y=420 on a 480x360 page, and is clipped to it.
    const footer = areas.find((area) => area.label === 'Footer strip');
    expect(footer?.bbox).toEqual({ x: 0, y: 330, width: 480, height: 30 });
  });

  it('drops a mask that overlaps an area the elements explain', async () => {
    const { transport } = answering(RECORDED);
    const areas = await available(configured({ transport })).segment(await withExplained());

    // The reply's `page heading` mask covers the fixture's heading element.
    expect(areas.map((area) => area.label)).not.toContain('Page heading');
    expect(areas.map((area) => area.label)).toContain('Product card grid');
  });

  it('counts two masks that round to one rectangle as one region', async () => {
    const { transport } = answering(RECORDED);
    const areas = await available(configured({ transport })).segment(input);

    expect(areas.filter((area) => area.label === 'Product card grid')).toHaveLength(1);
  });

  it('labels a mask the reply named nothing, rather than leaving it blank', async () => {
    const { transport } = answering({ masks: [{ box: [100, 100, 200, 180] }] });
    const areas = await available(configured({ transport })).segment(input);

    expect(areas.map((area) => area.label)).toEqual([UNNAMED_SEGMENT_LABEL]);
  });

  it('reads mask coordinates in image pixels, not CSS pixels, on a scaled capture', async () => {
    // The browser step captures with `scale: 'device'`, so a persona on a device whose
    // scale factor is three hands over an image three times the page's size and the model
    // answers in that image's pixels. The same region, stated at both scales, maps to one
    // area — and the instruction tells the model the size of the image it was actually
    // shown.
    const atOne = answering({ masks: [{ label: 'product card grid', box: [16, 112, 464, 344] }] });
    const atThree = answering({
      masks: [{ label: 'product card grid', box: [48, 336, 1392, 1032] }],
    });

    const unscaled = await available(configured({ transport: atOne.transport })).segment(input);
    const scaled = await available(
      configured({ transport: atThree.transport, imageScale: 3 }),
    ).segment(input);

    expect(scaled).toEqual(unscaled);
    expect(scaled[0]?.bbox).toEqual({ x: 16, y: 112, width: 448, height: 232 });

    const sent = atThree.requests[0]?.body.input[0]?.content ?? [];
    const text = sent.find((part) => part.type === 'input_text');
    expect(text?.type === 'input_text' && text.text).toContain('1440 by 1080 image pixels');
  });

  it('reads a "bbox" as extents and a "box" as corners, which is what each one means', async () => {
    const { transport } = answering({
      masks: [{ label: 'promo tile', bbox: [300, 60, 120, 40] }],
    });
    const areas = await available(configured({ transport })).segment(input);

    expect(areas[0]?.bbox).toEqual({ x: 300, y: 60, width: 120, height: 40 });
  });

  it('asks the model for the regions the elements did not explain', async () => {
    const { transport, requests } = answering(RECORDED);
    await available(configured({ transport })).segment(await withExplained());

    const sent = requests[0]?.body.input[0]?.content ?? [];
    const text = sent.find((part) => part.type === 'input_text');
    expect(text?.type === 'input_text' && text.text).toContain('Boots for every trail');
    const image = sent.find((part) => part.type === 'input_image');
    expect(image?.type === 'input_image' && image.image_url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('every failure is a stated reason and the offline fallback', () => {
  const segmentWith = (
    segmentation: SamSegmentation,
    given: SegmenterInput = input,
  ): Promise<readonly SegmentedArea[]> => Promise.resolve(available(segmentation).segment(given));

  it('reports a transport error and answers with the fallback', async () => {
    const reports: SamUnavailable[] = [];
    const transport: SamTransport = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const areas = await segmentWith(
      configured({ transport, report: (one) => void reports.push(one) }),
    );

    expect(reports.map((one) => one.reason)).toEqual(['transport']);
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('reports our own timeout as a timeout', async () => {
    const reports: SamUnavailable[] = [];
    const transport: SamTransport = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      });
    const areas = await segmentWith(
      configured({ transport, timeoutMs: 1, report: (one) => void reports.push(one) }),
    );

    expect(reports.map((one) => one.reason)).toEqual(['timeout']);
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('reports a non-2xx status', async () => {
    const reports: SamUnavailable[] = [];
    const { transport } = answering({ error: { message: 'service unavailable' } }, 503);
    const areas = await segmentWith(
      configured({ transport, report: (one) => void reports.push(one) }),
    );

    expect(reports.map((one) => one.reason)).toEqual(['http_status']);
    expect(reports[0]?.message).toContain('503');
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('reports a malformed reply rather than presenting an empty segmentation', async () => {
    const reports: SamUnavailable[] = [];
    const { transport } = answering({
      output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
    });
    const areas = await segmentWith(
      configured({ transport, report: (one) => void reports.push(one) }),
    );

    expect(reports.map((one) => one.reason)).toEqual(['unparseable']);
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('reports masks it cannot turn into rectangles, and keeps an honest empty answer empty', async () => {
    const undecodable: SamUnavailable[] = [];
    const { transport: rle } = answering({
      masks: [{ label: 'ribbon', rle: { counts: 'Xk3a1' } }],
    });
    expect(
      await segmentWith(
        configured({ transport: rle, report: (one) => void undecodable.push(one) }),
      ),
    ).toEqual([FALLBACK_AREA]);
    expect(undecodable.map((one) => one.reason)).toEqual(['unparseable']);

    // A reply that found nothing is not a failure: it is a screen with no unexplained
    // region on it, and it is reported as nothing rather than as the fallback's areas.
    const empty: SamUnavailable[] = [];
    const { transport: none } = answering({ masks: [] });
    expect(
      await segmentWith(configured({ transport: none, report: (one) => void empty.push(one) })),
    ).toEqual([]);
    expect(empty).toEqual([]);
  });

  it('reports a reply whose masks were all dropped rather than answering nothing', async () => {
    // Every mask well-formed, every one of them off the page — the shape a wrong image
    // scale or a different wire format takes. Answering `[]` here would read as a screen
    // with nothing on it; it is reported, and the call answers with the fallback's areas.
    const reports: SamUnavailable[] = [];
    const { transport } = answering({
      masks: [
        { label: 'off-page banner', box: [480, 400, 620, 520] },
        { label: 'further still', box: [900, 900, 1000, 1000] },
      ],
    });
    const areas = await segmentWith(
      configured({ transport, report: (one) => void reports.push(one) }),
    );

    expect(reports.map((one) => one.reason)).toEqual(['unparseable']);
    expect(reports[0]?.message).toContain('all 2 masks');
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('reports a screenshot it could not read, and never throws', async () => {
    const reports: SamUnavailable[] = [];
    const { transport, requests } = answering(RECORDED);
    const areas = await available(
      configured({
        transport,
        readScreenshot: () => {
          throw new Error('ENOENT: no such file');
        },
        report: (one) => void reports.push(one),
      }),
    ).segment(input);

    expect(reports.map((one) => one.reason)).toEqual(['transport']);
    expect(requests).toEqual([]);
    expect(areas).toEqual([FALLBACK_AREA]);
  });

  it('never breaks buildAois, whatever it does', async () => {
    const transport: SamTransport = async () => {
      throw new Error('torn connection');
    };
    const segmentation = configured({ transport, fallback: { segment: () => [] } });
    const areas = await buildAois({
      capture: fixture.capture,
      variant: VARIANT,
      segmenter: available(segmentation),
    });

    expect(areas.map((area) => area.source)).toEqual(['dom', 'dom']);
  });
});

describe('the credential', () => {
  it('goes in one header and reaches nothing else', async () => {
    const reports: SamUnavailable[] = [];
    const { transport, requests } = answering(RECORDED);
    const areas = await available(
      configured({ transport, report: (one) => void reports.push(one) }),
    ).segment(input);

    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.stringify(areas)).not.toContain(TEST_KEY);
    expect(JSON.stringify(reports)).not.toContain(TEST_KEY);
    // Nor does the request body, which is the only part of a call anything else may see.
    expect(JSON.stringify(requests[0]?.body)).not.toContain(TEST_KEY);
  });

  it('is named, not held: the module exports the name and reads no environment', () => {
    expect(SAM_CREDENTIAL_ENV).toBe('MODEL_API_KEY');
    expect(DEFAULT_SAM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

/**
 * The one test that would call the real service.
 *
 * It needs **both** the credential and an explicit opt-in, `PERSONAVISION_SAM_LIVE=1`,
 * because the owner's decision on #69 is "do not test SAM 3.1 for now" and a key alone is
 * present on the owner's machine for every other model call. It skips visibly, with the
 * reason in its name, so CI has nothing to configure and makes no call — and when it is
 * run, what it settles is the one thing this ticket could not: the request and response
 * shape. A failure here is a fixture to re-record, never a broken run.
 */
const apiKey = process.env[SAM_CREDENTIAL_ENV]?.trim() ?? '';
const optedIn = (process.env['PERSONAVISION_SAM_LIVE'] ?? '').trim() !== '';
const live = apiKey !== '' && optedIn ? it : it.skip;
const why =
  apiKey === ''
    ? ` — skipped: no ${SAM_CREDENTIAL_ENV} in the environment`
    : optedIn
      ? ''
      : ' — skipped: SAM 3.1 is deferred (#69); set PERSONAVISION_SAM_LIVE=1 to call it';

describe('the live SAM 3.1 path', () => {
  live(`segments the card-grid fixture's unexplained region${why}`, async () => {
    const reports: SamUnavailable[] = [];
    const segmentation = samSegmenter({
      mode: 'model',
      modelId: process.env['PERSONAVISION_SAM_MODEL_ID'] ?? 'sam-3.1',
      credential: apiKey,
      readScreenshot: (path) => readFile(path),
      transport: async ({ url, method, headers, body, signal }) => {
        const response = await globalThis.fetch(url, {
          method,
          headers: { ...headers },
          body: JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        return { status: response.status, body: parsed };
      },
      report: (one) => void reports.push(one),
    });

    const areas = await available(segmentation).segment({
      capture: { ...fixture.capture, screenshot: fixture.screenshotPath },
      variant: VARIANT,
      explained: [],
    });

    expect(
      reports,
      `the live call reported: ${reports.map((one) => one.message).join('; ')}`,
    ).toEqual([]);
    expect(areas.length).toBeGreaterThan(0);
    for (const area of areas) {
      expect(area.bbox.x).toBeGreaterThanOrEqual(0);
      expect(area.bbox.y).toBeGreaterThanOrEqual(0);
      expect(area.bbox.x + area.bbox.width).toBeLessThanOrEqual(fixture.capture.viewport.width);
      expect(area.bbox.y + area.bbox.height).toBeLessThanOrEqual(fixture.capture.pageHeight);
    }
  });
});
