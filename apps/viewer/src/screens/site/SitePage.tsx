import { useParams } from 'react-router';
import { SiteScreen } from './SiteScreen';

/**
 * `/sites/:siteId` — the URL, and what this site is allowed.
 *
 * `#screen-site` of `docs/design/prototype.html`: the URL as the heading, the URL read-only
 * with *Remove this site* beside it, the figures the site is bound by, and one line about
 * what **Improve my site** needs. There is nothing to prove about a site (`docs/FLOW.md`
 * section 13).
 */
export function SitePage() {
  const { siteId = null } = useParams();
  return <SiteScreen siteId={siteId} />;
}
