/**
 * The session's own JSON naming its video, and the offsets that make a cited timestamp
 * resolve.
 *
 * Two suites, because there are two things to hold. The first drives `runSession` over the
 * committed capture set with a recording that writes nothing: what it asserts is the wiring
 * above a recording — one offset per screen and one per action, in the session's own order,
 * written into the file the contract parses. How a recording behaves is
 * `packages/browser`'s and is asserted there (`test/video.test.ts`), so nothing here opens a
 * browser.
 *
 * The second is the real thing: one live session of the four-step fixture task, recorded by
 * Chromium into a run directory, whose session JSON is parsed with no exception made for it.
 * A developer without the browser is skipped with the reason in the suite's name, and CI is
 * not — `packages/browser`'s rule, from its own helper.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths, sessionSchema } from '@personavision/contract';
import {
  createFixtureSource,
  createLiveSource,
  readRecording,
  SessionBudget,
} from '@personavision/browser';
import { FREE_USAGE } from '@personavision/provider';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSession } from '../src/index.js';
import type { SessionVideo } from '@personavision/contract';
import type { CaptureSource, SessionRecording, VideoRequest } from '@personavision/browser';
import type { DecisionProvider } from '@personavision/provider';
import { CHROMIUM_INSTALLED } from '../../browser/test/helpers/chromium.js';
import { serveFixtureSite } from '../../browser/test/helpers/static-site.js';
import type { FixtureSite } from '../../browser/test/helpers/static-site.js';
import { COMMITTED, providerThat, sessionOver, sweep, temporaryRunDir } from './harness.js';

/** See `packages/browser/test/geometry.test.ts`: without the browser, skipped; CI is not. */
const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** A live session of four steps is four captures and three actions, so it gets its own cap. */
const LIVE_TIMEOUT_MS = 60_000;

/** What one recording was asked to mark, in the order it was asked. */
interface Marked {
  readonly screens: number[];
  readonly actions: number[];
}

/**
 * A recording that writes nothing and remembers what it was asked to mark.
 *
 * `tickMs` is its clock: every reading is that much later than the last, so an offset is a
 * number a test can recognise and two marks are never the same moment.
 */
const recordingThat = (
  video: (marked: Marked) => SessionVideo,
  tickMs = 100,
): { readonly recording: SessionRecording; readonly marked: Marked } => {
  const marked: Marked = { screens: [], actions: [] };
  let atMs = 0;
  const tick = (): number => (atMs += tickMs);
  return {
    marked,
    recording: {
      at: tick,
      screen: (at) => void marked.screens.push(at ?? tick()),
      action: (at) => void marked.actions.push(at ?? tick()),
      finish: () => Promise.resolve(video(marked)),
    },
  };
};

/** The recording the marks add up to: the block a session that recorded one carries. */
const recordedAs =
  (sessionId: string) =>
  ({ screens, actions }: Marked): SessionVideo => ({
    state: 'recorded',
    path: runPaths('').video(sessionId),
    // A recording outlasts its last mark: Playwright holds the final frame for about a
    // second after the session stops.
    durationMs: Math.max(0, ...screens, ...actions) + 500,
    truncated: null,
    screenOffsetsMs: [...screens],
    actionOffsetsMs: [...actions],
  });

/**
 * The committed capture set, replayed, with a recording bound to the session it opens — the
 * shape a source that opens a browser has. The requests it was handed are kept, because the
 * session names the file it is recorded into and nothing else may.
 */
const recordedBy = (
  recording: SessionRecording,
): { readonly source: CaptureSource; readonly asked: (VideoRequest | undefined)[] } => {
  const fixtures = createFixtureSource(COMMITTED);
  const asked: (VideoRequest | undefined)[] = [];
  return {
    asked,
    source: {
      ...fixtures,
      openSession: async (variant, device, session) => {
        asked.push(session?.video);
        // Set on the handle the fixture source made rather than on a copy of it: that
        // source knows its own handles by identity and refuses one it did not open.
        return Object.assign(await fixtures.openSession(variant, device), {
          video: recording,
        });
      },
    },
  };
};

/** Scrolls the first screen it is shown, then clicks what the agent looked at hardest. */
const scrollsThenClicks = (): DecisionProvider => {
  let scrolled = false;
  return providerThat((context) => {
    const target = context.fixatedElements[0];
    if (scrolled && target !== undefined) {
      return {
        intent: 'Getting on with it.',
        action: { kind: 'click', targetElementId: target.id },
        usage: FREE_USAGE,
      };
    }
    scrolled = true;
    return {
      intent: 'Looking further down.',
      action: { kind: 'scroll', targetElementId: null },
      usage: FREE_USAGE,
    };
  });
};

/** A session as everything but its recording, serialized: compared as bytes and not as a value. */
const withoutVideo = (session: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(session).filter(([key]) => key !== 'video')));

const readSessionFile = async (runDir: string, sessionId: string): Promise<unknown> =>
  JSON.parse(await readFile(runPaths(runDir).session(sessionId), 'utf8'));

