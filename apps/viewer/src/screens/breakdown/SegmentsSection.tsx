import type { Run } from '@personavision/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { variantTagClass } from '@/screens/sessions/rows';
import { useSessionRows } from '@/screens/sessions/useSessionRows';
import type { SessionRow } from '@/session';
import './SegmentsSection.css';

/**
 * *Which part of your audience this came from* — the foot of `/runs/:runId/breakdown`.
 *
 * The `.section` of `#screen-breakdown` that answers one question a business reader asks
 * out loud: **did this happen to all my customers, or only to the ones on a phone?** A
 * result driven entirely by one part of the audience is a different decision from one that
 * held across it, and this is the only place in the product that can show the difference —
 * which is why the owner's direction moved it off the Verdict screen rather than deleting
 * it (`docs/FLOW.md` sections 3 and 5).
 *
 * One row per generated person × version, stacked by outcome. Every count comes from the
 * run's **sessions as stored**: the three outcome statuses and our own automation's
 * failures stay four separate bands, never three (`docs/FLOW.md` section 8), and nothing
 * here re-derives an exclusion the pipeline already decided.
 *
 * A bar is never the only carrier of meaning. Each row prints its completed count against
 * the segment's total and the other three counts beside it, so the section reads with no
 * colour at all; the stack itself is decorative and hidden from the accessibility tree
 * rather than announced a second time in worse words.
 */

/** The four bands of one bar, in the order they are stacked. */
export interface OutcomeCounts {
  readonly success: number;
  readonly abandoned: number;
  readonly failed: number;
  /** Our own automation breaking. Its own band, and never folded into the other three. */
  readonly automationFailure: number;
}

/** One row: one generated person's segment on one version. */
export interface SegmentBar {
  readonly key: string;
  /** The version's id, which is the tag a reader sees. */
  readonly variant: string;
  /** The version's name, or its id when the run lists no version by that id. */
  readonly variantName: string;
  /** `null` on the row the sessions with no person in this test's audience land in. */
  readonly personaName: string | null;
  /** The persona's `segment` label, as the artifact carries it. */
  readonly segment: string | null;
  readonly deviceName: string | null;
  readonly counts: OutcomeCounts;
  /** Every session in this segment, the excluded included: the bar's denominator. */
  readonly total: number;
}

const NO_COUNTS: OutcomeCounts = { success: 0, abandoned: 0, failed: 0, automationFailure: 0 };

const totalOf = (counts: OutcomeCounts): number =>
  counts.success + counts.abandoned + counts.failed + counts.automationFailure;

/**
 * Every session with no person in this test's audience shares **one** row per version,
 * whatever its session file says: an imported real session carries a participant and no
 * persona at all, and a simulated session may name a persona the run never listed. Neither
 * is dropped, and neither is guessed into somebody else's segment.
 */
const UNKNOWN = null;

/** The key the sessions of one person on one version are gathered under. */
const groupKey = (personaId: string | null, variant: string): string =>
  `${personaId ?? ''}\u0000${variant}`;

const counted = (counts: OutcomeCounts, row: SessionRow): OutcomeCounts => {
  // The status as stored, over the contract's own four, so a fifth could not be quietly
  // absorbed into one of these: the four cases *are* the enumeration.
  switch (row.outcome.status) {
    case 'success':
      return { ...counts, success: counts.success + 1 };
    case 'abandoned':
      return { ...counts, abandoned: counts.abandoned + 1 };
    case 'failed':
      return { ...counts, failed: counts.failed + 1 };
    case 'automation_failure':
      return { ...counts, automationFailure: counts.automationFailure + 1 };
  }
};

/**
 * The rows, from the run's own two lists and the sessions that have been read.
 *
 * The grid is `personas × variants`, so a person who ran on one version and not on the
 * other has a row saying so rather than no row at all. Rows are ordered by **segment** — in
 * the order the segments first appear in `run.personas` — so two people drawn from the same
 * part of the audience sit together and the list reads as parts of an audience rather than
 * as a list of names.
 *
 * Sessions whose person is not in that list are gathered into one row per version at the
 * foot, which is the only place a count could otherwise be lost.
 */
