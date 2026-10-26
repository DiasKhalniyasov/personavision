import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId/breakdown` — how sure is the verdict, and what drove it: the friction score with its spread, its four weighted components, the gap, and the full findings list.
 *
 * A placeholder on the route table, so that **#107** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function BreakdownPage() {
  return <ScreenPlaceholder screen="Score breakdown" ticket="#107" />;
}
