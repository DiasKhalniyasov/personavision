import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/audiences` — who this business serves: the audiences a test can be run for.
 *
 * A placeholder on the route table, so that **#109** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function AudiencesPage() {
  return <ScreenPlaceholder screen="Audiences" ticket="#109" />;
}
