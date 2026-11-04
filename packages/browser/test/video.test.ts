/**
 * A session's recording: the file, its duration, its frame, its caps, and the stated absence
 * of one.
 *
 * The assertions that need a browser drive one real walk each over the fixture site through
 * the package's public entry point — `createLiveSource({ video })` and `walkTask` — and read
 * the `.webm` back off disk. Nothing here asserts a Playwright object, and nothing reads a
 * file that is still being written: `walkTask` finishes the recording before it returns, and
 * finishing is what closes the context and saves the file.
 *
 * The caps are the contract's, and the cap assertions replace them with figures a test can
 * reach. What is asserted here is the behaviour at a cap — that a session long enough to have
 * reached the old 30-second screen cap now carries a complete timeline, and that a session
 * reporting a cut was really cut; the two figures themselves live in
 * `@personavision/contract` and are asserted there.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SCHEMA_VERSION, runPaths, sessionSchema } from '@personavision/contract';
import type { VideoStore } from '@personavision/contract';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveSource,
  prepareRecording,
  readRecording,
  videoFrame,
  walkTask,
} from '../src/index.js';
import type {
  DecideAction,
  Device,
  TaskDefinition,
  TaskWalkResult,
  VideoRequest,
} from '../src/index.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

/** See `geometry.test.ts`: a developer without the browser is skipped, CI is not. */
const CHROMIUM_INSTALLED = existsSync(chromium.executablePath());
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** A recorded walk is two captures, one action, and a video saved and measured. */
const WALK_TIMEOUT_MS = 60_000;

/**
 * The bucket the object-store case pretends to be configured with. It appears in no artifact
 * and in no message, which is what the session JSON is asserted against.
 */
const VIDEO_BUCKET = 'pv-test-session-videos';

const MOBILE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  touch: true,
};

/**
 * Two steps of `test/fixtures/site/LANDMARKS.md`'s checkout: enough for a walk with two
 * screens and one action between them, and short enough to record several times in a suite.
 */
const TASK: TaskDefinition = {
  id: 'checkout',
  prompt: 'Buy the tote bag',
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
      match: { urlPattern: '/payment\\.html', requiredSelector: '#payment-form' },
      primaryAction: { selector: '#payment-submit' },
    },
  ],
};

/** The 720p box every recording fits inside. */
const FRAME_BOX = { width: 1280, height: 720 };

/**
 * A session the contract accepts, carrying the walk's screens, its actions and its video — so
 * that a field this module spells wrongly, or an offset list of the wrong length, is a
 * failure here rather than a session JSON nothing can read.
 */
const sessionOf = (walked: TaskWalkResult, sessionId: string): unknown => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId,
  runId: '2026-10-27-1000-fixture',
  variant: walked.variant,
  taskId: TASK.id,
  kind: 'simulated',
  persona: null,
  participant: null,
  seed: 7,
  startedAt: '2026-10-27T10:00:00.000Z',
  durationMs: 1_200,
  screens: walked.screens.map((screen, index) => ({
    index,
    step: screen.capture.step ?? 'cart',
    screenshot: screen.capture.screenshot ?? 'screenshots/control/cart.png',
    scrollY: 0,
    intent: TASK.prompt,
    decidedAction: screen.action?.action.type ?? 'none',
  })),
  fixations: [],
  saccades: [],
  actions: walked.screens
    .filter((screen) => screen.action !== null)
    .map((screen) => ({
      tMs: 100,
      type: screen.action?.action.type ?? 'click',
      target: null,
      aoiId: null,
      value: null,
      ok: screen.action?.ok ?? true,
    })),
  outcome: {
    status: 'success',
    step: walked.step ?? 'cart',
    reason: 'the walk reached the last step the task declares',
    attribution: 'product',
    excludedFromScores: false,
  },
  integrity: walked.integrity,
  ...(walked.video === undefined ? {} : { video: walked.video }),
});

/** A decision layer that dwells on the screen before acting: how a cap is reached. */
const dwellThenAdvance =
  (forMs: number): DecideAction =>
  async (_screen, step) => {
    await new Promise((resolve) => setTimeout(resolve, forMs));
    return step === null ? null : { type: 'click', selector: step.primaryAction.selector };
  };

