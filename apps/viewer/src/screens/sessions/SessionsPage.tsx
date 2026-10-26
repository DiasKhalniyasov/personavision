import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId/sessions` — one row per simulated person: what happened, how long it took and where it ended.
 *
 * A placeholder on the route table, so that **#21** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function SessionsPage() {
  return <ScreenPlaceholder screen="Sessions" ticket="#21" />;
}
