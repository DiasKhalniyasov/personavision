import { createContext, use } from 'react';
import type { Audience } from '@personavision/contract';
import { useLatestRun, useOptionalRun } from './useRun';

/**
 * The audiences this workspace has. A test cannot be run without one, so `/new` asks for
 * an audience before it offers a form (`docs/FLOW.md` section 2).
 *
 * It is a stub, like `useSession`: until **#102** stores audiences, the only audience the
 * viewer can see is the one a finished test froze into its own artifact — so a workspace
 * with a test has that audience, and a workspace with no test has none. #102 and #109
 * replace the body; no screen asks for an audience any other way.
 */

export type AudiencesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly audiences: readonly Audience[] };

/** Overrides the stub, for #102's store, for #124's public demo and for tests. */
export const AudiencesContext = createContext<AudiencesState | null>(null);

export function useAudiences(): AudiencesState {
  const override = use(AudiencesContext);
  const latest = useLatestRun();
  const run = useOptionalRun(latest.status === 'ready' ? latest.runId : null);

  if (override !== null) return override;
  if (latest.status === 'loading') return { status: 'loading' };
  if (latest.status !== 'ready') return { status: 'ready', audiences: [] };
  if (run === null || run.status === 'loading') return { status: 'loading' };
  return { status: 'ready', audiences: run.status === 'ready' ? [run.run.audience] : [] };
}
