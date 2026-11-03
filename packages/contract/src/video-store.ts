/**
 * Where a session's recording actually lives, and the one variable that decides it.
 *
 * A run directory is a directory on the machine that asked for the run, and `videos/S-NN.webm`
 * is a file in it. That is the default and it is what every test, the acceptance suite and the
 * demo run on: `PV_VIDEO_BUCKET` unset means local disk and nothing here is constructed at all.
 * Set, it names a Google Cloud Storage bucket, and the recordings of that process go there
 * instead — written by `@personavision/browser`'s recording seam and served by the read-only run
 * mount as a redirect. `docs/adr/0005-where-session-videos-live.md` records the choice.
 *
 * **One seam, one choice, no branching downstream.** {@link selectVideoStore} is the only
 * function in the repository that reads `PV_VIDEO_BUCKET`, and what it answers is a store or
 * `null`. Nothing that holds the answer asks which it got: a session hands its bytes over and
 * gets back the same run-directory-relative path `runPaths` declares either way, and the URL a
 * browser fetches is `GET /runs/<runId>/videos/S-NN.webm` either way.
 *
 * **The credential is Google's to read, not ours.** This module reads exactly one variable,
 * `PV_VIDEO_BUCKET`, which is a bucket name and not a credential. The default transport takes
 * its access token from the metadata server of the machine it runs on — the same shape
 * `@personavision/swarm`'s Cloud Run transport takes — and signing goes through that identity's
 * own `signBlob`, so no private key is read, held or needed here. A deployment authorised some
 * other way injects a {@link VideoObjectTransport} and this module opens no socket.
 *
 * **Nothing it says may name a bucket, an object URL or a credential.** A reason from here can
 * end up in a session JSON and in a run artifact, which `CONTEXT.md` forbids carrying anything
 * account-shaped. So every message this module produces names a status word and nothing else,
 * and an implementation of {@link VideoStore} written elsewhere owes the same.
 */

import { runPaths } from './paths.js';

/** The one variable, and it is not a credential. `docs/deployment.md` lists it. */
export const VIDEO_BUCKET_ENV = 'PV_VIDEO_BUCKET';

/**
 * The object one session's recording is written as: `<runId>/videos/S-NN.webm`.
 *
 * The run-directory layout, verbatim, with the run's own id in front of it — so a bucket holds
 * the same tree the disk would and the name is derived from `runPaths` rather than spelt twice.
 */
export const videoObjectName = (runId: string, sessionId: string): string =>
  `${runId}/${runPaths('').video(sessionId)}`;

/** The media type a recording is stored with, taken from the layout's own extension. */
const VIDEO_CONTENT_TYPE = 'video/webm';

/** Where a request for a stored recording is sent, or the honest absence of one. */
export type VideoLocation =
  /** Fetch it there. Short-lived, and the range a player asks for is not signed into it. */
  | { readonly kind: 'url'; readonly url: string }
  /**
   * The store does not hold it any more. A recording is kept for thirty days (#228), so this
   * is a state the results screens render and never a failure: the typed, worded "no longer
   * kept" of this seam's contract.
   */
  | { readonly kind: 'gone'; readonly reason: string };

/** What the mount says for a recording the store no longer holds. Wording, in one place. */
export const NO_LONGER_KEPT = 'This recording is no longer kept.';

/** The state word that answer carries, so a screen matches on it rather than on a sentence. */
export const NO_LONGER_KEPT_STATE = 'no-longer-kept';

/**
 * Somewhere other than the run directory that a recording's bytes live.
 *
 * Two operations, because two are what the halves of the seam need: the recorder hands bytes
 * over, and the mount asks where to send a browser. Neither side knows which implementation it
 * holds.
 *
 * **Every message an implementation throws may be written into a session JSON**, so it names a
 * status and never a bucket, an object URL or a credential.
 */
export interface VideoStore {
  /** Writes one recording, retrying a refusal. Throws when it could not be stored. */
  put(objectName: string, bytes: Uint8Array): Promise<void>;
  /** Where to send a browser for it, or that it is no longer kept. */
  locate(objectName: string): Promise<VideoLocation>;
}

/**
 * The object store refused, or could not be reached.
 *
 * It carries a status word and **not** what the API said: an API's own sentence names the
 * bucket and the object, and this message can reach a session JSON.
 */
export class VideoStoreRefused extends Error {
  readonly status: string;

  constructor(status: string) {
    super(`the object store answered ${status}`);
    this.name = 'VideoStoreRefused';
    this.status = status;
  }
}

/**
 * The one path from this module to the network, injected — the shape every third-party call in
 * this repository takes (`@personavision/provider`'s `ModelTransport`, `@personavision/swarm`'s
 * `JobsTransport`). The default is built only when none is given, so a test never reaches it.
 */
