/**
 * Records the behaviour suite's committed capture set.
 *
 * `pnpm -F @personavision/swarm record:fixtures` serves `fixtures/site/` on a free port,
 * drives Chromium through each scenario, and writes `fixtures/captures/`: one capture per
 * variant and step, the full-page screenshot beside it, and the index that records the walk.
 *
 * **It records through the module's own seams.** `openSession`, `capture` and `act` are what
 * a live run uses, so a recorded capture is a live capture — the same geometry, the same
 * elements from the DOM and the accessibility tree, the same stable ids, the same image —
 * and not a hand-written approximation of one. `packages/browser/scripts/record-captures.ts`
 * does the same job for that package's own site and says more about why it is shaped this
 * way; this is the behaviour suite's, over the scenarios `fixtures.ts` declares.
 *
 * **Re-running it against unchanged pages rewrites identical files.** Nothing it writes
 * depends on when it ran or on the machine that ran it: no timestamps, no ephemeral port — a
 * step records the path it was at, and the replay resolves it against the variant's own URL —
 * and the fields are written in a fixed order rather than in whatever order they were built
 * in. `.prettierignore` leaves the set alone for the same reason the browser module's set is
 * left alone: it is recorded data.
 *
 * **The run directory it captures into is a temporary one**, and the images it wrote there
 * are copied into the set, so a recorded `screenshot` field is still the path `run.json`
 * records and the bytes are still `writeScreenshot`'s.
 *
 * It is compiled and run as JavaScript rather than through `tsx`, because a `page.evaluate`
 * cannot serialise a rewritten function: `tsconfig.record.json` says more.
 */

import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, capture as takeCapture, closeSession, openSession } from '@personavision/browser';
import { runPaths } from '@personavision/contract';
import {
  BEHAVIOUR_CAPTURES,
  BEHAVIOUR_DEVICE,
  BEHAVIOUR_SITE,
  BEHAVIOUR_TASK,
  PRIMARY_ACTION_SELECTOR,
  RECORDED_FROM,
  SCENARIOS,
  siteDigest,
} from './fixtures.js';
import type { Capture, CaptureContext } from '@personavision/browser';
import type { Server } from 'node:http';
import type { Scenario } from './fixtures.js';

/** The index format the fixture capture source reads. */
const CAPTURE_SET_FORMAT_VERSION = 1;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

interface Site {
  readonly origin: string;
  close: () => Promise<void>;
}

/**
 * The fixture site, served from disk on a port the operating system chooses. A path that
 * leaves the site's directory is answered 403 rather than read, as any static server must.
 */
const serve = async (root: string): Promise<Site> => {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file)
      .then((bytes) => {
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        });
        response.end(bytes);
      })
      .catch(() => response.writeHead(404).end());
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture site is listening on no port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
};

/**
 * The committed JSON of one capture, field by field.
 *
 * Written out rather than handed to `JSON.stringify` whole, so that the bytes are this
 * script's decision and not the order the capture happened to be built in: a seam that
 * spreads an element to set one flag would otherwise move that flag to the end of the
 * object, and a recorded file would change without anything on the page changing.
 */
const encodeCapture = (capture: Capture): string =>
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

const writeText = async (path: string, text: string): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return path;
};

/** One recorded step: the step it is, and the page path it was recorded at. */
interface RecordedStep {
  readonly step: string;
  readonly path: string;
}

/**
 * Walks one scenario and writes its captures.
 *
 * The step the page reports is checked against the step the scenario declares at this point
 * of the walk: a recorder that wrote whatever it found would quietly commit a set in which
 * one page is recorded under another's name, and every id in it would be minted under the
 * wrong step.
 */
const record = async (
  dir: string,
  runDir: string,
  scenario: Scenario,
  origin: string,
): Promise<{ readonly steps: readonly RecordedStep[]; readonly files: readonly string[] }> => {
  const recorded: RecordedStep[] = [];
  const files: string[] = [];
  const handle = await openSession(
    { id: scenario.variant, url: `${origin}${scenario.entry}` },
    BEHAVIOUR_DEVICE,
  );
  const ctx: CaptureContext = {
    variant: scenario.variant,
    device: BEHAVIOUR_DEVICE,
    task: BEHAVIOUR_TASK,
    runDir,
  };

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const captured = await takeCapture(handle, ctx);
      if (captured.step !== step) {
        throw new Error(
          `the ${scenario.variant} walk expected the ${step} step and the page is on ${captured.step ?? 'no step'}`,
        );
      }
      files.push(
        await writeText(
          join(dir, 'captures', scenario.variant, `${step}.json`),
          encodeCapture(captured),
        ),
      );
      recorded.push({ step, path: declaredPath(scenario, index) });

      if (captured.screenshot !== null) {
        const to = runPaths(dir).screenshot(scenario.variant, step);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(runPaths(runDir).screenshot(scenario.variant, step), to);
        files.push(to);
      }

      if (index === scenario.steps.length - 1) break;
      const advanced = await act(handle, { type: 'click', selector: PRIMARY_ACTION_SELECTOR }, ctx);
      if (!advanced.ok) {
        throw new Error(
          `the ${scenario.variant} walk could not advance from ${step}: clicking ${PRIMARY_ACTION_SELECTOR} reported ${advanced.failure}`,
        );
      }
    }
  } finally {
    await closeSession(handle);
  }

  return { steps: recorded, files };
};

