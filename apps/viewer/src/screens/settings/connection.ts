import { useEffect, useState } from 'react';
import { z } from 'zod';

/**
 * The workspace's GitHub connection, read in one place.
 *
 * Two screens render it — `/new`'s path-2 card and `/settings/github` — and they must not be
 * able to disagree about whether this workspace can open a pull request, so there is one
 * read and one answer, the way `useAudienceList` is the viewer's one read of the audience
 * store.
 *
 * **Nothing here decides anything.** Whether the GitHub App exists at all is the platform's
 * answer, from `GITHUB_APP_ID` in its environment (#319); which repository is connected is
 * the installation record's (#299). The browser cannot see either, so it asks, and a screen
 * never carries a flag of its own that would be a second source of truth.
 *
 * While #299 has not mounted the route, the request falls through the platform to the app
 * and comes back as something that is not this answer — which is read as **unreadable**, and
 * unreadable renders locked. Locked is the safe answer: the one state this must never
 * invent is an unlocked path that cannot open a pull request.
 */

/** The route the platform answers this with (#299 mounts it). */
export const CONNECTION_PATH = '/github/connection';

/**
 * The answer, as thin as the two screens need it: whether the App is registered, and the
 * connection if there is one. A field this does not name is a field no screen reads.
 */
const answerSchema = z.object({
  registered: z.boolean(),
  connection: z.object({ repository: z.string().min(1) }).nullable(),
});

export type GithubConnectionState =
  /** The read is in flight. Both cards are already drawn, and path 2 is already locked. */
  | { readonly status: 'loading' }
  /** No GitHub App: nothing can be connected by anybody, which the screen says plainly. */
  | { readonly status: 'unregistered' }
  /** The App exists and this workspace has not connected a repository. The normal state. */
  | { readonly status: 'disconnected' }
  | { readonly status: 'connected'; readonly repository: string }
  /** The state could not be read. Path 2 stays locked and says so. */
  | { readonly status: 'unreadable'; readonly problem: string };

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

const unreadable = (problem: string): GithubConnectionState => ({ status: 'unreadable', problem });

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readConnection = async (): Promise<GithubConnectionState> => {
  let response: Response;
  try {
    // `/settings/github` is also a screen of this app, so the request says what it wants.
    response = await fetch(absolute(CONNECTION_PATH), { headers: { accept: 'application/json' } });
  } catch (error) {
    return unreadable(`The platform could not be reached. ${reason(error)}`);
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return unreadable(
      response.ok
        ? 'The platform answered something that is not JSON.'
        : `The platform answered ${String(response.status)}.`,
    );
  }

  if (!response.ok) {
    const stated = z.object({ error: z.string() }).safeParse(body);
    return unreadable(
      stated.success ? stated.data.error : `The platform answered ${String(response.status)}.`,
    );
  }

  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) return unreadable('The platform answered a connection state nobody knows.');
  if (!parsed.data.registered) return { status: 'unregistered' };
  const { connection } = parsed.data;
  return connection === null
    ? { status: 'disconnected' }
    : { status: 'connected', repository: connection.repository };
};

let read: Promise<GithubConnectionState> | null = null;

/**
 * One read while the app is open, shared by both screens. Only a state the platform really
 * answered is kept: one that could not be read is asked again rather than remembered as
 * broken, which is `useAudienceList`'s rule for the same reason.
 */
const load = (): Promise<GithubConnectionState> => {
  read ??= readConnection().then((state) => {
    if (state.status === 'unreadable') read = null;
    return state;
  });
  return read;
};

/**
 * Forget what has been read.
 *
 * Nothing in this build can change the connection — `/settings/github` is the entry point
 * and nothing more — so the caller is whoever builds the connect flow (#299, #227), the way
 * a save calls `refreshAudiences`. Until then it is what a test resets between cases, and
 * there is no stale state a user can reach: a connection made in another tab is read on the
 * next load, and a state that could not be read was never cached.
 */
export const forgetGithubConnection = (): void => {
  read = null;
};

export function useGithubConnection(): GithubConnectionState {
  const [state, setState] = useState<GithubConnectionState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}
