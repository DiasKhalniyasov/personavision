import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/` for a visitor with no session: the product's own page — what it does, the verdict it produces, and two actions, *See the demo* and *Sign in*. Public.
 *
 * A placeholder on the route table, so that **#123** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function LandingPage() {
  return <ScreenPlaceholder screen="PersonaVision" ticket="#123" />;
}
