import type {
  HoldoutFigures,
  HoldoutVerdict,
  PullRequest,
  Run,
  Score,
} from '@personavision/contract';

/**
 * The words of the one comment this product posts on the pull request it opened — the one
 * place the product's numbers leave the product (`docs/FLOW.md` section 15, point 6).
 *
 * The reader of this comment has never seen a screen of PersonaVision. They see a pull
 * request on their own repository and a comment on it stating that a hundred people did
 * better on one version than on the other. So the wording is load-bearing in a way a
 * screen's is not, and three things are true of it by construction rather than by
 * intention:
 *
 * 1. **It is written from the run.** Every figure comes from the run's own stored scores
 *    and its holdout block, so the comment cannot state a number the artifact does not
 *    hold. The pull request it belongs on comes from the run too, so a comment cannot land
 *    on a pull request the run never tested.
 * 2. **Every number carries the _simulated_ label**, and the finished text is read back
 *    line by line to check it. A line that states a measurement and does not say
 *    `simulated` is {@link CommentRefused} with the line quoted — nothing is posted, which
 *    is the safe direction: an unlabelled percentage on somebody's pull request reads as a
 *    measurement of real people.
 * 3. **It carries nothing about how the product is built.** No credential, no run id, no
 *    persona id, no variant id, no path on our disk. The baseline and the change are
 *    called *baseline* and *the change* — the user's words (`docs/FLOW.md` section 16) —
 *    and the one thing it links to is the run on the platform.
 *
 * The prototype does not draw this comment's text: `#screen-improve`'s `.prbox` draws only
 * the promise of it — *"One comment, updated rather than repeated, with the figures below,
 * the holdout line and a link to this run. Every number in it is labelled simulated."*
 * What is written here is that promise's four things, in the prototype's order and voice:
 * the holdout line first, then the before/after figures of its *Before and after* section,
 * then that section's *Why* reasons, then the link, then its footnote's claim carried over
 * in full.
 */

/**
 * The hidden marker that makes this comment findable as ours.
 *
 * A re-run looks for it to know whether to edit rather than post again, so it is the whole
 * of the product's claim on a comment: a comment without it is somebody else's and is
 * never edited, whoever wrote it. It is an HTML comment, so GitHub renders nothing of it
 * and the reader never sees it.
 */
export const COMMENT_MARKER = '<!-- personavision:run-comment -->';

/** The word every number in the body is labelled with. */
export const SIMULATED_LABEL = 'simulated';

/**
 * What a measurement looks like in the finished text: a percentage, a *38 of 93*, or a
 * count of people. It is deliberately a reading of the **text** and not of the figures
 * that went in — the promise is about what a reader sees, and a reader cannot see an
 * intention. It matches no part of a URL, a date or a pull request number, none of which
 * is a measurement of anybody.
 */
const MEASUREMENT = /\d[\d,.]*\s*%|\b\d+\s+(?:of|in)\s+(?:the\s+)?\d+\b|\b\d+\s+people\b/;

/** The label, however it was spelled. */
const LABELLED = /simulated/i;

/**
 * A path on this product's own disk. Nothing in a run needs to be quoted as one, so one
 * appearing in the finished text is a leak and the comment is refused rather than posted.
 */
const OUR_PATH = /(^|\s)(\/[A-Za-z0-9._-]+){2,}/;

/** The body of the comment, and the pull request the run says it belongs on. */
export interface RunComment {
  readonly kind: 'comment';
  readonly text: string;
  /** From the run's own `improve` block, so the comment goes where the change went. */
  readonly pullRequest: PullRequest;
}

/** Why no comment was written. Nothing is posted and nothing is edited. */
export interface CommentRefused {
  readonly kind: 'refused';
  readonly reason: string;
}

export type CommentDraft = RunComment | CommentRefused;

export interface CommentInput {
  /** The run the figures are read from. Nothing in the body comes from anywhere else. */
  readonly run: Run;
  /**
   * Where this run is on the platform, as the caller's own deployment addresses it. It is
   * the one argument, because a run artifact holds no notion of the host it is served
   * from, and a URL guessed from a convention would be a link to somebody else's page.
   */
  readonly runUrl: string;
}

const refused = (reason: string): CommentRefused => ({ kind: 'refused', reason });

/**
 * One line the product writes, labelled as a simulation when it states a number.
 *
 * It is applied to each composed line, quoted run sentences included: the run's reasons are
 * written by the scoring step and may well state a count of people, and a reader seeing one
 * unlabelled would read it as a count of real ones. A quoted sentence that itself spans
 * lines is **not** split — its first line would carry a number with the label on a later
 * one — so such a sentence falls to the check below and the comment is refused.
 */