/**
 * The path a recorded step is at, from the scenario rather than from the page.
 *
 * A recording carries no origin — it was made against a server on an ephemeral port, and a
 * port in a committed file would be a recording of the machine that made it — and every page
 * of this site is reached by its own path, so the entry and the pages the walk clicks
 * through are the whole of it.
 */
const declaredPath = (scenario: Scenario, index: number): string =>
  index === 0 ? scenario.entry : '/done.html';

/**
 * Anything in the set that this run did not write, taken out.
 *
 * A scenario that loses a step, or a variant that is renamed, would otherwise leave a
 * capture and its image behind: unreferenced by the index it was rewritten beside, and
 * invisible to the byte-identity the rest of this script promises, because only the files
 * that *are* rewritten are ever compared.
 */
const sweepOrphans = async (dir: string, written: readonly string[]): Promise<string[]> => {
  const keep = new Set(written.map((path) => resolve(path)));
  const found = await readdir(dir, { recursive: true, withFileTypes: true });
  const removed: string[] = [];
  for (const entry of found) {
    if (!entry.isFile()) continue;
    const path = resolve(join(entry.parentPath, entry.name));
    if (keep.has(path)) continue;
    await rm(path);
    removed.push(path);
  }
  return removed;
};

export interface RecordedFixtures {
  readonly dir: string;
  /** Every file the set now holds, captures, images and index alike. */
  readonly files: readonly string[];
  /** Files that were in the directory and are not part of this recording. */
  readonly removed: readonly string[];
}

/** Records the whole set into `dir`, and leaves nothing in it that it did not write. */
export const recordFixtures = async (
  dir: string = BEHAVIOUR_CAPTURES,
): Promise<RecordedFixtures> => {
  const runDir = await mkdtemp(join(tmpdir(), 'personavision-behaviour-'));
  const variants: {
    id: string;
    device: typeof BEHAVIOUR_DEVICE;
    steps: readonly RecordedStep[];
  }[] = [];
  const files: string[] = [];

  let site: Site | undefined;
  try {
    site = await serve(BEHAVIOUR_SITE);
    for (const scenario of SCENARIOS) {
      const recorded = await record(dir, runDir, scenario, site.origin);
      files.push(...recorded.files);
      variants.push({ id: scenario.variant, device: BEHAVIOUR_DEVICE, steps: recorded.steps });
    }
  } finally {
    await site?.close();
    await rm(runDir, { recursive: true, force: true });
  }

  files.push(
    await writeText(
      join(dir, 'capture-set.json'),
      `${JSON.stringify(
        {
          formatVersion: CAPTURE_SET_FORMAT_VERSION,
          variants: variants.map((variant) => ({
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
      )}\n`,
    ),
  );

  // Which pages this set came from, so that a page edited without a re-recording is a
  // failing test rather than a suite quietly measuring a screen that has moved.
  files.push(
    await writeText(
      dir === BEHAVIOUR_CAPTURES ? RECORDED_FROM : join(dir, 'recorded-from.json'),
      `${JSON.stringify(await siteDigest(), null, 2)}\n`,
    ),
  );

  return { dir, files, removed: await sweepOrphans(dir, files) };
};

const main = async (): Promise<void> => {
  const asked = process.argv.at(2);
  const recorded = await recordFixtures(asked === undefined ? undefined : resolve(asked));
  process.stdout.write(
    `${recorded.files.length} files in ${recorded.dir}${
      recorded.removed.length === 0 ? '' : `, ${recorded.removed.length} orphan(s) removed`
    }\n`,
  );
};

/**
 * Run as a script. An import — the test that holds the committed set to these pages — writes
 * nothing.
 */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
