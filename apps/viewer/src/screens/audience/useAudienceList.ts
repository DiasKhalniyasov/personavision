import { useEffect, useState } from 'react';
import { listAudiences, readAudience } from './store';
import type { AudienceRecord } from './store';

/**
 * Reading the audience store. The **only** place in the viewer that does.
 *
 * One read of the list while the app is open, because three places ask for it — the
 * Audiences screen, the shell's `useAudiences` (which is how `/new` knows a test can be
 * run at all) and the setup form on its way back from a save. A save drops the entry with
 * `refreshAudiences`, so the list a reader returns to is the one they just wrote and not a
 * remembered copy of what it was before.
 *
 * Only a successful read is kept: a store that could not be reached is asked again rather
 * than remembered as broken.
 */

export type AudienceListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly records: readonly AudienceRecord[] }
  | { readonly status: 'unreadable'; readonly problem: string };

export type AudienceState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly record: AudienceRecord }
  | { readonly status: 'not-found'; readonly recordId: string }
  | { readonly status: 'unreadable'; readonly problem: string };

let listed: Promise<AudienceListState> | null = null;

const readList = async (): Promise<AudienceListState> => {
  const answer = await listAudiences();
  if (answer.ok) return { status: 'ready', records: answer.value };
  return {
    status: 'unreadable',
    problem:
      answer.kind === 'refused'
        ? (answer.issues[0]?.message ?? 'The audience store refused the list.')
        : answer.problem,
  };
};

const loadList = (): Promise<AudienceListState> => {
  listed ??= readList().then((state) => {
    if (state.status !== 'ready') listed = null;
    return state;
  });
  return listed;
};

/** Read the list again on the next render that asks for it: a save has changed it. */
export const refreshAudiences = (): void => {
  listed = null;
};

/** Forget what has been read. For tests, and for signing out. */
export const clearAudienceCache = (): void => {
  listed = null;
};

export function useAudienceList(): AudienceListState {
  const [state, setState] = useState<AudienceListState>({ status: 'loading' });

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

/**
 * One audience, by the id its URL carries — the **record's** id, which is what the store
 * addresses it by; the audience's own id is the one a run artifact records.
 *
 * It is not cached: this is the screen that edits the audience, and it has to open on what
 * is stored rather than on what was listed before somebody else changed it.
 */
export function useAudience(recordId: string | null): AudienceState {
  const [state, setState] = useState<AudienceState>({ status: 'loading' });

  useEffect(() => {
    if (recordId === null) return;
    let live = true;
    setState({ status: 'loading' });
    void readAudience(recordId).then((answer) => {
      if (!live) return;
      if (answer.ok) {
        setState({ status: 'ready', record: answer.value });
        return;
      }
      setState(
        answer.kind === 'not-found'
          ? { status: 'not-found', recordId }
          : {
              status: 'unreadable',
              problem:
                answer.kind === 'unreachable'
                  ? answer.problem
                  : (answer.issues[0]?.message ?? 'That audience could not be read.'),
            },
      );
    });
    return () => {
      live = false;
    };
  }, [recordId]);

  return state;
}
