import { z } from 'zod';
import { runPaths } from './paths.js';

/**
 * The run artifact, as zod schemas.
 *
 * The field names come from the step spec and are binding: a later step that needs a new
 * field adds it here and says so on the step issue, rather than writing a sibling file.
 * What this module owns is the refinements — the ranges, the enumerations and the messages.
 *
 * Every object here is **closed**: a field the contract does not declare is rejected, at its
 * own path, rather than quietly dropped. That is what keeps a run directory portable — an
 * account id, a workspace id, an email, a password or a token has nowhere to hide
 * (`docs/FLOW.md` section 8) — and it turns a misspelt field into a violation.
 */

/**
 * The version every artifact file is written for. Raised to 2 by the owner's direction
 * change: `run.json` now carries the audience the test ran for, each persona carries the
 * audience it was generated from, and the verdict carries what the product leads with.
 */
export const SCHEMA_VERSION = 2;

/**
 * Every artifact file carries this. A file written for another version is named as such
 * rather than guessed at, so an old run on disk is identified and never silently misread.
 */
const schemaVersion = z.literal(SCHEMA_VERSION, {
  error: (issue) => {
    if (issue.input === undefined) {
      return `missing: every artifact file states the schema version it was written for (${SCHEMA_VERSION})`;
    }
    if (typeof issue.input === 'number') {
      return `written for schema version ${issue.input}, but this build reads schema version ${SCHEMA_VERSION}: regenerate the run directory`;
    }
    return `${JSON.stringify(issue.input)} is not a schema version: expected the number ${SCHEMA_VERSION}`;
  },
});

const name = z.string().min(1);
/** 0..1, inclusive — traits, score components and shares all live on this scale. */
const unitInterval = z.number().min(0).max(1);
/** The friction score and its medians are points out of 100, not a share. */
const points = z.number().min(0).max(100);
const count = z.int().min(0);
const milliseconds = z.number().min(0);
const seconds = z.number().min(0);
/** A length, or a point on a rendered page: never negative. */
const pixels = z.number().min(0);
/** A box's origin, which is negative when the element sits off the left or top edge. */
const coordinate = z.number();
/** Timestamps are ISO 8601; an offset is accepted so an imported real session keeps its own. */
const timestamp = z.iso.datetime({ offset: true });
/** `S-01`, `S-02` … `S-NN` — a session's id, and the name of its file under `sessions/`. */
const sessionId = z.string().regex(/^S-\d{2,}$/, 'a session id is S-01, S-02 … S-NN');

/**
 * One plain sentence a reader could act on — the rule of `docs/FLOW.md` section 14 for a
 * recommendation and of section 12 for the two sentences of a goal, enforced here and not
 * by a prompt: something that needs two sentences is two of whatever it is, and a model
 * that writes a paragraph is rejected rather than rendered.
 *
 * A boundary is a terminator followed by the start of another sentence, so a full stop
 * inside a number (`2.5 seconds`) or an abbreviation (`e.g. the banner`) is not one.
 */
const SENTENCE_BOUNDARY = /[.!?]["')\]]*\s+["'([]*[A-Z0-9]/u;

/**
 * What is inside quotation marks is quoted, not written. A success criterion's whole job is
 * to name something observable in the page, **including a piece of text**
 * (`docs/FLOW.md` section 12), and real page copy ends in a full stop: a criterion reading
 * `The page shows "Order complete. Thank you."` is one criterion quoting two sentences, and
 * refusing it would make a correct run unwritable. So a quoted span is blanked before the
 * boundary is looked for.
 *
 * The cost is one case this no longer catches — `He said "Go." Then he left.` reads as one
 * sentence, because the only terminator was inside the quotes. A false refusal of real page
 * copy stops a run; a false acceptance of that is a sentence nobody writes.
 */
const QUOTED_SPAN = /"[^"]*"|“[^”]*”/gu;

const oneSentence = (what: string, section = 14) =>
  name.refine((value) => !SENTENCE_BOUNDARY.test(value.replace(QUOTED_SPAN, '""')), {
    error: `${what} is one plain sentence (docs/FLOW.md section ${section}): this is two or more`,
  });

/**
 * The age brackets a user actually thinks in (`docs/FLOW.md` section 12). They are the
 * user's own words, so they are an enumeration and not a pair of numbers each audience
 * picks for itself: two audiences cut at two different ages cannot be compared.
 */
const ageGroupSchema = z.enum(['18–24', '25–34', '35–44', '45–54', '55–64', '65+']);

/**
 * What each bracket means in years. The last one is open above — `max` is `null`, because
 * `65+` is where a person stops being asked their age, not an upper bound somebody measured.
 */
const AGE_GROUP_YEARS: Record<
  z.infer<typeof ageGroupSchema>,
  { readonly min: number; readonly max: number | null }
> = {
  '18–24': { min: 18, max: 24 },
  '25–34': { min: 25, max: 34 },
  '35–44': { min: 35, max: 44 },
  '45–54': { min: 45, max: 54 },
  '55–64': { min: 55, max: 64 },
  '65+': { min: 65, max: null },
};

/** `18–24`, or `65+` for the open one: a bracket as a message prints it. */
const spellAgeGroup = (years: { readonly min: number; readonly max: number | null }): string =>
  years.max === null ? `${years.min}+` : `${years.min}–${years.max}`;

const viewportSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
});

const deviceSchema = z.strictObject({
  name,
  viewport: viewportSchema,
  deviceScaleFactor: z.number().positive(),
  touch: z.boolean(),
});

/** Each trait is 0..1; the persona generator samples them and the policy reads them. */
const personaTraitsSchema = z.strictObject({
  persistence: unitInterval,
  scanningVsReading: unitInterval,
  detailOrientation: unitInterval,
  interfaceFamiliarity: unitInterval,
  patience: unitInterval,
  riskTolerance: unitInterval,
});

/**
 * One device of an audience's mix, with the share of the audience that uses it. The shares
 * are a distribution: `runSchema` holds them to summing to one.
 */
const audienceDeviceSchema = deviceSchema.extend({ share: unitInterval });

/**
 * One age bracket of an audience, with the share of the audience in it. Like the device
 * mix, the shares are a distribution; `audienceSchema` also holds them to agreeing with
 * `ageRange`, which is derived from them (`docs/FLOW.md` section 12).
 */
const audienceAgeGroupSchema = z.strictObject({ group: ageGroupSchema, share: unitInterval });

/**
 * The share of the audience that is male and the share that is female — a distribution like
 * `devices[].share` (`docs/FLOW.md` section 12), and the only two shares there are: a split
 * is how the agents are drawn, not a statement about who exists.
 */
const genderSplitSchema = z.strictObject({ male: unitInterval, female: unitInterval });

/**
 * What a simulated person was drawn as. The two words are `genderSplitSchema`'s own two
 * shares, read off it rather than written out a second time: a persona is drawn from the
 * split, so there is nothing to be drawn as that the split carries no share for, and a
 * third word here would be a draw nobody could have made (`docs/FLOW.md` section 12).
 */
const genderSchema = genderSplitSchema.keyof();

/** `devices[].share` is a distribution, so the mix has to add up to one whole audience. */
const SHARE_TOLERANCE = 1e-6;

/**
 * The audience a test was run for, as it was **when the test started** — copied into the
 * artifact by value, never referenced, so that editing the stored audience later cannot
 * restate a finished test. `docs/FLOW.md` section 1 declares the shape; the platform and
 * the persona generator both import this one rather than restating it.
 *
 * Its two invariants live here rather than on `runSchema`, so that a caller parsing an
 * audience on its own — the platform storing one, the generator sampling from one — is
 * held to them too, and not only once a whole run has been simulated and written.
 */