export interface VideoObjectTransport {
  /** Uploads one object. Throws {@link VideoStoreRefused}. */
  put(request: {
    readonly bucket: string;
    readonly object: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<void>;
  /** `true` when the bucket still holds that object. Throws {@link VideoStoreRefused}. */
  holds(request: { readonly bucket: string; readonly object: string }): Promise<boolean>;
  /**
   * The identity that signs, which a signed URL has to name **inside** what it signs — so it
   * is asked for before there is anything to sign.
   */
  signer(): Promise<string>;
  /** Signs one string with that identity, hex-encoded lower case. */
  sign(payload: string): Promise<string>;
}

/**
 * How long a signed URL is good for: one hour.
 *
 * Short-lived, and not as short as it could be. The URL is what a `<video>` element holds for
 * the whole of a replay — every seek is another `Range` request against the same URL — so a
 * ten-minute URL would break a scrubbing session in the middle, which is the one thing the
 * redirect exists to make work.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Waits between upload attempts. Two retries: a refused upload is usually refused again. */
const RETRY_DELAYS_MS = [250, 1_000] as const;

export interface ObjectVideoStoreOptions {
  readonly bucket: string;
  /** Built only when none is given. */
  readonly transport?: VideoObjectTransport;
  /** The clock a signed URL is dated from. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** How long a signed URL lasts. Defaults to {@link SIGNED_URL_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  /** The waits between upload attempts, so a test does not spend them. */
  readonly retryDelaysMs?: readonly number[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => {
    setTimeout(settle, ms);
  });

/** RFC 3986, which is stricter than `encodeURIComponent` about five characters. */
const escape = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** An object's path inside the URL: every segment escaped, the separators left alone. */
const escapePath = (objectName: string): string => objectName.split('/').map(escape).join('/');

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (text: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** `20260104T120000Z` and `20260104`, which is how V4 spells the two it needs. */
const stamps = (at: number): { readonly timestamp: string; readonly date: string } => {
  const timestamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { timestamp, date: timestamp.slice(0, 8) };
};

/**
 * A V4 signed `GET` URL for one object (`GOOG4-RSA-SHA256`).
 *
 * `host` is the only signed header, which is what lets the redirect carry a replay's `Range`
 * through: a player's range request against this URL is served by the store itself, and the
 * bytes of a 1.4 GB recording never pass through this process.
 */
const signedUrlFor = async (
  options: {
    readonly bucket: string;
    readonly objectName: string;
    readonly expiresInSeconds: number;
    readonly at: number;
  },
  transport: VideoObjectTransport,
): Promise<string> => {
  const { timestamp, date } = stamps(options.at);
  const scope = `${date}/auto/storage/goog4_request`;
  const resource = `/${escape(options.bucket)}/${escapePath(options.objectName)}`;

  // Who signs is part of what is signed, so the identity is asked for before the string the
  // signature is over can be assembled at all.
  const signer = await transport.signer();
  const query = Object.entries({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${signer}/${scope}`,
    'X-Goog-Date': timestamp,
    'X-Goog-Expires': String(options.expiresInSeconds),
    'X-Goog-SignedHeaders': 'host',
  })
    // By name, which is what "canonical" means here, and these five are plain ASCII.
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${escape(name)}=${escape(value)}`)
    .join('&');

  const canonical = [
    'GET',
    resource,
    query,
    'host:storage.googleapis.com',
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', timestamp, scope, await sha256Hex(canonical)].join('\n');
  const signature = await transport.sign(toSign);
  return `https://storage.googleapis.com${resource}?${query}&X-Goog-Signature=${signature}`;
};

/**
 * The object store, over an injected transport.
 *
 * `locate` asks whether the bucket still holds the object before it signs, which is the one
 * extra round trip the typed "no longer kept" costs: a signed URL for a deleted object would
 * send a browser to a 404 nobody can render a sentence from.
 *
 * ponytail: one metadata read per video request. Cache it by object name if a replay screen
 * ever asks more than once per view.
 */
export const createObjectVideoStore = (options: ObjectVideoStoreOptions): VideoStore => {
  const transport = options.transport ?? createGoogleStorageTransport();
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;

  return {
    put: async (objectName, bytes) => {
      for (let attempt = 0; ; attempt++) {
        try {
          await transport.put({
            bucket: options.bucket,
            object: objectName,
            contentType: VIDEO_CONTENT_TYPE,
            bytes,
          });
          return;
        } catch (error) {
          // A video is never a reason to lose a session: the last refusal is thrown, the
          // recorder states it in words, and the session is written up without a recording.
          if (attempt >= delays.length) throw error;
          await sleep(delays[attempt] ?? 0);
        }
      }
    },
    locate: async (objectName) => {
      if (!(await transport.holds({ bucket: options.bucket, object: objectName }))) {
        return { kind: 'gone', reason: NO_LONGER_KEPT };
      }
      return {
        kind: 'url',
        url: await signedUrlFor(
          {
            bucket: options.bucket,
            objectName,
            expiresInSeconds: options.ttlSeconds ?? SIGNED_URL_TTL_SECONDS,
            at: now(),
          },
          transport,
        ),
      };
    },
  };
};

export interface SelectVideoStoreOptions {
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A transport of its own, for a test and for a deployment authorised its own way. */
  readonly transport?: VideoObjectTransport;
  readonly now?: () => number;
  readonly ttlSeconds?: number;
  readonly retryDelaysMs?: readonly number[];
}

/**
 * **The one place where a video's home is chosen**, from one variable.
 *
 * `PV_VIDEO_BUCKET` unset or empty answers `null`: the recording stays the file in the run
 * directory that `runPaths` names, which is what every existing test, the acceptance suite and
 * the demo read, and nothing reaches for a bucket or constructs a client. Set, it answers the
 * store for that bucket.
 */
export const selectVideoStore = (options: SelectVideoStoreOptions = {}): VideoStore | null => {
  const env = options.env ?? process.env;
  const bucket = env[VIDEO_BUCKET_ENV]?.trim() ?? '';
  if (bucket === '') return null;
  return createObjectVideoStore({ bucket, ...options });
};

/** Where a workload on Google's own infrastructure is handed an access token and its name. */
const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts';
const STORAGE = 'https://storage.googleapis.com/storage/v1';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1';
const SIGN_BLOB = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

/** A status word for an answer, from the API's own when it gave one. */
const statusOf = (response: Response, body: unknown): string => {
  const named =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error?: { status?: string } }).error?.status ?? '')
      : '';
  return named === '' ? `HTTP_${String(response.status)}` : named;
};

/** base64 of a UTF-8 string, and back to bytes: no `Buffer`, so this module stays portable. */
const base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

/**
 * The default transport: plain `fetch`, the metadata server for the identity this process runs
 * as, and that identity's `signBlob` for a signature. No Google client library, no dependency
 * whose transport could not be injected, and no credential read by this repository.
 */
export const createGoogleStorageTransport = (): VideoObjectTransport => {
  /** The account that signs. It does not change while this process runs, so it is read once. */
  let signerEmail: Promise<string> | null = null;

  const askMetadata = async (path: string): Promise<string> => {
    const response = await fetch(`${METADATA}/default/${path}`, {
      headers: { 'metadata-flavor': 'Google' },
    });
    if (!response.ok) throw new VideoStoreRefused('UNAUTHENTICATED');
    return await response.text();
  };

  /**
   * One access token, asked for per request rather than held — the shape
   * `@personavision/swarm`'s Cloud Run transport takes. The metadata server is on the machine
   * itself and does its own caching, so re-asking costs a loopback call and can never hand back
   * a token that expired while this process was idle.
   */
  const authorised = async (
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
  ): Promise<Response> => {
    const issued = (JSON.parse(await askMetadata('token')) as { access_token?: string })
      .access_token;
    if (issued === undefined || issued === '') throw new VideoStoreRefused('UNAUTHENTICATED');
    return await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${issued}` },
    });
  };

  /** Every failure, as a status word and nothing more: what it said names the bucket. */
  const refuse = async (response: Response): Promise<never> => {
    const body = await response.json().catch(() => null);
    throw new VideoStoreRefused(statusOf(response, body));
  };

  return {
    put: async ({ bucket, object, contentType, bytes }) => {
      const response = await authorised(
        `${UPLOAD}/b/${escape(bucket)}/o?uploadType=media&name=${escape(object)}`,
        {
          method: 'POST',
          headers: { 'content-type': contentType },
          // One `Uint8Array`, which `fetch` sends as the body verbatim.
          body: bytes,
        },
      );
      if (!response.ok) await refuse(response);
    },
    holds: async ({ bucket, object }) => {
      const response = await authorised(`${STORAGE}/b/${escape(bucket)}/o/${escape(object)}`, {
        method: 'GET',
      });
      if (response.status === 404) return false;
      if (!response.ok) await refuse(response);
      return true;
    },
    signer: async () => {
      signerEmail ??= askMetadata('email').then((email) => email.trim());
      return await signerEmail;
    },
    sign: async (payload) => {
      signerEmail ??= askMetadata('email').then((email) => email.trim());
      const email = await signerEmail;
      const response = await authorised(`${SIGN_BLOB}/${escape(email)}:signBlob`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: base64(payload) }),
      });
      if (!response.ok) await refuse(response);
      const signed = (await response.json()) as { signedBlob?: string };
      return hex(fromBase64(signed.signedBlob ?? ''));
    },
  };
};
