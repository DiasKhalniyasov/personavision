/**
 * Records the committed capture set the fixture source replays.
 *
 * `pnpm -F @personavision/browser record:captures` serves `test/fixtures/site/` on a free
 * port, drives Chromium through the task those pages are written for, and writes
 * `test/fixtures/captures/`: one capture per variant and step, the full-page screenshot
 * beside it, and the index that records the walk.
 *
 * **It records through the module's own seams.** `openSession`, `capture` and `act` are
 * what a live run uses, so a recorded capture is a live capture — the same geometry, the
 * same elements from the DOM and the accessibility tree, the same stable ids, the same
 * image — and not a hand-written approximation of one.
 *
 * **The run directory it captures into is a temporary one**, and the images it wrote there
 * are copied into the capture set. So a recorded `screenshot` field is still the path
 * `run.json` records and the bytes are still the ones `writeScreenshot` produced — while
 * everything else a run directory accumulates stays out of committed test material. It
 * accumulates more than it used to: the capture cache (#51) keeps `.capture-cache/` there,
 * keyed on the variant URL, which holds the port the recording server happened to get.
 *
 * **Re-running it against an unchanged site rewrites identical files.** Nothing it writes
 * depends on when it ran or on the machine that ran it: no timestamps, no ephemeral port —
 * a step records the path it was at and the replay resolves it against the variant's own
 * URL — and the fields are written in a fixed order rather than in whatever order they were
 * built in. `test/determinism.test.ts` holds that, and holds the committed set to being
 * this script's output over the site as it stands.
 *
 * **Two variants, two devices, one site.** `docs/FLOW.md` section 1 splits a swarm between
 * mobile and desktop, and `LANDMARKS.md`'s `cart-promo-apply` is below the fold at 390x844
 * and above it at 1440x900 — so recording variant A at the mobile device and variant B at
 * the desktop one leaves a committed set that holds both readings of one control, and a
 * fixture run can compare two variants as a real run does. A capture's geometry is its
 * viewport's, so the device a variant was recorded under is part of the index and the
 * fixture source refuses a session that asks for another.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPaths } from '@personavision/contract';
import {
  act,
  capture as takeCapture,
  closeSession,
  createFixtureSource,
  openSession,
  readSessionState,
} from '../src/index.js';
import type { Capture, CaptureContext, Device, TaskDefinition } from '../src/index.js';
import {
  CAPTURE_SET_FORMAT_VERSION,
  captureSetPaths,
  parseCapture,
  parseCaptureSet,
} from '../src/fixture-source.js';
import type { CaptureSet, RecordedStep, RecordedVariant } from '../src/fixture-source.js';
import { serveFixtureSite } from '../test/helpers/static-site.js';
import type { FixtureSite } from '../test/helpers/static-site.js';

/**
 * This package's own directory: the nearest ancestor of this file holding a `package.json`.
 *
 * `record:captures` compiles this script and runs the JavaScript, because `tsx` rewrites
 * every function it loads and a rewritten function cannot be serialised into a page — so at
 * run time this file sits in `dist/record/scripts/` as often as in `scripts/`. The fixture
 * site and the capture set are the package's, not this file's neighbours, so they are
 * addressed from here and both layouts find them.
 */
const packageRoot = (): string => {
  let at = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(at, 'package.json'))) return at;
    const up = dirname(at);
    if (up === at) {
      throw new Error(`no package.json above ${fileURLToPath(import.meta.url)}`);
    }
    at = up;
  }
};

/** The fixture site to record, and where the committed set this script writes lives. */
export const FIXTURE_SITE_DIR = join(packageRoot(), 'test', 'fixtures', 'site');
export const COMMITTED_CAPTURES_DIR = join(packageRoot(), 'test', 'fixtures', 'captures');

const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/**
 * The task the fixture site is written for, as `test/fixtures/site/LANDMARKS.md` declares
 * it. All four steps, because the recorded walk is the whole task: the confirmation step's
 * primary action starts the task again, so it is the one step the walk does not act on.
 */
export const FIXTURE_TASK: TaskDefinition = {
  id: 'checkout',
  prompt: 'Buy the canvas tote bag',
  steps: [
    {
      id: 'cart',
      label: 'Cart',
      match: { urlPattern: '/cart\\.html', requiredSelector: '#cart-items' },
      primaryAction: { selector: '#cart-checkout' },
    },
    {
      id: 'payment',
      label: 'Payment',
      match: { urlPattern: '/(payment|no-control)\\.html', requiredSelector: '#payment-form' },
      primaryAction: { selector: '#payment-submit' },
    },
    {
      id: 'review',
      label: 'Review',
      match: { urlPattern: '/review\\.html', requiredSelector: '#review-summary' },
      primaryAction: { selector: '#review-place-order' },
    },
    {
      id: 'confirmation',
      label: 'Confirmation',
      match: { urlPattern: '/confirmation\\.html', requiredSelector: '#confirmation-receipt' },
      primaryAction: { selector: '#confirmation-continue-shopping' },
    },
  ],
};

