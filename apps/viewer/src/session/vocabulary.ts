import type { Session } from '@personavision/contract';

/**
 * The words and the colour tokens for a task outcome and for who it is attributed to.
 *
 * `docs/FLOW.md` section 8 fixes the vocabulary and `docs/design/tokens.css` the tokens, and
 * both screens of this step read them from here. Success, abandonment, a failed task and our
 * own automation breaking are **four different things** with four different words and four
 * different tokens: the one rule this module exists to keep is that the three non-success
 * outcomes are never folded into one bucket.
 *
 * An automation failure borrows the attribution token rather than an `--outcome-*` one of
 * its own, because that is what the tokens file declares: it is not an outcome of the
 * product under test, it is ours.
 */

/** The four outcomes, and the two attributions, as the contract enumerates them. */
export type OutcomeStatus = Session['outcome']['status'];
export type Attribution = Session['outcome']['attribution'];

export interface OutcomeWords {
  readonly status: OutcomeStatus;
  /** What a screen prints: `Success`, `Abandoned`, `Failed`, `Automation failure`. */
  readonly label: string;
  /** The custom property carrying this outcome's foreground colour. */
  readonly token: string;
  /** Its background counterpart, for the tag the prototype draws. */
  readonly backgroundToken: string;
}

export interface AttributionWords {
  readonly attribution: Attribution;
  readonly label: string;
  readonly token: string;
  readonly backgroundToken: string;
}

const OUTCOMES: Readonly<Record<OutcomeStatus, OutcomeWords>> = {
  success: {
    status: 'success',
    label: 'Success',
    token: '--outcome-success',
    backgroundToken: '--outcome-success-bg',
  },
  abandoned: {
    status: 'abandoned',
    label: 'Abandoned',
    token: '--outcome-abandoned',
    backgroundToken: '--outcome-abandoned-bg',
  },
  failed: {
    status: 'failed',
    label: 'Failed',
    token: '--outcome-failed',
    backgroundToken: '--outcome-failed-bg',
  },
  automation_failure: {
    status: 'automation_failure',
    label: 'Automation failure',
    token: '--attr-automation',
    backgroundToken: '--attr-automation-bg',
  },
};

const ATTRIBUTIONS: Readonly<Record<Attribution, AttributionWords>> = {
  product: {
    attribution: 'product',
    label: 'product',
    token: '--attr-product',
    backgroundToken: '--attr-product-bg',
  },
  automation: {
    attribution: 'automation',
    label: 'automation',
    token: '--attr-automation',
    backgroundToken: '--attr-automation-bg',
  },
};

/** How one outcome is worded and coloured. */
export function outcomeWords(status: OutcomeStatus): OutcomeWords {
  return OUTCOMES[status];
}

/**
 * Whether a value is one of the four outcomes — what a screen asks of a `?outcome=` before
 * it filters or words anything by it, so that an unknown value is a filter the URL does not
 * carry rather than a row with no word on it.
 */
export function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return typeof value === 'string' && Object.hasOwn(OUTCOMES, value);
}

/** How an outcome's attribution is worded and coloured. */
export function attributionWords(attribution: Attribution): AttributionWords {
  return ATTRIBUTIONS[attribution];
}