describe('the frame a session is recorded at', () => {
  it('scales a device viewport to fit inside 720p and keeps its aspect ratio', () => {
    // A phone is taller than the box, so it is recorded as a tall 720 rather than as a strip
    // in the middle of a landscape frame.
    const phone = videoFrame({ width: 390, height: 844 });
    expect(phone.height).toBe(720);
    expect(phone.width / phone.height).toBeCloseTo(390 / 844, 2);

    expect(videoFrame({ width: 1440, height: 900 })).toEqual({ width: 1152, height: 720 });

    for (const frame of [phone, videoFrame({ width: 1440, height: 900 })]) {
      expect(frame.width).toBeLessThanOrEqual(FRAME_BOX.width);
      expect(frame.height).toBeLessThanOrEqual(FRAME_BOX.height);
      // An encoder's macroblocks are even, and so are both sides of a frame.
      expect(frame.width % 2).toBe(0);
      expect(frame.height % 2).toBe(0);
    }
  });

  it('never scales a viewport up: a small device is recorded at its own size', () => {
    expect(videoFrame({ width: 320, height: 480 })).toEqual({ width: 320, height: 480 });
  });
});

describe('bytes that are not a recording', () => {
  it('are measured as nothing rather than guessed at', () => {
    expect(readRecording(Buffer.from('this is not a WebM'))).toBeNull();
    expect(readRecording(new Uint8Array())).toBeNull();
  });
});

describe('a recording that cannot start', () => {
  let runDir: string;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'pv-video-prepare-'));
    // The one place the videos directory goes is occupied by a file, so making it fails
    // whoever the test runs as — which `chmod` cannot promise.
    await writeFile(runPaths(runDir).videosDir, 'not a directory');
  });

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('is found before a browser is launched, and says which directory it was', async () => {
    const prepared = await prepareRecording({ runDir, sessionId: 'S-01' });

    expect(prepared.dir).toBeNull();
    expect(prepared.failed).toContain(runPaths(runDir).videosDir);
    expect(prepared.failed).toContain('not recorded');
  });
});

