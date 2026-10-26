import { useParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { RunFailedScreen } from '@/screens/runstatus/RunFailedScreen';
import { RunningScreen } from '@/screens/runstatus/RunningScreen';
import { VerdictPage } from '@/screens/verdict/VerdictPage';
import { RunNotFound } from './RunNotFound';
import { runStatus } from './runStatus';
import { useRun } from './useRun';

/**
 * What `/runs/:runId` is: one of three screens, chosen on the run's status.
 *
 * A test still running is the Running screen, a test that failed to start is the Test
 * failed screen, and a finished one is the Verdict. An id this workspace does not hold
 * renders a not-found state inside the chrome rather than throwing.
 */
export function RunRoute() {
  const { runId = '' } = useParams();
  const state = useRun(runId);

  switch (state.status) {
    case 'loading':
      // The chrome above is already in its loading state; the body stays empty rather than
      // flashing a spinner the reader cannot act on.
      return null;
    case 'not-found':
      return <RunNotFound runId={state.runId} url={state.url} />;
    case 'unreadable':
      return <RunNotFound runId={state.runId} url={state.url} problem={state.problem} />;
    case 'ready':
      return <RunScreen run={state.run} />;
  }
}

/** The screen a finished, running or failed test renders. Exported so each branch is testable. */
export function RunScreen({ run }: { run: Run }) {
  switch (runStatus(run)) {
    case 'running':
      return <RunningScreen run={run} />;
    case 'failed':
      return <RunFailedScreen run={run} />;
    case 'complete':
      return <VerdictPage run={run} />;
  }
}
