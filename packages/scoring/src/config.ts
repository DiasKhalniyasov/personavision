import type { Findings } from '@personavision/contract';

/**
 * The scoring step's one configuration object.
 *
 * Every number the friction score is made of lives here: the four weights, the two
 * normalisation constants, the 0–100 scale and the severity each findings rule carries.
 * `docs/FLOW.md` section 5 states them in prose and this file is their only expression in
 * code — the viewer imports `scoringConfig` to label a component "weight 30%" rather than
 * writing 30 beside the label, so changing a weight stays one edit (#9, user story 18).
 *
 * They are **versioned with the code, not with a run**: `runSchema` has no field for them,
 * which means a run directory on disk is re-scored by whatever version reads it. That was
 * the owner's call on #9; if a run should record the weights it was scored with, that is a
 * field request on the artifact contract and a one-line change here.
 */

/** The severity vocabulary, from the `--sev-*` tokens. Owned by the artifact contract. */
export type Severity = Findings['findings'][number]['severity'];

/**
 * The findings rules, by id, in the order `docs/FLOW.md` section 6 and #9 list them.
 *
 * The ids are the public key space three later tickets build on: #28 generates a finding
 * per rule, #29 matches a planted defect by rule id and area of interest, and the demo
 * step declares its defects with them. They are fixed here, before those tickets start,
 * so that none of them has to invent a name the others would have to guess.
 */
export const FINDING_RULE_IDS = [
  /** No fixation ever landed on the control that advances the task. */
  'never-fixated-primary-action',
  /** The primary action sits below the fold and few sessions ever looked at it. */
  'primary-action-below-fold',
  /** Something that does not advance the task took the first fixation and held it. */
  'competing-first-fixation',
  /** A value the person was shown changed between steps, and they kept going back to it. */
  'value-changed-between-steps',
  /** One step is where sessions give up. */
  'high-abandonment-at-step',
  /** The primary action was found, but slowly. */
  'slow-primary-action-fixation',
  /** An area the task needs was looked at by few of the sessions that reached it. */
  'low-looked-at-share',
  /** Worth stating, nothing to fix: the run's own shape, coverage or exclusions. */
  'informational-note',
] as const;

export type FindingRuleId = (typeof FINDING_RULE_IDS)[number];

/**
 * How the four components are weighted into one number.
 *
 * They sum to 1 by construction — a test holds them to it — because the score is a
 * weighted blend expressed as a fraction before it is put on the 0–100 scale. A set of
 * weights that summed to anything else would make 100 unreachable or reachable twice.
 */
export interface ComponentWeights {
  readonly taskFailureRate: number;
  readonly abandonment: number;
  readonly timeToFirstFixationPrimary: number;
  readonly deadEndRevisits: number;
}

/** What a raw reading is divided by before it is capped at one. */
export interface Normalisation {
  /**
   * Seconds to the primary action that count as a full 1.0. Six, from section 5: longer
   * than that and the control might as well not be there. **Never fixated is also a full
   * 1.0**, which is why the reading is `null` rather than a large number — a control
   * nobody saw is the worst case, not a slow case.
   */
  readonly timeToFirstFixationSeconds: number;
  /**
   * Returns per session to an area that does not advance the task that count as a full
   * 1.0. Five, from section 5: dividing by the cap rather than by the worst session
   * observed is what stops one pathological session from setting the scale for the run.
   *
   * The artifact stores the normalised component and not the count behind it, so a screen
   * showing the raw reading multiplies the component by this number — and a component of
   * exactly 1 is "five or more", because the cap has thrown the rest away.
   */
  readonly deadEndRevisitsPerSession: number;
}

/** The numbers the findings rules compare a reading against. #28 owns their tuning. */
export interface FindingThresholds {
  /** `lookedAtShare` at or below this is "few of them looked at it". */
  readonly lowLookedAtShare: number;
  /** The share of a step's sessions that gave up there, above which the step is the story. */
  readonly highAbandonmentShare: number;
  /** Seconds to the primary action above which finding it counts as slow. */
  readonly slowPrimaryActionSeconds: number;
  /** An area's share of a step's total dwell, above which it is competing for attention. */
  readonly competingDwellShare: number;
  /** Returns per session to one area, above which going back there is a pattern. */
  readonly repeatedRevisitsPerSession: number;
}

export interface ScoringConfig {
  readonly weights: ComponentWeights;
  readonly normalisation: Normalisation;
  /**
   * Points per unit of the weighted blend. The 0–100 scale is the artifact contract's
   * (`scores[].frictionScore` is points, not a share); this is the one place the
   * multiplication is written down.
   */
  readonly pointsPerUnit: number;
  /**
   * The severity each rule's finding carries. It is a property of the situation, not of
   * the run: a control nobody ever saw is critical whichever variant it is on, so the
   * severity is configuration and not something a rule decides for itself.
   */
  readonly severityByRule: Readonly<Record<FindingRuleId, Severity>>;
  readonly thresholds: FindingThresholds;
}

export const scoringConfig: ScoringConfig = {
  weights: {
    taskFailureRate: 0.3,
    abandonment: 0.2,
    timeToFirstFixationPrimary: 0.35,
    deadEndRevisits: 0.15,
  },

  normalisation: {
    timeToFirstFixationSeconds: 6,
    deadEndRevisitsPerSession: 5,
  },

  pointsPerUnit: 100,

  severityByRule: {
    'never-fixated-primary-action': 'critical',
    'primary-action-below-fold': 'high',
    'competing-first-fixation': 'high',
    'value-changed-between-steps': 'high',
    'high-abandonment-at-step': 'high',
    'slow-primary-action-fixation': 'medium',
    'low-looked-at-share': 'medium',
    'informational-note': 'info',
  },

  thresholds: {
    lowLookedAtShare: 0.3,
    highAbandonmentShare: 0.3,
    // Half the six-second cap: past three seconds the control was found late enough to say
    // so, while still being found — the full cap is the never-fixated case's.
    slowPrimaryActionSeconds: 3,
    competingDwellShare: 0.3,
    repeatedRevisitsPerSession: 2,
  },
};
