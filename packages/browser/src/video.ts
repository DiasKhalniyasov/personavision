/**
 * The recording a session leaves behind, and the honest absence when it cannot be made.
 *
 * Recording is the browser's own feature: a context opened with `recordVideo: { dir }` has a
 * non-null `page.video()`, and closing the context leaves a `.webm` on disk. It adds no
 * dependency, no binary and no `postinstall` — the one thing it needs is the Chromium
 * `packages/browser/README.md` already documents.
 *
 * **The path is the contract's.** `runPaths(runDir).video(sessionId)` is where the file ends
 * up and `runPaths('').video(sessionId)` is what a session JSON records. Playwright chooses
 * the name of the file it writes, so the recording is saved to the contract's path once the
 * context has closed, and Playwright's own copy is deleted.
 *
 * **The caps are enforced here.** 30 seconds a screen and 10 minutes a session, which is
 * `@personavision/contract`'s `VIDEO_CAP_MS` and nowhere else. Playwright cannot stop
 * recording a page it is still showing, so a cap is enforced on the file: the recording is
 * cut at the cap as it is saved, the screens and actions that happened after it carry no
 * offset, and the result names the cap it hit. A video that is quietly short is worse than
 * one that is missing, because nobody doubts it.
 *
 * **A failed recording is not a failed session.** Every way this file can fail — a videos
 * directory that cannot be made, a context that opened no recording, a file that cannot be
 * saved or measured — comes back as `{ state: 'absent', reason }`, in words, and the session
 * is otherwise complete. Nothing here throws, and nothing here is an automation failure.
 *
 * **The offsets are positional, and the caller marks them.** `screen()` and `action()` are
 * called once per screen and once per action, in the order the session's own `screens` and
 * `actions` arrays record them, because that is the alignment `sessionSchema` length-checks.
 * `walkTask` marks its own; a consumer that drives `openSession` itself marks its own.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { VIDEO_CAP_MS, runPaths } from '@personavision/contract';
import type { SessionVideo, VideoCap } from '@personavision/contract';
import type { Page, Video } from 'playwright';
import type { Viewport } from './types.js';

/** What a session needs to say to be recorded: where the run lives, and which session it is. */
export interface VideoRequest {
  /** The run directory. `videos/` is made inside it, by the contract's spelling. */
  readonly runDir: string;
  /** The session's id — `S-01` — which names the file and is re-derived nowhere. */
  readonly sessionId: string;
  /**
   * The caps, in milliseconds, replacing `VIDEO_CAP_MS`'s.
   *
   * The real figures are the contract's and are restated nowhere; this exists so that the
   * cap behaviour can be driven in a second rather than in ten minutes.
   */
  // ponytail: a test knob, not a feature. A caller that wants a different cap is a decision
  // to make on the contract, where both figures live.
  readonly caps?: Readonly<Partial<Record<VideoCap, number>>>;
  /** The clock, for the same reason. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A recording in progress: where its offsets are marked, and how it is finished. */
export interface SessionRecording {
  /** Marks where the screen about to be captured begins in the recording. */
  screen(): void;
  /** Marks where the action about to be taken happens in it. */
  action(): void;
  /**
   * Closes the context, saves the file at the contract's path, cuts it at a cap it reached,
   * and reports what is on disk. Called **before** the session's browser is closed, and safe
   * to call more than once: a second call answers with the first one's result.
   */
  finish(): Promise<SessionVideo>;
}

/**
 * A recording's first phase. The directory Playwright writes into has to exist before the
 * context that records is opened, and `recordVideo` cannot be added to a context afterwards,
 * so preparing and starting are two steps of one thing.
 */
export interface PreparedRecording {
  /** Where Playwright writes, or `null` when there will be no recording. */
  readonly dir: string | null;
  /** Why there is none, in words, or `null` when there is one. */
  readonly failed: string | null;
  /** Binds the recording to the page the context opened, which starts the offset clock. */
  start(page: Page): SessionRecording;
}

/** The 720p box a recording is scaled to fit. */
const FRAME_BOX: Viewport = { width: 1280, height: 720 };

/**
 * The frame a device is recorded at: its own viewport, scaled to fit inside 720p.
 *
 * The cap is on the pixels, so the aspect ratio stays the device's — a phone is recorded as a
 * tall 720 rather than as a tall strip in the middle of a landscape frame, which is what
 * asking Playwright for the box itself produces. A viewport already inside the box is
 * recorded at its own size and never scaled up, and both sides are even because a video
 * encoder's macroblocks are.
 */
export const videoFrame = (viewport: Viewport): Viewport => {
  const scale = Math.min(
    1,
    FRAME_BOX.width / Math.max(1, viewport.width),
    FRAME_BOX.height / Math.max(1, viewport.height),
  );
  const even = (side: number): number => Math.max(2, 2 * Math.round((side * scale) / 2));
  return { width: even(viewport.width), height: even(viewport.height) };
};

const absent = (reason: string): SessionVideo => ({ state: 'absent', reason });

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A recording that never started: it takes its marks, and reports why there is no file. */
const neverStarted = (reason: string): PreparedRecording => ({
  dir: null,
  failed: reason,
  start: () => ({
    screen: () => undefined,
    action: () => undefined,
    finish: () => Promise.resolve(absent(reason)),
  }),
});

/**
 * Makes the videos directory and hands back the two phases of a recording.
 *
 * A directory that cannot be made is the one failure that is known **before** a browser is
 * launched, which is why it is found here: the session then opens with no `recordVideo` at
 * all, and nothing has been started that could leak.
 */
export const prepareRecording = async (request: VideoRequest): Promise<PreparedRecording> => {
  const videosDir = runPaths(request.runDir).videosDir;
  try {
    await mkdir(videosDir, { recursive: true });
  } catch (error) {
    return neverStarted(
      `the videos directory ${videosDir} could not be made, so this session was not recorded: ${message(error)}`,
    );
  }
  return { dir: videosDir, failed: null, start: (page) => startRecording(page, request) };
};

/** One cap, as it was reached: which it was, and where the recording is cut because of it. */
interface Reached {
  readonly cap: VideoCap;
  readonly cutAtMs: number;
}

const startRecording = (page: Page, request: VideoRequest): SessionRecording => {
  const now = request.now ?? Date.now;
  const caps = { ...VIDEO_CAP_MS, ...request.caps };
  const startedAt = now();
  const screenOffsetsMs: (number | null)[] = [];
  const actionOffsetsMs: (number | null)[] = [];
  /** Where the screen being recorded began, which the per-screen cap is measured from. */
  let screenAtMs = 0;
  let reached: Reached | null = null;
  let finished: Promise<SessionVideo> | null = null;

  /** The earliest cap wins: a session that hits both is cut where the first one landed. */
  const reach = (cap: VideoCap, cutAtMs: number): void => {
    if (reached === null || cutAtMs < reached.cutAtMs) reached = { cap, cutAtMs };
  };

  const check = (atMs: number): void => {
    if (atMs - screenAtMs > caps.screen) reach('screen', screenAtMs + caps.screen);
    if (atMs > caps.session) reach('session', caps.session);
  };

  /**
   * An entry's offset into the recording, and `null` for one the recording stopped before.
   * Clamping an entry past the cap to the last frame would cite a frame showing something
   * else, which is why the contract has `null` for it.
   */
  const mark = (offsets: (number | null)[], atMs: number): void => {
    check(atMs);
    offsets.push(reached !== null && atMs > reached.cutAtMs ? null : atMs);
  };

  const save = async (video: Video): Promise<SessionVideo> => {
    const onDisk = runPaths(request.runDir).video(request.sessionId);
    const recorded = runPaths('').video(request.sessionId);
    // The file is finished by the context closing, and `saveAs` waits for that to have
    // happened. Closing it here rather than leaving it to `closeSession` is what makes the
    // recording a whole file before anything reads it.
    await page.context().close();
    await video.saveAs(onDisk);
    // Playwright's own copy, under the name it chose: a run directory carries one video per
    // session, not two. A copy that will not delete is litter, not a lost recording.
    await video.delete().catch(() => undefined);

    const written = await readFile(onDisk);
    const cut = reached === null ? written : cutRecording(written, reached.cutAtMs);
    if (cut !== written) await writeFile(onDisk, cut);

    const facts = readRecording(cut);
    if (facts === null) {
      return absent(
        `the recording at ${recorded} is not a WebM this module can measure, so its duration would be a guess`,
      );
    }

    // An offset is taken from the clock and a duration is read off the file, so a session's
    // last entry can land a frame past the end of its own recording. The contract holds an
    // offset to the recording it cites, and a frame of slack is not a cap.
    const inside = (offsetMs: number | null): number | null =>
      offsetMs === null ? null : Math.min(offsetMs, facts.durationMs);

    return {
      state: 'recorded',
      path: recorded,
      durationMs: facts.durationMs,
      truncated: reached === null ? null : reached.cap,
      screenOffsetsMs: screenOffsetsMs.map(inside),
      actionOffsetsMs: actionOffsetsMs.map(inside),
    };
  };

  return {
    screen: () => {
      const atMs = now() - startedAt;
      mark(screenOffsetsMs, atMs);
      // The cap is per screen, so the clock it is measured against restarts here — after the
      // mark, which belongs to the screen that is beginning.
      screenAtMs = atMs;
    },
    action: () => mark(actionOffsetsMs, now() - startedAt),
    finish: () => {
      finished ??= (async () => {
        // A session that sat on its last screen past the cap reached it without marking
        // anything afterwards.
        check(now() - startedAt);
        const video = page.video();
        if (video === null) return absent('the browser opened no recording for this session');
        try {
          return await save(video);
        } catch (error) {
          return absent(
            `the recording could not be saved to ${runPaths('').video(request.sessionId)}, so this session has none: ${message(error)}`,
          );
        }
      })();
      return finished;
    },
  };
};

/**
 * What a recording on disk is: its own duration, and the frame it was recorded at.
 *
 * Read out of the file rather than echoed back from what was asked for, so that the duration
 * a session reports is the duration the file has and the 720p claim is the file's own.
 */
export interface RecordingFacts {
  readonly durationMs: number;
  readonly frame: Viewport;
}

/*
 * The Matroska reading below is deliberately small. A WebM is a tree of elements, each an id,
 * a size and its content; this module needs four leaves of it — the timecode scale, the
 * duration, and the video track's pixel width and height — and one surgical cut. A parser for
 * the format would be a dependency this step may not add, and four leaves are forty lines.
 */

const SEGMENT = '18538067';
const INFO = '1549a966';
const TIMECODE_SCALE = '2ad7b1';
const DURATION = '4489';
const TRACKS = '1654ae6b';
const TRACK_ENTRY = 'ae';
const TRACK_VIDEO = 'e0';
const PIXEL_WIDTH = 'b0';
const PIXEL_HEIGHT = 'ba';
const CLUSTER = '1f43b675';
const CLUSTER_TIMECODE = 'e7';
/**
 * The frame. Playwright's recorder writes nothing but simple blocks, so a `BlockGroup` — the
 * other way a frame can be written — is not read for its timecode here; it is copied as it
 * stands, like a cluster's own timecode, and the duration is still the last simple block kept.
 */
const SIMPLE_BLOCK = 'a3';

/** The default timecode scale: a timecode is a millisecond unless the file says otherwise. */
const DEFAULT_SCALE_NS = 1_000_000;

/** One element of the tree: its id in hex, where it starts, and where its content lies. */
interface Element {
  readonly id: string;
  readonly at: number;
  readonly idWidth: number;
  readonly contentAt: number;
  readonly end: number;
}

/** How many bytes a variable-length integer occupies, read off its leading byte. */
const widthOf = (first: number): number => {
  for (let width = 1; width <= 8; width++) {
    if (first >= 0x100 >> width) return width;
  }
  return 0;
};

/** A big-endian unsigned integer, read a byte at a time: a size can exceed 32 bits. */
const uintAt = (bytes: Uint8Array, at: number, length: number): number => {
  let value = 0;
  for (let step = 0; step < length; step++) value = value * 256 + (bytes[at + step] ?? 0);
  return value;
};

/** A node's children, as far as they parse: a malformed tail is simply not read. */
const childrenOf = (bytes: Uint8Array, start: number, end: number): Element[] => {
  const found: Element[] = [];
  let at = start;
  while (at < end) {
    const idWidth = widthOf(bytes[at] ?? 0);
    if (idWidth === 0 || at + idWidth >= end) break;
    const sizeAt = at + idWidth;
    const sizeWidth = widthOf(bytes[sizeAt] ?? 0);
    if (sizeWidth === 0 || sizeAt + sizeWidth > end) break;
    const contentAt = sizeAt + sizeWidth;
    // The leading byte's marker bit says how wide the number is and is not part of it.
    const lead = (bytes[sizeAt] ?? 0) - (0x100 >> sizeWidth);
    const size = lead * 256 ** (sizeWidth - 1) + uintAt(bytes, sizeAt + 1, sizeWidth - 1);
    // An all-ones size is an element of unknown length, which runs to the end of its parent.
    const unknown = size === 2 ** (7 * sizeWidth) - 1;
    found.push({
      id: Buffer.from(bytes.subarray(at, sizeAt)).toString('hex'),
      at,
      idWidth,
      contentAt,
      end: unknown ? end : Math.min(contentAt + size, end),
    });
    at = unknown ? end : contentAt + size;
  }
  return found;
};

/** Where the duration is written, so that a cut can rewrite it in place. */
interface DurationField {
  readonly ticks: number | null;
  readonly at: number;
  readonly width: number;
}

/** The part of a WebM's structure this module reads, found once. */
interface Structure {
  readonly segment: Element;
  readonly children: readonly Element[];
  readonly scaleNs: number;
  readonly duration: DurationField;
  readonly frame: Viewport | null;
}

const structureOf = (bytes: Uint8Array): Structure | null => {
  const segment = childrenOf(bytes, 0, bytes.length).find((child) => child.id === SEGMENT);
  if (segment === undefined) return null;
  const children = childrenOf(bytes, segment.contentAt, segment.end);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);