describeWithChromium('a recorded session', () => {
  let site: FixtureSite;
  let runs: string;

  beforeAll(async () => {
    site = await serveFixtureSite();
    runs = await mkdtemp(join(tmpdir(), 'pv-video-'));
  });

  afterAll(async () => {
    await site.close();
    await rm(runs, { recursive: true, force: true });
  });

  /** One walk of the two-step task, recorded into a run directory of its own. */
  const record = async (
    video: Omit<VideoRequest, 'runDir'>,
    options: { readonly runDir?: string; readonly decide?: DecideAction } = {},
  ): Promise<{ walked: TaskWalkResult; runDir: string; wallClockMs: number }> => {
    const runDir = options.runDir ?? (await mkdtemp(join(runs, 'run-')));
    const started = Date.now();
    const walked = await walkTask(createLiveSource({ video: { ...video, runDir } }), {
      variant: { id: 'control', url: `${site.url}/cart.html` },
      device: MOBILE,
      task: TASK,
      runDir,
      ...(options.decide === undefined ? {} : { decide: options.decide }),
    });
    return { walked, runDir, wallClockMs: Date.now() - started };
  };

  it(
    'leaves a non-empty WebM at the contract’s path, whose measured duration is the one it reports',
    async () => {
      // The session dwells on its first screen for a known second and a half, which is what
      // the recording's own clock is then checked against.
      const dwellMs = 1_500;
      const { walked, runDir, wallClockMs } = await record(
        { sessionId: 'S-01' },
        { decide: dwellThenAdvance(dwellMs) },
      );

      expect(walked.failure).toBeNull();
      expect(walked.outcome).toBeNull();
      expect(walked.completed).toBe(true);
      expect(walked.video?.state).toBe('recorded');
      if (walked.video?.state !== 'recorded') return;

      // The path is the contract's, in the run-directory-relative form a session records.
      expect(walked.video.path).toBe(runPaths('').video('S-01'));
      const onDisk = join(runDir, walked.video.path);
      expect(onDisk).toBe(runPaths(runDir).video('S-01'));

      const bytes = readFileSync(onDisk);
      expect(bytes.length).toBeGreaterThan(0);

      // Measured off the file rather than echoed back from what the session reported: the
      // duration a session claims is the duration its own file has.
      const facts = readRecording(bytes);
      expect(facts).not.toBeNull();
      expect(facts?.durationMs).toBe(walked.video.durationMs);

      // And the file's clock is real time, within a stated bracket: the recording holds at
      // least the second and a half the session spent dwelling, and no more than the whole
      // walk plus the **one second** Playwright holds the last frame for when it stops
      // recording — which is why a recording can outlast the session that made it.
      expect(walked.video.durationMs).toBeGreaterThan(dwellMs);
      expect(walked.video.durationMs).toBeLessThanOrEqual(wallClockMs + 2_000);

      // The same clock, read through the offsets: the action on the first screen happened
      // the dwell after the screen was captured, within half a second.
      const dwelled =
        (walked.video.actionOffsetsMs[0] ?? 0) - (walked.video.screenOffsetsMs[0] ?? 0);
      expect(dwelled).toBeGreaterThanOrEqual(dwellMs);
      expect(dwelled).toBeLessThan(dwellMs + 500);
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'hands the recording to the object store, and records the contract’s own path for it',
    async () => {
      // A fake store, in process: no network, no credential, no bucket. What is asserted is
      // that the session is indistinguishable from a locally stored one — the same path, the
      // same duration, the same offsets — and that nothing of the store reaches the artifact.
      const taken = new Map<string, Uint8Array>();
      const store: VideoStore = {
        put: (objectName, bytes) => {
          taken.set(objectName, bytes);
          return Promise.resolve();
        },
        locate: () => Promise.resolve({ kind: 'gone', reason: 'not asked for here' }),
        remove: () => Promise.resolve(),
      };

      const { walked, runDir } = await record({ sessionId: 'S-05', store });
      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');

      // The path a session JSON records is the run-directory-relative one, exactly as it is
      // for a recording on disk: a session does not know where its video went.
      expect(walked.video.path).toBe(runPaths('').video('S-05'));
      expect(walked.video.durationMs).toBeGreaterThan(0);

      // The bytes are in the store, under the run, and are a WebM something can measure.
      const objectName = `${basename(runDir)}/${runPaths('').video('S-05')}`;
      const stored = taken.get(objectName);
      expect(stored).toBeDefined();
      expect(readRecording(stored ?? new Uint8Array())?.durationMs).toBe(walked.video.durationMs);
      // And the run directory holds no second copy of them.
      expect(existsSync(join(runDir, walked.video.path))).toBe(false);

      // The session the contract accepts carries the path and nothing of the store: no bucket
      // name, no object URL and no credential, which is what `CONTEXT.md` requires of a run
      // artifact.
      const session = JSON.stringify(sessionSchema.parse(sessionOf(walked, 'S-05')));
      expect(session).toContain(runPaths('').video('S-05'));
      expect(session).not.toContain(VIDEO_BUCKET);
      expect(session).not.toContain('storage.googleapis.com');
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'is recorded at 720p: the device’s own viewport, scaled to fit the box',
    async () => {
      const { walked, runDir } = await record({ sessionId: 'S-02' });
      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');

      // The frame the file declares, not the one that was asked for.
      const frame = readRecording(readFileSync(join(runDir, walked.video.path)))?.frame;
      expect(frame).toEqual(videoFrame(MOBILE.viewport));
      expect(frame?.height).toBeLessThanOrEqual(FRAME_BOX.height);
      expect(frame?.width).toBeLessThanOrEqual(FRAME_BOX.width);
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'records where every screen and every action is in the recording, and the contract accepts them',
    async () => {
      const { walked, runDir } = await record({ sessionId: 'S-01' });
      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');

      const { screenOffsetsMs, actionOffsetsMs, durationMs } = walked.video;
      expect(screenOffsetsMs).toHaveLength(walked.screens.length);
      expect(actionOffsetsMs).toHaveLength(
        walked.screens.filter((screen) => screen.action !== null).length,
      );
      // Nothing was truncated, so every entry is inside the video and in the walk's order.
      expect(walked.video.truncated).toBeNull();
      for (const offsets of [screenOffsetsMs, actionOffsetsMs]) {
        expect(offsets).not.toContain(null);
        expect(offsets.every((offset) => (offset ?? -1) <= durationMs)).toBe(true);
        expect([...offsets]).toEqual([...offsets].sort((a, b) => (a ?? 0) - (b ?? 0)));
      }
      // The screen was captured before the action on it was taken.
      expect(screenOffsetsMs[0] ?? durationMs).toBeLessThanOrEqual(
        actionOffsetsMs[0] ?? durationMs,
      );

      expect(() => sessionSchema.parse(sessionOf(walked, 'S-01'))).not.toThrow();
      expect(readFileSync(join(runDir, walked.video.path)).length).toBeGreaterThan(0);
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'keeps a whole timeline for a session whose every screen outlasts half a minute',
    async () => {
      // The recorder's own clock, stubbed so that every mark lands three-quarters of a minute
      // after the last: each screen of this walk then outlasts the 30 seconds a screen this
      // package shipped with, which is the shape of the owner's run on #412 — one model
      // decision slower than the cap, and every offset after the first was `null`.
      let elapsedMs = 0;
      const screensThatThink = (): number => (elapsedMs += 45_000);

      const { walked } = await record(
        { sessionId: 'S-07', now: screensThatThink },
        { decide: dwellThenAdvance(100) },
      );
      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');

      // Three-quarters of a minute a screen is well inside the contract's screen cap, so
      // nothing was cut and the session's timeline is complete: every screen and every action
      // has an offset, which is what the old cap took away.
      expect(walked.video.truncated).toBeNull();
      expect(walked.video.screenOffsetsMs).toHaveLength(walked.screens.length);
      expect(walked.video.screenOffsetsMs).not.toContain(null);
      expect(walked.video.actionOffsetsMs).not.toContain(null);
      // Each one lands inside the recording. The stub clock runs ahead of the real file, so
      // the offsets are clamped to its own duration; what is asserted here is that there is
      // an offset at all, and that it is a frame the recording has.
      for (const offset of [...walked.video.screenOffsetsMs, ...walked.video.actionOffsetsMs]) {
        expect(offset).not.toBeNull();
        expect(offset ?? -1).toBeLessThanOrEqual(walked.video.durationMs);
      }

      expect(() => sessionSchema.parse(sessionOf(walked, 'S-07'))).not.toThrow();
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'stops at the per-screen cap, says so, and gives the screens it did not reach no offset',
    async () => {
      const capMs = 800;
      const { walked, runDir } = await record(
        { sessionId: 'S-03', caps: { screen: capMs } },
        { decide: dwellThenAdvance(1_500) },
      );

      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');
      expect(walked.video.truncated).toBe('screen');
      // The duration it reached: the cap is measured from where the screen began, so the
      // recording stops that far past the first screen's offset and not a frame later.
      expect(walked.video.durationMs).toBeGreaterThan(0);
      expect(walked.video.durationMs).toBeLessThanOrEqual(
        (walked.video.screenOffsetsMs[0] ?? 0) + capMs,
      );

      // The session kept going, so its later entries are in the session and not in the video:
      // the last screen is always one the recording stopped before. Whether the *first* one is
      // inside depends on how long the first capture took, which is a machine's business and
      // not this assertion's.
      expect(walked.screens.length).toBeGreaterThan(1);
      expect(walked.video.screenOffsetsMs).toContain(null);
      expect(walked.video.screenOffsetsMs.at(-1)).toBeNull();

      // Cut, and still a WebM: read back off disk and measured rather than assumed.
      const cut = readFileSync(join(runDir, walked.video.path));
      expect(cut.length).toBeGreaterThan(0);
      expect(readRecording(cut)?.durationMs).toBe(walked.video.durationMs);
      expect(readRecording(cut)?.frame).toEqual(videoFrame(MOBILE.viewport));

      // A truncated recording is a session the contract still accepts, nulls and all.
      expect(() => sessionSchema.parse(sessionOf(walked, 'S-03'))).not.toThrow();
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'stops at the per-session cap and names that one instead',
    async () => {
      const capMs = 1_500;
      const { walked, runDir, wallClockMs } = await record(
        { sessionId: 'S-04', caps: { session: capMs } },
        { decide: dwellThenAdvance(1_200) },
      );

      if (walked.video?.state !== 'recorded') throw new Error('the session recorded nothing');
      expect(walked.video.truncated).toBe('session');
      expect(walked.video.durationMs).toBeGreaterThan(0);
      expect(walked.video.durationMs).toBeLessThanOrEqual(capMs);

      // A session may not report a cut over a file of the full length (#412). The walk ran
      // well past the cap, and the duration is read back off the bytes on disk rather than
      // from what the session says — so a cutter that quietly stopped cutting fails here,
      // instead of surfacing as a recording nothing can line up with.
      expect(wallClockMs).toBeGreaterThan(capMs);
      const measured = readRecording(readFileSync(join(runDir, walked.video.path)));
      expect(measured?.durationMs).toBe(walked.video.durationMs);
      expect(measured?.durationMs ?? 0).toBeLessThanOrEqual(capMs);
      // Cut at the cap, not down to a single frame left behind.
      expect(measured?.durationMs ?? 0).toBeGreaterThan(capMs - 500);
      // A cap is not a failure: the walk still reached the task's last step.
      expect(walked.completed).toBe(true);
      expect(walked.failure).toBeNull();
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'is a complete session with its video absent when the recording cannot start at all',
    async () => {
      const runDir = await mkdtemp(join(runs, 'unwritable-'));
      // The videos directory cannot be made, because a file is already in its place.
      await writeFile(runPaths(runDir).videosDir, 'not a directory');

      const { walked } = await record({ sessionId: 'S-05' }, { runDir });

      // The session is otherwise complete, and this is not an automation failure.
      expect(walked.completed).toBe(true);
      expect(walked.failure).toBeNull();
      expect(walked.outcome).toBeNull();
      expect(walked.screens).toHaveLength(TASK.steps.length);
      // And the absence is stated, with its reason in words.
      expect(walked.video?.state).toBe('absent');
      if (walked.video?.state !== 'absent') return;
      expect(walked.video.reason).toContain(runPaths(runDir).videosDir);
      expect(existsSync(runPaths(runDir).video('S-05'))).toBe(false);

      expect(() => sessionSchema.parse(sessionOf(walked, 'S-05'))).not.toThrow();
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'records nothing at all when nobody asked it to, and names no video',
    async () => {
      const runDir = await mkdtemp(join(runs, 'unrecorded-'));
      const walked = await walkTask(createLiveSource(), {
        variant: { id: 'control', url: `${site.url}/cart.html` },
        device: MOBILE,
        task: TASK,
        runDir,
      });

      expect(walked.completed).toBe(true);
      // A walk nobody asked to record names no video, which is the contract's difference
      // between a session that recorded none and one that lost one.
      expect(walked.video).toBeUndefined();
      expect(existsSync(runPaths(runDir).videosDir)).toBe(false);
      expect(() => sessionSchema.parse(sessionOf(walked, 'S-06'))).not.toThrow();
    },
    WALK_TIMEOUT_MS,
  );

  it(
    'records one session per source: a second walk never writes over the first recording',
    async () => {
      const runDir = await mkdtemp(join(runs, 'twice-'));
      const walk = {
        variant: { id: 'control', url: `${site.url}/cart.html` },
        device: MOBILE,
        task: TASK,
        runDir,
      };
      // One source, two walks — the shape `test/integration/live-source.test.ts` already uses.
      const source = createLiveSource({ video: { runDir, sessionId: 'S-01' } });

      const first = await walkTask(source, walk);
      const firstBytes = readFileSync(runPaths(runDir).video('S-01')).length;
      const second = await walkTask(source, walk);

      expect(first.video?.state).toBe('recorded');
      // The second session is complete and records nothing, rather than writing over the
      // first session's file and reporting a path that is already another session's.
      expect(second.completed).toBe(true);
      expect(second.failure).toBeNull();
      expect(second.video).toBeUndefined();
      expect(readFileSync(runPaths(runDir).video('S-01')).length).toBe(firstBytes);
    },
    WALK_TIMEOUT_MS,
  );
});
