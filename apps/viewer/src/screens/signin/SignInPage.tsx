import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/signin` — email and password against a workspace. Public, and the one screen on the dark fir band.
 *
 * A placeholder on the route table, so that **#103** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function SignInPage() {
  return <ScreenPlaceholder screen="Sign in" ticket="#103" />;
}
