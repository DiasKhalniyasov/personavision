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
/** `S-01`, `S-02` … `S-NN` — a session's id, and the name of its file under `sessions/`. */
const sessionId = z.string().regex(/^S-\d{2,}$/, 'a session id is S-01, S-02 … S-NN');

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
  /**
   * Automation failures are excluded, so this is at least one: a variant whose every
   * session was an automation failure has no friction score and no completion rate, and
   * belongs out of `scores` rather than in it reporting a zero nobody measured.
   */
  scoredSessionCount: z.int().positive(),
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
      const { success, abandoned, failed } = score.outcomeCounts;
      // The denominator is the scored sessions, and the three product outcomes are what
      // they are made of: an automation failure is excluded from the scores, not from the
      // run. Without this, 5 successes and 5 abandonments over 5 scored sessions would
      // state a completion rate of 1 and agree with itself.
      const accounted = success + abandoned + failed;
      if (accounted !== score.scoredSessionCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['scores', index, 'scoredSessionCount'],
          message: `${score.scoredSessionCount} sessions were scored, but the outcomes account for ${accounted} of them (${success} success, ${abandoned} abandoned, ${failed} failed; automation failures are counted separately and excluded)`,
        });
      }
      if (score.scoredSessionCount <= 0) return;
      const expected = success / score.scoredSessionCount;
      if (Math.abs(score.completionRate - expected) > COMPLETION_TOLERANCE) {
        ctx.addIssue({
          code: 'custom',
          path: ['scores', index, 'completionRate'],
          message: `completionRate ${score.completionRate} disagrees with ${success} of ${score.scoredSessionCount} scored sessions (${expected})`,
        });
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
  });

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

/**
 * The query parameters the two evidence screens take, from the routes in `docs/FLOW.md`
 * section 3. The key space is closed like every other object in the artifact: a link
 * cannot carry a parameter those screens have no use for, and so cannot carry a
 * credential under a name of its own invention.
 */
const EVIDENCE_LINK_PARAMS = ['variant', 'step', 'aoi', 'outcome'] as const;

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
export type Persona = z.infer<typeof personaSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Score = z.infer<typeof scoreSchema>;
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
export type Session = z.infer<typeof sessionSchema>;
export type Findings = z.infer<typeof findingsSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