/** One variant to record: the id it is recorded under, where it starts, and its device. */
export interface RecordedWalk {
  readonly variant: string;
  readonly entry: string;
  readonly device: Device;
}

export const FIXTURE_WALKS: readonly RecordedWalk[] = [
  { variant: 'A', entry: '/cart.html', device: MOBILE },
  { variant: 'B', entry: '/cart.html', device: DESKTOP },
];

export interface RecordCapturesOptions {
  /** Where to write. Defaults to the committed set. */
  readonly dir?: string;
  readonly task?: TaskDefinition;
  readonly walks?: readonly RecordedWalk[];
}

export interface RecordedFile {
  readonly path: string;
  readonly bytes: number;
}

export interface RecordCapturesResult {
  readonly dir: string;
  readonly set: CaptureSet;
  /** Every file written, captures and images alike, in the order they were written. */
  readonly files: readonly RecordedFile[];
}

/**
 * The committed JSON of one capture, field by field.
 *
 * Written out rather than handed to `JSON.stringify` whole, so that the bytes are this
 * script's decision and not the order the capture happened to be built in: a seam that
 * spreads an element to set one flag moves that flag to the end of the object, and a
 * recorded file would change without anything on the page changing. Formatted as the
 * repository formats JSON, and `.prettierignore` leaves this set alone for the same reason
 * the calibration corpus is left alone — it is recorded data, asserted byte for byte.
 */
export const encodeCapture = (capture: Capture): string =>
  `${JSON.stringify(
    {
      variant: capture.variant,
      step: capture.step,
      screenshot: capture.screenshot,
      viewport: { width: capture.viewport.width, height: capture.viewport.height },
      pageHeight: capture.pageHeight,
      foldY: capture.foldY,
      elements: capture.elements.map((element) => ({
        id: element.id,
        source: element.source,
        role: element.role,
        name: element.name,
        text: element.text,
        bbox: {
          x: element.bbox.x,
          y: element.bbox.y,
          width: element.bbox.width,
          height: element.bbox.height,
        },
        isPrimaryAction: element.isPrimaryAction,
        belowFold: element.belowFold,
        selector: element.selector,
      })),
      contentHash: capture.contentHash,
    },
    null,
    2,
  )}\n`;

/** The committed JSON of the index. */
export const encodeCaptureSet = (set: CaptureSet): string =>
  `${JSON.stringify(
    {
      formatVersion: set.formatVersion,
      variants: set.variants.map((variant) => ({
        id: variant.id,
        device: {
          name: variant.device.name,
          viewport: {
            width: variant.device.viewport.width,
            height: variant.device.viewport.height,
          },
          deviceScaleFactor: variant.device.deviceScaleFactor,
          touch: variant.device.touch,
        },
        steps: variant.steps.map((step) => ({ step: step.step, path: step.path })),
      })),
    },
    null,
    2,
  )}\n`;

/**
 * Where a recorded page was, with the origin dropped.
 *
 * The origin is a loopback address and a port the operating system chose, so it is the one
 * thing about a recording that is about the machine rather than about the site. The path and
 * its query survive — the payment step submits by `GET`, so the review page is at
 * `/review.html?card=…`, and `LANDMARKS.md` keeps the step patterns unanchored for exactly
 * that reason.
 */
const pathOf = (url: string, origin: string): string => {
  const at = new URL(url);
  if (at.origin !== new URL(origin).origin) {
    throw new Error(`the walk left the fixture site: ${url} is not on ${origin}`);
  }
  return `${at.pathname}${at.search}`;
};

const writeText = async (path: string, text: string): Promise<RecordedFile> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text) };
};

/** The screenshot `writeScreenshot` took, copied out of the run directory into the set. */
const copyImage = async (from: string, to: string): Promise<RecordedFile> => {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return { path: to, bytes: (await stat(to)).size };
};

/**
 * Walks one variant and writes its captures.
 *
 * The step the page reports is checked against the step the task expected at this point of
 * the walk: a recorder that wrote whatever it found would quietly commit a set in which the
 * payment page is recorded as the cart, and every id in it would be minted under the wrong
 * step.
 */
