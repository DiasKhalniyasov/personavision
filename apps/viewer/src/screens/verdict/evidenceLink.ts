import type { Findings } from '@personavision/contract';
import { heatmapLink, sessionsLink } from '@/shell/paths';

/**
 * Where a finding's stored `evidence_link` leads.
 *
 * A finding carries its own destination — `{ screen, params }` as the pipeline wrote it —
 * and this is where that destination is turned into one of the product's link builders. The
 * viewer therefore never reads a claim sentence to decide where a click goes (`docs/FLOW.md`
 * section 6), and the two screens a finding can open are the two the route table mounts.
 *
 * The URL itself is assembled in `shell/paths.ts` with every other link in the product, so
 * which parameters a screen honours is answered in one place and a renamed route is one
 * edit. A parameter the named screen does not take is left out by the builder rather than
 * written into a query the screen would ignore.
 *
 * A link the route table cannot accept — an unknown screen, or an Attention link with no
 * version or step to open — is `null` rather than a URL that leads nowhere. The finding is
 * still rendered; it is rendered without its action.
 */

/** One finding, as `findings.json` carries it. The contract names the fields, not this app. */
export type FindingItem = Findings['findings'][number];

type EvidenceLink = FindingItem['evidence_link'];

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
      return heatmapLink(runId, variant, step, params);
    }
    case 'sessions':
      return sessionsLink(runId, params);
    default:
      return null;
  }
}
