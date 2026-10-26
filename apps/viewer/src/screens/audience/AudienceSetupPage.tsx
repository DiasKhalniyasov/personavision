import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/audiences/new` and `/audiences/:audienceId` — describing an audience, and the people it generates.
 *
 * A placeholder on the route table, so that **#109** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function AudienceSetupPage() {
  return <ScreenPlaceholder screen="Audience" ticket="#109" />;
}
