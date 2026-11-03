import styles from './improve.module.css';

/**
 * The pull request that was written: `#screen-improve`'s `.prbox` in
 * `docs/design/prototype.html`.
 *
 * The title, the repository and number with the state the run recorded, the recommendation
 * the change answers, the diff, and the three rows under it — *Preview*, *Tested with* and
 * *Comment on the pull request*. **Everything here is read from the run**: this component
 * takes what the artifact carries and formats it, so the screen cannot put a claim on the
 * page that the pipeline did not record.
 *
 * It is drawn twice over the same props: once for a connected workspace's own change, and
 * once as the prototype's illustration under *What it looks like once connected*, which is
 * the whole reason the props are plain data rather than a run. The two faces are therefore
 * the same box and cannot drift into two layouts (decision 82).
 *
 * **A field the run did not record is not invented.** No recorded state means the chip
 * carries the repository and the number alone; no recorded patch means one line saying the
 * change itself is on the pull request, rather than an empty diff. A preview that is a
 * stated nothing prints its reason here, and the before/after is not drawn at all — that is
 * `ImprovePage`'s call, since a comparison of two versions one of which was never reached
 * is not a comparison.
 */

/** Where the changed version was reached, or the stated reason there is nowhere. */
export interface PreviewOf {
  readonly url: string | null;
  /** Why there is no URL. The contract refuses a nothing with no reason. */
  readonly reason: string | null;
}

/** Who the change was tested on, as the *Tested with* row names them. */
export interface TestedWith {
  /** The audience by name, or `null` in the illustration, which names nobody's. */
  readonly audience: string | null;
  /** The people the change was chosen on: the run's own, less the holdout. */
  readonly participants: number;
  readonly seeds: number;
  /** The people the change was never chosen against. `0` when no holdout ran. */
  readonly holdout: number;
}

/** The one change a run tested, as this box prints it. */
export interface WrittenChange {
  readonly title: string;
  readonly repository: string;
  readonly number: number;
  /** The pull request itself. `null` in the illustration, which links nowhere. */
  readonly url: string | null;
  /** The state the run recorded, or `null` when it recorded none. */
  readonly state: string | null;
  readonly recommendationId: string;
  /** The recommendation's own sentence, where the run carries it. */
  readonly recommendationSentence: string | null;
  readonly changedFile: string;
  /** The unified diff, or `null` when the run recorded no patch. */
  readonly patch: string | null;
  readonly preview: PreviewOf;
  readonly testedWith: TestedWith;
}

/** *N people*, and one person when there is one of them. */
const people = (count: number): string => `${String(count)} ${count === 1 ? 'person' : 'people'}`;

/** What the comment on the pull request carries, in the prototype's words. */
const COMMENT =
  'One comment, updated rather than repeated, with the figures below, the holdout line and a link to this run. Every number in it is labelled simulated.';

/** What the preview URL is, in the prototype's words. */
const PREVIEW_IS = "your repository's own preview deployment for this pull request";

/** The sentence a run with no preview prints in place of a URL. */
const NO_PREVIEW = 'No preview, so the changed version could not be reached.';

/** A line of a unified diff: added, removed, or context. */
const lineClass = (line: string): string | undefined => {
  if (line.startsWith('+')) return styles.add;
  if (line.startsWith('-')) return styles.del;
  return undefined;
};

export function PullRequestBox({ change }: { change: WrittenChange }) {
  const { preview, testedWith } = change;

  return (
    <div className={styles.prbox} data-section="pull-request">
      <div className={styles.prhead}>
        {/* The prototype sets the title as an `h3` under the illustration's label, which
            is not a heading; on the screen this box is a section of its own under the
            page's `h1`, so it is an `h2` and the heading order holds in both faces. */}
        <h2>{change.url === null ? change.title : <a href={change.url}>{change.title}</a>}</h2>
        <span className="grow" />
        <span className="tag tag-info">
          {change.repository} #{change.number}
          {change.state === null ? null : ` · ${change.state}`}
        </span>
      </div>

      <p className="lede" data-section="from-recommendation">
        From recommendation {change.recommendationId}
        {change.recommendationSentence === null ? null : (
          <>
            {' — '}
            <i>{change.recommendationSentence}</i>
          </>
        )}
        . It touches <span className="mono">{change.changedFile}</span> and nothing else: one
        change, so the before/after says what the change did.
      </p>

      {change.patch === null ? (
        <p className={styles.nodiff} data-section="diff">
          This test recorded no patch, so the change itself is on the pull request.
        </p>
      ) : (
        <div className={styles.diff} data-section="diff">
          {change.patch.split('\n').map((line, position) => (
            // Keyed by position: a diff is a sequence of lines and two of them can read
            // the same, so a line is not its own identity.
            <span className={lineClass(line)} key={position}>
              {line}
              {'\n'}
            </span>
          ))}
        </div>
      )}

      <dl className={styles.kv}>
        <dt>Preview</dt>
        {preview.url === null ? (
          <dd data-section="no-preview">
            <b>{NO_PREVIEW}</b>{' '}
            {preview.reason ?? 'This test recorded no reason for there being none.'} There is no
            before and after, because there was nothing to measure the change on.
          </dd>
        ) : (
          <dd className="mono" data-section="preview">
            {preview.url} <span className="faint">&mdash; {PREVIEW_IS}</span>
          </dd>
        )}

        <dt>Tested with</dt>
        <dd data-section="tested-with">
          The same audience
          {testedWith.audience === null ? '' : `, ${testedWith.audience}`}, the same{' '}
          {people(testedWith.participants)}, the same{' '}
          {testedWith.seeds === 1 ? 'seed' : `${String(testedWith.seeds)} seeds`}
          {testedWith.holdout === 0 ? (
            <>
              {' '}
              &mdash; and <b>no holdout</b>, so nothing here was checked against people the change
              was never chosen against.
            </>
          ) : (
            <>
              {' '}
              &mdash; plus a <b>holdout</b> of {people(testedWith.holdout)} generated from the same
              audience on seeds this change was never chosen against.
            </>
          )}
        </dd>

        <dt>Comment on the pull request</dt>
        <dd>{COMMENT}</dd>
      </dl>
    </div>
  );
}
