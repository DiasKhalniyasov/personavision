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
 * What a measurement looks like in the finished text: a percentage, a *38 of 93*, a count
 * of people, a duration, or a number of times. It is deliberately a reading of the **text**
 * and not of the figures that went in — the promise is about what a reader sees, and a
 * reader cannot see an intention.
 *
 * The five shapes are the ones `@personavision/scoring`'s own `wording.ts` emits —
 * `percentSaid`, `outOf`, `people`, `secondsSaid`, `millisecondsSaid` and `timesSaid` —
 * because the one thing in this body the product did not write is a run's prose, and that
 * prose is written there. A reason reading *"the first look took 610 ms longer"* is a
 * simulated measurement and is labelled as one.
 *
 * It matches no part of a date or a pull request number. It is not asked about the link
 * line, which carries no measurement by construction and whose percent-encoding would
 * read as one.
 */
const MEASUREMENT =
  /\d[\d,.]*\s*%|\b\d+\s+(?:of|in)\s+(?:the\s+)?\d+\b|\b\d+\s+people\b|\b\d[\d,.]*\s*m?s\b|\b\d+\s+times\b/;

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

/**
 * The stored share as a percentage — and **100% and 0% are reserved for everybody and
 * nobody**, as the Verdict screen's own `inTen` reserves ten tenths and none.
 *
 * Rounding never reaches them. 199 of 200 is 99% here and not 100%, because this is the one
 * line of the product a reader quotes back, and *"100% completed the task, 199 of 200
 * people"* contradicts itself inside one line. The counts decide the two ends, so the
 * figure and the population beside it always say the same thing.
 */
const percent = (figures: HoldoutFigures | Score): string => {
  const { success } = figures.outcomeCounts;
  if (success === 0) return '0%';
  if (success === figures.scoredSessionCount) return '100%';
  return `${String(Math.min(99, Math.max(1, Math.round(figures.completionRate * 100))))}%`;
};

/**
 * The population behind the figure, which is what makes the percentage readable. Spelled as
 * `@personavision/scoring`'s `outOf` spells it, the singular included: *1 of 1 person*.
 */
const population = (figures: HoldoutFigures | Score): string => {
  const scored = figures.scoredSessionCount;
  return `${String(figures.outcomeCounts.success)} of ${String(scored)} ${scored === 1 ? 'person' : 'people'}`;
};

const figure = (label: string, figures: HoldoutFigures | Score, note = ''): string =>
  labelled(
    `- **${label}** — ${percent(figures)} completed the task (${SIMULATED_LABEL}), ${population(figures)}${note}`,
  );

/**
 * The holdout line, in words, in the body's opening lines. A change that won on the seeds
 * it was chosen on and not on the holdout reads as *not confirmed* here, where a reader
 * who stops after two lines still sees it, and not in a trailing note.
 *
 * It is a **label and not an explanation**, because the run's own headline already is the
 * explanation: `judgeHoldout` in `@personavision/scoring` writes the holdout into
 * `verdict.audienceSentence` and *replaces* the headline with it rather than appending a
 * caveat (decision 96). A sentence of ours spelling the same judgement out a second time
 * would state *not confirmed* twice in one paragraph, in two different wordings, which is
 * the drift this product has one spelling of everything to avoid. The prototype's notice
 * leads with exactly these three words, so the label is also what `#screen-improve` draws.
 */
const HOLDOUT_LINE: Readonly<Record<HoldoutVerdict, string>> = {
  confirmed: '**Confirmed on the holdout.**',
  not_confirmed: '**Not confirmed on the holdout.**',
  /** No holdout, or one too small to judge: both are `none`, and neither confirms anything. */
  none: '**No holdout ran.** Nothing below is confirmed against people this change was never chosen against.',
};

/**
 * A link to the run is an `http://` or `https://` address that names a host, and that
 * cannot end the markdown link it is written into.
 *
 * `(`, `)`, `<`, `>`, `` ` `` and `"` are what close a link destination or open a title, so
 * an address carrying one would end the link early and leave the rest of itself in the
 * comment as raw markup — on a customer's pull request, which is the one thing this module
 * must not do. No address of a run on the platform carries any of them.
 */
const linkable = (url: string): boolean => {
  if (/[\s\u0000-\u001f\u007f()<>`"]/.test(url)) return false;
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
  const link = `[See this run on PersonaVision](${runUrl})`;

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
    link,
    `Simulated for ${run.audience.name}. It says this change helps these people; it does not estimate what it will do to your conversion rate. Merging is yours.`,
  ];
  const text = `${blocks.join('\n\n')}\n`;

  // Every line but the link, which carries no measurement and whose percent-encoding would
  // read as one: `%20%2F` holds a `0%`, and refusing a whole comment over it would stop one
  // deployment's runs from ever being commented on, with a reason that reads like a typo.
  const unlabelled = text
    .split('\n')
    .find((row) => row !== link && MEASUREMENT.test(row) && !LABELLED.test(row));
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
