import { SiteScreen } from './SiteScreen';

/**
 * `/sites/new` — the URL of the page a feature starts on, added to the workspace.
 *
 * The empty state of `#screen-site` in `docs/design/prototype.html`: the URL field alone.
 * A site created here lands on its own page, which is the same screen opened on it.
 */
export function AddSitePage() {
  return <SiteScreen siteId={null} />;
}