export const audienceSchema = z
  .strictObject({
    id: name,
    name,
    ageRange: z.strictObject({ min: z.int().min(0), max: z.int().min(0) }),
    roles: z.array(name),
    regions: z.array(name),
    /**
     * The languages the audience reads the page in, beside `regions`: "Almaty" and "in
     * Russian" are two different facts about the same audience, and the agents read the
     * page in one of them (`docs/FLOW.md` section 12).
     *
     * Optional with no default, like the two additions below — an audience carrying none
     * declared none, which is not the same statement as an empty list, so the absent field
     * is the one spelling of it.
     */
    languages: z
      .array(name)
      .min(1, 'an audience that declares no language leaves the field out rather than empty')
      .optional(),
    /**
     * The gender split, when the audience declared one. Optional with no default: a split
     * of zeroes is a measurement somebody made, and an audience that made none says so by
     * carrying nothing here.
     */
    genderSplit: genderSplitSchema.optional(),
    /**
     * The age brackets the audience falls into, each with its share. Optional with no
     * default, and when present a distribution that `ageRange` has to agree with: the range
     * is derived from the brackets that carry somebody (`docs/FLOW.md` section 12).
     */
    ageGroups: z
      .array(audienceAgeGroupSchema)
      .min(1, 'an audience that declares no age group leaves the field out rather than empty')
      .optional(),
    goals: z.array(name),
    devices: z.array(audienceDeviceSchema).min(1),
    techSavviness: unitInterval,
    priceSensitivity: unitInterval,
    /** How many simulated people the audience generates, and so how many personas a run has. */
    size: z.int().positive(),
    generatedFrom: z.strictObject({ seed: z.int(), generatorVersion: name }),
  })
  .superRefine((audience, ctx) => {
    const shareTotal = audience.devices.reduce((total, device) => total + device.share, 0);
    if (Math.abs(shareTotal - 1) > SHARE_TOLERANCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['devices'],
        message: `the device mix is a distribution: the shares must sum to 1 (±${SHARE_TOLERANCE}), and these sum to ${shareTotal}`,
      });
    }
    if (audience.ageRange.min > audience.ageRange.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['ageRange'],
        message: `an age range runs from min to max: found ${audience.ageRange.min}–${audience.ageRange.max}`,
      });
    }
    if (audience.genderSplit !== undefined) {
      const splitTotal = audience.genderSplit.male + audience.genderSplit.female;
      if (Math.abs(splitTotal - 1) > SHARE_TOLERANCE) {
        ctx.addIssue({
          code: 'custom',
          path: ['genderSplit'],
          message: `the gender split is a distribution: the shares must sum to 1 (±${SHARE_TOLERANCE}), and these sum to ${splitTotal}`,
        });
      }
    }
    const { ageGroups } = audience;
    // An empty list is refused above, by the rule that the absent field is what declares
    // nothing: the checks below would otherwise report the same fault a second time.
    if (ageGroups !== undefined && ageGroups.length > 0) {
      const groupTotal = ageGroups.reduce((total, group) => total + group.share, 0);
      if (Math.abs(groupTotal - 1) > SHARE_TOLERANCE) {
        ctx.addIssue({
          code: 'custom',
          path: ['ageGroups'],
          message: `the age groups are a distribution: the shares must sum to 1 (±${SHARE_TOLERANCE}), and these sum to ${groupTotal}`,
        });
      }
      // One bracket carries one share: the same bracket twice is two numbers for one fact,
      // and whichever a reader took would be a different audience.
      const declared = new Set<string>();
      ageGroups.forEach((entry, index) => {
        if (declared.has(entry.group)) {
          ctx.addIssue({
            code: 'custom',
            path: ['ageGroups', index, 'group'],
            message: `age group "${entry.group}" appears more than once: one bracket carries one share`,
          });
        }
        declared.add(entry.group);
      });
      // `ageRange` is derived from the brackets that carry somebody, so it starts inside the
      // lowest of them and ends inside the highest. A bracket with a zero share holds nobody
      // and so cannot widen the range it was derived from.
      const years = ageGroups
        .filter((entry) => entry.share > 0)
        .map((entry) => AGE_GROUP_YEARS[entry.group]);
      if (years.length > 0) {
        const lowest = years.reduce((a, b) => (b.min < a.min ? b : a));
        const highest = years.reduce((a, b) => (b.min > a.min ? b : a));
        const outside = (age: number, bracket: { min: number; max: number | null }): boolean =>
          age < bracket.min || (bracket.max !== null && age > bracket.max);
        if (outside(audience.ageRange.min, lowest) || outside(audience.ageRange.max, highest)) {
          ctx.addIssue({
            code: 'custom',
            path: ['ageGroups'],
            message: `the age groups that carry somebody run ${spellAgeGroup(lowest)} to ${spellAgeGroup(highest)}, and ageRange is ${audience.ageRange.min}–${audience.ageRange.max}: an age range is derived from those brackets, so it starts inside the lowest and ends inside the highest`,
          });
        }
      }
    }
  });

/**
 * Who last wrote the goal — the model, or the user who edited what it wrote. A completion
 * rate is only as meaningful as the criterion behind it, so a reader a month later has to be
 * able to see which of the two wrote the one they are reading (`docs/FLOW.md` section 12).
 */
const goalAuthorSchema = z.enum(['model', 'user']);

/**
 * The goal a run was given: what the agents attempt, and what counts as having done it
 * (`docs/FLOW.md` section 12). Muse Wonder writes both from the site's URL and the feature
 * description, the user may edit either on the screen before launch, and the edited text is
 * what the run records.
 *
 * The success criterion is **what has to be observable in the page** — a visible element, a
 * URL, a piece of text — and not a judgement and not a feeling. Whether a sentence is
 * observable is not something a schema can decide: the provider sends an unobservable
 * criterion back once for one it can state (step #219). What is held here is the shape, and
 * that each of the two is one sentence.
 */
export const goalSchema = z.strictObject({
  /** What the agents attempt, in the words a person would use. */
  task: oneSentence("a goal's task", 12),
  /** What has to be observable in the page for an attempt to count as a success. */
  successCriterion: oneSentence('a success criterion', 12),
  /** The model, or the user: whoever's words these are now. */
  lastWrittenBy: goalAuthorSchema,
});

/**
 * One simulated person, generated from the audience. It carries where it came from —
 * `audienceId` and a `segment` label such as `mobile · price-sensitive` — so that results
 * are grouped by segment without re-deriving who was who.
 */
export const personaSchema = z.strictObject({
  id: name,
  name,
  audienceId: name,
  segment: name,
  traits: personaTraitsSchema,
  device: deviceSchema,
  /**
   * What this person was drawn as, from the audience's `genderSplit`. Optional with no
   * default: a persona generated from an audience that declared no split — which is every
   * persona written before this revision — was drawn as nothing in particular, and `male`
   * is not a value to assume on its behalf.
   */
  gender: genderSchema.optional(),
  /**
   * The one language this person reads the page and types in, drawn from the audience's
   * `languages`. One and not a list: an audience may read in several, and each agent reads
   * in one of them (`docs/FLOW.md` section 12), which is what makes it groupable. Optional
   * with no default, for the same reason as `gender`.
   */
  language: name.optional(),
  /** Who the person is, in words: optional, because a generated persona has only its traits. */
  profile: z.strictObject({ age: z.int().min(0), about: name, habits: z.array(name) }).optional(),
});

const variantSchema = z.strictObject({ id: name, name, url: z.url() });

const taskSchema = z.strictObject({ id: name, prompt: name });

const engineModeSchema = z.enum(['offline', 'model']);

/**
 * Which of the two models a run was run on — the owner's per-run setting, not a provider
 * detail. `contributor` is `muse-spark-1.3-contributor`: about twelve times cheaper, and
 * Meta may use the content to train its models. `standard` is `muse-spark-1.3` at the
 * published prices, and the content is not used for training. The two price rows and the
 * mapping to those model ids live in the provider, not here: what the contract fixes is
 * that a run records the mode it ran on, so a cost figure can be checked against the table
 * that produced it and a customer can see which model their content went to.
 */
export const modelModeSchema = z.enum(['contributor', 'standard']);

/** How an area of interest was found: the DOM, the accessibility tree, or segmentation. */
const aoiSourceSchema = z.enum(['dom', 'a11y', 'sam']);

/** `docs/FLOW.md` section 8: *abandoned*, *failed* and *automation failure* are never merged. */
const outcomeStatusSchema = z.enum(['success', 'abandoned', 'failed', 'automation_failure']);

const attributionSchema = z.enum(['product', 'automation']);

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

/**
 * Where a run has got to: `open` while the swarm is still landing sessions, `failed` when
 * the run never started, `finished` when it is done. The Running screen reads this rather
 * than inferring a status from what happens to be on disk (`docs/FLOW.md` sections 7, 8).
 */
const runStatusSchema = z.enum(['open', 'failed', 'finished']);

/**
 * One finished session, as the Running screen's log reads it: **structured fields, never a
 * pre-composed sentence**. The screen and the CLI each render the wording from these, in
 * the vocabulary `docs/FLOW.md` section 8 fixes, and the artifact stores no display text.
 */
const sessionProgressSchema = z.strictObject({
  sessionId,
  /** Who it was, as this run's `personas` name them: the log reads a name, not an id. */
  personaName: name,
  variant: name,
  /** `null` for a real session, which carries a participant and no seed. */
  seed: z.int().nullable(),
  /** When it landed: the log's timestamp, and what elapsed time is measured against. */
  finishedAt: timestamp,
  durationMs: milliseconds,
  status: outcomeStatusSchema,
  /** The step it ended on. Unchecked against `steps`, as a session's own step is: a session
   * may end somewhere the run never planned to go. */
  step: name,
  reason: z.string(),
  attribution: attributionSchema,
});

/** One variant's share of the swarm: a `.segbar` count, and the width of its bar. */
const variantProgressSchema = z.strictObject({
  variant: name,
  totalSessions: count,
  finishedSessions: count,
});

/**
 * How far along the run is — "17 of 24 sessions finished", the same two counts per variant,
 * and one entry per finished session. `runSchema` holds the counts to each other and to the
 * entries beneath them, so a screen rendering all three is rendering one claim.
 */
const runProgressSchema = z.strictObject({
  totalSessions: count,
  finishedSessions: count,
  perVariant: z.array(variantProgressSchema).default([]),
  /** Append order, which is the order they finished in; the screen shows newest first. */
  sessions: z.array(sessionProgressSchema).default([]),
});