export function segmentBars(run: Run, rows: readonly SessionRow[]): readonly SegmentBar[] {
  const gathered = new Map<string, OutcomeCounts>();
  const listed = new Set(run.personas.map((persona) => persona.id));
  const isUnknown = (row: SessionRow): boolean =>
    row.personaId === null || !listed.has(row.personaId);

  for (const row of rows) {
    const key = groupKey(isUnknown(row) ? UNKNOWN : row.personaId, row.variant);
    gathered.set(key, counted(gathered.get(key) ?? NO_COUNTS, row));
  }

  const countsAt = (key: string): OutcomeCounts => gathered.get(key) ?? NO_COUNTS;

  // The segments, in the order `run.personas` first names each of them, then the people of
  // each segment in the run's own order.
  const segments = [...new Set(run.personas.map((persona) => persona.segment))];
  const people = segments.flatMap((segment) =>
    run.personas.filter((persona) => persona.segment === segment),
  );

  const known = people.flatMap((persona) =>
    run.variants.map((variant) => {
      const key = groupKey(persona.id, variant.id);
      return {
        key,
        variant: variant.id,
        variantName: variant.name,
        personaName: persona.name,
        segment: persona.segment,
        deviceName: persona.device.name,
        counts: countsAt(key),
        total: totalOf(countsAt(key)),
      };
    }),
  );

  // Whatever the grid did not claim keeps a row of its own at the foot, in the manifest's
  // order: a person the run never listed, an imported real session with no persona at all,
  // or a version the run's own list does not name. This is the only place a count could
  // otherwise be lost, and losing one would quietly change what the test measured.
  const claimed = new Set(known.map((bar) => bar.key));
  const stray = [...gathered.keys()]
    .filter((key) => !claimed.has(key))
    .map((key) => {
      const [personaId = '', variant = ''] = key.split('\u0000');
      // An unknown-person key carries no id, and no persona has the empty name.
      const persona = run.personas.find((candidate) => candidate.id === personaId);
      const named = run.variants.find((candidate) => candidate.id === variant);
      return {
        key,
        variant,
        variantName: named?.name ?? variant,
        personaName: persona?.name ?? null,
        segment: persona?.segment ?? null,
        deviceName: persona?.device.name ?? null,
        counts: countsAt(key),
        total: totalOf(countsAt(key)),
      };
    });

  return [...known, ...stray];
}

/**
 * The four bands, in the order they stack, each with the class carrying its token.
 *
 * The excluded band takes `--attr-automation` and not an `--outcome-*` colour, because that
 * is what `docs/design/tokens.css` declares it as: it is not an outcome of the checkout
 * under test, it is ours. Its legend entry says so in those words.
 */
const BANDS = [
  { key: 'success', className: 's', legend: 'Completed' },
  { key: 'abandoned', className: 'ab', legend: 'Gave up' },
  { key: 'failed', className: 'f', legend: 'Failed' },
  { key: 'automationFailure', className: 'au', legend: 'Our automation broke (excluded)' },
] as const satisfies readonly { key: keyof OutcomeCounts; className: string; legend: string }[];

