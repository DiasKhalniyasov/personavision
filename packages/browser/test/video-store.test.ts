/**
 * The second half of the recording seam: where the bytes go once the file is measured.
 *
 * Nothing here launches a browser. `storeRecording` is the whole of the hand-over — the file
 * Playwright wrote is already on disk by then — so the three answers it can give are driven
 * directly: no store at all, a store that takes the bytes, and a store that refuses.
 *
 * The recorded `videos/S-NN.webm` path is the contract's either way. That is the point of the
 * seam, and it is asserted here against a fake store that reaches no network and reads no
 * credential.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaths, VideoStoreRefused } from '@personavision/contract';
import type { VideoStore } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discardRecording, storeRecording } from '../src/index.js';

/** A bucket name no message of ours may carry, distinctive enough to grep an artifact for. */
const BUCKET = 'pv-test-session-videos';
const SESSION = 'S-03';
const BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86]);

/** A store in memory: what the object-store implementation does, with no network under it. */
const fakeStore = (taken: Map<string, Uint8Array>): VideoStore => ({
  put: (objectName, bytes) => {
    taken.set(objectName, bytes);
    return Promise.resolve();
  },
  remove: (objectName) => {
    taken.delete(objectName);
    return Promise.resolve();
  },
  locate: (objectName) =>
    Promise.resolve(
      taken.has(objectName)
        ? { kind: 'url', url: `https://storage.googleapis.com/${BUCKET}/${objectName}?signed` }
        : { kind: 'gone', reason: 'This recording is no longer kept.' },
    ),
});

describe('handing a finished recording over', () => {
  let root: string;
  let runDir: string;
  let onDisk: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'personavision-video-store-'));
    runDir = join(root, '2026-11-04-0930-northwind');
    await mkdir(runPaths(runDir).videosDir, { recursive: true });
    onDisk = runPaths(runDir).video(SESSION);
    await writeFile(onDisk, BYTES);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('leaves the file where it is when there is no store', async () => {
    const kept = await storeRecording({ runDir, sessionId: SESSION, store: null, bytes: BYTES });

    expect(kept).toBeNull();
    expect(existsSync(onDisk)).toBe(true);
  });

  it('writes the bytes to the store under the run and the contract’s own path', async () => {
    const taken = new Map<string, Uint8Array>();
    const kept = await storeRecording({
      runDir,
      sessionId: SESSION,
      store: fakeStore(taken),
      bytes: BYTES,
    });

    expect(kept).toBeNull();
    expect(taken.get(`2026-11-04-0930-northwind/${runPaths('').video(SESSION)}`)).toEqual(BYTES);
    // One home for one recording: the mount redirects to the store, so a local copy would be
    // bytes nothing serves and a second answer to which file is the recording.
    expect(existsSync(onDisk)).toBe(false);
  });

  it('reports a refused upload in words, and names no bucket in them', async () => {
    const refusing: VideoStore = {
      put: () => Promise.reject(new VideoStoreRefused('HTTP_403')),
      locate: () => Promise.resolve({ kind: 'gone', reason: 'no' }),
      remove: () => Promise.resolve(),
    };

    const kept = await storeRecording({
      runDir,
      sessionId: SESSION,
      store: refusing,
      bytes: BYTES,
    });

    expect(kept).not.toBeNull();
    expect(kept).toContain(SESSION);
    expect(kept).toContain('HTTP_403');
    // This sentence is written into a session JSON, so nothing account-shaped may be in it.
    expect(kept).not.toContain(BUCKET);
    expect(kept).not.toContain('storage.googleapis.com');
    // And a session that says it has no recording may not leave one at the path it names.
    expect(existsSync(onDisk)).toBe(false);
  });

  it('files the recording under the run it is told, not under the directory it was written to', async () => {
    // What a Cloud Run task does: a scratch directory of its own, and the run it belongs to
    // said rather than guessed. Filed under the directory's name, the object would be one
    // nothing could ever read back.
    const scratch = join(root, 'personavision-task-AbC123');
    await mkdir(runPaths(scratch).videosDir, { recursive: true });
    await writeFile(runPaths(scratch).video(SESSION), BYTES);
    const taken = new Map<string, Uint8Array>();

    await storeRecording({
      runDir: scratch,
      runId: '2026-11-04-0930-northwind',
      sessionId: SESSION,
      store: fakeStore(taken),
      bytes: BYTES,
    });

    expect([...taken.keys()]).toEqual([`2026-11-04-0930-northwind/${runPaths('').video(SESSION)}`]);
  });

  it('takes an abandoned session’s recording back out of both homes', async () => {
    const taken = new Map<string, Uint8Array>();
    const store = fakeStore(taken);
    await writeFile(onDisk, BYTES);
    await storeRecording({ runDir, sessionId: SESSION, store, bytes: BYTES });
    await writeFile(onDisk, BYTES);

    await discardRecording({ runDir, sessionId: SESSION, store });

    // A recording a reader can find that no session names is worse than no recording at all.
    expect(existsSync(onDisk)).toBe(false);
    expect([...taken.keys()]).toEqual([]);
  });

  it('writes no log line in either mode, so nothing of a bucket is printed', async () => {
    const printed: string[] = [];
    const streams = [process.stdout, process.stderr] as const;
    const originals = streams.map((stream) => stream.write.bind(stream));
    for (const stream of streams) {
      stream.write = ((chunk: unknown) => {
        printed.push(String(chunk));
        return true;
      }) as typeof stream.write;
    }
    try {
      await storeRecording({
        runDir,
        sessionId: SESSION,
        store: fakeStore(new Map()),
        bytes: BYTES,
      });
      await writeFile(onDisk, BYTES);
      await storeRecording({
        runDir,
        sessionId: SESSION,
        store: {
          put: () => Promise.reject(new VideoStoreRefused('HTTP_403')),
          locate: () => Promise.resolve({ kind: 'gone', reason: 'no' }),
          remove: () => Promise.resolve(),
        },
        bytes: BYTES,
      });
    } finally {
      streams.forEach((stream, index) => {
        stream.write = originals[index] as typeof stream.write;
      });
    }

    expect(printed).toEqual([]);
  });
});