const labelled = (text: string): string =>
  MEASUREMENT.test(text) && !LABELLED.test(text) ? `${text} (${SIMULATED_LABEL})` : text;

/** The share as a percentage, as the product says it everywhere else. */
const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

/** The population behind the figure, which is what makes the percentage readable. */
const population = (figures: HoldoutFigures | Score): string =>
  `${String(figures.outcomeCounts.success)} of ${String(figures.scoredSessionCount)} people`;

const figure = (label: string, figures: HoldoutFigures | Score, note = ''): string =>
  labelled(
    `- **${label}** — ${percent(figures.completionRate)} completed the task (${SIMULATED_LABEL}), ${population(figures)}${note}`,
  );

/**
 * The holdout line, in words, in the body's opening lines. A change that won on the seeds
 * it was chosen on and not on the holdout reads as *not confirmed* here, where a reader
 * who stops after two lines still sees it, and not in a trailing note.
 */
const HOLDOUT_LINE: Readonly<Record<HoldoutVerdict, string>> = {
  confirmed:
    '**Confirmed on the holdout.** The gain held up on people this change was never chosen against, so it is the change and not the swarm agreeing with itself.',
  not_confirmed:
    '**Not confirmed on the holdout.** This change won on the seeds it was chosen on and not on the people it was never chosen against, so the gain below is not confirmed.',
  none: '**No holdout ran.** Nobody was held out of the people this change was chosen from, so nothing below is confirmed against people it was never chosen against.',
};

/** A link to the run is an `http://` or `https://` address that names a host. */
const linkable = (url: string): boolean => {
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
};

/**
 * Write the comment for a run, or say why there is none to write.
 *
 * Refuses rather than writing a comment that would mislead: a run that tested no change, a
 * change that was never served anywhere (`#screen-improve`'s error state — there is no
 * comparison to report, so there is no comment), a run missing one side's scores, and a
 * finished text with a number that is not labelled as a simulation.
 */
export const commentBody = (input: CommentInput): CommentDraft => {
  const { run, runUrl } = input;
  const change = run.improve;
  if (change === undefined) {
    return refused(
      'this run tested no change, so there is no before and after to post on a pull request',
    );
  }
  if (change.preview.url === null) {
    return refused(
      `the change was never served at a URL, so there is no comparison to report: ${change.preview.reason ?? 'this run resolved no preview'}`,
    );
  }
  if (!linkable(runUrl)) {
    return refused(
      `a comment carries the link to this run on the platform, and "${runUrl}" is not an http:// or https:// address`,
    );
  }

  const scored = (variant: string): Score | undefined =>
    run.scores.find((score) => score.variant === variant && score.taskId === run.task.id);
  const baseline = scored(change.baselineVariant);
  const after = scored(change.changeVariant);
  if (baseline === undefined || after === undefined) {
    return refused(
      'this run scored only one of the two versions on the task it tested, so there is no before and after to state',
    );
  }

  const verdict: HoldoutVerdict = run.verdict.holdout ?? 'none';
  const holdout = after.holdout;

  const blocks = [
    COMMENT_MARKER,
    `### Before and after, ${SIMULATED_LABEL} for ${run.audience.name}`,
    `${HOLDOUT_LINE[verdict]} ${labelled(run.verdict.audienceSentence)}`,
    [
      figure('Baseline', baseline),
      figure('With the change', after),
      ...(holdout === undefined
        ? []
        : [figure('Holdout', holdout, ', on seeds this change was never chosen against')]),
    ].join('\n'),
    ['**Why**', '', ...run.verdict.reasons.map((reason) => labelled(`- ${reason}`))].join('\n'),
    `[See this run on PersonaVision](${runUrl})`,
    `Simulated for ${run.audience.name}. It says this change helps these people; it does not estimate what it will do to your conversion rate. Merging is yours.`,
  ];
  const text = `${blocks.join('\n\n')}\n`;

  const unlabelled = text.split('\n').find((row) => MEASUREMENT.test(row) && !LABELLED.test(row));
  if (unlabelled !== undefined) {
    return refused(
      `every number in this comment is labelled ${SIMULATED_LABEL}, and "${unlabelled.trim()}" is not: nothing is posted`,
    );
  }
  const leaked = text.match(OUR_PATH)?.[0].trim();
  if (leaked !== undefined) {
    return refused(
      `a comment carries nothing about how this product is built, and "${leaked}" is a path on our own disk: nothing is posted`,
    );
  }

  return { kind: 'comment', text, pullRequest: change.pullRequest };
};
