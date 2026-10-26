/**
 * The score-band thresholds, read from the design tokens at runtime.
 *
 * `docs/design/tokens.css` declares `--score-threshold-good` and `--score-threshold-bad`.
 * Nothing in this app may restate those numbers: a screen that wants to know which band a
 * friction score falls in asks here, so that moving a threshold in the tokens moves the
 * product and a screen cannot quietly disagree with the stylesheet.
 */

/** The bands `docs/design/tokens.css` names with its `--score-*` colours. */
export type ScoreBand = 'good' | 'warn' | 'bad';

/** The thresholds between the bands, by the custom property that declares each one. */
const THRESHOLD_TOKEN = {
  good: '--score-threshold-good',
  bad: '--score-threshold-bad',
} as const;

/** Which end of the scale a threshold bounds. `good` and `bad` are the two tokens. */
export type ScoreThreshold = keyof typeof THRESHOLD_TOKEN;

/**
 * One custom property as a number.
 *
 * Throws rather than falling back to a number of its own: a token that cannot be read
 * means the stylesheet did not load, and a plausible-looking default would hide that.
 */
function numericToken(style: CSSStyleDeclaration, property: string): number {
  const raw = style.getPropertyValue(property).trim();
  const value = Number(raw);

  if (raw === '' || !Number.isFinite(value)) {
    throw new Error(
      `${property} did not resolve to a number (got ${JSON.stringify(raw)}). ` +
        'docs/design/tokens.css is the only place it is declared; check that it loaded.',
    );
  }

  return value;
}

/** The value of a score-band threshold as the cascade currently resolves it. */
export function readScoreThreshold(threshold: ScoreThreshold): number {
  return numericToken(getComputedStyle(document.documentElement), THRESHOLD_TOKEN[threshold]);
}

/**
 * Throws unless `docs/design/tokens.css` has reached the page.
 *
 * Both thresholds are checked, not one sentinel: a stylesheet that loaded but no longer
 * declares a threshold has to fail at boot, where the message can name the file, rather
 * than at the first score somebody tries to band.
 */
export function assertTokensLoaded(): void {
  const style = getComputedStyle(document.documentElement);
  numericToken(style, THRESHOLD_TOKEN.good);
  numericToken(style, THRESHOLD_TOKEN.bad);
}

/**
 * The band a friction score falls in, by the thresholds the tokens declare. Scores run
 * 0-100 and higher is worse, so `good` is at or below the good threshold and `bad` is at
 * or above the bad one.
 *
 * Both thresholds come from one `getComputedStyle`, because a screen bands a score per
 * table row and they cannot change between the two reads.
 */
export function scoreBand(score: number): ScoreBand {
  if (!Number.isFinite(score)) {
    throw new Error(
      `A friction score must be a finite number (got ${JSON.stringify(score)}). ` +
        'Banding a missing or malformed score would show it as a clean result.',
    );
  }

  const style = getComputedStyle(document.documentElement);

  if (score <= numericToken(style, THRESHOLD_TOKEN.good)) return 'good';
  if (score >= numericToken(style, THRESHOLD_TOKEN.bad)) return 'bad';
  return 'warn';
}
