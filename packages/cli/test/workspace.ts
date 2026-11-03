import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDirName, runPaths, writeRun } from '@personavision/contract';
import { RUN_ID, validArtifact } from '../../contract/tests/fixtures.js';

/**
 * A temporary workspace for the command to be run in: a `runs/` directory written through
 * `@personavision/contract`'s own writer, and a built viewer to serve.
 *
 * The run artifact comes from the contract package's fixtures rather than a copy of it
 * here, so a change to the schemas reaches these tests as a compile error. The screenshot
 * bytes are this file's own: `writeRun` writes the JSON files, and a screenshot is the
 * pipeline's to produce.
 */

/** Not a real PNG, deliberately: what is asserted is that the bytes arrive unchanged. */
export const SCREENSHOT_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xfe, 0xff,
]);

/** The variant and step the fixture captured, and so the screenshot that is served. */
export const SCREENSHOT = { variant: 'A', step: 'cart' } as const;

/**
 * Not a playable recording, deliberately: a WebM file's own EBML magic followed by a
 * deterministic ramp, so a slice of it is checked by arithmetic rather than by a decoder.
 * Two kilobytes, which is what puts bytes on both sides of `bytes=1024-`.
 */
export const VIDEO_BYTES = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from(Array.from({ length: 2044 }, (_, index) => index % 256)),
]);

/** The session whose recording the suites serve: the fixture's own first session. */
export const VIDEO_SESSION = 'S-01';

/**
 * One session's recording, written where the paths module says it lives. Called by the
 * suites that serve a video rather than by `temporaryWorkspace`, so a run directory holds
 * one only where a test asked for one.
 */
export const writeSessionVideo = async (
  runDir: string,
  sessionId: string = VIDEO_SESSION,
): Promise<Buffer> => {
  const video = runPaths(runDir).video(sessionId);
  await mkdir(dirname(video), { recursive: true });
  await writeFile(video, VIDEO_BYTES);
  return VIDEO_BYTES;
};

/**
 * The viewer's own document shell stands in for a build: `apps/viewer/dist` is a build
 * output and may not exist when the suite runs, and what is under test here is the
 * serving, not the bundling.
 */
const VIEWER_HTML = fileURLToPath(new URL('../../../apps/viewer/index.html', import.meta.url));

export interface TestWorkspace {
  /** The directory the command is run from. */
  dir: string;
  runsRoot: string;
  runDir: string;
  runId: string;
  viewerDist: string;
  cleanup: () => Promise<void>;
}

export const temporaryWorkspace = async ({ withRun = true } = {}): Promise<TestWorkspace> => {
  const dir = await mkdtemp(join(tmpdir(), 'personavision-cli-'));
  const runsRoot = join(dir, 'runs');
  const runDir = join(runsRoot, RUN_ID);
  const viewerDist = join(dir, 'viewer-dist');

  await mkdir(runsRoot, { recursive: true });
  await mkdir(viewerDist, { recursive: true });
  await copyFile(VIEWER_HTML, join(viewerDist, 'index.html'));

  if (withRun) {
    await writeRun(runDir, validArtifact());
    const screenshot = runPaths(runDir).screenshot(SCREENSHOT.variant, SCREENSHOT.step);
    await mkdir(dirname(screenshot), { recursive: true });
    await writeFile(screenshot, SCREENSHOT_BYTES);
  }

  return {
    dir,
    runsRoot,
    runDir,
    runId: RUN_ID,
    viewerDist,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

/**
 * One more run, written under a directory of its own. `stamp` is what the directory is
 * named for and `createdAt` what the run records: a suite that wants the two in opposite
 * orders passes them apart, and one that does not passes the same instant twice.
 */
export const writeRunAt = async (
  runsRoot: string,
  { stamp, createdAt, name }: { stamp: string; createdAt: string; name: string },
): Promise<string> => {
  const runId = runDirName(new Date(stamp), name);
  const artifact = validArtifact();
  artifact.run = { ...artifact.run, runId, createdAt };
  artifact.findings = { ...artifact.findings, runId };
  await writeRun(join(runsRoot, runId), artifact);
  return runId;
};