/** Why a run never started. The Test failed screen shows both and fabricates neither. */
const runFailureSchema = z.strictObject({
  reason: name,
  /** What was captured — a stderr line, a status code. Empty when nothing was. */
  detail: z.string(),
});

/**
 * What the whole run spent. Cached input and reasoning output are fields of their own
 * because the model mode the owner chose reports both (`muse-spark-1.3` with cached input):
 * a cached run must not be reported as more expensive than it was, and reasoning tokens are
 * billed as output. A provider that reports neither records zero for both, and an offline
 * run records zero truthfully rather than leaving its cost unknown.
 */
export const runUsageSchema = z.strictObject({
  calls: count,
  inputTokens: count,
  /** Of `inputTokens`, how many the model served from its prompt cache. */
  cachedInputTokens: count,
  outputTokens: count,
  /** Of `outputTokens`, how many were reasoning tokens. */
  reasoningTokens: count,
  /** US dollars, estimated from the provider's prices at call time. */
  estimatedCostUsd: z.number().min(0),
});

const frictionScoreSchema = z.strictObject({ median: points, sd: z.number().min(0) });

/**
 * The four outcomes a variant's scored sessions ended in. Declared once and used twice —
 * by a variant's own score, and by the holdout's figures beside it — so the holdout's
 * counts cannot be spelt a second way.
 */
const outcomeCountsSchema = z.strictObject({
  success: count,
  abandoned: count,
  failed: count,
  automationFailure: count,
});

/**
 * The holdout's own figures on one score: a completion rate, the sessions behind it and
 * the four outcomes, for the holdout people alone. Stored so that the Improve screen
 * prints a third figure beside the baseline and the change without computing anything
 * (`docs/FLOW.md` section 15). `runSchema` holds this rate to these counts by the same
 * arithmetic and the same tolerance as a variant's own, and refuses them altogether on a
 * run that ran no holdout, so a holdout figure cannot disagree with the people behind it.
 */
const holdoutFiguresSchema = z.strictObject({
  completionRate: unitInterval,
  outcomeCounts: outcomeCountsSchema,
  /** Automation failures are excluded here too, so a measured holdout is at least one. */
  scoredSessionCount: z.int().positive(),
});

const scoreSchema = z.strictObject({
  variant: name,
  taskId: name,
  frictionScore: frictionScoreSchema,
  /**
   * The share of the audience that finished the task: `outcomeCounts.success` over
   * `scoredSessionCount`. Stored, not computed in a browser — the Verdict screen leads
   * with it and formats it (`docs/FLOW.md` section 5). `runSchema` holds it to the counts.
   */
  completionRate: unitInterval,
  /** Each component is 0..1; the weights that combine them live in `@personavision/scoring`. */
  components: z.strictObject({
    taskFailureRate: unitInterval,
    abandonment: unitInterval,
    timeToFirstFixationPrimary: z.strictObject({
      worstStep: name,
      /** `null` when no session ever fixated the primary action on the worst step. */
      medianSeconds: seconds.nullable(),
      value: unitInterval,
    }),
    deadEndRevisits: unitInterval,
  }),
  outcomeCounts: outcomeCountsSchema,
  /**
   * Automation failures are excluded, so this is at least one: a variant whose every
   * session was an automation failure has no friction score and no completion rate, and
   * belongs out of `scores` rather than in it reporting a zero nobody measured.
   */
  scoredSessionCount: z.int().positive(),
  perSeedGroup: z.array(z.strictObject({ seed: z.int(), frictionScore: points })),
  /**
   * The completion rate, the outcomes and the session count for the holdout people alone.
   * Optional with no default: a score of a run that tested no change carries none, and an
   * absent block is a score no holdout was measured on rather than a holdout that
   * completed nothing. The friction score is deliberately not restated — the holdout's
   * line is a completion figure, and the gap in points stays the verdict's.
   */
  holdout: holdoutFiguresSchema.optional(),
});

/**
 * Whether the holdout confirmed the gain: `confirmed`, `not_confirmed`, or `none` for a
 * path-2 test that ran no holdout. The **sentence** that states it is
 * `@personavision/scoring`'s to write (`docs/FLOW.md` section 15); what the contract fixes
 * is that the three states have one spelling, so the Improve screen renders its notice
 * from data rather than by matching on prose.
 */
export const holdoutVerdictSchema = z.enum(['confirmed', 'not_confirmed', 'none']);

/**
 * What the product leads with. All of it is produced by the scoring step and stored: the
 * Verdict screen formats it and decides nothing, which is what makes that screen quiet
 * (`docs/FLOW.md` section 5).
 */
export const verdictSchema = z.strictObject({
  harderVariant: name,
  gapPoints: points,
  bandsDisjoint: z.boolean(),
  seedGroupsAgreeing: count,
  sentence: name,
  /** The variant the audience completes — what to ship. */
  preferredVariant: name,
  /** The headline, in the user's words, not the product's. */
  audienceSentence: name,
  /** One or two short clauses drawn from the top findings. Never none, never three. */
  reasons: z
    .array(name)
    .min(1, 'the verdict leads with one or two reasons: none is not a verdict')
    .max(2, 'the verdict leads with one or two reasons, never three'),
  /** At most three findings, in rank order: the pipeline ranks and the screen does not. */
  headlineFindingIds: z.array(name).max(3, 'the Verdict screen shows at most three findings'),
  /** The one heatmap the verdict embeds: `aoiId` is `null` when the whole step is the evidence. */
  heroEvidence: z.strictObject({ variant: name, step: name, aoiId: name.nullable() }),
  /**
   * Whether the holdout confirmed the gain. Optional with no default: a run that tested no
   * change has no holdout to report on. `runSchema` holds a run that ran one to carrying
   * this, and holds this and the run's own record of it to saying the same thing.
   */
  holdout: holdoutVerdictSchema.optional(),
});

/**
 * How far a stored `completionRate` may sit from the counts it summarises: two decimal
 * places. A rate written as `0.82` for 9 of 11 sessions is that number rounded, not a
 * different claim; anything further apart is a disagreement and is reported as one.
 */
const COMPLETION_TOLERANCE = 0.005;

/**
 * A stored `completionRate` and the outcome counts beneath it are one claim, so the rate is
 * held to the counts wherever a score stores one: a variant's own figures, and the
 * holdout's figures beside them. One function and one tolerance, so the two figures a
 * screen prints side by side are never held to two different rules.
 */
const completionRateIssues = (
  figures: Score | HoldoutFigures,
  path: PropertyKey[],
): Array<{ path: PropertyKey[]; message: string }> => {
  const issues: Array<{ path: PropertyKey[]; message: string }> = [];
  const { success, abandoned, failed } = figures.outcomeCounts;
  // The denominator is the scored sessions, and the three product outcomes are what they
  // are made of: an automation failure is excluded from the scores, not from the run.
  // Without this, 5 successes and 5 abandonments over 5 scored sessions would state a
  // completion rate of 1 and agree with itself.
  const accounted = success + abandoned + failed;
  if (accounted !== figures.scoredSessionCount) {
    issues.push({
      path: [...path, 'scoredSessionCount'],
      message: `${figures.scoredSessionCount} sessions were scored, but the outcomes account for ${accounted} of them (${success} success, ${abandoned} abandoned, ${failed} failed; automation failures are counted separately and excluded)`,
    });
  }
  if (figures.scoredSessionCount <= 0) return issues;
  const expected = success / figures.scoredSessionCount;
  if (Math.abs(figures.completionRate - expected) > COMPLETION_TOLERANCE) {
    issues.push({
      path: [...path, 'completionRate'],
      message: `completionRate ${figures.completionRate} disagrees with ${success} of ${figures.scoredSessionCount} scored sessions (${expected})`,
    });
  }
  return issues;
};

/**
 * A web address a client can actually ask for: `http` or `https`, with a host. This is
 * `packages/platform`'s rule for a site URL, applied to the two addresses path 2 records,
 * because `new URL` — and so a bare `z.url()` — accepts `javascript:`, `data:` and
 * `file:` without complaint. The preview is what the swarm is pointed at and the pull
 * request is what a screen renders as a link, so neither may be a scheme that runs code
 * or reads local disk.
 */
