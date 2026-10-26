import { createContext, use } from 'react';

/**
 * Who is signed in. The **only** place the viewer asks.
 *
 * It is a stub: it answers with the seeded demo workspace, signed in, so that every screen
 * ticket can be built and tested before the platform exists. #103 fills it against
 * `GET /auth/session` by replacing the default below; nothing else in the app changes,
 * because no screen reads a session any other way.
 *
 * A test — and #124's public demo page — supplies its own answer with `SessionContext`.
 */

export interface AccountSession {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly account: { readonly name: string; readonly email: string };
}

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: AccountSession };

/**
 * The seeded demo workspace of `docs/FLOW.md` section 2: a fresh install has one, and its
 * latest test is the committed example run. The words are the prototype's own.
 */
export const DEMO_SESSION: SessionState = {
  status: 'signed-in',
  session: {
    workspace: { id: 'northwind-demo', name: 'Northwind Outdoors' },
    account: { name: 'Workspace owner', email: 'owner@northwind.example' },
  },
};

/** Overrides the stub. #103 provides the real one above the router; a test provides its own. */
export const SessionContext = createContext<SessionState>(DEMO_SESSION);

export const useSession = (): SessionState => use(SessionContext);

/** The initials the account menu shows, from the workspace this session is in. */
export const workspaceInitials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
