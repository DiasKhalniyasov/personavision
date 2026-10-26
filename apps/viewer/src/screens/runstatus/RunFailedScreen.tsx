import type { Run } from '@personavision/contract';
import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId` for a test that failed to start — `#screen-error` in the prototype: what
 * could not be opened, that nobody was simulated, and the ways on.
 *
 * A placeholder. **#18** builds it, on top of the failure block **#32** adds to the run
 * artifact; `RunRoute` already chooses it on run status.
 */
export function RunFailedScreen({ run }: { run: Run }) {
  void run;
  return <ScreenPlaceholder screen="Test failed to start" ticket="#18" />;
}