export function SegmentsSection({ run }: { run: Run }) {
  const states = useSessionRows(run);
  const reading = states.some((state) => state.status === 'pending');
  const read = states.flatMap((state) => (state.status === 'ready' ? [state.row] : []));
  const unreadable = states.filter((state) => state.status === 'failed').length;

  return (
    <div className="section" data-section="segments">
      <h2>Which part of your audience this came from</h2>
      <p className="lede">
        Same generated people, same seeds, both versions. One segment carrying the whole result is
        worth knowing about. Did this happen to all your customers, or only to the ones on a phone?
      </p>
      <div className="card">
        {run.sessionIds.length === 0 ? (
          <p className="lede" data-section="segments-empty">
            This test recorded no people, so there is no audience to break the result down by.
          </p>
        ) : (
          <>
            {reading ? (
              // The grid is `personas × variants`, which the run names before a single
              // session file is read, so the reservation is the list's own height and not
              // an approximation of it.
              <Reserved rows={run.personas.length * run.variants.length} />
            ) : (
              <Bars bars={segmentBars(run, read)} unreadable={unreadable} />
            )}
            <Legend />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * While the sessions are read: one placeholder per row the list will have, each a row's own
 * height, so the legend under it does not travel up the page as the counts arrive.
 *
 * The rows are held back until every session has settled rather than filled one at a time,
 * because a stacked bar drawn from half a segment is not a smaller reading of it — it is a
 * different one, and it would be on screen long enough to be believed.
 */
function Reserved({ rows }: { rows: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Counting this test’s people"
      className="segments-reserve"
      role="status"
      data-section="segments-loading"
    >
      {Array.from({ length: rows }, (_unused, slot) => (
        <Skeleton className="segbar-reserve" key={slot} />
      ))}
    </div>
  );
}

function Bars({ bars, unreadable }: { bars: readonly SegmentBar[]; unreadable: number }) {
  const short =
    unreadable === 1
      ? '1 session of this test could not be read, and is counted in no bar above.'
      : `${unreadable} sessions of this test could not be read, and are counted in no bar above.`;

  return (
    <>
      <ul className="segments" id="segments">
        {bars.map((bar) => (
          <Segbar bar={bar} key={bar.key} />
        ))}
      </ul>
      {unreadable > 0 && (
        <p className="footnote" data-section="segments-unreadable">
          {short}
        </p>
      )}
    </>
  );
}

/**
 * The faint half of a row's label: the part of the audience this person was drawn from, and
 * the device they ran on.
 *
 * The version is the chip at the head of the row and is not spelt out again here — the
 * label column is the prototype's 220px, and a version's full name inside it pushes every
 * row to three lines for a fact the chip already carries.
 */
const detailOf = (bar: SegmentBar): string => {
  const parts = [bar.segment ?? 'not one of this test’s people', bar.deviceName];
  return parts.flatMap((part) => (part === null ? [] : [part])).join(' · ');
};

/** `0 gave up · 0 failed · 1 excluded` — every band the completed figure does not name. */
const splitOf = (counts: OutcomeCounts): string =>
  [
    `${counts.abandoned} gave up`,
    `${counts.failed} failed`,
    `${counts.automationFailure} excluded`,
  ].join(' · ');

function Segbar({ bar }: { bar: SegmentBar }) {
  return (
    <li className="segbar">
      <span className="segbar-who">
        {/* The chip is the version's identity everywhere A and B appear; a reader with no
            sight of it hears the version's own name instead of a letter. */}
        <Badge aria-hidden="true" variant="ghost" className={`tag ${variantTagClass(bar.variant)}`}>
          {bar.variant}
        </Badge>
        <span className="sr-only">{bar.variantName}: </span>{' '}
        <span className="segbar-person">{bar.personaName ?? 'Unknown person'}</span>{' '}
        <span className="faint">{detailOf(bar)}</span>
      </span>
      {/* Decorative: every width it draws is a number printed in the cell beside it. */}
      <span aria-hidden="true" className="stack">
        {bar.total > 0 &&
          BANDS.map((band) => (
            <i
              className={band.className}
              key={band.key}
              style={{ width: `${(bar.counts[band.key] / bar.total) * 100}%` }}
            />
          ))}
      </span>
      <span className="segbar-counts">
        {bar.total === 0 ? (
          <span className="faint">no sessions on this version</span>
        ) : (
          <>
            <span className="num">
              {bar.counts.success} / {bar.total} completed
            </span>
            <span className="faint num segbar-split">{splitOf(bar.counts)}</span>
          </>
        )}
      </span>
    </li>
  );
}

/**
 * The four colours, named. The excluded entry is worded as **our** automation's failure
 * rather than as an outcome of the test, because that is what it is: a reader must never
 * take that band as evidence against their own checkout.
 */
function Legend() {
  return (
    <p className="legend" data-section="segments-legend">
      {BANDS.map((band) => (
        <span key={band.key}>
          <i aria-hidden="true" className={band.className} /> {band.legend}
        </span>
      ))}
    </p>
  );
}
