import { useParams } from 'react-router';
import { SiteScreen } from './SiteScreen';

/**
 * `/sites/:siteId` — what the URL is, and how to prove it is mine.
 *
 * `#screen-site` of `docs/design/prototype.html`: the four verification methods, the exact
 * line to copy, and a failed check that says what it looked for, where and what it found
 * (`docs/FLOW.md` section 13).
 */
export function SitePage() {
  const { siteId = null } = useParams();
  return <SiteScreen siteId={siteId} />;
}
