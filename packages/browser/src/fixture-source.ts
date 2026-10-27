/**
 * A capture source that replays committed captures from a directory.
 *
 * This is the default in tests and in the engine's offline mode: no network, no Chromium
 * navigation, and the same bytes every time, so the engine, the swarm and their tests are
 * deterministic. It answers the same `CaptureSource` interface as the live source, so
 * nothing downstream knows which one it has.
 *
 * **It launches nothing and opens nothing.** No `playwright` value is imported here — only
 * its types — so replaying a capture set starts no browser process and no socket. The
 * `browser`, `context` and `page` a `PageHandle` carries are therefore stand-ins: reading
 * any property of one throws, naming this source, rather than handing a seam that wanted a
 * real page something that silently answers nothing.
 * `docs/adr/0002-capture-source-and-the-segmentation-hand-off.md` describes a replaying
 * source as satisfying the shape over a blank page; #52's acceptance is stricter — fixture
 * mode is asserted with the fixture server down and no browser launched — and this is the
 * one place that difference lives.
 *
 * **The capture set on disk.** `scripts/record-captures.ts` writes it and this file reads
 * it; `test/fixtures/captures/README.md` is the record of the committed one.
 *
 * ```
 * <dir>/capture-set.json                 the index: the variants, each with the device it
 *                                        was recorded under and its ordered steps
 * <dir>/captures/<variant>/<step>.json   one capture per variant and step
 * <dir>/screenshots/<variant>/<step>.png the image beside it
 * ```
 *
 * The first two names are this module's own — a capture set is not a run artifact, and
 * nothing here claims to be one. The third is **not**: the recorder wrote those images with
 * `writeScreenshot` into this directory as its run directory, so they sit exactly where
 * `runPaths(dir).screenshot(variant, step)` puts them, and a recorded capture's
 * `screenshot` field is the run-directory-relative path the contract spells. That is what
 * lets `capture()` put the recorded image into a real run directory and hand back the same
 * path the live source would.
 *
 * **What a replay decides.** A recorded walk is the walk the task's primary actions make,
 * so:
 *
 * - `capture` answers with the recorded capture for the step the session is on, deep-copied,
 *   and copies the recorded screenshot into `ctx.runDir` at the contract's path. Two
 *   captures of one recorded page are equal and share nothing, so a caller that builds on
 *   one cannot change the other.
 * - a click on the step's **primary action** advances one step along the recorded sequence.
 *   At the end of the recording there is no successor, and that is a typed
 *   `navigation_error` rather than an invented page.
 * - a click on any other recorded control reports `ok` on the same step. The recording says
 *   nothing about where that control leads, and the alternative — a typed failure — would
 *   exclude the session from the scores, so an agent that clicks *Remove* could never be
 *   shown abandoning a task offline.
 * - a `back` moves one step backwards, and off the first recorded step it is a
 *   `navigation_error`: the live source reports one when a back lands on the blank page the
 *   session started from, and a replay has no page before its first either.
 * - a scroll moves a position this source keeps per session, clamped to the recorded page,
 *   and a targeted scroll moves it the minimum that puts the element's box in view.
 * - a `type` leaves the session where it is. A recorded page does not change when something
 *   is typed into it, and pretending otherwise would be inventing a page.
 *
 * **What it refuses.** A variant or a step the set does not hold, a device whose viewport or
 * device scale factor is not the one the variant was recorded under, a capture file that
 * does not parse, a recorded screenshot that is not on disk, and a handle another source
 * opened: each is an `Error` naming what was looked for and where, because a replay that
 * guessed would put a number nobody recorded into every metric downstream.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runPaths } from '@personavision/contract';
import type { Browser, BrowserContext, Page } from 'playwright';
import type {
  ActResult,
  Action,
  AutomationFailureReason,
  Box,
  Capture,
  CaptureContext,
  CaptureElement,
  CaptureSource,
  Device,
  PageHandle,
  Variant,
  Viewport,
} from './types.js';

export type CreateFixtureSource = (dir: string) => CaptureSource;

/** The one version of the index this module reads. */
export const CAPTURE_SET_FORMAT_VERSION = 1;

/** The index file, and the directory the per-step captures sit in. */
const CAPTURE_SET_FILE = 'capture-set.json';
const CAPTURES_DIR = 'captures';
const CAPTURE_EXTENSION = '.json';

