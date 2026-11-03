import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/sites/:siteId` — what the URL is, and how to prove it is mine.
 *
 * `#screen-site` of `docs/design/prototype.html`: the four verification methods, the exact
 * line to copy, and a failed check that says what it looked for, where and what it found
 * (`docs/FLOW.md` section 13). **#269** builds it.
 */
export function SitePage() {
  return <ScreenPlaceholder screen="Prove this site is yours" ticket="#269" />;
}
