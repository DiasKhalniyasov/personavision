import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/demo` — the committed example run's Verdict, read-only and with no account. Public.
 *
 * A placeholder on the route table, so that **#124** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function DemoPage() {
  return <ScreenPlaceholder screen="Demo" ticket="#124" />;
}
