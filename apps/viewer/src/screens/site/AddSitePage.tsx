import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/sites/new` — the URL of the page a feature starts on, added to the workspace.
 *
 * The first half of `#screen-site` in `docs/design/prototype.html`; the ownership
 * verification under it is the same screen once the site exists. **#269** builds both.
 */
export function AddSitePage() {
  return <ScreenPlaceholder screen="Add a site" ticket="#269" />;
}
