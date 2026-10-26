import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The session cookie: a signed, HTTP-only cookie carrying nothing but a session id, over
 * a server-side record.
 *
 * This is the seam sign-in fills (#101). What is here is what the run mount needs in
 * order to scope a request today: mint the cookie value for a session, and read one back.
 * A cookie that is unknown, expired or badly signed is signed out — never an error.
 */

export const SESSION_COOKIE = 'pv_session';

/** The cookie's value: the session id and an HMAC of it, so the id cannot be guessed at. */
export const signSessionId = (sessionId: string, signingKey: string): string =>
  `${sessionId}.${createHmac('sha256', signingKey).update(sessionId).digest('hex')}`;

const verify = (value: string, signingKey: string): string | null => {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const sessionId = value.slice(0, separator);
  const given = Buffer.from(value.slice(separator + 1), 'hex');
  const expected = Buffer.from(
    createHmac('sha256', signingKey).update(sessionId).digest('hex'),
    'hex',
  );
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return sessionId;
};

/** The cookies a request carries, by name. A malformed pair is skipped, not an error. */
const cookies = (request: IncomingMessage): Map<string, string> => {
  const header = request.headers.cookie ?? '';
  const pairs = header.split(';').map((pair) => {
    const separator = pair.indexOf('=');
    return separator === -1
      ? null
      : ([pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()] as const);
  });
  return new Map(pairs.filter((pair): pair is readonly [string, string] => pair !== null));
};

/** The session id a request's cookie signs for, or `null` for a request that is signed out. */
export const readSessionId = (request: IncomingMessage, signingKey: string): string | null => {
  const value = cookies(request).get(SESSION_COOKIE);
  if (value === undefined || value === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A cookie that is not valid percent-encoding is a cookie we did not write, and so
    // is signed out — not a 500 on every request the browser makes until it is cleared.
    return null;
  }
  return verify(decoded, signingKey);
};

/**
 * `true` when the request reached this server over HTTPS, which is what decides whether
 * the session cookie is marked `Secure`.
 *
 * `x-forwarded-proto` is trusted because the self-hosted server is reached either on
 * loopback or through a reverse proxy that sets it. A client that lies about it only
 * asks for a cookie its own browser will then refuse to send back over HTTP; it cannot
 * take a `Secure` marking off a cookie a proxy's request earns.
 */
export const isSecureRequest = (request: IncomingMessage): boolean => {
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return proto === 'https' || (request.socket as { encrypted?: boolean }).encrypted === true;
};

/**
 * The `set-cookie` value for a session. `Secure` is set when the request reached the
 * server over HTTPS — a self-hosted server on loopback is reached over HTTP, and a cookie
 * marked `Secure` there would never come back.
 */
export const sessionCookieHeader = (
  value: string,
  { secure, maxAgeSeconds }: { secure: boolean; maxAgeSeconds: number },
): string =>
  [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');

/**
 * The `set-cookie` value that ends a session in the browser: the same cookie, emptied and
 * expired. It is sent on signing out beside deleting the record, and on a cookie this
 * server cannot verify, so a browser holding one stops sending it.
 */
export const clearedSessionCookieHeader = (options: { secure: boolean }): string =>
  sessionCookieHeader('', { ...options, maxAgeSeconds: 0 });