  const info = children.find((child) => child.id === INFO);
  if (info === undefined) return null;
  let scaleNs = DEFAULT_SCALE_NS;
  let duration: DurationField = { ticks: null, at: 0, width: 0 };
  for (const child of childrenOf(bytes, info.contentAt, info.end)) {
    const width = child.end - child.contentAt;
    if (child.id === TIMECODE_SCALE) scaleNs = uintAt(bytes, child.contentAt, width);
    if (child.id === DURATION && (width === 4 || width === 8)) {
      duration = {
        ticks: width === 4 ? view.readFloatBE(child.contentAt) : view.readDoubleBE(child.contentAt),
        at: child.contentAt,
        width,
      };
    }
  }

  const tracks = children.find((child) => child.id === TRACKS);
  let frame: Viewport | null = null;
  for (const entry of tracks === undefined ? [] : childrenOf(bytes, tracks.contentAt, tracks.end)) {
    if (entry.id !== TRACK_ENTRY) continue;
    const video = childrenOf(bytes, entry.contentAt, entry.end).find(
      (child) => child.id === TRACK_VIDEO,
    );
    if (video === undefined) continue;
    let width: number | null = null;
    let height: number | null = null;
    for (const side of childrenOf(bytes, video.contentAt, video.end)) {
      const value = uintAt(bytes, side.contentAt, side.end - side.contentAt);
      if (side.id === PIXEL_WIDTH) width = value;
      if (side.id === PIXEL_HEIGHT) height = value;
    }
    if (width !== null && height !== null) frame = { width, height };
  }