const webAddress = z.url({ protocol: /^https?$/, hostname: /^[^\s/?#]+$/ });

/**
 * The pull request a change was opened as, on the connected repository. The URL is
 * recorded rather than composed from the repository and the number, because a URL built
 * from those two is a guess at the host's layout.
 *
 * **Nothing here holds a credential**, and the object is closed like every other, so there
 * is nowhere for one to hide: the installation token is read at call time and never
 * written into a run, a log line or an error (`CONTEXT.md`, `docs/FLOW.md` section 16).
 */
const pullRequestSchema = z.strictObject({
  /**
   * `owner/name`, as GitHub spells a repository and in the characters GitHub allows. The
   * client composes an API path from this, so a segment of dots — which would walk up out
   * of `/repos/owner/name/pulls` — is not a name however the host reads it.
   */
  repository: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'a repository is owner/name, as GitHub spells it')
    .refine((value) => !value.split('/').some((segment) => /^\.+$/.test(segment)), {
      error: 'a repository is owner/name: "." and ".." are not names of anything',
    }),
  number: z.int().positive(),
  url: webAddress,
  title: name,
});

/**
 * Where the changed version was reached: the pull request's own preview deployment
 * (`docs/FLOW.md` section 15, point 3). A repository that has none is a state the product
 * states plainly rather than guesses at (#232) — the URL is `null` and the reason is what
 * the Improve screen prints. A URL guessed from a convention would produce a confident 404
 * and a run against somebody else's site, so the honest nothing is writable here and the
 * guess is unnecessary.
 *
 * The invariant lives on this object rather than on `runSchema`, so that the step
 * resolving a preview on its own is held to it too, and not only once a whole run has been
 * simulated and written.
 */
export const previewSchema = z
  .strictObject({
    /** `null` when the repository has no preview deployment for this pull request. */
    url: webAddress.nullable(),
    /** Why there is none. Carried only when there is no URL. */
    reason: name.optional(),
  })
  .superRefine((preview, ctx) => {
    if (preview.url === null && preview.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          'this change was tested at no URL, so it records why there is no preview: a repository with no preview deployment is stated, never left blank',
      });
    }
    if (preview.url !== null && preview.reason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `this change was tested at ${preview.url} and also carries a reason there is no preview: a preview is a URL or a stated nothing, never both`,
      });
    }
  });

/**
 * The people the change was never chosen against: personas generated from the same
 * audience on seeds that were not used when the change was picked. It is the only thing in
 * the loop that stops the swarm agreeing with itself, so a change that wins on the original
 * seeds and not on the holdout is reported as **not confirmed** (`docs/FLOW.md` section 15,
 * point 4). `runSchema` holds the ids to the run's own personas, and `confirmed` to the
 * holdout verdict beside it.
 */
const holdoutSchema = z.strictObject({
  /** Ids of this run's own personas. Empty when no holdout ran. */
  personaIds: z.array(name),
  /** `true`, `false`, or `null` when no holdout ran. */
  confirmed: z.boolean().nullable(),
});

/**
 * How a recorded holdout reads as a verdict: the one mapping between the two, so that the
 * record and the notice the screen renders cannot be made to disagree.
 */
const holdoutVerdictOf = (confirmed: boolean | null): z.infer<typeof holdoutVerdictSchema> => {
  if (confirmed === null) return 'none';
  return confirmed ? 'confirmed' : 'not_confirmed';
};

/**
 * Which recommendation a change answers and the one file it touches: the two fields the
 * change Muse Wonder decides and the change a run tested spell the same way. Declared once
 * here so that `changeSchema` and `improveSchema` cannot drift into two spellings of them.
 *
 * They are the only two. The pull-request **title** appears on both shapes on purpose — the
 * title the change asked for is the title it was opened with — and the **body** is on the
 * decision alone, so once the pull request exists the artifact no longer holds the body that
 * `docs/FLOW.md` section 15 asks to state the recommendation, the evidence and the
 * simulated label. Whether `improveSchema` should record it is the question of the step that
 * owns that block, not this one.
 */
const changeTargetShape = {
  /** The recommendation this change answers, by its id in `recommendations.json`. */
  recommendationId: name,
  /** The file in the repository the change touches: one targeted change, not a list. */
  changedFile: name,
} as const;

/**
 * The change Muse Wonder decided — the fourth of the four things it answers
 * (`docs/FLOW.md` sections 15 and 16): the recommendation it answers, the file it touches,
 * the patch, and the title and body of the pull request to open. **One change, not a
 * list**: a model that would rather make two has to pick one, and this shape is where that
 * is true instead of a prompt.
 *
 * It is the decision, not the outcome. `improveSchema` below is what a run records once the
 * pull request exists — its number, its URL, the preview it was tested at and the holdout
 * it was tested against — and it shares the two fields above with this one rather than
 * restating them.
 */
export const changeSchema = z.strictObject({
  ...changeTargetShape,
  /**
   * The patch that makes the change, as a unified diff. It is carried as text and not
   * parsed here: a contract that guessed at a diff dialect would refuse patches `git apply`
   * accepts, and the repository is the only thing that can say whether one applies.
   */
  patch: z
    .string()
    .min(1, 'a change carries the patch that makes it: an empty patch changes nothing'),
  /**
   * The pull request this change asks for, before there is one. The body states the
   * recommendation it comes from, the evidence it cites and that the numbers behind it are
   * simulated (`docs/FLOW.md` section 15); that it says so is the writer's job, and what is
   * held here is that there is a body to say it in.
   */
  pullRequest: z.strictObject({ title: name, body: name }),
});

/**
 * The change a run tested — the whole of what the artifact learns about path 2's closed
 * loop (`docs/FLOW.md` section 15): the recommendation the change answers, the file it
 * touches, the pull request it was opened as, the preview it was tested at, and the holdout
 * it was tested against.
 *
 * The two variants of such a run are named here so that no screen has to guess which is
 * which: `baselineVariant` is the site as it is, `changeVariant` is the pull request's
 * version, both by their ids in `variants`. **Baseline** and **change** are the user's
 * words for them; _variant_ stays the internal word the artifact uses for both
 * (`docs/FLOW.md` section 16).
 */
export const improveSchema = z.strictObject({
  ...changeTargetShape,
  pullRequest: pullRequestSchema,
  preview: previewSchema,
  baselineVariant: name,
  changeVariant: name,
  holdout: holdoutSchema,
});

