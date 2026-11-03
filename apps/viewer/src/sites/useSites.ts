import { useEffect, useState } from 'react';
import { listSites } from './store';
import type { SiteRecord } from './store';

/**
 * Reading the workspace's sites. The **only** place in the viewer that does.
 *
 * One read of the list while the app is open, the way the audiences are read
 * (`screens/audience/useAudienceList.ts`): the Sites screen asks for it, and the screens
 * that come later — the launch step choosing a site among them — ask the same question.
 * Adding or verifying a site drops the entry with `refreshSites`, so the list a reader
 * returns to is the one they just changed and not a remembered copy of what it was before.
 *
 * Only a successful read is kept: a platform that could not be reached is asked again
 * rather than remembered as broken.
 */

export type SiteListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly sites: readonly SiteRecord[] }
  | { readonly status: 'unreadable'; readonly problem: string };

let listed: Promise<SiteListState> | null = null;

const readList = async (): Promise<SiteListState> => {
  const answer = await listSites();
  if (answer.ok) return { status: 'ready', sites: answer.value };
  return {
    status: 'unreadable',
    problem:
      answer.kind === 'refused'
        ? (answer.issues[0]?.message ?? 'The platform refused the list of sites.')
        : answer.problem,
  };
};

const loadList = (): Promise<SiteListState> => {
  if (listed !== null) return listed;
  // `listed === pending` rather than an unconditional clear: a read that fails after
  // `refreshSites` has already started its replacement must not throw that replacement
  // away, or the next render asks the platform a third time for the same list.
  const pending: Promise<SiteListState> = readList().then((state) => {
    if (state.status !== 'ready' && listed === pending) listed = null;
    return state;
  });
  listed = pending;
  return pending;
};

/** Read the list again on the next render that asks for it: a site has been added or proved. */
export const refreshSites = (): void => {
  listed = null;
};

/** Forget what has been read. For tests, and for signing out. */
export const clearSiteCache = (): void => {
  listed = null;
};

export function useSites(): SiteListState {
  const [state, setState] = useState<SiteListState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void loadList().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}