describe('a session whose source records one', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await temporaryRunDir();
  });

  afterEach(async () => {
    await sweep(runDir);
  });

  it('names its video and carries one offset per screen and per action', async () => {
    const { recording, marked } = recordingThat(recordedAs('S-01'));
    const { source, asked } = recordedBy(recording);

    const session = await runSession(sessionOver(runDir, { source }));

    // The recording was asked for by the session it belongs to, at the contract's spelling.
    // The run is named rather than taken from the directory: a remote task's run directory
    // is a scratch directory of its own (#316).
    expect(asked).toEqual([{ runDir, runId: '2026-10-27-1200-fixture', sessionId: 'S-01' }]);
    expect(session.video?.state).toBe('recorded');
    if (session.video?.state !== 'recorded') return;
    expect(session.video.path).toBe(runPaths('').video('S-01'));

    // Positional, and exactly as long as the arrays they index: this is the length check
    // `sessionSchema` makes, and `writeSession` has already made it on the way to disk.
    expect(session.video.screenOffsetsMs).toHaveLength(session.screens.length);
    expect(session.video.actionOffsetsMs).toHaveLength(session.actions.length);
    expect(session.screens.length).toBeGreaterThan(0);
    expect(session.actions.length).toBeGreaterThan(0);
    expect(marked.screens).toEqual(session.video.screenOffsetsMs);
    expect(marked.actions).toEqual(session.video.actionOffsetsMs);

    // In the session's own order, and inside the recording they cite.
    const { durationMs } = session.video;
    for (const offsets of [session.video.screenOffsetsMs, session.video.actionOffsetsMs]) {
      expect(offsets).not.toContain(null);
      expect([...offsets]).toEqual([...offsets].sort((a, b) => (a ?? 0) - (b ?? 0)));
      expect(offsets.every((offset) => (offset ?? -1) <= durationMs)).toBe(true);
    }
    // A screen is captured before anything is done to it.
    expect(session.video.screenOffsetsMs[0] ?? 0).toBeLessThan(
      session.video.actionOffsetsMs[0] ?? 0,
    );

    // On disk, and parsed off it with no exception made for the video block.
    const onDisk = await readSessionFile(runDir, 'S-01');
    expect(onDisk).toEqual(session);
    expect(() => sessionSchema.parse(onDisk)).not.toThrow();
  });

  it('gives a screen captured twice two offsets', async () => {
    const { recording } = recordingThat(recordedAs('S-01'));
    const { source } = recordedBy(recording);

    const session = await runSession(
      sessionOver(runDir, {
        source,
        providers: { decision: scrollsThenClicks() },
        maxScreens: 3,
      }),
    );

    if (session.video?.state !== 'recorded') throw new Error('the session recorded nothing');
    // The scroll leaves the agent on the step it was already on, so the same screen is
    // captured twice — two screens of the session, two decisions and two offsets.
    expect(session.screens.length).toBeGreaterThan(1);
    expect(session.screens[1]?.step).toBe(session.screens[0]?.step);
    expect(session.video.screenOffsetsMs).toHaveLength(session.screens.length);
    expect(session.video.screenOffsetsMs[0]).not.toBe(session.video.screenOffsetsMs[1]);
  });

  it('marks an action where it happened, not where the driver answered', async () => {
    const { recording } = recordingThat(recordedAs('S-01'));
    const { source } = recordedBy(recording);
    /** The recording's clock while the driver is away, which is where it may not be marked. */
    const whileActing: number[] = [];
    const acting: CaptureSource = {
      ...source,
      act: (page, action, ctx, options) => {
        // A click waits out the navigation it causes and the budget may retry it, so the
        // recording's clock has moved on by the time the driver answers.
        whileActing.push(recording.at(), recording.at(), recording.at());
        return source.act(page, action, ctx, options);
      },
    };

    const session = await runSession(
      sessionOver(runDir, {
        source: acting,
        providers: { decision: scrollsThenClicks() },
        maxScreens: 1,
      }),
    );

    if (session.video?.state !== 'recorded') throw new Error('the session recorded nothing');
    expect(whileActing.length).toBeGreaterThan(0);
    const acted = session.video.actionOffsetsMs[0];
    expect(acted).not.toBeNull();
    // The frame the action happened on, not the frame after the next screen had loaded.
    expect(acted ?? 0).toBeLessThan(Math.min(...whileActing));
  });

  it('finishes and removes the recording of a session the budget gave up on', async () => {
    let finishes = 0;
    const { recording } = recordingThat((marked) => {
      finishes += 1;
      // What finishing does: the file lands at the contract's path. Left unfinished, the
      // browser closing would leave it under the name Playwright chose instead.
      mkdirSync(runPaths(runDir).videosDir, { recursive: true });
      writeFileSync(runPaths(runDir).video('S-01'), 'a recording');
      return recordedAs('S-01')(marked);
    });
    const { source } = recordedBy(recording);
    const slow: CaptureSource = {
      ...source,
      openSession: async (variant, device, session) => {
        // The session arrives after the cap that gave up on it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return source.openSession(variant, device, session);
      },
    };

    const session = await runSession(
      sessionOver(runDir, { source: slow, budget: new SessionBudget({ wallClockMs: 1 }) }),
    );

    expect(session.outcome.status).toBe('automation_failure');
    expect(session.video).toBeUndefined();
    // The late handle's recording is finished and its file removed: a session written up as
    // having no video may not leave one at its own path for a reader to find.
    await vi.waitFor(() => {
      expect(finishes).toBe(1);
      expect(existsSync(runPaths(runDir).video('S-01'))).toBe(false);
    });
  });

  it('is written complete and scored when the recording failed', async () => {
    const reason = 'the videos directory /nope could not be made, so this session has none';
    const { recording } = recordingThat(() => ({ state: 'absent', reason }));
    const { source } = recordedBy(recording);

    const session = await runSession(sessionOver(runDir, { source }));

    expect(session.video).toEqual({ state: 'absent', reason });
    // Otherwise complete, and scored like any other session: a broken recording never costs
    // a person their whole attempt.
    expect(session.screens.length).toBeGreaterThan(0);
    expect(session.outcome.status).not.toBe('automation_failure');
    expect(session.outcome.attribution).not.toBe('automation');
    expect(session.outcome.excludedFromScores).toBe(false);
    expect(await readSessionFile(runDir, 'S-01')).toEqual(session);
  });

  it('leaves everything but the recording byte-identical across two runs of one seed', async () => {
    const run = async (tickMs: number): Promise<string> => {
      const { recording } = recordingThat(recordedAs('S-01'), tickMs);
      await runSession(sessionOver(runDir, { source: recordedBy(recording).source }));
      return readFile(runPaths(runDir).session('S-01'), 'utf8');
    };

    // Two clocks, so the two recordings are the one part that differs: everything else is
    // derived from the seed and has to come back the same bytes.
    const first = JSON.parse(await run(100)) as Record<string, unknown>;
    const second = JSON.parse(await run(130)) as Record<string, unknown>;

    expect(second['video']).not.toEqual(first['video']);
    expect(withoutVideo(second)).toBe(withoutVideo(first));
  });
});