export const runSchema = z
  .strictObject({
    schemaVersion,
    runId: name,
    createdAt: timestamp,
    /**
     * The four fields the Running and Test failed screens read. All of them are optional:
     * a `run.json` written before this step carries none, and an absent status is a run
     * that never recorded one rather than a status guessed from the sessions on disk.
     */
    status: runStatusSchema.optional(),
    /** When the swarm started. `createdAt` is when the run was asked for. */
    startedAt: timestamp.optional(),
    /** When it stopped, either way. Absent while the run is open. */
    finishedAt: timestamp.optional(),
    progress: runProgressSchema.optional(),
    /** Present only on a failed run; a run that finished carries none. */
    failure: runFailureSchema.optional(),
    usage: runUsageSchema.optional(),
    task: taskSchema,
    /**
     * The feature whose experience was tested, **in the user's own words** — _"generating a
     * video from a prompt"_, _"checking out with a promo code"_ (`docs/FLOW.md` section 11).
     * One of the things a path-1 test is made of, and what the results heading reads back.
     *
     * It is stored exactly as it was typed: nothing trims it, normalises it, folds its case
     * or holds it to one sentence. A user who wrote two sentences about their own checkout
     * wrote the sentence this field is for, and the `goal` below — which *is* held to one
     * sentence each, because a model wrote it — is what was made of it. The two sit side by
     * side so that a reader can see both the question and what was tested.
     *
     * Optional with no default: a run carrying none was started without one, which is every
     * run that exists today.
     */
    feature: name.optional(),
    /**
     * The goal this run ran, and who last wrote it (`docs/FLOW.md` section 12). Optional
     * with no default: a run carrying none recorded none, and a completion rate with no
     * stated criterion behind it is read as exactly that rather than as a criterion
     * somebody can reconstruct from the task.
     */
    goal: goalSchema.optional(),
    variants: z.array(variantSchema).min(1),
    steps: z.array(z.strictObject({ id: name, label: name })).min(1),
    /**
     * The sentence the Attention screen reads out under one variant's step. It is written
     * by the pipeline, not by the screen; a run that records none still parses.
     */
    stepCaptions: z.array(z.strictObject({ variant: name, step: name, caption: name })).default([]),
    /** Copied by value when the run started: see `audienceSchema`. */
    audience: audienceSchema,
    personas: z.array(personaSchema),
    seedGroups: z.array(z.int()),
    engine: z.strictObject({
      mode: engineModeSchema,
      /**
       * Which model this run called, recorded beside what it cost. Optional with no
       * default: absent means no model was used or none was recorded, and a mode nobody
       * chose is never guessed at. A screen and a cost reader take this field rather than
       * matching `models.decision` against a known id, so a new model id cannot quietly
       * break them.
       */
      modelMode: modelModeSchema.optional(),
      provider: name.nullable(),
      models: z.strictObject({ decision: name, segmentation: name, planning: name }).nullable(),
      weights: z.strictObject({ alpha: z.number(), beta: z.number(), gamma: z.number() }),
      version: name,
    }),
    /**
     * What it takes to run this run again, on the record beside what it produced (#78).
     *
     * Everything here is already true of the run somewhere else — the seeds are
     * `seedGroups`, the engine is `engine`, the devices are the people's — and it is
     * restated as one block on purpose: a reader looking at a committed artifact asks "how
     * do I get this directory back?", and the answer should be one object rather than six
     * fields and a ticket. The step rules are the only thing here that is nowhere else: a
     * run records the *steps* it walked, and not how a page is recognised as one.
     *
     * Optional, with no default: a run written before this block carries none, and an
     * absent block is a run that did not say how to reproduce itself rather than a claim
     * that it cannot be.
     */
    reproduce: z
      .strictObject({
        /** The one command that regenerates the directory in place. */
        command: name,
        /** The seed groups, restated so the block is the whole recipe. */
        seeds: z.array(z.int()),
        engineMode: engineModeSchema,
        engineVersion: name,
        /** Every device the run drove, once each, in the order the audience declares them. */
        devices: z.array(deviceSchema).min(1),
        /** How each step is recognised, and what advances it, as the task declared it. */
        steps: z
          .array(
            z.strictObject({
              id: name,
              label: name,
              urlPattern: name,
              requiredSelector: name,
              primaryActionSelector: name,
              /** What the person wants on that screen, where the task declares one. */
              goal: name.optional(),
            }),
          )
          .min(1),
      })
      .optional(),
    sessionIds: z.array(name),
    screenshots: z.array(
      z.strictObject({
        variant: name,
        step: name,
        /** Run-directory-relative, as `runPaths('').screenshot(variant, step)` spells it. */
        path: name,
        viewport: viewportSchema,
        pageHeight: pixels,
        foldY: pixels,
      }),
    ),
    aois: z.array(
      z.strictObject({
        id: name,
        variant: name,
        step: name,
        label: name,
        source: aoiSourceSchema,
        role: z.string().nullable(),
        bbox: z.strictObject({ x: coordinate, y: coordinate, width: pixels, height: pixels }),
        isPrimaryAction: z.boolean(),
        belowFold: z.boolean(),
      }),
    ),
    aoiMetrics: z.array(
      z.strictObject({
        aoiId: name,
        /** `null` when no fixation ever landed: a never-fixated area is a result, not a gap. */
        timeToFirstFixationMs: milliseconds.nullable(),
        firstFixationDurationMs: milliseconds.nullable(),
        totalDwellMs: milliseconds,
        fixationCount: count,
        revisits: count,
        lookedAtShare: unitInterval,
        sessionCount: count,
      }),
    ),
    scores: z.array(scoreSchema),
    verdict: verdictSchema,
    /**
     * The change this run tested, on a path-2 run. Optional with no default: every run
     * that exists today tested no change, and an absent block is a run that tested none
     * rather than a change that did nothing.
     */
    improve: improveSchema.optional(),
    calibration: z
      .strictObject({
        benchmark: z.literal('UEyes'),
        cc: z.number().nullable(),
        nss: z.number().nullable(),
        scanMatch: z.number().nullable(),
      })
      .nullable(),
  })
  .superRefine((run, ctx) => {
    const { audience } = run;

    // The personas are generated from the audience, so the audience's size is how many of
    // them there are and the audience's id is the one every one of them carries.
    if (run.personas.length !== audience.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['personas'],
        message: `the audience generates ${audience.size} ${audience.size === 1 ? 'person' : 'people'}, but this run carries ${run.personas.length}`,
      });
    }
    const generated = new Set<string>();
    run.personas.forEach((persona, index) => {
      if (persona.audienceId !== audience.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['personas', index, 'audienceId'],
          message: `"${persona.audienceId}" is not this run's audience "${audience.id}": a run's personas are generated from the audience it carries`,
        });
      }
      // A persona id addresses one simulated person on the Sessions screen and in every
      // session file, so two people cannot share one.
      if (generated.has(persona.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['personas', index, 'id'],
          message: `persona "${persona.id}" appears more than once: a persona id names one simulated person`,
        });
      }
      generated.add(persona.id);
    });

    // `completionRate` is stored so that no screen computes it, which only works while it
    // agrees with the outcome counts underneath it.
    run.scores.forEach((score, index) => {
      for (const issue of completionRateIssues(score, ['scores', index])) {
        ctx.addIssue({ code: 'custom', ...issue });
      }
      // The holdout's figures are a third completion rate printed beside these two, so
      // they are held to the holdout's own counts by the same arithmetic: a holdout figure
      // that disagreed with the people behind it would print beside two that do not.
      if (score.holdout !== undefined) {
        for (const issue of completionRateIssues(score.holdout, ['scores', index, 'holdout'])) {
          ctx.addIssue({ code: 'custom', ...issue });
        }
        // Figures for people who were never held out are a third figure about nobody, and
        // the Improve screen would print it beside two that are about somebody.
        if ((run.improve?.holdout.personaIds.length ?? 0) === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['scores', index, 'holdout'],
            message:
              "this score carries the holdout's own figures, but this run ran no holdout: a figure is recorded for the people behind it or not at all",
          });
        }
      }
    });

    // A run says where it got to once. A failed run says why, and a run that is not failed
    // has no failure to report — the Test failed screen is reached by the status, so the two
    // disagreeing would leave the viewer with a reason for a run that ran.
    if (run.status === 'failed' && run.failure === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message:
          'a run that failed records why it failed: the Test failed screen shows the reason and the captured detail',
      });
    }
    if (run.failure !== undefined && run.status !== 'failed') {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `this run carries a failure but its status is ${run.status === undefined ? 'absent' : `"${run.status}"`}: only a failed run has a failure`,
      });
    }
    // An open run has not stopped, so a finishing time would be a claim about a future.
    if (run.status === 'open' && run.finishedAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'a run whose status is open has not finished, so it records no finishedAt',
      });
    }
    if (run.finishedAt !== undefined) {
      if (run.startedAt === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['startedAt'],
          message: 'a run that records when it finished records when it started',
        });
      } else if (run.finishedAt < run.startedAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['finishedAt'],
          message: `this run finished at ${run.finishedAt}, before it started at ${run.startedAt}`,
        });
      }
    }

    const { progress } = run;
    if (progress !== undefined) {
      if (progress.finishedSessions > progress.totalSessions) {
        ctx.addIssue({
          code: 'custom',
          path: ['progress', 'finishedSessions'],
          message: `${progress.finishedSessions} finished of ${progress.totalSessions} planned: a run finishes no more sessions than it has`,
        });
      }
      // The count and the log are one claim: "17 of 24 finished" above seventeen lines.
      if (progress.sessions.length !== progress.finishedSessions) {
        ctx.addIssue({
          code: 'custom',
          path: ['progress', 'sessions'],
          message: `progress counts ${progress.finishedSessions} finished sessions but carries ${progress.sessions.length} of them`,
        });
      }
      const logged = new Set<string>();
      progress.sessions.forEach((entry, index) => {
        if (logged.has(entry.sessionId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['progress', 'sessions', index, 'sessionId'],
            message: `session "${entry.sessionId}" is recorded as finished more than once`,
          });
        }
        logged.add(entry.sessionId);
      });
      progress.perVariant.forEach((entry, index) => {
        if (entry.finishedSessions > entry.totalSessions) {
          ctx.addIssue({
            code: 'custom',
            path: ['progress', 'perVariant', index, 'finishedSessions'],
            message: `${entry.finishedSessions} finished of ${entry.totalSessions} planned on variant "${entry.variant}"`,
          });
        }
      });
      // The two bars are the one bar, split: the variants carry the whole swarm between
      // them, so a per-variant breakdown that does not add up to the total is wrong twice.
      if (progress.perVariant.length > 0) {
        for (const key of ['totalSessions', 'finishedSessions'] as const) {
          const split = progress.perVariant.reduce((total, entry) => total + entry[key], 0);
          if (split !== progress[key]) {
            ctx.addIssue({
              code: 'custom',
              path: ['progress', 'perVariant'],
              message: `the variants account for ${split} ${key} but the run records ${progress[key]}`,
            });
          }
        }
      }
      // "Nobody was simulated and no result was saved" is what the Test failed screen says,
      // so a failed run has no progress to show rather than a fabricated one.
      if (
        run.status === 'failed' &&
        (progress.finishedSessions > 0 || progress.sessions.length > 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['progress'],
          message: 'a run that failed to start simulated nobody: it records no finished sessions',
        });
      }
    }

    const { usage } = run;
    if (usage !== undefined) {
      if (usage.cachedInputTokens > usage.inputTokens) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage', 'cachedInputTokens'],
          message: `${usage.cachedInputTokens} cached of ${usage.inputTokens} input tokens: the cached tokens are part of the input tokens, not extra to them`,
        });
      }
      if (usage.reasoningTokens > usage.outputTokens) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage', 'reasoningTokens'],
          message: `${usage.reasoningTokens} reasoning of ${usage.outputTokens} output tokens: reasoning tokens are part of the output tokens, not extra to them`,
        });
      }
      // Zero calls and a non-zero bill is a writer that forgot to count one of the two.
      const spent = usage.inputTokens + usage.outputTokens > 0 || usage.estimatedCostUsd > 0;
      if (usage.calls === 0 && spent) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage', 'calls'],
          message:
            'this run records tokens or a cost but no model calls: one of the two was not counted',
        });
      }
      // The offline provider costs nothing, and a run's mode is never silently upgraded, so
      // an offline run billing for calls is a mode that was recorded wrongly.
      if (run.engine.mode === 'offline' && usage.calls > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['usage', 'calls'],
          message: `this run ran the offline deterministic engine, which makes no model calls, but records ${usage.calls}`,
        });
      }
    }

    // Which model ran is part of a run's record: a cost figure cannot be checked without
    // the price table that produced it, and a customer could not otherwise tell whether
    // their content went to the model that may be trained on it. So a run that called a
    // model says which one and names the ids it called, and an offline run — which paid for
    // nothing and sent nothing anywhere — carries neither.
    const { engine } = run;
    if (engine.mode === 'model') {
      if (engine.modelMode === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['engine', 'modelMode'],
          message: `this run called a model, so it records which one it called: ${modelModeSchema.options.join(' or ')}`,
        });
      }
      if (engine.models === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['engine', 'models'],
          message: 'this run called a model, so it records the model ids it called',
        });
      }
    } else if (engine.mode === 'offline') {
      if (engine.modelMode !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['engine', 'modelMode'],
          message: `this run ran the offline deterministic engine, which calls no model, but records the "${engine.modelMode}" model mode`,
        });
      }
      if (engine.models !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['engine', 'models'],
          message:
            'this run ran the offline deterministic engine, which calls no model, but names the model ids it called',
        });
      }
    }

    // The headline findings are a ranked three at most, so naming one twice spends a place
    // the Verdict screen has only three of.
    const named = new Set<string>();
    run.verdict.headlineFindingIds.forEach((findingId, index) => {
      if (named.has(findingId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict', 'headlineFindingIds', index],
          message: `finding "${findingId}" is named more than once`,
        });
      }
      named.add(findingId);
    });

    // Path 2's block. It is absent on every run that exists today; what is held when it is
    // present is that a change which was tested cannot be recorded without the people it
    // was tested against and the verdict on them.
    const { improve } = run;
    const verdictHoldout = run.verdict.holdout;
    if (improve === undefined) {
      if (verdictHoldout !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict', 'holdout'],
          message:
            'this run tested no change, so it ran no holdout for its verdict to report on: a holdout verdict belongs to a run that carries an improve block',
        });
      }
    } else {
      const declared = new Set(run.variants.map((variant) => variant.id));
      for (const side of ['baselineVariant', 'changeVariant'] as const) {
        if (!declared.has(improve[side])) {
          ctx.addIssue({
            code: 'custom',
            path: ['improve', side],
            message: `"${improve[side]}" is not one of this run's variants (${run.variants.map((variant) => variant.id).join(', ')})`,
          });
        }
      }
      // The before and the after are two versions. One id on both sides would print the
      // same completion rate twice, and a gain of nothing would read as a change that did
      // nothing rather than as a writer that recorded one version.
      if (improve.baselineVariant === improve.changeVariant) {
        ctx.addIssue({
          code: 'custom',
          path: ['improve', 'changeVariant'],
          message: `the baseline and the change are both "${improve.changeVariant}": a before and after of one version is not a comparison`,
        });
      }
      const { holdout } = improve;
      // A holdout that names people the run never generated is not a holdout: the Improve
      // screen reads the holdout's figures as that set's, and a name nobody was is a
      // figure about nobody.
      const unknown = holdout.personaIds.findIndex((personaId) => !generated.has(personaId));
      if (unknown !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: ['improve', 'holdout', 'personaIds', unknown],
          message: `"${holdout.personaIds[unknown]}" is not one of this run's ${run.personas.length} personas: a holdout is people the run generated`,
        });
      }
      // The ids are how many people the holdout is, so naming one twice makes the holdout
      // bigger than the people in it — the rule `personas` is held to above.
      const held = new Set<string>();
      holdout.personaIds.forEach((personaId, index) => {
        if (held.has(personaId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['improve', 'holdout', 'personaIds', index],
            message: `persona "${personaId}" is held out more than once: the ids are how many people the holdout is`,
          });
        }
        held.add(personaId);
      });
      // "Nobody was simulated and no result was saved": a run that never started held
      // nobody out either, so the Test failed screen's run cannot carry a confirmation.
      if (run.status === 'failed' && holdout.personaIds.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['improve', 'holdout', 'personaIds'],
          message: `this run failed to start, so it simulated nobody, but it records a holdout of ${holdout.personaIds.length}`,
        });
      }
      // "A change that wins on the original seeds and not on the holdout is reported as
      // not confirmed, and says so in the sentence" — which is only renderable from data.
      // So a run that ran a holdout records whether it held, in both places, and the two
      // cannot say different things.
      const ran = holdout.personaIds.length > 0;
      if (ran && holdout.confirmed === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['improve', 'holdout', 'confirmed'],
          message: `this run ran a holdout of ${holdout.personaIds.length} ${holdout.personaIds.length === 1 ? 'person' : 'people'}, so it records whether the holdout confirmed the gain`,
        });
      }
      if (!ran && holdout.confirmed !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['improve', 'holdout', 'confirmed'],
          message: `this holdout names nobody, so nothing confirmed or failed to confirm the gain, but it records ${holdout.confirmed}`,
        });
      }
      const recorded = holdoutVerdictOf(holdout.confirmed);
      if (verdictHoldout === undefined) {
        if (ran) {
          ctx.addIssue({
            code: 'custom',
            path: ['verdict', 'holdout'],
            message: `this run ran a holdout, so its verdict says whether it was confirmed: ${holdoutVerdictSchema.options.join(', ')}`,
          });
        }
      } else if (verdictHoldout !== recorded) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict', 'holdout'],
          message: `the verdict reports the holdout as "${verdictHoldout}" but the run records it as "${recorded}": the notice and the record are one claim`,
        });
      }
    }
  });