/** One step of a recorded walk: the step it is, and the page path it was recorded at. */
export interface RecordedStep {
  readonly step: string;
  /**
   * The path the recorded page was at, resolved against the variant's URL at replay time —
   * so a recording carries no origin and no port, and a replay reports a position in the
   * caller's own space.
   */
  readonly path: string;
}

/** One recorded variant: the device it was recorded under, and its walk. */
export interface RecordedVariant {
  readonly id: string;
  readonly device: Device;
  readonly steps: readonly RecordedStep[];
}

/**
 * A recorded capture. Its step is never `null`: a capture is addressed by variant and step,
 * so a screen the task did not recognise has no address to be recorded under.
 */
export type RecordedCapture = Capture & { step: string };

/** A capture set's index, as `capture-set.json` holds it. */
export interface CaptureSet {
  readonly formatVersion: number;
  readonly variants: readonly RecordedVariant[];
}

/** Every file of one capture set. The screenshots' path is the contract's, not this file's. */
export interface CaptureSetPaths {
  readonly dir: string;
  readonly index: string;
  capture(variant: string, step: string): string;
  screenshot(variant: string, step: string): string;
}

export const captureSetPaths = (dir: string): CaptureSetPaths => ({
  dir,
  index: join(dir, CAPTURE_SET_FILE),
  capture: (variant, step) => join(dir, CAPTURES_DIR, variant, `${step}${CAPTURE_EXTENSION}`),
  screenshot: (variant, step) => runPaths(dir).screenshot(variant, step),
});

/* -------------------------------------------------------------------------------------- *
 * Parsing a capture set, which is the only place a file on disk becomes one of this
 * module's types. Every failure names the file, the path inside it, what was expected and
 * what was there, because a fixture directory is edited by hand as often as it is recorded.
 * -------------------------------------------------------------------------------------- */

/** What was actually there, short enough to read in one line. */
const describeValue = (value: unknown): string => {
  if (value === undefined) return 'absent';
  if (typeof value === 'function') return 'a function';
  const written = JSON.stringify(value);
  if (written === undefined) return String(value);
  return written.length > 80 ? `${written.slice(0, 77)}...` : written;
};

const fail = (source: string, at: string, expected: string, value: unknown): never => {
  throw new Error(`${source}: ${at} should be ${expected}, and is ${describeValue(value)}`);
};

