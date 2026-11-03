import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/settings/github` — where would the pull request go?
 *
 * The way in to path 2 of `docs/FLOW.md` section 11, which is shown and locked until a
 * repository is connected. **#271** builds it, with the locked path card it is reached from.
 */
export function GithubPage() {
  return <ScreenPlaceholder screen="GitHub connection" ticket="#271" />;
}
