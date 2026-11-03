import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createObjectVideoStore,
  NO_LONGER_KEPT,
  NO_LONGER_KEPT_STATE,
  runPaths,
  videoObjectName,
} from '@personavision/contract';
import type { VideoObjectTransport } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDataMount } from '../src/run-data.js';
import type { RunDataMountOptions, RunSummary } from '../src/run-data.js';
import { VIDEO_BYTES, VIDEO_SESSION, writeRunAt, writeSessionVideo } from './workspace.js';

/**
 * The mount on its own: what it refuses, and the scoping `personavision serve` adds above
 * it by naming the runs one request may see.
 */

const mounted = async (
  options: RunDataMountOptions,
): Promise<{ base: string; close: () => Promise<void> }> => {
  const mount = runDataMount(options);
  const server: Server = createServer((request, response) => {
    mount(request, response, () => {
      // The viewer sits here in the real server; a sentinel says the mount passed it on.
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the app');
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
};

describe('the run-data mount', () => {
  let root: string;
  let runsRoot: string;
  let shown: string;
  let hidden: string;
  let server: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'personavision-mount-'));
    runsRoot = join(root, 'runs');
    shown = await writeRunAt(runsRoot, {
      stamp: '2026-10-24T14:02:00Z',
      createdAt: '2026-10-24T14:02:00Z',
      name: 'this workspace',
    });
    hidden = await writeRunAt(runsRoot, {
      stamp: '2026-10-25T09:00:00Z',
      createdAt: '2026-10-25T09:00:00Z',
      name: 'another workspace',
    });
    // What `personavision serve` passes: the runs of the workspace the request belongs to.
    server = await mounted({ runsRoot, visibleRuns: () => [shown] });
  });

  afterAll(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists only the runs the request may see', async () => {
    const listed = (await (
      await fetch(new URL('runs/index.json', server.base))
    ).json()) as RunSummary[];

    expect(listed.map((entry) => entry.runId)).toEqual([shown]);
  });

  it('answers 404, not 403, for a run the request may not see', async () => {
    const response = await fetch(new URL(`runs/${hidden}/run.json`, server.base));

    // 404 and not 403: that another workspace holds a run is not this mount's to disclose.
    expect(response.status).toBe(404);
  });

  it('refuses a symbolic link that leaves the run directory', async () => {
    const secret = join(root, 'secret.json');
    await writeFile(secret, '{"not":"run data"}\n');
    await symlink(secret, join(runsRoot, shown, 'leak.json'));

    const response = await fetch(new URL(`runs/${shown}/leak.json`, server.base));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('not');
  });

  it('serves a file whose own name begins with dots', async () => {
    await writeFile(join(runsRoot, shown, '..keep.json'), '{"kept":true}\n');

    const response = await fetch(new URL(`runs/${shown}/..keep.json`, server.base));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kept: true });
  });

  it('serves an optional artifact file by the same rule, with no mount change', async () => {
    // `recommendations.json` is optional and written by the pipeline when a run has one:
    // the mount answers for it because it is a `.json` of the layout, not because it is
    // named here (`docs/adr/0001-run-data-over-http-as-static-files.md`).
    const file = runPaths('').recommendations;
    await writeFile(join(runsRoot, shown, file), '{"recommendations":[]}\n');

    const response = await fetch(new URL(`runs/${shown}/${file}`, server.base));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ recommendations: [] });
  });

  it('serves the aggregate the funnel and heatmap screens read', async () => {
    // `aggregate.json` is optional too, and reachable the moment the pipeline writes it: the
    // mount holds no list of names, only the file kinds of the layout (#287).
    const file = runPaths('').aggregate;
    await writeFile(join(runsRoot, shown, file), '{"funnelSlices":[]}\n');

    const response = await fetch(new URL(`runs/${shown}/${file}`, server.base));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ funnelSlices: [] });
  });

  it('names the methods it serves when asked for a write', async () => {
    const response = await fetch(new URL(`runs/${shown}/run.json`, server.base), {
      method: 'POST',
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('names the path that was asked for, never the path on disk', async () => {
    const response = await fetch(new URL(`runs/${shown}/sessions/S-99.json`, server.base));

    expect(response.status).toBe(404);
    const said = await response.text();
    expect(said).toContain(`/runs/${shown}/sessions/S-99.json`);
    expect(said).not.toContain(runsRoot);
  });

  it('passes a path that names no artifact file on to the app', async () => {
    for (const route of [`runs/${shown}`, `runs/${shown}/breakdown`, `runs/${shown}/sessions`]) {
      const response = await fetch(new URL(route, server.base));
      expect(response.status, route).toBe(200);
      expect(await response.text(), route).toBe('the app');
    }
  });

  /**
   * A session's recording, served as a screenshot is — the file on disk, with the one
   * header a `<video>` element needs to open paused on a frame instead of downloading
   * fourteen megabytes to reach it. Nothing is computed: a range is an offset into a read.
   */
  describe('a session video', () => {
    /** No range, then a range: what a refusal has to be the same under. */
    const HEADERS: Record<string, string>[] = [{}, { range: 'bytes=0-15' }];
    const last = VIDEO_BYTES.byteLength - 1;
    let url: URL;

    const ranged = async (range: string): Promise<Response> => fetch(url, { headers: { range } });

    beforeAll(async () => {
      await writeSessionVideo(join(runsRoot, shown));
      url = new URL(`runs/${shown}/${runPaths('').video(VIDEO_SESSION)}`, server.base);
    });

    it('serves the recording byte for byte, with the content type its own path spells', async () => {
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('video/webm');
      expect(response.headers.get('content-length')).toBe(String(VIDEO_BYTES.byteLength));
      // Advertised on the whole file too, because that is where a player looks before it
      // asks for a frame in the middle of one.
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO_BYTES);
    });

    it('answers a closed range with that slice of the file', async () => {
      const response = await ranged('bytes=0-15');

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 0-15/${VIDEO_BYTES.byteLength}`);
      expect(response.headers.get('content-length')).toBe('16');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO_BYTES.subarray(0, 16));
    });

    it('answers an open-ended range with the rest of the recording', async () => {
      const response = await ranged('bytes=1024-');

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 1024-${last}/${VIDEO_BYTES.byteLength}`,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO_BYTES.subarray(1024));
    });

    it('answers a suffix range with the last bytes of the recording', async () => {
      const response = await ranged('bytes=-16');

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes ${VIDEO_BYTES.byteLength - 16}-${last}/${VIDEO_BYTES.byteLength}`,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO_BYTES.subarray(-16));
    });

    it('answers a suffix longer than the file with the whole file', async () => {
      const response = await ranged(`bytes=-${VIDEO_BYTES.byteLength * 2}`);

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-${last}/${VIDEO_BYTES.byteLength}`,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO_BYTES);
    });

    it('clamps a range that runs past the end to the end', async () => {
      const response = await ranged(`bytes=1024-${VIDEO_BYTES.byteLength * 2}`);

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 1024-${last}/${VIDEO_BYTES.byteLength}`,
      );
    });

    it('answers 416 for a range the recording does not hold, saying how long it is', async () => {
      for (const range of ['bytes=4096-8192', `bytes=${VIDEO_BYTES.byteLength}-`, 'bytes=-0']) {
        const response = await ranged(range);

        expect(response.status, range).toBe(416);
        expect(response.headers.get('content-range'), range).toBe(
          `bytes */${VIDEO_BYTES.byteLength}`,
        );
      }
    });

    it('serves the whole file for a range header it does not understand', async () => {
      // Another unit, a list of ranges, or a last byte before the first: a range that
      // describes no bytes is the header ignored and the file served, not a 416 a player
      // cannot retry past (RFC 9110 §§14.1.1, 14.2). `bytes=100-50` is inside this file
      // and still not a range, which is why it is here and not with the 416s.
      for (const range of [
        'frames=0-15',
        'bytes=0-15,32-47',
        'bytes=-',
        'bytes=nonsense',
        'bytes=100-50',
      ]) {
        const response = await ranged(range);

        expect(response.status, range).toBe(200);
        expect(Buffer.from(await response.arrayBuffer()), range).toEqual(VIDEO_BYTES);
      }
    });

    it('answers a HEAD for a range with the slice’s length and no body', async () => {
      const response = await fetch(url, { method: 'HEAD', headers: { range: 'bytes=0-15' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-length')).toBe('16');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    });

    it('answers the mount’s own 404 for a recording the run does not have', async () => {
      const missing = `runs/${shown}/${runPaths('').video('S-99')}`;
      const response = await fetch(new URL(missing, server.base));

      // A video that was never recorded and an empty one must not look the same: this is
      // the mount's plain-text 404, not a zero-length body.
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const said = await response.text();
      expect(said).toContain(`/${missing}`);
      expect(said).not.toContain(runsRoot);
    });

    it('serves an empty recording as an empty file, which is not a 404', async () => {
      await mkdir(join(runsRoot, shown, 'videos'), { recursive: true });
      await writeFile(join(runsRoot, shown, runPaths('').video('S-02')), Buffer.alloc(0));

      const response = await fetch(
        new URL(`runs/${shown}/${runPaths('').video('S-02')}`, server.base),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('0');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    });

    it('refuses a link out of the run directory, range header or not', async () => {
      const outside = join(root, 'secret.webm');
      await writeFile(outside, VIDEO_BYTES);
      await mkdir(join(runsRoot, shown, 'videos'), { recursive: true });
      await symlink(outside, join(runsRoot, shown, runPaths('').video('leak')));
      const leak = new URL(`runs/${shown}/${runPaths('').video('leak')}`, server.base);

      for (const headers of HEADERS) {
        const response = await fetch(leak, { headers });

        expect(response.status).toBe(403);
        expect(await response.text()).toBe('Only the files of a run directory are served.\n');
      }
    });

    it('refuses a path that climbs out of the run directory, range header or not', async () => {
      // Encoded so the URL parser leaves the segments for the mount to refuse: a range is
      // a header, not a second way in.
      const escape = new URL(`runs/${shown}/%2e%2e%2f%2e%2e%2fsecret.webm`, server.base);

      for (const headers of HEADERS) {
        const response = await fetch(escape, { headers });

        expect(response.status).toBe(403);
      }
    });
  });
});

/**
 * The same mount with a bucket configured: the URL a browser fetches does not change, and the
 * answer is a redirect rather than the bytes.
 *
 * The store is the real object-store implementation over a **fake transport** — no network, no
 * credential, no bucket — so the redirect carries a real V4 signed URL and the "no longer kept"
 * state is the store's own, asserted over HTTP rather than through internals.
 */
describe('the run-data mount with session videos in an object store', () => {
  const BUCKET = 'pv-test-session-videos';
  const SIGNER = 'session-videos@personavision-test.iam.gserviceaccount.com';

  let root: string;
  let runsRoot: string;
  let shown: string;
  let server: { base: string; close: () => Promise<void> };
  let held: Set<string>;
  let url: URL;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'personavision-mount-stored-'));
    runsRoot = join(root, 'runs');
    shown = await writeRunAt(runsRoot, {
      stamp: '2026-11-04T09:30:00Z',
      createdAt: '2026-11-04T09:30:00Z',
      name: 'stored videos',
    });
    held = new Set([videoObjectName(shown, VIDEO_SESSION)]);

    const transport: VideoObjectTransport = {
      put: () => Promise.reject(new Error('the mount never writes')),
      holds: ({ object }) => Promise.resolve(held.has(object)),
      signer: () => Promise.resolve(SIGNER),
      sign: () => Promise.resolve('deadbeef'),
    };

    server = await mounted({
      runsRoot,
      visibleRuns: () => [shown],
      videoStore: createObjectVideoStore({ bucket: BUCKET, transport }),
    });
    url = new URL(`runs/${shown}/${runPaths('').video(VIDEO_SESSION)}`, server.base);
  });

  afterAll(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('answers the same URL with a 302 to a signed URL instead of the bytes', async () => {
    // A recording of this session exists on disk too, and is deliberately not what is served:
    // where a video lives is the store's answer, not a guess from what happens to be there.
    await writeSessionVideo(join(runsRoot, shown));

    const response = await fetch(url, { redirect: 'manual' });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://storage.googleapis.com');
    expect(location.pathname).toBe(`/${BUCKET}/${videoObjectName(shown, VIDEO_SESSION)}`);
    expect(location.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(location.searchParams.get('X-Goog-Signature')).toBe('deadbeef');
    // Nothing of a 1.4 GB recording passed through this process.
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('answers a Range request with the same redirect, so a scrubber still seeks', async () => {
    const response = await fetch(url, { redirect: 'manual', headers: { range: 'bytes=1024-' } });

    expect(response.status).toBe(302);
    // `host` is the only signed header, so the range the player re-sends to the signed URL is
    // served by the store rather than by this process.
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('X-Goog-SignedHeaders')).toBe('host');
  });

  it('states that a recording the store no longer holds is no longer kept', async () => {
    const aged = new URL(`runs/${shown}/${runPaths('').video('S-02')}`, server.base);

    const response = await fetch(aged);

    // A state the results screens render, not a failure and not an empty body: the lifecycle
    // rule deletes a test's videos after thirty days, which is the end of a recording's life.
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({
      state: NO_LONGER_KEPT_STATE,
      reason: NO_LONGER_KEPT,
    });
  });

  it('answers 404 for a .webm that is not a session recording, signing nothing', async () => {
    const response = await fetch(new URL(`runs/${shown}/videos/deeper/S-01.webm`, server.base));

    expect(response.status).toBe(404);
  });

  it('serves every other artifact file off disk exactly as it did', async () => {
    const response = await fetch(new URL(`runs/${shown}/run.json`, server.base));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('names no bucket and no object URL in what it refuses with', async () => {
    const missing = await fetch(
      new URL(`runs/${shown}/${runPaths('').video('S-09')}`, server.base),
    );
    const said = await missing.text();

    expect(said).not.toContain(BUCKET);
    expect(said).not.toContain('storage.googleapis.com');
  });
});
