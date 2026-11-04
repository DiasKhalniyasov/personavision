import { SiteScreen } from './SiteScreen';

/**
 * `/sites/new` — the URL of the page a feature starts on, added to the workspace.
 *
 * The empty state of `#screen-site` in `docs/design/prototype.html`: only the URL field is
 * offered, and the four ways to prove the site appear once it exists — which is the same
 * screen, opened on the site that was just created.
 */
export function AddSitePage() {
  return <SiteScreen siteId={null} />;
}
