import { notImplemented } from './types.js';
import type { Route } from './types.js';

/**
 * Sign-in, sign-out and the session the signed-in chrome reads.
 *
 * #100 fixes where they are and what they answer until they exist; #101 fills them in
 * over `AccountStore` and `SessionStore`, with the cookie seam in `../session.ts`.
 */

const TICKET = 101;

export const authRoutes: Route[] = [
  { method: 'POST', path: /^\/auth\/signin$/, handle: notImplemented(TICKET, 'Signing in') },
  { method: 'POST', path: /^\/auth\/signout$/, handle: notImplemented(TICKET, 'Signing out') },
  {
    method: 'GET',
    path: /^\/auth\/session$/,
    handle: notImplemented(TICKET, 'Reading the signed-in session'),
  },
];