const asObject = (value: unknown, source: string, at: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(source, at, 'an object', value);

const asArray = (value: unknown, source: string, at: string): unknown[] =>
  Array.isArray(value) ? value : fail(source, at, 'an array', value);

const asString = (value: unknown, source: string, at: string): string =>
  typeof value === 'string' && value !== '' ? value : fail(source, at, 'a non-empty string', value);

const asNullableString = (value: unknown, source: string, at: string): string | null =>
  value === null || typeof value === 'string' ? value : fail(source, at, 'a string or null', value);

const asNumber = (value: unknown, source: string, at: string): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(source, at, 'a finite number', value);

const asPositiveInt = (value: unknown, source: string, at: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fail(source, at, 'a positive whole number', value);

const asBoolean = (value: unknown, source: string, at: string): boolean =>
  typeof value === 'boolean' ? value : fail(source, at, 'true or false', value);

/**
 * Every object of a capture set is closed, as every object of the run artifact is: a field
 * this module does not declare is refused at its own path rather than dropped, so a
 * recorder that learns a new field and a reader that has not cannot pass each other by.
 */
const closed = (
  object: Record<string, unknown>,
  declared: readonly string[],
  source: string,
  at: string,
): void => {
  const unexpected = Object.keys(object).filter((key) => !declared.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${source}: ${at} carries ${unexpected.map((key) => `"${key}"`).join(', ')}, which this module does not declare; it holds ${declared.join(', ')}`,
    );
  }
};

const parseViewport = (value: unknown, source: string, at: string): Viewport => {
  const object = asObject(value, source, at);
  closed(object, ['width', 'height'], source, at);
  return {
    width: asPositiveInt(object.width, source, `${at}.width`),
    height: asPositiveInt(object.height, source, `${at}.height`),
  };
};

const parseDevice = (value: unknown, source: string, at: string): Device => {
  const object = asObject(value, source, at);
  closed(object, ['name', 'viewport', 'deviceScaleFactor', 'touch'], source, at);
  return {
    name: asString(object.name, source, `${at}.name`),
    viewport: parseViewport(object.viewport, source, `${at}.viewport`),
    deviceScaleFactor: asNumber(object.deviceScaleFactor, source, `${at}.deviceScaleFactor`),
    touch: asBoolean(object.touch, source, `${at}.touch`),
  };
};

const parseBox = (value: unknown, source: string, at: string): Box => {
  const object = asObject(value, source, at);
  closed(object, ['x', 'y', 'width', 'height'], source, at);
  return {
    x: asNumber(object.x, source, `${at}.x`),
    y: asNumber(object.y, source, `${at}.y`),
    width: asNumber(object.width, source, `${at}.width`),
    height: asNumber(object.height, source, `${at}.height`),
  };
};

const ELEMENT_SOURCES: readonly CaptureElement['source'][] = ['dom', 'a11y'];

const parseElement = (value: unknown, source: string, at: string): CaptureElement => {
  const object = asObject(value, source, at);
  closed(
    object,
    ['id', 'source', 'role', 'name', 'text', 'bbox', 'isPrimaryAction', 'belowFold', 'selector'],
    source,
    at,
  );
  const from = object.source;
  if (typeof from !== 'string' || !ELEMENT_SOURCES.includes(from as CaptureElement['source'])) {
    fail(source, `${at}.source`, ELEMENT_SOURCES.map((one) => `"${one}"`).join(' or '), from);
  }
  return {
    id: asString(object.id, source, `${at}.id`),
    source: from as CaptureElement['source'],
    role: asNullableString(object.role, source, `${at}.role`),
    name: asNullableString(object.name, source, `${at}.name`),
    text: asNullableString(object.text, source, `${at}.text`),
    bbox: parseBox(object.bbox, source, `${at}.bbox`),
    isPrimaryAction: asBoolean(object.isPrimaryAction, source, `${at}.isPrimaryAction`),
    belowFold: asBoolean(object.belowFold, source, `${at}.belowFold`),
    selector: asString(object.selector, source, `${at}.selector`),
  };
};

/**
 * One recorded capture, against this module's own `Capture`.
 *
 * `step` is never `null` in a capture set: a capture is addressed by variant and step, and a
 * screen the task did not recognise has no address to be recorded under — the same reason
 * `run.json` records neither a screenshot row nor an area of interest for one.
 *
 * At most one element may carry `isPrimaryAction`, because that is what
 * `resolvePrimaryAction` produces and what a replayed click is judged against.
 */
export const parseCapture = (value: unknown, source: string): RecordedCapture => {
  const object = asObject(value, source, 'the capture');
  closed(
    object,
    ['variant', 'step', 'screenshot', 'viewport', 'pageHeight', 'foldY', 'elements', 'contentHash'],
    source,
    'the capture',
  );

  const elements = asArray(object.elements, source, 'elements').map((element, index) =>
    parseElement(element, source, `elements[${index}]`),
  );
  const marked = elements.filter((element) => element.isPrimaryAction);
  if (marked.length > 1) {
    throw new Error(
      `${source}: ${marked.length} elements are marked as the step's primary action (${marked.map((element) => element.id).join(', ')}), and a step declares one control`,
    );
  }

  return {
    variant: asString(object.variant, source, 'variant'),
    step: asString(object.step, source, 'step'),
    screenshot: asNullableString(object.screenshot, source, 'screenshot'),
    viewport: parseViewport(object.viewport, source, 'viewport'),
    pageHeight: asNumber(object.pageHeight, source, 'pageHeight'),
    foldY: asNumber(object.foldY, source, 'foldY'),
    elements,
    contentHash: asString(object.contentHash, source, 'contentHash'),
  };
};

const parseRecordedStep = (value: unknown, source: string, at: string): RecordedStep => {
  const object = asObject(value, source, at);
  closed(object, ['step', 'path'], source, at);
  const path = asString(object.path, source, `${at}.path`);
  if (!path.startsWith('/')) {
    fail(source, `${at}.path`, 'a path beginning with "/", resolved against the variant URL', path);
  }
  return { step: asString(object.step, source, `${at}.step`), path };
};

const parseRecordedVariant = (value: unknown, source: string, at: string): RecordedVariant => {
  const object = asObject(value, source, at);
  closed(object, ['id', 'device', 'steps'], source, at);
  const steps = asArray(object.steps, source, `${at}.steps`).map((step, index) =>
    parseRecordedStep(step, source, `${at}.steps[${index}]`),
  );
  if (steps.length === 0) {
    fail(source, `${at}.steps`, 'at least one recorded step', steps);
  }
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (seen.has(step.step)) {
      throw new Error(
        `${source}: ${at}.steps[${index}] records "${step.step}" a second time, and one step of one variant is one capture`,
      );
    }
    seen.add(step.step);
  }
  return {
    id: asString(object.id, source, `${at}.id`),
    device: parseDevice(object.device, source, `${at}.device`),
    steps,
  };
};