describe('a session nobody could record', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await temporaryRunDir();
  });

  afterEach(async () => {
    await sweep(runDir);
  });

  it('names no video at all, and parses', async () => {
    // Fixture mode: the committed capture set opens no browser, so there is nothing to
    // record and no absence to explain.
    const session = await runSession(sessionOver(runDir));

    expect(session.video).toBeUndefined();
    const onDisk = (await readSessionFile(runDir, 'S-01')) as Record<string, unknown>;
    expect('video' in onDisk).toBe(false);
    expect(() => sessionSchema.parse(onDisk)).not.toThrow();
  });
});

describeWithChromium('a live session of the four-step fixture task', () => {
  let site: FixtureSite;
  let runDir: string;

  beforeAll(async () => {
    site = await serveFixtureSite();
    runDir = await mkdtemp(join(tmpdir(), 'personavision-swarm-video-'));
  });

  afterAll(async () => {
    await site.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it(
    'writes sessions/S-NN.json naming the recording beside it, and the offsets into it',
    async () => {
      const session = await runSession(
        sessionOver(runDir, {
          source: createLiveSource(),
          variant: { id: 'A', url: `${site.url}/cart.html` },
        }),
      );

      expect(session.video?.state).toBe('recorded');
      if (session.video?.state !== 'recorded') return;
      const { durationMs, screenOffsetsMs, actionOffsetsMs } = session.video;

      // `videos/` sits beside `sessions/` and `screenshots/`, at the contract's paths.
      expect(await readdir(runDir)).toEqual(
        expect.arrayContaining(['screenshots', 'sessions', 'videos']),
      );
      expect(session.video.path).toBe(runPaths('').video('S-01'));
      const bytes = await readFile(join(runDir, session.video.path));
      expect(bytes.length).toBeGreaterThan(0);

      // The duration the session claims is the duration the file has, measured off it.
      expect(readRecording(bytes)?.durationMs).toBe(durationMs);

      // Measured against the recording, not inferred: every offset lands inside the file,
      // and the action offsets are in the order the session's own actions are.
      expect(session.video.truncated).toBeNull();
      expect(screenOffsetsMs).toHaveLength(session.screens.length);
      expect(actionOffsetsMs).toHaveLength(session.actions.length);
      expect(session.actions.length).toBeGreaterThan(0);
      for (const offsets of [screenOffsetsMs, actionOffsetsMs]) {
        expect(offsets).not.toContain(null);
        expect(offsets.every((offset) => (offset ?? -1) <= durationMs)).toBe(true);
        expect([...offsets]).toEqual([...offsets].sort((a, b) => (a ?? 0) - (b ?? 0)));
      }

      // Parsed off disk with no exception made for the video block.
      const onDisk = await readSessionFile(runDir, 'S-01');
      expect(onDisk).toEqual(session);
      expect(() => sessionSchema.parse(onDisk)).not.toThrow();
    },
    LIVE_TIMEOUT_MS,
  );
});
