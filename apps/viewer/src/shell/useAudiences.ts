import { createContext, use } from 'react';
import { useAudienceList } from '@/screens/audience/useAudienceList';
import type { AudienceRecord } from '@/screens/audience/store';

/**
 * The audiences this workspace has. A test cannot be run without one, so `/new` asks for
 * an audience before it offers a form (`docs/FLOW.md` section 2).
 *
 * It reads **#102's store** — `GET /audiences`, which answers with each audience and the
 * people it generates — through the one module that talks to it, so the shell and the
 * Audiences screen cannot disagree about what the workspace has. A finished test's
 * audience is never read from here: that comes from `run.json`'s frozen copy, so editing
 * an audience cannot restate an old result.
 *
 * A test — and #124's public demo page — supplies its own answer with `AudiencesContext`.
 */

export type AudiencesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly audiences: readonly AudienceRecord[] };

/** Overrides the store, for #124's public demo and for tests. */
export const AudiencesContext = createContext<AudiencesState | null>(null);

export function useAudiences(): AudiencesState {
  const override = use(AudiencesContext);
  const list = useAudienceList();

  if (override !== null) return override;
  if (list.status === 'loading') return { status: 'loading' };
  // A store that cannot be read is a workspace with no audience we can offer a test for:
  // the screen that reads it says what went wrong, and this answer never guesses at one.
  return { status: 'ready', audiences: list.status === 'ready' ? list.records : [] };
}