const recordWalk = async (
  dir: string,
  runDir: string,
  task: TaskDefinition,
  walk: RecordedWalk,
  origin: string,
): Promise<{ readonly steps: RecordedStep[]; readonly files: RecordedFile[] }> => {
  const paths = captureSetPaths(dir);
  const steps: RecordedStep[] = [];
  const files: RecordedFile[] = [];

  const handle = await openSession(
    { id: walk.variant, url: `${origin}${walk.entry}` },
    walk.device,
  );
  const ctx: CaptureContext = {
    variant: walk.variant,
    device: walk.device,
    task,
    runDir,
  };

  try {
    for (const [index, step] of task.steps.entries()) {
      const { url } = await readSessionState(handle);
      const captured = await takeCapture(handle, ctx);
      if (captured.step !== step.id) {
        throw new Error(
          `the ${walk.variant} walk expected the ${step.id} step at ${url}, and the page is on ${captured.step ?? 'no step'}`,
        );
      }

      const json = encodeCapture(captured);
      // Parsed back before it is written, so that nothing lands in a committed set that the
      // fixture source would then refuse to read.
      const file = paths.capture(walk.variant, step.id);
      parseCapture(JSON.parse(json) as unknown, file);
      files.push(await writeText(file, json));
      steps.push({ step: step.id, path: pathOf(url, origin) });

      if (captured.screenshot !== null) {
        files.push(
          await copyImage(
            runPaths(runDir).screenshot(walk.variant, step.id),
            runPaths(dir).screenshot(walk.variant, step.id),
          ),
        );
      }

      const last = index === task.steps.length - 1;
      if (last) break;

      const advanced = await act(
        handle,
        { type: 'click', selector: step.primaryAction.selector },
        ctx,
      );
      if (!advanced.ok) {
        throw new Error(
          `the ${walk.variant} walk could not advance from ${step.id}: clicking ${step.primaryAction.selector} reported ${advanced.failure}`,
        );
      }
    }
  } finally {
    await closeSession(handle);
  }

  return { steps, files };
};

/**
 * Replays what was just written, so that a run of this script either leaves a set this
 * module can read or says why not: it opens every recorded variant, captures every
 * recorded step, and advances between them exactly as a consumer does.
 */
const verify = async (dir: string, set: CaptureSet, task: TaskDefinition): Promise<void> => {
  const source = createFixtureSource(dir);

  for (const variant of set.variants) {
    const ctx: CaptureContext = {
      variant: variant.id,
      device: variant.device,
      task,
      runDir: dir,
    };
    const handle = await source.openSession(
      // The fixture source resolves a recorded path against this, and never opens it.
      { id: variant.id, url: 'https://replay.invalid/' },
      variant.device,
    );

    try {
      for (const [index, recorded] of variant.steps.entries()) {
        const replayed = await source.capture(handle, ctx);
        if (replayed.step !== recorded.step) {
          throw new Error(
            `replaying ${variant.id} answered the ${replayed.step ?? 'unnamed'} step where ${recorded.step} was recorded`,
          );
        }
        const primary = replayed.elements.find((element) => element.isPrimaryAction);
        if (primary === undefined) {
          throw new Error(
            `the recorded ${recorded.step} capture of ${variant.id} marks no primary action`,
          );
        }
        if (index === variant.steps.length - 1) break;

        const advanced = await source.act(
          handle,
          { type: 'click', selector: primary.selector },
          ctx,
        );
        if (!advanced.ok) {
          throw new Error(
            `replaying ${variant.id} could not advance from ${recorded.step}: ${advanced.failure}`,
          );
        }
      }
    } finally {
      await source.close(handle);
    }
  }
};

/** Records a capture set, and returns what it wrote. */
export const recordCaptures = async (
  options: RecordCapturesOptions = {},
): Promise<RecordCapturesResult> => {
  const dir = options.dir ?? COMMITTED_CAPTURES_DIR;
  const task = options.task ?? FIXTURE_TASK;
  const walks = options.walks ?? FIXTURE_WALKS;

  await mkdir(dir, { recursive: true });
  const runDir = await mkdtemp(join(tmpdir(), 'personavision-recording-'));
  const files: RecordedFile[] = [];
  let set: CaptureSet;

  // The server is started inside the block that cleans up, so a site that cannot listen
  // leaves no temporary run directory behind.
  let site: FixtureSite | undefined;
  try {
    site = await serveFixtureSite({ root: FIXTURE_SITE_DIR });
    const variants: RecordedVariant[] = [];
    for (const walk of walks) {
      const recorded = await recordWalk(dir, runDir, task, walk, site.url);
      files.push(...recorded.files);
      variants.push({ id: walk.variant, device: walk.device, steps: recorded.steps });
    }
    set = { formatVersion: CAPTURE_SET_FORMAT_VERSION, variants };
  } finally {
    await site?.close();
    await rm(runDir, { recursive: true, force: true });
  }

  const paths = captureSetPaths(dir);
  const index = encodeCaptureSet(set);
  parseCaptureSet(JSON.parse(index) as unknown, paths.index);
  files.push(await writeText(paths.index, index));

  await verify(dir, set, task);

  return { dir, set, files };
};

const main = async (): Promise<void> => {
  const dir = process.argv.at(2);
  const result = await recordCaptures(dir === undefined ? {} : { dir: resolve(dir) });
  for (const variant of result.set.variants) {
    process.stdout.write(
      `${variant.id} at ${variant.device.name} ${variant.device.viewport.width}x${variant.device.viewport.height}: ${variant.steps.map((step) => step.step).join(' -> ')}\n`,
    );
  }
  const bytes = result.files.reduce((total, file) => total + file.bytes, 0);
  process.stdout.write(`${result.files.length} files, ${bytes} B, in ${result.dir}\n`);
};

/**
 * Run as a script. An import — the determinism test records into a temporary directory —
 * writes nothing.
 */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
