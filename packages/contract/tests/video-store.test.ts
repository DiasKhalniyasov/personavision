/**
 * Where a session's recording lives, and the one variable that decides it.
 *
 * Everything here runs against a **fake transport**: no network, no credential, no bucket. The
 * signed URL is assembled by this module and only the signature itself comes from the
 * transport, so what a store produces for a given clock and a given object is asserted in full.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createObjectVideoStore,
  NO_LONGER_KEPT,
  selectVideoStore,
  SIGNED_URL_TTL_SECONDS,
  VIDEO_BUCKET_ENV,
  videoObjectName,
  VideoStoreRefused,
} from '../src/index.js';
import type { VideoObjectTransport } from '../src/index.js';

const BUCKET = 'pv-test-session-videos';
const SIGNER = 'session-videos@personavision-test.iam.gserviceaccount.com';
/** A signature is hex, and this one is not a real one; nothing here verifies it. */
const SIGNATURE = 'abc123';
const AT = Date.parse('2026-11-04T09:30:00Z');

/** What was asked of the store, with nothing reached over a socket. */
interface Fake {
  readonly transport: VideoObjectTransport;
  readonly stored: Map<string, Uint8Array>;
  readonly signed: string[];
  readonly refusals: { count: number };
}

const fakeTransport = (options: { refuseTimes?: number } = {}): Fake => {
  const stored = new Map<string, Uint8Array>();
  const signed: string[] = [];
  const refusals = { count: options.refuseTimes ?? 0 };
  return {
    stored,
    signed,
    refusals,
    transport: {
      put: ({ object, bytes }) => {
        if (refusals.count > 0) {
          refusals.count--;
          return Promise.reject(new VideoStoreRefused('HTTP_503'));
        }
        stored.set(object, bytes);
        return Promise.resolve();
      },
      holds: ({ object }) => Promise.resolve(stored.has(object)),
      signer: () => Promise.resolve(SIGNER),
      sign: (payload) => {
        signed.push(payload);
        return Promise.resolve(SIGNATURE);
      },
    },
  };
};

const storeFor = (fake: Fake) =>
  createObjectVideoStore({
    bucket: BUCKET,
    transport: fake.transport,
    now: () => AT,
    retryDelaysMs: [0, 0],
  });

describe('the one variable that chooses where a video lives', () => {
  it('answers the run directory — no store at all — when it is unset', () => {
    expect(selectVideoStore({ env: {} })).toBeNull();
  });

  it('answers the run directory for a variable set to nothing but spaces', () => {
    expect(selectVideoStore({ env: { [VIDEO_BUCKET_ENV]: '  ' } })).toBeNull();
  });

  it('answers a store for the bucket it names, and constructs no client to do it', () => {
    const fake = fakeTransport();
    const store = selectVideoStore({
      env: { [VIDEO_BUCKET_ENV]: BUCKET },
      transport: fake.transport,
    });

    expect(store).not.toBeNull();
  });

  it('names an object the run-directory layout, under the run', () => {
    expect(videoObjectName('2026-11-04-0930-northwind', 'S-07')).toBe(
      '2026-11-04-0930-northwind/videos/S-07.webm',
    );
  });
});

describe('storing one recording', () => {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);

  it('writes the bytes under the object the layout names', async () => {
    const fake = fakeTransport();
    await storeFor(fake).put(videoObjectName('a-run', 'S-01'), bytes);

    expect(fake.stored.get('a-run/videos/S-01.webm')).toEqual(bytes);
  });

  it('retries a refusal rather than losing the recording', async () => {
    const fake = fakeTransport({ refuseTimes: 2 });
    await storeFor(fake).put(videoObjectName('a-run', 'S-01'), bytes);

    expect(fake.stored.has('a-run/videos/S-01.webm')).toBe(true);
    expect(fake.refusals.count).toBe(0);
  });

  it('gives up after its retries, with a status and nothing that names a bucket', async () => {
    const fake = fakeTransport({ refuseTimes: 99 });
    const thrown = await storeFor(fake)
      .put(videoObjectName('a-run', 'S-01'), bytes)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(VideoStoreRefused);
    expect((thrown as VideoStoreRefused).status).toBe('HTTP_503');
    // The message reaches a session JSON, so it names a status and not a place.
    expect((thrown as Error).message).not.toContain(BUCKET);
    expect((thrown as Error).message).not.toContain('storage.googleapis.com');
  });
});

