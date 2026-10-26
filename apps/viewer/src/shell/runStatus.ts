import type { Run } from '@personavision/contract';

/**
 * Which of the three screens `/runs/:runId` is: a test still running, a test that failed
 * to start, or the Verdict of a finished one. `RunRoute` switches on it.
 *
 * `packages/contract` does not declare a run status yet — #32 adds `open`, `failed` and
 * `finished` to the artifact, with the progress block behind them. Until it does, every
 * run directory this app can read is a finished test: the artifact is written when the run
 * is. #32 and #18 replace the body below, and nothing else moves, because `RunRoute`
 * already renders all three and no screen asks a run for its status any other way.
 */
export type RunStatus = 'running' | 'failed' | 'complete';

export const runStatus = (run: Run): RunStatus => {
  void run;
  return 'complete';
};
