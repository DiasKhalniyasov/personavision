import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId/attention/:variant/:step` — where the audience looked on this version of this step: the heatmap, the scanpath and the areas-of-interest table.
 *
 * A placeholder on the route table, so that **#30** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function AttentionPage() {
  return <ScreenPlaceholder screen="Attention" ticket="#30" />;
}