/**
 * Which cap stopped a recording. The caps are the owner's decision on #220 — **30 seconds
 * a screen and 10 minutes a session** — and they are an enumeration rather than a number
 * the recorder writes, because two recordings truncated at two figures of their own could
 * not be compared and one stuck session could still fill a disk.
 */
export const videoCapSchema = z.enum(['screen', 'session']);

/**
 * What each cap is, in milliseconds. This is the only place the two figures are written: a
 * recorder enforces them from here and a screen that prints *"truncated at 10:00"* reads
 * them from here.
 */
export const VIDEO_CAP_MS: Readonly<Record<z.infer<typeof videoCapSchema>, number>> = {
  screen: 30_000,
  session: 600_000,
};

/**
 * The one spelling of a session's video (`docs/FLOW.md` section 16): the recording, or the
 * stated absence of one. It is a discriminated union because the two are alternatives and
 * not one shape with holes in it — an absent recording has no duration to record, and a
 * duration of zero would read as something somebody measured.
 *
 * **Offsets are positional.** `screenOffsetsMs[i]` is where `screens[i]` begins in the
 * recording and `actionOffsetsMs[i]` is where `actions[i]` happens in it, which is what
 * lets a recommendation citing `S-62 · 0:48` open on the frame it means without replaying
 * anything. `sessionSchema` holds the two lists to the length of the arrays they index.
 *
 * **An entry past the cap has no offset.** A session that hit a cap kept going after the
 * recording stopped, so its later screens and actions are in the session and not in the
 * video: their offset is `null`. Clamping them to the last frame would cite a frame showing
 * something else, and leaving them out would misalign every entry after them. Only a
 * truncated recording may carry one.
 *
 * **The duration is recorded once.** A truncated recording names the cap it hit and nothing
 * else; `durationMs` is the duration it reached. The contract does not compare the two,
 * because a recorder stops the browser at the cap and reports the duration the file on disk
 * actually has, which lands near a cap rather than on it — a contract that compared them
 * would reject a correct recording.
 */
export const sessionVideoSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    /** Run-directory-relative, as `runPaths('').video(sessionId)` spells it. */
    path: name,
    /** The length of the recording itself, not of the session that produced it. */
    durationMs: milliseconds,
    /**
     * The cap that stopped the recording, or `null` for one that ended on its own. A
     * truncated video is a stated fact, never a silently short one.
     */
    truncated: videoCapSchema.nullable(),
    /**
     * One offset per entry of the session's own `screens`, in that order. `null` is a
     * screen the recording does not reach, which only a truncated recording has.
     */
    screenOffsetsMs: z.array(milliseconds.nullable()),
    /**
     * One offset per entry of the session's own `actions`, in that order. `null` is an
     * action the recording does not reach, which only a truncated recording has.
     */
    actionOffsetsMs: z.array(milliseconds.nullable()),
  }),
  z.strictObject({
    state: z.literal('absent'),
    /**
     * Why there is no recording, in the recorder's own words — it is printed, never parsed.
     * A session whose recording failed is otherwise complete and still scored: a broken
     * recording does not lose a person's whole attempt.
     */
    reason: z
      .string()
      .min(1, 'a session that recorded no video records why, in words: this reason is blank'),
  }),
]);

