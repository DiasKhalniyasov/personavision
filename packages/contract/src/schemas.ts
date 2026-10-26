import { z } from 'zod';

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
 * The audience a test was run for, as it was **when the test started** — copied into the
 * artifact by value, never referenced, so that editing the stored audience later cannot
 * restate a finished test. `docs/FLOW.md` section 1 declares the shape; the platform and
 * the persona generator both import this one rather than restating it.
 */
export const audienceSchema = z.strictObject({
  id: name,
  name,
  ageRange: z.strictObject({ min: z.int().min(0), max: z.int().min(0) }),
  roles: z.array(name),
  regions: z.array(name),
  goals: z.array(name),
  devices: z.array(audienceDeviceSchema).min(1),
  techSavviness: unitInterval,
  priceSensitivity: unitInterval,
  /** How many simulated people the audience generates, and so how many personas a run has. */
  size: z.int().positive(),
  generatedFrom: z.strictObject({ seed: z.int(), generatorVersion: name }),
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
});

const variantSchema = z.strictObject({ id: name, name, url: z.url() });

const taskSchema = z.strictObject({ id: name, prompt: name });

const engineModeSchema = z.enum(['offline', 'model']);

/** How an area of interest was found: the DOM, the accessibility tree, or segmentation. */
const aoiSourceSchema = z.enum(['dom', 'a11y', 'sam']);

/** `docs/FLOW.md` section 8: *abandoned*, *failed* and *automation failure* are never merged. */
const outcomeStatusSchema = z.enum(['success', 'abandoned', 'failed', 'automation_failure']);

const attributionSchema = z.enum(['product', 'automation']);

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const frictionScoreSchema = z.strictObject({ median: points, sd: z.number().min(0) });

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
  outcomeCounts: z.strictObject({
    success: count,
    abandoned: count,
    failed: count,
    automationFailure: count,
  }),
  scoredSessionCount: count,
  perSeedGroup: z.array(z.strictObject({ seed: z.int(), frictionScore: points })),
});

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
});

/** `devices[].share` is a distribution, so the mix has to add up to one whole audience. */
const SHARE_TOLERANCE = 1e-6;

/**
 * How far a stored `completionRate` may sit from the counts it summarises: two decimal
 * places. A rate written as `0.82` for 9 of 11 sessions is that number rounded, not a
 * different claim; anything further apart is a disagreement and is reported as one.
 */
const COMPLETION_TOLERANCE = 0.005;

export const runSchema = z
  .strictObject({
    schemaVersion,
    runId: name,
    createdAt: timestamp,
    task: taskSchema,
    variants: z.array(variantSchema).min(1),
    steps: z.array(z.strictObject({ id: name, label: name })).min(1),
    /** Copied by value when the run started: see `audienceSchema`. */
    audience: audienceSchema,
    personas: z.array(personaSchema),
    seedGroups: z.array(z.int()),
    engine: z.strictObject({
      mode: engineModeSchema,
      provider: name.nullable(),
      models: z.strictObject({ decision: name, segmentation: name, planning: name }).nullable(),
      weights: z.strictObject({ alpha: z.number(), beta: z.number(), gamma: z.number() }),
      version: name,
    }),
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

    // The device mix is a distribution over one audience, so its shares add up to one.
    const shareTotal = audience.devices.reduce((total, device) => total + device.share, 0);
    if (Math.abs(shareTotal - 1) > SHARE_TOLERANCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['audience', 'devices'],
        message: `the device mix is a distribution: the shares must sum to 1 (±${SHARE_TOLERANCE}), and these sum to ${shareTotal}`,
      });
    }

    if (audience.ageRange.min > audience.ageRange.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['audience', 'ageRange'],
        message: `an age range runs from min to max: found ${audience.ageRange.min}–${audience.ageRange.max}`,
      });
    }

    // The personas are generated from the audience, so the audience's size is how many of
    // them there are and the audience's id is the one every one of them carries.
    if (run.personas.length !== audience.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['personas'],
        message: `the audience generates ${audience.size} ${audience.size === 1 ? 'person' : 'people'}, but this run carries ${run.personas.length}`,
      });
    }
    run.personas.forEach((persona, index) => {
      if (persona.audienceId !== audience.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['personas', index, 'audienceId'],
          message: `"${persona.audienceId}" is not this run's audience "${audience.id}": a run's personas are generated from the audience it carries`,
        });
      }
    });

    // `completionRate` is stored so that no screen computes it, which only works while it
    // agrees with the outcome counts underneath it.
    run.scores.forEach((score, index) => {
      const { success } = score.outcomeCounts;
      const expected = score.scoredSessionCount === 0 ? 0 : success / score.scoredSessionCount;
      if (Math.abs(score.completionRate - expected) > COMPLETION_TOLERANCE) {
        ctx.addIssue({
          code: 'custom',
          path: ['scores', index, 'completionRate'],
          message:
            score.scoredSessionCount === 0
              ? `no session was scored, so the completion rate is 0, not ${score.completionRate}`
              : `completionRate ${score.completionRate} disagrees with ${success} of ${score.scoredSessionCount} scored sessions (${expected})`,
        });
      }
    });

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
  });

/** One shape for a simulated and a real session, told apart by `kind`. */
export const sessionSchema = z
  .strictObject({
    schemaVersion,
    sessionId: z.string().regex(/^S-\d{2,}$/, 'a session id is S-01, S-02 … S-NN'),
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
  });

export const findingsSchema = z.strictObject({
  schemaVersion,
  runId: name,
  findings: z.array(
    z.strictObject({
      id: name,
      rank: z.int().positive(),
      severity: severitySchema,
      claim: name,
      evidence: name,
      variant: name,
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
});

/**
 * The arguments a new run is started with. The CLI's `run` command and the web app's
 * New run form submit this same shape, so it is declared here once.
 */
export const runRequestSchema = z.strictObject({
  task: z.strictObject({ prompt: name }),
  variants: z.array(variantSchema).min(1),
  personaIds: z.array(name).min(1),
  /** Sessions per persona per variant. */
  repeats: z.int().positive(),
  seed: z.int(),
  engineMode: engineModeSchema,
});

export type Audience = z.infer<typeof audienceSchema>;
export type AudienceDevice = z.infer<typeof audienceDeviceSchema>;
export type Persona = z.infer<typeof personaSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Score = z.infer<typeof scoreSchema>;
export type Run = z.infer<typeof runSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Findings = z.infer<typeof findingsSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
