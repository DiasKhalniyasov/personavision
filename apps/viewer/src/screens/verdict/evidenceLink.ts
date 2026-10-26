import type { Findings } from '@personavision/contract';
import { paths } from '@/shell/paths';

/**
 * Where a finding's stored `evidence_link` leads.
 *
 * A finding carries its own destination — `{ screen, params }` as the pipeline wrote it —
 * and this is the only place that destination becomes a URL. The viewer therefore never
 * reads a claim sentence to decide where a click goes (`docs/FLOW.md` section 6), and the
 * two screens a finding can open are the two the route table mounts.
 *
 * A link the route table cannot accept — an unknown screen, or an Attention link with no
 * version or step to open — is `null` rather than a URL that leads nowhere. The finding is
 * still rendered; it is rendered without its action.
 */

/** One finding, as `findings.json` carries it. The contract names the fields, not this app. */
export type FindingItem = Findings['findings'][number];

type EvidenceLink = FindingItem['evidence_link'];

/** The query parameters the Sessions screen takes, in the order it lists them. */
const SESSION_FILTERS = ['variant', 'outcome', 'aoi'] as const;

const query = (params: Record<string, string>, keys: readonly string[]): string => {
  const search = new URLSearchParams();
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined && value !== '') search.append(key, value);
  }
  const written = search.toString();
  return written === '' ? '' : `?${written}`;
};

/**
 * The URL a finding's evidence link names, or `null` when the route table does not accept
 * it. `link` is typed as the contract writes it and checked as if it were not, because this
 * runs over a file on disk.
 */
export function evidenceUrl(runId: string, link: EvidenceLink): string | null {
  const params: Record<string, string> = link.params ?? {};
  switch (link.screen) {
    case 'attention': {
      // `/runs/:runId/attention/:variant/:step` has no optional segment: a link that names
      // neither opens no heatmap, so it opens nothing.
      const { variant, step } = params;
      if (variant === undefined || variant === '' || step === undefined || step === '') return null;
      return `${paths.attention(runId, variant, step)}${query(params, ['aoi'])}`;
    }
    case 'sessions':
      return `${paths.sessions(runId)}${query(params, SESSION_FILTERS)}`;
    default:
      return null;
  }
}