describe('where a browser is sent for a stored recording', () => {
  const object = 'a-run/videos/S-01.webm';

  const located = async (fake: Fake): Promise<URL> => {
    const where = await storeFor(fake).locate(object);
    if (where.kind !== 'url') throw new Error(`expected a URL, got ${where.kind}`);
    return new URL(where.url);
  };

  it('signs a V4 GET URL for the object, on the storage host', async () => {
    const fake = fakeTransport();
    await storeFor(fake).put(object, new Uint8Array([1]));
    const url = await located(fake);

    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(url.pathname).toBe(`/${BUCKET}/${object}`);
    expect(url.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(url.searchParams.get('X-Goog-Credential')).toBe(
      `${SIGNER}/20261104/auto/storage/goog4_request`,
    );
    expect(url.searchParams.get('X-Goog-Date')).toBe('20261104T093000Z');
    expect(url.searchParams.get('X-Goog-Expires')).toBe(String(SIGNED_URL_TTL_SECONDS));
    expect(url.searchParams.get('X-Goog-Signature')).toBe(SIGNATURE);
  });

  it('signs the host and nothing else, so a replay’s Range is carried through', async () => {
    const fake = fakeTransport();
    await storeFor(fake).put(object, new Uint8Array([1]));
    const url = await located(fake);

    // A signed `range` would make every seek a signature mismatch: the player asks the store
    // for its bytes directly, and only the host is part of what was signed.
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toBe('host');
    expect(fake.signed).toHaveLength(1);
    const [algorithm, timestamp, scope, digest] = (fake.signed[0] ?? '').split('\n');
    expect(algorithm).toBe('GOOG4-RSA-SHA256');
    expect(timestamp).toBe('20261104T093000Z');
    expect(scope).toBe('20261104/auto/storage/goog4_request');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('states that a recording is no longer kept rather than signing a URL for nothing', async () => {
    const fake = fakeTransport();
    const where = await storeFor(fake).locate(object);

    expect(where).toEqual({ kind: 'gone', reason: NO_LONGER_KEPT });
    expect(fake.signed).toHaveLength(0);
  });
});

describe('this package reads one variable, and it is not a credential', () => {
  // Assembled from fragments, so this test cannot match itself and pass while a real read
  // sits a line away — the shape `tests/workspace.test.ts` uses for the whole workspace.
  const SECRETISH = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'];
  const NAME = `[A-Za-z0-9_]*(?:${SECRETISH.join('|')})`;
  const READS = [
    new RegExp(`process\\.env\\.${NAME}\\b`, 'i'),
    new RegExp(`process\\.env\\[\\s*['"\`]${NAME}`, 'i'),
    new RegExp(`\\benv\\[\\s*[A-Za-z0-9_]*(?:${SECRETISH.join('|')})[A-Za-z0-9_]*\\s*\\]`, 'i'),
  ];

  const sources = readdirSync(new URL('../src', import.meta.url).pathname)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      source: readFileSync(join(new URL('../src', import.meta.url).pathname, name), 'utf8'),
    }));

  it('reads nothing key-, token-, secret- or credential-shaped out of the environment', () => {
    for (const { name, source } of sources) {
      for (const pattern of READS) {
        expect(pattern.test(source), `${name} matched ${pattern.source}`).toBe(false);
      }
    }
  });

  it(`names ${VIDEO_BUCKET_ENV} and no other variable of ours`, () => {
    const named = new Set(
      sources.flatMap(({ source }) => [...source.matchAll(/'(PV_[A-Z0-9_]+)'/g)].map((m) => m[1])),
    );

    expect([...named]).toEqual([VIDEO_BUCKET_ENV]);
  });
});