  return { segment, children, scaleNs, duration, frame };
};

/**
 * A recording's own duration and frame, or `null` for bytes that are not a WebM this module
 * can measure — which is reported as an absent recording rather than as a guessed duration.
 */
export const readRecording = (bytes: Uint8Array): RecordingFacts | null => {
  const tree = structureOf(bytes);
  if (tree === null || tree.duration.ticks === null || tree.frame === null) return null;
  return {
    durationMs: Math.round((tree.duration.ticks * tree.scaleNs) / 1_000_000),
    frame: tree.frame,
  };
};

/** An element's size, written in its widest form so that nothing is measured twice. */
const sizeBytes = (size: number): Uint8Array => {
  const written = new Uint8Array(8);
  written[0] = 0x01;
  let left = size;
  for (let at = 7; at >= 1; at--) {
    written[at] = left % 256;
    left = Math.floor(left / 256);
  }
  return written;
};

/**
 * The recording, cut at the cap it reached.
 *
 * Playwright cannot stop recording a page it is still showing, so the cap is enforced on the
 * file: every frame whose timecode is past the cap is dropped, the duration is rewritten to
 * the last frame kept, and what comes back is a WebM a player opens — the header, the segment
 * info, the track declaration and the clusters, in that order. The index (`Cues`) and the
 * seek head are dropped rather than rewritten: both are byte offsets into a file that no
 * longer has those bytes, and both are optional.
 *
 * One frame is always kept. A cap shorter than the first frame would otherwise leave a file
 * with no picture in it, which is the silently empty video the caps exist to prevent.
 *
 * Bytes this module cannot read come back unchanged: a cut it cannot make honestly is a
 * recording reported at the duration the file actually has.
 */
