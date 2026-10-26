import type { Run } from '@personavision/contract';
import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId` while the test is still open — `#screen-running` in the prototype: how far
 * along it is, per version, with the log of people as they finish.
 *
 * A placeholder. **#18** builds it, on top of the progress block **#32** adds to the run
 * artifact; `RunRoute` already chooses it on run status, so #18 fills this file and touches
 * nothing else.
 */
export function RunningScreen({ run }: { run: Run }) {
  void run;
  return <ScreenPlaceholder screen="Running" ticket="#18" />;
}
