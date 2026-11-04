import type { GoalAuthor } from '../draft';

/**
 * How the goal step reads: the authorship line, and the sentence a step with nothing to
 * write a goal from states instead.
 *
 * The notice is the point of this screen. A run records the goal it ran **and who last wrote
 * it** (`docs/FLOW.md` section 12), because a completion rate is only as meaningful as the
 * criterion behind it — so the line that says which of the two wrote it, and when, is not
 * decoration and is not composed twice.
 */

/**
 * `3 Nov`, in the reader's own time zone and in the locale every figure in this app uses.
 *
 * Day then month, as `#screen-newtest-goal` prints it, which is why the two are formatted
 * apart: `en-US` writes the pair the other way round in one format
 * (`screens/analysis/provenance.ts` says the same of the same line).
 */
const dayOfMonth = new Intl.DateTimeFormat('en-US', { day: 'numeric' });
const month = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** `09:08`, on the twenty-four-hour clock the rest of the product prints. */
const clock = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** An instant as a reader reads it, or `null` for one that is not an instant at all. */
const instant = (at: string): string | null => {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? null
    : `${dayOfMonth.format(parsed)} ${month.format(parsed)} ${clock.format(parsed)}`;
};

/**
 * The authorship line, in two parts: the claim, which the notice sets in bold as
 * `#screen-newtest-goal` does, and the reason it matters.
 *
 * The model's half is the prototype's own wording. The user's half is the same sentence past
 * its condition: once they have edited either field the test **does** record them as the
 * author, so the line states it rather than warning them it would happen.
 *
 * A `writtenAt` that is not an instant — a draft from a build that stored something else —
 * leaves the time off rather than printing `Invalid Date`: the author is the load-bearing
 * half of this line and is stated either way.
 */
export const authorNotice = (
  author: GoalAuthor,
  writtenAt: string,
): { readonly claim: string; readonly because: string } => {
  const at = instant(writtenAt);
  const who = author === 'model' ? 'Muse Wonder' : 'you';
  const because =
    author === 'model'
      ? 'If you change it, the test records you as the author of the goal, because a completion rate is only as meaningful as the criterion behind it.'
      : 'The test records you as the author of the goal, because a completion rate is only as meaningful as the criterion behind it.';
  return { claim: at === null ? `Written by ${who}.` : `Written by ${who}, ${at}.`, because };
};

/** What the step says while the platform is writing the goal. */
export const BEING_WRITTEN = 'Muse Wonder is writing the goal from your URL and your sentence.';

/**
 * The sentence a step with no site, or no feature sentence, states instead of asking the
 * model for nothing.
 *
 * It names **which** of the two is missing, because the way back is the same screen either
 * way and a user who is sent there has to know what to fill in.
 */
export const nothingToWriteFrom = (hasSite: boolean, hasFeature: boolean): string => {
  const missing =
    !hasSite && !hasFeature ? 'neither yet' : !hasSite ? 'no site yet' : 'no sentence yet';
  return `A goal is written from your site and your own sentence about the feature, and this test has ${missing}.`;
};
