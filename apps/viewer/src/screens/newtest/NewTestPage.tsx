import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/new` — choose the audience, the two versions and the task. Reached only once the workspace has an audience.
 *
 * A placeholder on the route table, so that **#110** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function NewTestPage() {
  return <ScreenPlaceholder screen="New test" ticket="#110" />;
}
