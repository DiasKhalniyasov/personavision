/**
 * What the Session replay's tests need on top of the app harness.
 *
 * The app, the providers and the run data all come from `tests/app.tsx`, which serves the
 * **repository's own** run directory — session files included — so these tests assert what
 * a reader of the committed example run sees. What is here is the little this screen adds:
 * the seed run's id, a session file a test wants to change before it is served, and a
 * teardown that also forgets the sessions this screen read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { runPaths } from '@personavision/contract';
import { clearSessionCache } from '../../src/screens/replay/useReplaySession';
import { forgetRuns, serveRunData } from '../app';

export { mountApp } from '../app';
export { serveRunData };

/** The committed example run: 24 people over two versions of the northwind checkout. */
export const SEED_RUN = '2026-10-24-1402-northwind-demo';

// Under the jsdom environment `new URL(…, import.meta.url)` throws, as `tests/app.tsx` notes.
const runsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../tests/fixtures/runs');

const layout = runPaths('');

/** The URL a session file is served at — the contract's path under the run's own. */
export const sessionPath = (sessionId: string): string =>
  `/runs/${SEED_RUN}/${layout.session(sessionId)}`;

/** One session of the seed run, parsed, for a test that wants to serve a variation of it. */
export function readSeedSession(sessionId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(runsRoot, SEED_RUN, layout.session(sessionId)), 'utf8'),
  ) as Record<string, unknown>;
}

/** Every run and session read so far is forgotten, so one test cannot see another's. */
export const forget = (): void => {
  forgetRuns();
  clearSessionCache();
};

/* ---- The recording the stage plays ------------------------------------- */

/** The URL the recording of one session is served at, as the contract spells the path. */
export const videoPath = (sessionId: string): string =>
  `/runs/${SEED_RUN}/${layout.video(sessionId)}`;

/** The URL `recommendations.json` of the seed run is served at. */
export const recommendationsPath = (): string => `/runs/${SEED_RUN}/${layout.recommendations}`;

interface SeedSession {
  readonly durationMs: number;
  readonly screens: readonly { readonly index: number }[];
  readonly actions: readonly { readonly tMs: number }[];
  readonly fixations: readonly { readonly screenIndex: number; readonly tMs: number }[];
}

/**
 * Where each screen begins on the session's own clock: its first fixation, which is the
 * rule `src/session/timeline.ts` uses — so a screen offset written from it is the moment
 * the timeline reports for that screen, and the two clocks agree about where a screen is.
 */
const screenStarts = (file: SeedSession): number[] =>
  file.screens.map((_screen, index) => {
    const first = file.fixations.find((fixation) => fixation.screenIndex === index);
    return index === 0 ? 0 : (first?.tMs ?? 0);
  });

/** What the agent spent waiting before each action, keyed by the action's own index. */
export type Waits = Readonly<Record<number, number>>;

/** The waiting the recording had done by the time it stamped the entry at `tMs`. */
const waitedBy = (file: SeedSession, waits: Waits, tMs: number): number =>
  Object.entries(waits)
    .filter(([index]) => (file.actions[Number(index)]?.tMs ?? Number.POSITIVE_INFINITY) <= tMs)
    .reduce((total, [, ms]) => total + ms, 0);

/**
 * One session of the seed run with the recording a run of this product now makes.
 *
 * The committed fixture predates session video, which is the honest fixture for the
 * fallback — a session with no recording still has a replay — so a test about the stage
 * serves the same session back with a `video` block. The offsets are positional, as the
 * contract holds them to be.
 *
 * `shiftMs` is the one knob that matters: the recorder's clock and the session's own start
 * together and are not the same clock afterwards, so a recording whose entries land later
 * than the session's figures is what the offsets exist for. The default is no shift, which
 * is the simple case a test about something else wants.
 */
export function recordedSession(
  sessionId: string,
  options: {
    shiftMs?: number;
    /** Milliseconds the recording ran on for after the session's last figure. */
    plusMs?: number;
    /**
     * Milliseconds the agent spent being told what to do next **before** the action of
     * each index: time the recording ran and the session's own clock did not, which is
     * what a wait is made of. A browser-driven run is mostly made of these, because the
     * gaze model's clock costs no wall time and a model call does.
     */
    waits?: Waits;
    truncated?: 'screen' | 'session' | null;
  } = {},
): Record<string, unknown> {
  const file = readSeedSession(sessionId);
  const read = file as unknown as SeedSession;
  const shiftMs = options.shiftMs ?? 0;
  const waits = options.waits ?? {};
  const offset = (tMs: number): number => tMs + shiftMs + waitedBy(read, waits, tMs);
  const waitedInAll = Object.values(waits).reduce((total, ms) => total + ms, 0);

  return {
    ...file,
    video: {
      state: 'recorded',
      path: layout.video(sessionId),
      durationMs: read.durationMs + shiftMs + waitedInAll + (options.plusMs ?? 0),
      truncated: options.truncated ?? null,
      screenOffsetsMs: screenStarts(read).map(offset),
      actionOffsetsMs: read.actions.map((action) => offset(action.tMs)),
    },
  };
}