export const cutRecording = (bytes: Uint8Array, atMs: number): Uint8Array => {
  const tree = structureOf(bytes);
  if (tree === null) return bytes;
  const info = tree.children.find((child) => child.id === INFO);
  const tracks = tree.children.find((child) => child.id === TRACKS);
  if (info === undefined || tracks === undefined) return bytes;

  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const msPerTick = tree.scaleNs / 1_000_000;
  const clusters: Buffer[] = [];
  let lastKeptMs = 0;
  let anyFrame = false;

  for (const cluster of tree.children) {
    if (cluster.id !== CLUSTER) continue;
    const children = childrenOf(bytes, cluster.contentAt, cluster.end);
    const timecode = children.find((child) => child.id === CLUSTER_TIMECODE);
    const clusterMs =
      timecode === undefined
        ? 0
        : uintAt(bytes, timecode.contentAt, timecode.end - timecode.contentAt) * msPerTick;
    const body: Buffer[] = [];
    let frames = 0;
    for (const child of children) {
      if (child.id !== SIMPLE_BLOCK) {
        body.push(Buffer.from(bytes.subarray(child.at, child.end)));
        continue;
      }
      // A block's own timecode is relative to its cluster's: a signed 16-bit number that
      // follows the track number.
      const trackWidth = widthOf(bytes[child.contentAt] ?? 0);
      const blockMs = clusterMs + view.readInt16BE(child.contentAt + trackWidth) * msPerTick;
      if (anyFrame && blockMs > atMs) continue;
      body.push(Buffer.from(bytes.subarray(child.at, child.end)));
      lastKeptMs = Math.max(lastKeptMs, blockMs);
      anyFrame = true;
      frames++;
    }
    // A cluster whose every frame is past the cap is dropped with them.
    if (frames === 0) continue;
    const content = Buffer.concat(body);
    clusters.push(
      Buffer.concat([
        Buffer.from(bytes.subarray(cluster.at, cluster.at + cluster.idWidth)),
        Buffer.from(sizeBytes(content.length)),
        content,
      ]),
    );
  }

  const patchedInfo = Buffer.from(bytes.subarray(info.at, info.end));
  const durationAt = tree.duration.at - info.at;
  if (tree.duration.width === 4) patchedInfo.writeFloatBE(lastKeptMs / msPerTick, durationAt);
  if (tree.duration.width === 8) patchedInfo.writeDoubleBE(lastKeptMs / msPerTick, durationAt);

  const body = Buffer.concat([
    patchedInfo,
    Buffer.from(bytes.subarray(tracks.at, tracks.end)),
    ...clusters,
  ]);
  return Buffer.concat([
    // Everything before the segment is the EBML header, which a cut does not touch.
    Buffer.from(bytes.subarray(0, tree.segment.at)),
    Buffer.from(bytes.subarray(tree.segment.at, tree.segment.at + tree.segment.idWidth)),
    Buffer.from(sizeBytes(body.length)),
    body,
  ]);
};
