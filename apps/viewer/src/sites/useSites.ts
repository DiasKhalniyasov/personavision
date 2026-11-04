import { useEffect, useState } from 'react';
import { listSites, readSite } from './store';
import type { SiteRecord } from './store';

/**
 * Reading the workspace's sites. The **only** place in the viewer that does.
 *
 * One read of the list while the app is open, the way the audiences are read
 * (`screens/audience/useAudienceList.ts`): the Sites screen asks for it, and the screens
 * that come later — the launch step choosing a site among them — ask the same question.
 * Adding or removing a site drops the entry with `refreshSites`, so the list a reader
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

/** Read the list again on the next render that asks for it: a site has been added or removed. */
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

/** Reading one site, as its own page opens on it. */
export type SiteState =
  | { readonly status: 'loading' }
  /** `/sites/new`: no site is being read, because there is not one yet. */
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly site: SiteRecord }
  | { readonly status: 'not-found'; readonly siteId: string }
  | { readonly status: 'unreadable'; readonly problem: string };

/**
 * One site, by the id in the path — **read fresh every time**, and deliberately not cached.
 *
 * The list above is remembered because every screen asks the same question of it; a single
 * site is not, because this is the screen a reader opens to act on the site in front of
 * them. What it shows has to be what is stored now, not the copy that was true when the
 * workspace's list was last read.
 *
 * `/sites/new` and `/sites/:siteId` are one component on the route table, so a path naming
 * no site clears the answer rather than leaving the last site standing in the new form.
 */
export function useSite(siteId: string | null): SiteState {
  /**
   * The answer, **and the site it is an answer about**.
   *
   * The id is held beside the state because the effect below runs after the render that
   * changed it: a reader going from `/sites/A` to `/sites/B` stays on one mounted
   * component, so without this the first painted frame of B would carry A's URL as the
   * heading, A's figures, and a *Remove this site* bound to A. Comparing the two during
   * the render closes that window — the frame is `loading`, which is what it is.
   */
  const [answered, setAnswered] = useState<{
    readonly siteId: string | null;
    readonly state: SiteState;
  }>({ siteId: null, state: { status: 'none' } });

  useEffect(() => {
    if (siteId === null) {
      setAnswered({ siteId: null, state: { status: 'none' } });
      return;
    }
    let live = true;
    void readSite(siteId).then((answer) => {
      if (!live) return;
      setAnswered({
        siteId,
        state: answer.ok
          ? { status: 'ready', site: answer.value }
          : answer.kind === 'not-found'
            ? { status: 'not-found', siteId }
            : {
                status: 'unreadable',
                problem:
                  answer.kind === 'unreachable'
                    ? answer.problem
                    : (answer.issues[0]?.message ?? 'That site could not be read.'),
              },
      });
    });
    return () => {
      live = false;
    };
  }, [siteId]);

  if (answered.siteId === siteId) return answered.state;
  return siteId === null ? { status: 'none' } : { status: 'loading' };
}
