import type { Run } from '@personavision/contract';

/**
 * Which of the three screens `/runs/:runId` is: a test still running, a test that failed to
 * start, or the Verdict of a finished one. `RunRoute` switches on it, and no screen asks a
 * run for its status any other way.
 *
 * The artifact says where the run got to — `open`, `failed` or `finished` — and says
 * nothing on a run written before that field existed. Such a run is on disk because it ran,
 * so it is the Verdict rather than a run of unknown state. **#18** builds the two screens
 * the other statuses lead to, on top of the progress and failure blocks beside the status.
 */
export type RunStatus = 'running' | 'failed' | 'complete';

export const runStatus = (run: Run): RunStatus => {
  switch (run.status) {
    case 'open':
      return 'running';
    case 'failed':
      return 'failed';
    case 'finished':
    case undefined:
      return 'complete';
  }
};