/** A session whose recorder said why there is no file. */
export function unrecordedSession(sessionId: string, reason: string): Record<string, unknown> {
  return { ...readSeedSession(sessionId), video: { state: 'absent', reason } };
}

/** What a request for a recording was answered with, so a test can assert the mount is read. */
export interface VideoRequest {
  readonly path: string;
  readonly method: string;
}

/**
 * The seed run served with recordings in it.
 *
 * `serveRunData` serves the repository's own run directory and the files a test replaces;
 * the recordings themselves are not JSON, so they are answered here — a `content-length` for
 * the `HEAD` the outcome card reads the file's size with, and `accept-ranges`, which is what
 * the real mount answers and what makes a recording seekable (#245).
 */
export async function serveRecordings(
  options: {
    sessions?: Record<string, Record<string, unknown>>;
    /** What the mount reports the recording's size as. `null` leaves it unreported. */
    videoBytes?: number | null;
    /** `recommendations.json`, or nothing, which is a run that produced none. */
    recommendations?: Record<string, unknown>;
  } = {},
): Promise<{ requests: VideoRequest[] }> {
  const files: Record<string, string> = {};
  for (const [sessionId, file] of Object.entries(options.sessions ?? {})) {
    files[sessionPath(sessionId)] = JSON.stringify(file);
  }
  // Since #262 the fixture directory on disk carries a `recommendations.json` of its own, so
  // a test that asks for none has to be answered 404 rather than served what is there: the
  // outcome card's "no recommendations" row is about a run that produced none.
  const missing = options.recommendations === undefined ? [recommendationsPath()] : [];
  if (options.recommendations !== undefined) {
    files[recommendationsPath()] = JSON.stringify(options.recommendations);
  }
  await serveRunData({ files, missing });

  const served = globalThis.fetch;
  const requests: VideoRequest[] = [];
  const bytes = options.videoBytes === undefined ? 11_400_000 : options.videoBytes;

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    // A relative path is what the screen asks for, as a page does; the stub resolves it
    // the way the browser would.
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      globalThis.location.href,
    );
    if (!url.pathname.startsWith(`/runs/${SEED_RUN}/${layout.videosDir}/`)) {
      return served(input, init);
    }
    requests.push({ path: url.pathname, method: init?.method ?? 'GET' });
    return Promise.resolve(
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'video/webm',
          'accept-ranges': 'bytes',
          ...(bytes === null ? {} : { 'content-length': String(bytes) }),
        },
      }),
    );
  });

  return { requests };
}

/* ---- Driving a video element under jsdom ------------------------------- */

/**
 * jsdom lays out nothing and plays nothing: a `<video>` there has no duration, no frame
 * size and a `play()` that is not implemented. These give the element the three things the
 * stage reads from it — a settable `currentTime`, a frame size, and a `play`/`pause` that
 * resolve — so a test can drive the player the way a browser would and assert what the
 * screen does about it. Nothing about the component is stubbed.
 */
export function stubVideoPlayback(): void {
  const media = globalThis.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  media.play = function play(this: HTMLMediaElement) {
    return Promise.resolve();
  };
  media.pause = function pause(this: HTMLMediaElement) {
    return undefined;
  };
  // `videoWidth` and `videoHeight` are `HTMLVideoElement`'s own, and jsdom's answer 0: a
  // definition on the media prototype would be shadowed by it.
  for (const [prototype, name, store] of [
    [globalThis.HTMLMediaElement.prototype, 'currentTime', '__t'],
    [globalThis.HTMLVideoElement.prototype, 'videoWidth', '__w'],
    [globalThis.HTMLVideoElement.prototype, 'videoHeight', '__h'],
  ] as const) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      get(this: Record<string, unknown>) {
        return (this[store] as number | undefined) ?? 0;
      },
      set(this: Record<string, unknown>, value: number) {
        this[store] = value;
      },
    });
  }
}

/** The `<video>` on the stage. */
export const stage = (): HTMLVideoElement => {
  const video = document.querySelector('video');
  if (video === null) throw new Error('there is no video on this screen');
  return video as HTMLVideoElement;
};

/** The file reporting what it is: the frame size the outcome card prints. */
export function metadataArrives(size: { width: number; height: number }): void {
  const video = stage() as unknown as Record<string, unknown>;
  video.__w = size.width;
  video.__h = size.height;
  fireEvent(stage(), new Event('loadedmetadata'));
}

/**
 * The element arriving where the page seeked it, as a real player does.
 *
 * The replay's clock is the **session's** and the page owns it, so the element is never
 * the thing being advanced: what a test drives is time (`vi.advanceTimersByTime`), and this
 * is here for the one thing the element still reports on its own — a decode it could not do.
 */
export function playbackFails(): void {
  fireEvent(stage(), new Event('error'));
}