/** One shape for a simulated and a real session, told apart by `kind`. */
export const sessionSchema = z
  .strictObject({
    schemaVersion,
    sessionId,
    runId: name,
    variant: name,
    taskId: name,
    kind: z.enum(['simulated', 'real']),
    persona: z
      .strictObject({ id: name, traits: personaTraitsSchema, device: deviceSchema })
      .nullable(),
    participant: z.strictObject({ id: name }).nullable(),
    seed: z.int().nullable(),
    startedAt: timestamp,
    durationMs: milliseconds,
    screens: z.array(
      z.strictObject({
        index: count,
        step: name,
        screenshot: name,
        scrollY: pixels,
        intent: z.string(),
        decidedAction: z.string(),
      }),
    ),
    fixations: z.array(
      z.strictObject({
        index: count,
        screenIndex: count,
        tMs: milliseconds,
        durationMs: milliseconds,
        x: pixels,
        y: pixels,
        pageX: pixels,
        pageY: pixels,
        aoiId: name.nullable(),
      }),
    ),
    saccades: z.array(
      z.strictObject({
        fromFixation: count,
        toFixation: count,
        amplitudePx: pixels,
        durationMs: milliseconds,
      }),
    ),
    actions: z.array(
      z.strictObject({
        tMs: milliseconds,
        type: z.enum(['click', 'scroll', 'type', 'back', 'hesitate', 'abandon']),
        target: z.string().nullable(),
        aoiId: name.nullable(),
        value: z.string().nullable(),
        ok: z.boolean(),
      }),
    ),
    outcome: z.strictObject({
      status: outcomeStatusSchema,
      step: name,
      reason: z.string(),
      attribution: attributionSchema,
      /** Derived once, in the pipeline, and stored: no screen re-derives it. */
      excludedFromScores: z.boolean(),
    }),
    integrity: z.strictObject({ selectorFailures: count, retries: count }),
    /**
     * The session's recording. **Optional with no default**: a session recorded before
     * session video existed names none, and that is a session that recorded none rather
     * than one that lost one or one somebody measured as zero.
     */
    video: sessionVideoSchema.optional(),
  })
  .superRefine((session, ctx) => {
    // `index` is the ordering key and runs continuously across the whole session, not
    // restarted per screen, so an index is its entry's position in the array. Every index
    // that points at another list has to land inside it, or a replay reads past the end.
    session.screens.forEach((screen, position) => {
      if (screen.index !== position) {
        ctx.addIssue({
          code: 'custom',
          path: ['screens', position, 'index'],
          message: `screen index runs 0, 1, 2 … in array order: expected ${position}, found ${screen.index}`,
        });
      }
    });
    session.fixations.forEach((fixation, position) => {
      if (fixation.index !== position) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixations', position, 'index'],
          message: `fixation index runs 0, 1, 2 … continuously across the session, in array order: expected ${position}, found ${fixation.index}`,
        });
      }
      if (fixation.screenIndex >= session.screens.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixations', position, 'screenIndex'],
          message: `screenIndex ${fixation.screenIndex} is past the session's ${session.screens.length} screens`,
        });
      }
    });
    session.saccades.forEach((saccade, position) => {
      for (const end of ['fromFixation', 'toFixation'] as const) {
        if (saccade[end] >= session.fixations.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['saccades', position, end],
            message: `${end} ${saccade[end]} is past the session's ${session.fixations.length} fixations`,
          });
        }
      }
    });
    // The video's offsets are positional: the fourth entry of the screen offsets is where
    // `screens[3]` begins. A list of the wrong length is therefore a misalignment of every
    // entry after the first difference, which nobody would notice from the data, so it is a
    // parse error here rather than a replay that opens on the wrong frame.
    const { video } = session;
    if (video !== undefined && video.state === 'recorded') {
      // The path is produced by the paths module and re-derived nowhere, so the only
      // recording a session can name is its own. A session JSON carrying another session's
      // path would play another participant under this one's label, and nothing else in the
      // artifact would contradict it.
      const own = runPaths('').video(session.sessionId);
      if (video.path !== own) {
        ctx.addIssue({
          code: 'custom',
          path: ['video', 'path'],
          message: `"${video.path}" is not this session's recording: ${session.sessionId}'s video is "${own}", as the paths module spells it`,
        });
      }
      const aligned = [
        {
          field: 'screenOffsetsMs',
          offsets: video.screenOffsetsMs,
          indexes: 'screens',
          length: session.screens.length,
        },
        {
          field: 'actionOffsetsMs',
          offsets: video.actionOffsetsMs,
          indexes: 'actions',
          length: session.actions.length,
        },
      ] as const;
      for (const { field, offsets, indexes, length } of aligned) {
        if (offsets.length !== length) {
          ctx.addIssue({
            code: 'custom',
            path: ['video', field],
            message: `${offsets.length} offsets for ${length} ${length === 1 ? indexes.slice(0, -1) : indexes}: an offset is the position of its own entry of \`${indexes}\` in the recording, so the two lists are the same length`,
          });
          // Reporting a position of a list that is already the wrong length would name a
          // screen or an action that the offset was never about.
          continue;
        }
        offsets.forEach((offsetMs, position) => {
          if (offsetMs === null) {
            // A recording that ended on its own reaches everything the session did, so
            // there is nothing it could fail to have a frame of.
            if (video.truncated === null) {
              ctx.addIssue({
                code: 'custom',
                path: ['video', field, position],
                message: `this recording was not truncated, so it reaches every entry of \`${indexes}\`: an offset of null is one the recording stopped before`,
              });
            }
            return;
          }
          if (offsetMs > video.durationMs) {
            ctx.addIssue({
              code: 'custom',
              path: ['video', field, position],
              message: `offset ${offsetMs} ms is past the end of a ${video.durationMs} ms recording: a cited timestamp has to land inside the video it cites, and an entry the recording stopped before has no offset at all`,
            });
          }
        });
      }
    }
  });

/**
 * The query parameters an `evidence_link` may carry. The key space is closed like every
 * other object in the artifact: a link cannot carry a parameter the screens have no use
 * for, and so cannot carry a credential under a name of its own invention.
 *
 * **It is closed, and it grows only here**, and only with a parameter `docs/FLOW.md`
 * section 16 names. That section's four are `segment` — the filter the Sessions, Heatmaps
 * and Funnel screens share — `step`, which was already here, `overlay`, which chooses one
 * of the Heatmaps screen's three, and `t`, the video-millisecond offset a citation opens a
 * replay paused on. A link a screen cannot build is a citation rendered as prose, which is
 * what section 14 forbids.
 *
 * `fix` is **not** here. The Session replay route carries it in sections 3 and 14, but
 * section 16's enumeration leaves it out and no `evidence_link` can name the replay today:
 * `findingsSchema`'s `screen` is `attention` or `sessions`. Whoever adds the replay as a
 * link target decides then whether `fix` joins this list.
 */
export const EVIDENCE_LINK_PARAMS = [
  'variant',
  'step',
  'aoi',
  'outcome',
  'segment',
  'overlay',
  't',
] as const;

export const findingsSchema = z
  .strictObject({
    schemaVersion,
    runId: name,
    findings: z.array(
      z.strictObject({
        id: name,
        rank: z.int().positive(),
        severity: severitySchema,
        claim: name,
        evidence: name,
        /** `null` when the finding concerns the run itself rather than one variant. */
        variant: name.nullable(),
        step: name,
        aoiId: name.nullable(),
        sessionIds: z.array(name),
        sessionCount: count,
        attribution: attributionSchema,
        evidence_link: z.strictObject({
          screen: z.enum(['attention', 'sessions']),
          params: z.record(z.string(), z.string()),
        }),
      }),
    ),
  })
  .superRefine((findings, ctx) => {
    findings.findings.forEach((finding, index) => {
      for (const key of Object.keys(finding.evidence_link.params)) {
        if (!(EVIDENCE_LINK_PARAMS as readonly string[]).includes(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['findings', index, 'evidence_link', 'params', key],
            message: `"${key}" is not a parameter the evidence screens take (${EVIDENCE_LINK_PARAMS.join(', ')})`,
          });
        }
      }
    });
  });

/**
 * The three things a recommendation may cite, from `docs/FLOW.md` section 14. A citation is
 * **structured and never prose**: the screens build the deep link — `?t=`, the heatmap
 * route, the funnel anchor — out of these fields, and the model never writes a URL. The
 * set is closed and discriminated by `kind`, so an unknown kind is reported at its own
 * path instead of being read as one of the others.
 */
const citationSchema = z.discriminatedUnion('kind', [
  /** A moment in one session's recording: a link carrying it opens the replay on that frame. */
  z.strictObject({ kind: z.literal('session'), sessionId, offsetMs: milliseconds }),
  /**
   * A heatmap region, addressed as the verdict's hero evidence is: `aoiId` is `null` when
   * the whole step is the region rather than one area on it.
   */
  z.strictObject({ kind: z.literal('heatmap'), variant: name, step: name, aoiId: name.nullable() }),
  /** One step of the funnel, as the Funnel and timing screen anchors it. */
  z.strictObject({ kind: z.literal('funnel'), stepId: name }),
]);

const AT_LEAST_ONE_CITATION =
  'a claim carries its evidence as citations: one with nothing to cite is not published (docs/FLOW.md section 14)';

/**
 * How much of the run Muse Wonder read before writing any of this — what the Analysis
 * screen prints as *"Read 20 of 93 sessions"*. These four field names are shared with the
 * sampling ticket of the same step, named in both places so the two cannot drift.
 */
const sampleProvenanceSchema = z.strictObject({
  /** How many whole sessions were read in detail. */
  read: count,
  /** How many the run holds: the aggregate covers all of them, the sample is read. */
  of: count,
  /** How the sample was drawn, in the sampler's own words — it is printed, never parsed. */
  strategy: name,
  /** The seed it was drawn with, so the same run yields the same sample. */
  seed: z.int(),
});

