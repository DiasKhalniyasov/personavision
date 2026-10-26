import type { Run } from '@personavision/contract';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Which test is being read: its name, when it ran and how many people it ran with.
 *
 * The name is the run's own `task.prompt` — what was tested, in the words it was asked for,
 * which is what `GET /runs/index.json` lists a test by. The people are the audience's
 * `size`: the number of simulated people it generates, which is not the number of sessions
 * (4 people × 2 versions × 3 seeds is 24 sessions).
 *
 * It names the test and opens nothing. The prototype draws a caret here, promising a list
 * of tests; no step builds that screen, so the caret is left off rather than promising it.
 */

const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
const time = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `24 Oct 14:02 · 4 people`, in the reader's own time zone. */
export function testMeta(run: Run): string {
  const at = new Date(run.createdAt);
  const people = run.audience.size === 1 ? '1 person' : `${run.audience.size} people`;
  return `${day.format(at)} ${time.format(at)} · ${people}`;
}

export function TestPicker({ run }: { run: Run }) {
  return (
    <span className="runpick" data-shell="test-picker">
      <strong>{run.task.prompt}</strong>
      <span>{testMeta(run)}</span>
    </span>
  );
}

/**
 * The picker while the run is still being read. It holds the same two lines so that the
 * chrome does not shift when they resolve.
 */
export function TestPickerPlaceholder() {
  return (
    <span className="runpick" data-shell="test-picker" aria-hidden="true">
      <Skeleton className="runpick-name" />
      <Skeleton className="runpick-meta" />
    </span>
  );
}