/** A capture set's index, against this module's own types. */
export const parseCaptureSet = (value: unknown, source: string): CaptureSet => {
  const object = asObject(value, source, 'the capture set');
  closed(object, ['formatVersion', 'variants'], source, 'the capture set');

  const formatVersion = asNumber(object.formatVersion, source, 'formatVersion');
  // Named rather than read as this version, which is how every file in this project
  // written for another version is treated.
  if (formatVersion !== CAPTURE_SET_FORMAT_VERSION) {
    throw new Error(
      `${source}: this is a format-${formatVersion} capture set, and this module reads format ${CAPTURE_SET_FORMAT_VERSION}`,
    );
  }

  const variants = asArray(object.variants, source, 'variants').map((variant, index) =>
    parseRecordedVariant(variant, source, `variants[${index}]`),
  );
  if (variants.length === 0) {
    fail(source, 'variants', 'at least one recorded variant', variants);
  }
  const seen = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    if (seen.has(variant.id)) {
      throw new Error(
        `${source}: variants[${index}] records "${variant.id}" a second time, and one variant is one recorded walk`,
      );
    }
    seen.add(variant.id);
  }

  return { formatVersion, variants };
};

/** The JSON a file holds, or a failure naming the file rather than a stray parse error. */
const readJson = async (path: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`the fixture capture source looked for ${path}, and it is not there`, {
      cause,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path} is not JSON`, { cause });
  }
};

/* -------------------------------------------------------------------------------------- *
 * Replaying it.
 * -------------------------------------------------------------------------------------- */

/**
 * A stand-in for a Chromium object this source does not have.
 *
 * Reading any property of it throws, naming the source and the property, so a seam handed a
 * fixture handle fails where it reached for a page rather than three calls later on
 * something undefined. Properties an inspector reaches for — `constructor`, `toString`,
 * every symbol — are answered from the empty object underneath, so printing a failed
 * expectation cannot itself throw.
 */
const absent = <T>(what: string, dir: string): T =>
  new Proxy({} as object, {
    get: (target, property, receiver) => {
      if (typeof property === 'symbol' || property === 'then' || Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(
        `the fixture capture source replays the captures in ${dir} and holds no browser, so there is no ${what}.${String(property)} to read`,
      );
    },
  }) as T;

/** Where one open fixture session is: which recorded step, and where it is scrolled to. */
interface FixtureSession {
  readonly variant: RecordedVariant;
  at: number;
  scrollY: number;
  closed: boolean;
}

/**
 * The URL a recorded path is at, resolved against the variant the session was opened on.
 *
 * A recording carries no origin — it was made against a server on an ephemeral port, and a
 * port in a committed file would be a recording of the machine that made it — so the
 * position a replay reports is the caller's own URL space. A variant URL that cannot be a
 * base, which a run with a placeholder URL may well pass, leaves the recorded path as the
 * position rather than failing an action over a label.
 */
const positionUrl = (variant: Variant, path: string): string => {
  try {
    return new URL(path, variant.url).href;
  } catch {
    return path;
  }
};

/** A capture nothing else holds a reference into: equal to the recorded one, and separate. */
const copyOfCapture = (capture: RecordedCapture, screenshot: string | null): Capture => ({
  variant: capture.variant,
  step: capture.step,
  screenshot,
  viewport: { width: capture.viewport.width, height: capture.viewport.height },
  pageHeight: capture.pageHeight,
  foldY: capture.foldY,
  elements: capture.elements.map((element) => ({
    ...element,
    bbox: { ...element.bbox },
  })),
  contentHash: capture.contentHash,
});

const clampScroll = (scrollY: number, capture: RecordedCapture): number =>
  Math.max(0, Math.min(scrollY, capture.pageHeight - capture.viewport.height));

/** The minimum scroll that puts a box in view, which is what a targeted scroll does. */
const scrollToShow = (box: Box, capture: RecordedCapture, scrollY: number): number => {
  if (box.y < scrollY) return clampScroll(box.y, capture);
  const bottom = box.y + box.height;
  if (bottom > scrollY + capture.viewport.height) {
    return clampScroll(bottom - capture.viewport.height, capture);
  }
  return scrollY;
};

/** The elements an action names: an id matches one, a selector matches each candidate for it. */
const targeted = (capture: RecordedCapture, action: Action): CaptureElement[] => {
  if (action.elementId !== undefined) {
    return capture.elements.filter((element) => element.id === action.elementId);
  }
  if (action.selector !== undefined) {
    return capture.elements.filter((element) => element.selector === action.selector);
  }
  return [];
};

export const createFixtureSource: CreateFixtureSource = (dir) => {
  const paths = captureSetPaths(dir);
  const sessions = new WeakMap<PageHandle, FixtureSession>();

  /** The index, read once however many sessions a swarm opens over it. */
  let index: Promise<CaptureSet> | undefined;
  const captureSet = (): Promise<CaptureSet> => {
    index ??= readJson(paths.index).then((value) => parseCaptureSet(value, paths.index));
    return index;
  };

  /** One capture per variant and step, read once and handed out as copies. */
  const loaded = new Map<string, Promise<RecordedCapture>>();

  const loadCapture = (variant: string, step: string): Promise<RecordedCapture> => {
    const key = `${variant}\u0000${step}`;
    const already = loaded.get(key);
    if (already !== undefined) return already;

    const source = paths.capture(variant, step);
    const reading = readJson(source).then((value) => {
      const capture = parseCapture(value, source);
      if (capture.variant !== variant || capture.step !== step) {
        throw new Error(
          `${source} records variant "${capture.variant}" step "${capture.step}", and a capture set addresses it as variant "${variant}" step "${step}"`,
        );
      }
      // The only path this source ever joins to the directory is the contract's own
      // spelling for this variant and step, so a recorded `screenshot` field can name no
      // file but the one beside it.
      const expected = runPaths('').screenshot(variant, step);
      if (capture.screenshot !== null && capture.screenshot !== expected) {
        throw new Error(
          `${source} records its screenshot at "${capture.screenshot}", and a recorded screenshot is at "${expected}"`,
        );
      }
      return capture;
    });
    loaded.set(key, reading);
    return reading;
  };

  const sessionFor = (page: PageHandle): FixtureSession => {
    const session = sessions.get(page);
    if (session === undefined) {
      throw new Error(
        `this page handle was not opened by the fixture capture source replaying ${dir}`,
      );
    }
    if (session.closed) {
      throw new Error(
        `the fixture session over variant "${session.variant.id}" is closed, and a closed session has no page`,
      );
    }
    return session;
  };

  /**
   * The step the session is on, and the capture recorded for it.
   *
   * `ctx.variant` is checked against the variant the session was opened on: they are the
   * same string in a run, and a disagreement means a caller is recording one variant's
   * screens under another's name, which would mint every element id under the wrong
   * variant.
   */
  const current = async (
    page: PageHandle,
    ctx: CaptureContext,
  ): Promise<{ session: FixtureSession; step: RecordedStep; capture: RecordedCapture }> => {
    const session = sessionFor(page);
    if (ctx.variant !== session.variant.id) {
      throw new Error(
        `this fixture session replays variant "${session.variant.id}", and the capture context says "${ctx.variant}"`,
      );
    }
    const step = session.variant.steps[session.at];
    if (step === undefined) {
      throw new Error(
        `the fixture session over variant "${session.variant.id}" is at step ${session.at} of ${session.variant.steps.length} recorded ones`,
      );
    }
    return { session, step, capture: await loadCapture(session.variant.id, step.step) };
  };

  /**
   * The recorded image, put where a run keeps it.
   *
   * The live source writes a screenshot into the run directory and returns the path
   * `run.json` records; this hands over the recorded bytes and returns the same path, so an
   * offline run leaves a run directory the screens can draw rather than one whose
   * `screenshots` rows point at a fixture.
   */
  const placeScreenshot = async (
    capture: RecordedCapture,
    runDir: string,
  ): Promise<string | null> => {
    if (capture.screenshot === null) return null;

    const from = paths.screenshot(capture.variant, capture.step);
    const to = runPaths(runDir).screenshot(capture.variant, capture.step);
    if (from !== to) {
      await mkdir(dirname(to), { recursive: true });
      try {
        await copyFile(from, to);
      } catch (cause) {
        throw new Error(
          `the fixture capture source looked for the screenshot of variant "${capture.variant}" step "${capture.step}" at ${from}, and could not read it`,
          { cause },
        );
      }
    }
    return runPaths('').screenshot(capture.variant, capture.step);
  };

  return {
    openSession: async (variant, device) => {
      const set = await captureSet();
      const recorded = set.variants.find((candidate) => candidate.id === variant.id);
      if (recorded === undefined) {
        throw new Error(
          `${paths.index} records no variant "${variant.id}": it holds ${set.variants.map((candidate) => `"${candidate.id}"`).join(', ')}`,
        );
      }

      // A recorded capture's geometry is that viewport's and its image is that device
      // scale factor's pixels, and every `belowFold` in it was computed from the fold they
      // make. Replaying them for another device would put a wrong number into every
      // fold-dependent metric with nothing to show it was wrong, so it is refused — and the
      // error says which device the set does answer for. The device's name and whether it
      // has touch are labels a recording does not depend on, so they are not compared.
      const asked = device.viewport;
      const was = recorded.device.viewport;
      if (
        asked.width !== was.width ||
        asked.height !== was.height ||
        device.deviceScaleFactor !== recorded.device.deviceScaleFactor
      ) {
        throw new Error(
          `variant "${variant.id}" was recorded at ${was.width}x${was.height} and a device scale factor of ${recorded.device.deviceScaleFactor}, and this session asks for ${asked.width}x${asked.height} at ${device.deviceScaleFactor}`,
        );
      }

      const handle: PageHandle = {
        variant,
        device,
        // Nothing is displayed, because nothing is launched.
        headless: true,
        browser: absent<Browser>('browser', dir),
        context: absent<BrowserContext>('context', dir),
        page: absent<Page>('page', dir),
      };
      sessions.set(handle, { variant: recorded, at: 0, scrollY: 0, closed: false });
      return handle;
    },

    capture: async (page, ctx) => {
      const { capture } = await current(page, ctx);
      return copyOfCapture(capture, await placeScreenshot(capture, ctx.runDir));
    },

    act: async (page, action, ctx) => {
      const { session, capture } = await current(page, ctx);

      const report = (failure?: AutomationFailureReason): ActResult => {
        const step = session.variant.steps[session.at];
        if (step === undefined) {
          throw new Error(
            `the fixture session over variant "${session.variant.id}" is at step ${session.at} of ${session.variant.steps.length} recorded ones`,
          );
        }
        const position = {
          action,
          url: positionUrl(page.variant, step.path),
          scrollY: session.scrollY,
          step: step.step,
        };
        return failure === undefined
          ? { ok: true, ...position }
          : { ok: false, ...position, failure };
      };

      /** Arriving on a recorded step: a page opens at the top of itself. */
      const moveTo = (at: number): void => {
        session.at = at;
        session.scrollY = 0;
      };

      if (action.type === 'back') {
        if (session.at === 0) return report('navigation_error');
        moveTo(session.at - 1);
        return report();
      }

      if (
        action.type === 'scroll' &&
        action.elementId === undefined &&
        action.selector === undefined
      ) {
        session.scrollY = clampScroll(session.scrollY + (action.deltaY ?? 0), capture);
        return report();
      }

      const matches = targeted(capture, action);
      const target = matches[0];
      if (target === undefined) return report('selector_not_found');

      if (action.type === 'scroll') {
        session.scrollY = scrollToShow(target.bbox, capture, session.scrollY);
        return report();
      }

      if (action.type === 'type') return report();

      // A recorded walk is the walk the primary actions make. Both candidates for one
      // control — the DOM's and the accessibility tree's — carry its selector while only
      // the one `resolvePrimaryAction` matched carries the flag, so the selector is what a
      // click is judged by: an agent that chose either of them chose the same control.
      const primary = capture.elements.find((element) => element.isPrimaryAction);
      const advances =
        primary !== undefined && matches.some((element) => element.selector === primary.selector);
      if (!advances) return report();
      if (session.at + 1 >= session.variant.steps.length) return report('navigation_error');

      moveTo(session.at + 1);
      return report();
    },

    close: async (page) => {
      const session = sessions.get(page);
      if (session === undefined) {
        throw new Error(
          `this page handle was not opened by the fixture capture source replaying ${dir}`,
        );
      }
      // Closing twice is not an error, as it is not for a Chromium session.
      session.closed = true;
    },
  };
};
