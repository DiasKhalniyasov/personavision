import { useEffect, useState } from 'react';
import { estimateTest } from '@/screens/newtest/start';
import type { EstimateQuery, RunEstimate } from '@/screens/newtest/start';

/**
 * The estimate for the draft on the launch step: one `POST /runs/estimate` (#283).
 *
 * Asked **per draft and never remembered**: the figures are a quote for what the user has
 * chosen, and a cached answer would be a quote for what they had chosen before. The three
 * inputs are what the question is, so the question is asked again when any of them changes
 * and not when the component happens to render.
 *
 * `null` is *"not yet enough to ask"* — the audience's own size and the site's cap are reads
 * of their own, and until both have landed there is nothing to quote. The step renders the
 * loading state meanwhile, which is the state this hook starts in.
 *
 * It never refuses anything: an estimate that cannot be read is one sentence on the step and
 * the launch stays available, because an unknown estimate is not a reason to block a test.
 */

export type EstimateState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly estimate: RunEstimate }
  | { readonly status: 'unreadable'; readonly problem: string };

export function useEstimate(query: EstimateQuery | null): EstimateState {
  const [state, setState] = useState<EstimateState>({ status: 'loading' });
  // The question, field by field: a fresh object every render would ask it again on every
  // render, and these three numbers and one string are the whole of it.
  const participants = query?.participants ?? null;
  const siteUrl = query?.siteUrl ?? null;
  const concurrency = query?.concurrency ?? null;

  useEffect(() => {
    if (participants === null || siteUrl === null || concurrency === null) return;
    let live = true;
    setState({ status: 'loading' });
    void estimateTest({ participants, siteUrl, concurrency }).then((answer) => {
      if (!live) return;
      setState(
        answer.ok
          ? { status: 'ready', estimate: answer.estimate }
          : { status: 'unreadable', problem: answer.problem },
      );
    });
    return () => {
      live = false;
    };
  }, [participants, siteUrl, concurrency]);

  return state;
}