/**
 * One claim of the write-up the Analysis screen renders: a heading, its body and the
 * citations it rests on. The generator writes the closing *"What I did not find"* claim as
 * the last of them; what the schema holds every claim to is having something to cite.
 */
const writeUpClaimSchema = z.strictObject({
  heading: name,
  body: name,
  citations: z.array(citationSchema).min(1, AT_LEAST_ONE_CITATION),
});

/**
 * One thing to change. A finding states what happened and a recommendation states what to
 * do about it, so it names the findings it rests on (`docs/FLOW.md` section 14).
 */
const recommendationSchema = z.strictObject({
  id: name,
  /** 1, 2, 3 … The pipeline ranks and stores it; the screen renders the order it finds. */
  rank: z.int().positive(),
  /** What to change, in one sentence a site owner could act on. */
  sentence: oneSentence('a recommendation'),
  /** Why — the sentence the Summary prints under it. */
  evidence: name,
  findingIds: z
    .array(name)
    .min(
      1,
      'a recommendation names the findings it rests on: a claim and the evidence behind it cannot drift apart',
    ),
  citations: z.array(citationSchema).min(1, AT_LEAST_ONE_CITATION),
  /** The first of the two keys the ranking is stored from: how many people it would reach. */
  peopleAffected: count,
  /** The second: the funnel step it sits on, so a tie is broken by how far through it is. */
  step: name,
});

/**
 * `recommendations.json` — what Muse Wonder says to change, ranked, each one citing its
 * evidence (`docs/FLOW.md` sections 14 and 16). **Optional** in a run directory: a run
 * without the file produced no recommendation, which is not a zero somebody measured.
 */
export const recommendationsSchema = z
  .strictObject({
    schemaVersion,
    runId: name,
    sample: sampleProvenanceSchema,
    recommendations: z.array(recommendationSchema),
    /** The full write-up, generated from the recommendations above and never from prose. */
    writeUp: z
      .array(writeUpClaimSchema)
      .min(1, 'a write-up with no claim in it is no write-up: leave it out instead')
      .optional(),
    /**
     * Why a run recommends nothing, in one stored sentence: the Summary states it in words
     * rather than showing an empty section.
     */
    nothingToRecommend: oneSentence('the reason a run recommends nothing').optional(),
  })
  .superRefine((document, ctx) => {
    // `rank` is the stored order, so it is asserted the way a session's indexes are: an
    // entry's rank is its position, and a gap or a repeat is a different list.
    document.recommendations.forEach((recommendation, position) => {
      const rank = position + 1;
      if (recommendation.rank !== rank) {
        ctx.addIssue({
          code: 'custom',
          path: ['recommendations', position, 'rank'],
          message: `rank runs 1, 2, 3 … in array order, with no gap and no repeat: expected ${rank}, found ${recommendation.rank}`,
        });
      }
    });
    if (document.recommendations.length > 0 && document.nothingToRecommend !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['nothingToRecommend'],
        message: `a run either recommends something or says why it could not: this carries ${document.recommendations.length} recommendation${document.recommendations.length === 1 ? '' : 's'} as well as a reason there are none`,
      });
    }
    if (document.sample.read > document.sample.of) {
      ctx.addIssue({
        code: 'custom',
        path: ['sample', 'read'],
        message: `the sample read ${document.sample.read} of ${document.sample.of} sessions: a sample is never larger than the run it was drawn from`,
      });
    }
  });

/**
 * The arguments a new run is started with. The CLI's `run` command and the web app's
 * New run form submit this same shape, so it is declared here once.
 */
export const runRequestSchema = z
  .strictObject({
    task: z.strictObject({ prompt: name }),
    variants: z.array(variantSchema).min(1),
    /**
     * The audience the test is for, by id — the platform resolves it and the pipeline copies
     * it into `run.json` by value as the test starts. There is no subset of personas to
     * name: the personas are generated from the audience, and a run carries `audience.size`
     * of them.
     */
    audienceId: name,
    /**
     * The feature the test is about, in the user's words, and the goal a model wrote from
     * it: between them, what makes **one URL** a test rather than a comparison of two
     * (`docs/FLOW.md` section 11). `variants` above is unchanged and still allows one — a
     * one-URL request is a request with one variant, not a second kind of request, and
     * nothing here forks on a "path".
     *
     * Both optional with no default: today's two-variant request carries neither and is
     * accepted exactly as it was, and a caller that resolves a goal after the request was
     * made has nothing to put here yet.
     */
    feature: name.optional(),
    /** The goal, in the words the user approved on the screen before launch. */
    goal: goalSchema.optional(),
    /** Sessions per persona per variant. */
    repeats: z.int().positive(),
    seed: z.int(),
    engineMode: engineModeSchema,
    /**
     * Which model to run it on. Optional, and with no default here: the CLI defaults it to
     * `contributor` and the platform resolves it from the workspace, because a default
     * belongs where the caller is known. A request for `model` mode that names no model is
     * invalid rather than resolved to the cheap one — a paying customer's run is never
     * quietly downgraded. An `offline` request may carry one and simply not spend it, which
     * is what the CLI's own defaults ask for.
     */
    modelMode: modelModeSchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (request.engineMode === 'model' && request.modelMode === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelMode'],
        message: `a run on a model names the model it is to run on: ${modelModeSchema.options.join(' or ')}`,
      });
    }
  });

export type ModelMode = z.infer<typeof modelModeSchema>;
export type Audience = z.infer<typeof audienceSchema>;
export type AudienceDevice = z.infer<typeof audienceDeviceSchema>;
export type AgeGroup = z.infer<typeof ageGroupSchema>;
export type AudienceAgeGroup = z.infer<typeof audienceAgeGroupSchema>;
export type Gender = z.infer<typeof genderSchema>;
export type GenderSplit = z.infer<typeof genderSplitSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type GoalAuthor = z.infer<typeof goalAuthorSchema>;
export type Change = z.infer<typeof changeSchema>;
export type EvidenceLinkParam = (typeof EVIDENCE_LINK_PARAMS)[number];
export type Persona = z.infer<typeof personaSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Score = z.infer<typeof scoreSchema>;
export type HoldoutFigures = z.infer<typeof holdoutFiguresSchema>;
export type HoldoutVerdict = z.infer<typeof holdoutVerdictSchema>;
export type Improve = z.infer<typeof improveSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type Preview = z.infer<typeof previewSchema>;
export type Holdout = z.infer<typeof holdoutSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunProgress = z.infer<typeof runProgressSchema>;
export type SessionProgress = z.infer<typeof sessionProgressSchema>;
export type VariantProgress = z.infer<typeof variantProgressSchema>;
export type RunFailure = z.infer<typeof runFailureSchema>;
export type RunUsage = z.infer<typeof runUsageSchema>;

/**
 * A run that made no model calls: the offline deterministic engine's whole bill, and what
 * a run's totals start at, so that zero is recorded rather than left unknown.
 */
export const ZERO_USAGE: RunUsage = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: 0,
};

/**
 * The share of a run's sessions that may be **our own** automation failures before the run
 * stops being a measurement of the site. Above it — more than a fifth — a run says so above
 * its own summary, because at that point the aggregate is about our harness and not about
 * the site (`docs/FLOW.md` section 11); the line itself is the results screen's to render.
 *
 * The fraction is declared here and restated nowhere: a reader comparing that line with the
 * counts printed beside it is comparing them against one number.
 */
export const AUTOMATION_FAILURE_NOTICE_SHARE = 1 / 5;

/**
 * Whether that notice is due on a run, **derived** from the progress counters the run
 * already carries. It is deliberately not a stored field: a stored boolean can disagree
 * with the counts printed next to it, and a reader who sees "4 of 24" above a notice that
 * says otherwise has been told two different things about one run.
 *
 * The numerator is the finished sessions whose outcome *was* an automation failure:
 * `attribution` says whose a failure was and the status says what it was, so the status is
 * what is counted — a session the **site** failed is the result the run was run for, and
 * excluding it would be the harness claiming the site's own failures. The denominator is
 * `finishedSessions`, which `runSchema` holds equal to the number of entries beneath it, so
 * this is a share of the sessions that produced an outcome and not of a plan that may still
 * be running.
 *
 * A run with no progress block, or one that has finished nothing, is `false`: there is no
 * share of nothing to report. The comparison is strict, because the rule is *more than* a
 * fifth — a run sitting exactly on the share has not crossed it.
 */
export const automationFailureNoticeIsDue = (progress: RunProgress | undefined): boolean => {
  if (progress === undefined || progress.finishedSessions === 0) return false;
  const ours = progress.sessions.filter((entry) => entry.status === 'automation_failure').length;
  return ours / progress.finishedSessions > AUTOMATION_FAILURE_NOTICE_SHARE;
};

export type Session = z.infer<typeof sessionSchema>;
export type SessionVideo = z.infer<typeof sessionVideoSchema>;
export type VideoCap = z.infer<typeof videoCapSchema>;
export type Findings = z.infer<typeof findingsSchema>;
export type Recommendations = z.infer<typeof recommendationsSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type WriteUpClaim = z.infer<typeof writeUpClaimSchema>;
export type SampleProvenance = z.infer<typeof sampleProvenanceSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
