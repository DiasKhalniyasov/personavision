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
 * The value of a score-band threshold as the cascade currently resolves it.
 *
 * Throws rather than falling back to a number of its own: a threshold that cannot be read
 * means the tokens did not load, and a plausible-looking default would hide that.
 */
export function readScoreThreshold(
  threshold: ScoreThreshold,
  element: Element = document.documentElement,
): number {
  const property = THRESHOLD_TOKEN[threshold];
  const raw = getComputedStyle(element).getPropertyValue(property).trim();
  const value = Number(raw);

  if (raw === '' || !Number.isFinite(value)) {
    throw new Error(
      `${property} did not resolve to a number (got ${JSON.stringify(raw)}). ` +
        'docs/design/tokens.css is the only place it is declared; check that it loaded.',
    );
  }

  return value;
}

/**
 * The band a friction score falls in, by the thresholds the tokens declare. Scores run
 * 0-100 and higher is worse, so `good` is at or below the good threshold and `bad` is at
 * or above the bad one.
 */
export function scoreBand(score: number, element: Element = document.documentElement): ScoreBand {
  if (score <= readScoreThreshold('good', element)) return 'good';
  if (score >= readScoreThreshold('bad', element)) return 'bad';
  return 'warn';
}
