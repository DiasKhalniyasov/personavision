import { z } from 'zod';

/**
 * The run artifact, as zod schemas.
 *
 * The field names come from the step spec and are binding: a later step that needs a new
 * field adds it here and says so on the step issue, rather than writing a sibling file.
 * What this module owns is the refinements — the ranges, the enumerations and the messages.
 */

/** Every artifact file carries this. A file without it is rejected rather than guessed at. */
const schemaVersion = z.literal(1);

const name = z.string().min(1);
/** 0..1, inclusive — traits, score components and shares all live on this scale. */
const unitInterval = z.number().min(0).max(1);
/** The friction score and its medians are points out of 100, not a share. */
const points = z.number().min(0).max(100);
const count = z.int().min(0);
const milliseconds = z.number().min(0);
const seconds = z.number().min(0);
/** A page or viewport coordinate. Negative is meaningless on a rendered page. */
const pixels = z.number().min(0);
/** Timestamps are ISO 8601; an offset is accepted so an imported real session keeps its own. */
const timestamp = z.iso.datetime({ offset: true });

const viewportSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
});

const deviceSchema = z.object({
  name,
  viewport: viewportSchema,
  deviceScaleFactor: z.number().positive(),
  touch: z.boolean(),
});

/** Each trait is 0..1; the persona generator samples them and the policy reads them. */
const personaTraitsSchema = z.object({
  persistence: unitInterval,
  scanningVsReading: unitInterval,
  detailOrientation: unitInterval,
  interfaceFamiliarity: unitInterval,
  patience: unitInterval,
  riskTolerance: unitInterval,
});

const variantSchema = z.object({ id: name, name, url: z.url() });

const taskSchema = z.object({ id: name, prompt: name });

const engineModeSchema = z.enum(['offline', 'model']);

/** How an area of interest was found: the DOM, the accessibility tree, or segmentation. */
const aoiSourceSchema = z.enum(['dom', 'a11y', 'sam']);

/** `docs/FLOW.md` section 8: *abandoned*, *failed* and *automation failure* are never merged. */
const outcomeStatusSchema = z.enum(['success', 'abandoned', 'failed', 'automation_failure']);

const attributionSchema = z.enum(['product', 'automation']);

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const frictionScoreSchema = z.object({ median: points, sd: z.number().min(0) });

const scoreSchema = z.object({
  variant: name,
  taskId: name,
  frictionScore: frictionScoreSchema,
  /** Each component is 0..1; the weights that combine them live in `@personavision/scoring`. */
  components: z.object({
    taskFailureRate: unitInterval,
    abandonment: unitInterval,
    timeToFirstFixationPrimary: z.object({
      worstStep: name,
      /** `null` when no session ever fixated the primary action on the worst step. */
      medianSeconds: seconds.nullable(),
      value: unitInterval,
    }),
    deadEndRevisits: unitInterval,
  }),
  outcomeCounts: z.object({
    success: count,
    abandoned: count,
    failed: count,
    automationFailure: count,
  }),
  scoredSessionCount: count,
  perSeedGroup: z.array(z.object({ seed: z.int(), frictionScore: points })),
});

export const runSchema = z.object({
  schemaVersion,
  runId: name,
  createdAt: timestamp,
  task: taskSchema,
  variants: z.array(variantSchema).min(1),
  steps: z.array(z.object({ id: name, label: name })).min(1),
  personas: z.array(
    z.object({ id: name, name, traits: personaTraitsSchema, device: deviceSchema }),
  ),
  seedGroups: z.array(z.int()),
  engine: z.object({
    mode: engineModeSchema,
    provider: name.nullable(),
    models: z.object({ decision: name, segmentation: name, planning: name }).nullable(),
    weights: z.object({ alpha: z.number(), beta: z.number(), gamma: z.number() }),
    version: name,
  }),
  sessionIds: z.array(name),
  screenshots: z.array(
    z.object({
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
    z.object({
      id: name,
      variant: name,
      step: name,
      label: name,
      source: aoiSourceSchema,
      role: z.string().nullable(),
      bbox: z.object({ x: pixels, y: pixels, width: pixels, height: pixels }),
      isPrimaryAction: z.boolean(),
      belowFold: z.boolean(),
    }),
  ),
  aoiMetrics: z.array(
    z.object({
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
  verdict: z.object({
    harderVariant: name,
    gapPoints: points,
    bandsDisjoint: z.boolean(),
    seedGroupsAgreeing: count,
    sentence: name,
  }),
  calibration: z
    .object({
      benchmark: z.literal('UEyes'),
      cc: z.number().nullable(),
      nss: z.number().nullable(),
      scanMatch: z.number().nullable(),
    })
    .nullable(),
});

/** One shape for a simulated and a real session, told apart by `kind`. */
export const sessionSchema = z
  .object({
    schemaVersion,
    sessionId: z.string().regex(/^S-\d{2,}$/, 'a session id is S-01, S-02 … S-NN'),
    runId: name,
    variant: name,
    taskId: name,
    kind: z.enum(['simulated', 'real']),
    persona: z.object({ id: name, traits: personaTraitsSchema, device: deviceSchema }).nullable(),
    participant: z.object({ id: name }).nullable(),
    seed: z.int().nullable(),
    startedAt: timestamp,
    durationMs: milliseconds,
    screens: z.array(
      z.object({
        index: count,
        step: name,
        screenshot: name,
        scrollY: pixels,
        intent: z.string(),
        decidedAction: z.string(),
      }),
    ),
    fixations: z.array(
      z.object({
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
      z.object({
        fromFixation: count,
        toFixation: count,
        amplitudePx: pixels,
        durationMs: milliseconds,
      }),
    ),
    actions: z.array(
      z.object({
        tMs: milliseconds,
        type: z.enum(['click', 'scroll', 'type', 'back', 'hesitate', 'abandon']),
        target: z.string().nullable(),
        aoiId: name.nullable(),
        value: z.string().nullable(),
        ok: z.boolean(),
      }),
    ),
    outcome: z.object({
      status: outcomeStatusSchema,
      step: name,
      reason: z.string(),
      attribution: attributionSchema,
      /** Derived once, in the pipeline, and stored: no screen re-derives it. */
      excludedFromScores: z.boolean(),
    }),
    integrity: z.object({ selectorFailures: count, retries: count }),
  })
  .superRefine((session, ctx) => {
    // `index` is the ordering key and runs continuously across the whole session, not
    // restarted per screen, so a fixation's index is its position in the array.
    session.fixations.forEach((fixation, position) => {
      if (fixation.index !== position) {
        ctx.addIssue({
          code: 'custom',
          path: ['fixations', position, 'index'],
          message: `fixation index runs 0, 1, 2 … continuously across the session, in array order: expected ${position}, found ${fixation.index}`,
        });
      }
    });
  });

export const findingsSchema = z.object({
  schemaVersion,
  runId: name,
  findings: z.array(
    z.object({
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
      evidence_link: z.object({
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
export const runRequestSchema = z.object({
  task: z.object({ prompt: name }),
  variants: z.array(variantSchema).min(1),
  personaIds: z.array(name).min(1),
  /** Sessions per persona per variant. */
  repeats: z.int().positive(),
  seed: z.int(),
  engineMode: engineModeSchema,
});

export type Run = z.infer<typeof runSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Findings = z.infer<typeof findingsSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
