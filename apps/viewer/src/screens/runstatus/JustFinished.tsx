import { Link } from 'react-router';
import type { Run, SessionProgress } from '@personavision/contract';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { paths } from '@/shell/paths';
import {
  clockDuration,
  endedOnPhrase,
  JUST_FINISHED,
  outcomeLabel,
  outcomeTagClass,
  personLine,
} from './progress';
import styles from './justFinished.module.css';

/**
 * *Just finished*: the last handful of people to land, newest first, each a door to their
 * own replay — `#screen-running-swarm`'s `.card` and its table.
 *
 * **It is read, not computed.** Every cell is a field of the run's own progress block: the
 * session id, the person (looked up among the run's personas by the name the entry carries),
 * the outcome in the vocabulary of `docs/FLOW.md` section 8, the stored duration and the
 * step the run labels. Nothing here re-derives an outcome and nothing fetches a session
 * file — the run artifact already said all of it.
 *
 * **Our own automation failing is marked as ours and said to be excluded** (`docs/FLOW.md`
 * section 11): its chip carries the attribution colour rather than one of the three outcomes
 * of the product under test, its Ended-on cell says `excluded`, and a sentence under the
 * table says what that means. It is never counted as a person who gave up.
 *
 * **The replay opens while the run is still going.** A session named in the progress block
 * is a session the artifact also lists in `sessionIds` — the contract holds the two together
 * — so its file is on disk and `/runs/:runId/sessions/:sessionId` can read it. That screen's
 * breadcrumb leads back to `/runs/:runId`, which is this screen for as long as the test is
 * open, so a reader who opens somebody comes back to the progress they left.
 */

/** The six columns, in the order the prototype's `thead` draws them. */
const COLUMNS = ['Session', 'Person', 'Outcome', 'Time', 'Ended on'] as const;

/** The one figure a reader compares down its column. */
const FIGURES = new Set<string>(['Time']);

/**
 * `The 5 most recent of the 63 people who have finished, newest first.` — what the card is
 * showing, and of how many, for a reader who cannot see that it holds five rows.
 *
 * It reads as a sentence at every count the card can be in, which is the whole reason it is
 * written here rather than assembled inline: *the most recent of the one person who has
 * finished* is a different sentence from the plural one, not the plural one with an `s`.
 */
const caption = (shown: number, finished: number): string => {
  const of =
    finished === 1 ? 'the one person who has finished' : `the ${finished} people who have finished`;
  return shown === 1
    ? `The most recent of ${of}.`
    : `The ${shown} most recent of ${of}, newest first.`;
};

export function JustFinished({
  run,
  sessions,
}: {
  run: Run;
  sessions: readonly SessionProgress[];
}) {
  // The artifact appends in the order they finished, so its last entry is the first row.
  const newestFirst = [...sessions].reverse().slice(0, JUST_FINISHED);
  const ours = newestFirst.filter((entry) => entry.status === 'automation_failure').length;

  return (
    <div className={`card ${styles.card}`} data-section="just-finished">
      <span className={`microlabel ${styles.label}`}>Just finished</span>

      {newestFirst.length === 0 ? (
        <p className={`faint ${styles.empty}`}>
          Nobody has finished yet. Each person appears here as they land, and can be opened straight
          away.
        </p>
      ) : (
        // The one scroll region of this screen, and a reader with no pointer has to be able
        // to reach it: six columns do not fit a phone, and the column that goes off the edge
        // is the link to the recording.
        <div
          className={styles.tablewrap}
          tabIndex={0}
          role="region"
          aria-label="The people who just finished"
        >
          <Table>
            <TableCaption className="sr-only">
              {/* How many of how many, so a reader who cannot see that the card holds five
                  rows is not left thinking those five are everybody. */}
              {`${caption(newestFirst.length, sessions.length)} Every one of them can be opened while the test is still running.`}
            </TableCaption>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((column) => (
                  <TableHead
                    key={column}
                    className={FIGURES.has(column) ? styles.figure : undefined}
                  >
                    {column}
                  </TableHead>
                ))}
                <TableHead>
                  {/* The prototype leaves this header empty. A header with no name is one a
                      screen reader announces as nothing at all, so the name is here and only
                      the sighted layout is empty. */}
                  <span className="sr-only">The recording</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newestFirst.map((entry) => (
                <FinishedRow key={entry.sessionId} run={run} entry={entry} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {ours === 0 ? null : (
        <p className={`footnote ${styles.note}`}>
          {ours === 1
            ? 'One of these is our own automation failing, not this site: it is excluded from every figure and from every recommendation, and it is not somebody who gave up.'
            : `${ours} of these are our own automation failing, not this site: they are excluded from every figure and from every recommendation, and they are not people who gave up.`}
        </p>
      )}
    </div>
  );
}

function FinishedRow({ run, entry }: { run: Run; entry: SessionProgress }) {
  const to = paths.session(run.runId, entry.sessionId);

  return (
    <TableRow>
      <TableCell className={styles.tight}>
        <Link className="mono" to={to}>
          {entry.sessionId}
        </Link>
      </TableCell>
      <TableCell>{personLine(run, entry)}</TableCell>
      <TableCell className={styles.tight}>
        <Badge variant="ghost" className={`tag ${outcomeTagClass(entry)}`}>
          {outcomeLabel(entry)}
        </Badge>
      </TableCell>
      <TableCell className={styles.figure}>{clockDuration(entry.durationMs)}</TableCell>
      <TableCell className={styles.where}>{endedOnPhrase(run, entry)}</TableCell>
      <TableCell className={styles.tight}>
        {/* Five links reading `Watch` and nothing else are five links a screen reader cannot
            tell apart, so the name says whose recording it opens — the visible word first,
            so the two agree. */}
        <Link to={to} aria-label={`Watch ${entry.sessionId}`}>
          Watch
        </Link>
      </TableCell>
    </TableRow>
  );
}
