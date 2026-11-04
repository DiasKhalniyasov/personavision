import { runSchema } from '@personavision/contract';
import { z } from 'zod';
import type { Goal, RunRequest } from '@personavision/contract';

/**
 * Handing a test to the platform, and asking it what one would take. The New test screen's
 * requests, and the only place in this app that makes them.
 *
 * Three of them, all about one test:
 *
 * - `POST /runs` with the `RunRequest` the contract declares — the two-URL A/B form (#110);
 * - `POST /runs` with a **site** rather than two versions — the launch step's button (#282);
 * - `POST /runs/estimate` — what a hundred agents on that site would take (#283).
 *
 * **This screen runs nothing**: the swarm is #54's and the Running state at `/runs/:runId` is
 * #18's, both driven by the artifact the platform starts writing. The browser's whole part is
 * these requests and the route it then goes to.
 *
 * A refusal is read as carefully as an answer, and nothing here throws: a test that was not
 * started must leave the form standing with everything typed still in it. The ladder below
 * reads the way `screens/audience/store.ts` reads #102's routes, deliberately: the rule the
 * app is held to is that **the request itself** lives in the one module named for the
 * interface it speaks to (`tests/skeleton.test.ts`), so lifting the `fetch` out into a
 * shared helper would move the call out of this file and break exactly that rule.
 */

const RUNS = '/runs';

/** `POST /runs/estimate` — a question about a draft, which writes nothing (#283). */
const ESTIMATE = '/runs/estimate';

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/**
 * What the platform answers with. Only the id is read, and its shape is the contract's own
 * `runId` rather than a second spelling of it: the run's other fields are read from the
 * artifact by `useRun`, through the contract, like every other figure in this app. The
 * object is tolerant on purpose — an answer that carries the whole run is not an answer this
 * screen should refuse.
 */
const startedSchema = z.object({ runId: runSchema.shape.runId });

const refusalSchema = z.object({ error: z.string().optional() });

export type StartResult =
  | { readonly ok: true; readonly runId: string }
  /** The test was not started, with the reason to put above the form. */
  | { readonly ok: false; readonly problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The sentence a reader is given when the platform itself is the problem. */
const UNREACHABLE = 'The test could not be started.';

/** The same, for a question that would have started nothing. */
const NO_ESTIMATE = 'That estimate could not be read.';

/** An answer in a shape this build does not know is not a refusal of anything. */
const UNREADABLE = 'The platform answered something this build cannot read.';

/**
 * One request to the platform, read down to its body.
 *
 * It answers with the status beside the body rather than with a decision, because the three
 * requests above read the same statuses differently: a 429 is a cap refusing a launch, and
 * there is no such thing as a cap refusing a question. Nothing here throws.
 */
type Posted =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly problem: string };

const post = async (path: string, body: unknown, whenUnreachable: string): Promise<Posted> => {
  let response: Response;
  try {
    response = await fetch(absolute(path), {
      method: 'POST',
      // `GET /runs/…` is the read-only run-data mount and `/runs` is a screen of this app,
      // so this says what it wants rather than taking whatever a navigation would get.
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, problem: `${whenUnreachable} ${reason(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      problem: response.ok
        ? UNREADABLE
        : `${whenUnreachable} It answered ${String(response.status)}.`,
    };
  }

  return { ok: true, status: response.status, body: parsed };
};

/** The sentence a refusal carries, or the status it arrived with where it carries none. */
const statedProblem = (body: unknown, status: number, whenUnreachable: string): string => {
  const refusal = refusalSchema.safeParse(body);
  const stated = refusal.success ? refusal.data.error : undefined;
  return stated ?? `${whenUnreachable} It answered ${String(status)}.`;
};

export const startTest = async (request: RunRequest): Promise<StartResult> => {
  const answer = await post(RUNS, request, UNREACHABLE);
  if (!answer.ok) return { ok: false, problem: answer.problem };

  if (answer.status >= 400) {
    return { ok: false, problem: statedProblem(answer.body, answer.status, UNREACHABLE) };
  }

  const started = startedSchema.safeParse(answer.body);
  return started.success
    ? { ok: true, runId: started.data.runId }
    : { ok: false, problem: 'The platform started a test but did not say which.' };
};

/* ===========================================================================
   The launch step: a hundred agents on one URL (#279).
   ======================================================================== */

/**
 * The engine a launch from this wizard runs on.
 *
 * `POST /runs` takes no `engineMode` from the wizard — `run/start.ts` resolves an absent one
 * as a model run, because a test of somebody's live site is not a dry run — and the estimate
 * must be quoted for **the engine the button will really use**, or its cost is a price for a
 * test nobody is about to start. So it is named here, beside the request that relies on it,
 * and the estimate below sends it rather than taking it from a caller who could disagree.
 *
 * **The one case this is wrong for, and why it is still sent from here.** A `contributor`
 * workspace whose model cannot be served runs offline rather than being refused (*"no key
 * means offline, not an error"*, `run/start.ts`), so its run is billed nothing while this
 * estimate quotes dollars. A `standard` workspace — which is what signing up creates — is
 * refused instead, with the 503 this screen renders, so the quote is right for every
 * workspace the product can create today. The browser cannot tell the difference: whether a
 * key is present is a fact only the server holds (decision 44), and the engine therefore
 * belongs beside `modelMode` and the concurrency, which `POST /runs/estimate` already
 * computes itself rather than trusting the body. When it computes the engine too, this
 * constant goes and the screen sends three fields instead of four.
 */
const LAUNCHES_ON = 'model' satisfies RunRequest['engineMode'];

/** The goal as the platform spells it: the wizard's own draft spells it `{ task, success, author }`. */
export interface LaunchGoal {
  readonly task: string;
  readonly successCriterion: string;
  readonly lastWrittenBy: Goal['lastWrittenBy'];
}

/**
 * What the launch button submits: the one-URL form of `POST /runs` (#282).
 *
 * The site is named twice and the two are not the same thing — `site` is the URL the feature
 * starts on and `siteId` is the record in this workspace the per-site caps are counted
 * against. The wizard's draft holds both halves, so the step looks nothing up.
 *
 * `repeats`, `seed` and `engineMode` are deliberately absent: one attempt a person, the seed
 * of the launch day, and the engine above. A `modelMode` is the workspace's and is ignored
 * when submitted, so it is not sent either.
 */
export interface SiteTestRequest {
  readonly site: string;
  readonly siteId: string;
  readonly feature: string;
  readonly goal: LaunchGoal;
  readonly audienceId: string;
}

/** One field of the wizard the platform refused, at the path the wizard knows it by. */
export interface LaunchIssue {
  readonly path: string;
  readonly message: string;
}

const issuesSchema = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

/**
 * A cap refusing a launch, as `packages/platform/src/caps.ts` types it and `POST /runs`
 * answers it: 429, with the figures beside the sentence.
 *
 * The sentence is **the platform's**, printed as it is given — the cap, its limit, what was
 * observed and when a launch like this one next passes are the figures the screen puts under
 * it, and `retryAt` is the instant it draws the reader's own clock time from (decision 111).
 */
const capRefusalSchema = z.object({
  error: z.string(),
  cap: z.string(),
  limit: z.number(),
  observed: z.number(),
  retryAt: z.string().nullable(),
});

export type CapRefusal = z.infer<typeof capRefusalSchema>;

export type LaunchResult =
  | { readonly ok: true; readonly runId: string }
  /** A cap refused it. Everything the user chose is still in the step. */
  | { readonly ok: false; readonly kind: 'cap'; readonly refusal: CapRefusal }
  /** Fields the platform refused, each at its own step of the wizard. */
  | {
      readonly ok: false;
      readonly kind: 'fields';
      readonly problem: string;
      readonly issues: readonly LaunchIssue[];
    }
  /** Anything else: the platform's own sentence, or why it could not be reached. */
  | { readonly ok: false; readonly kind: 'platform'; readonly problem: string };

/**
 * Starting a one-URL test. The launch step's one request, and the only thing on that step
 * that starts anything.
 *
 * Every refusal is read as what it is rather than flattened to a sentence: a cap keeps its
 * figures so the step can say when the next run is allowed, and a refused field keeps its
 * path so the step can point at the step that holds it.
 */
export const startSiteTest = async (request: SiteTestRequest): Promise<LaunchResult> => {
  const answer = await post(RUNS, request, UNREACHABLE);
  if (!answer.ok) return { ok: false, kind: 'platform', problem: answer.problem };

  if (answer.status === 429) {
    const refused = capRefusalSchema.safeParse(answer.body);
    return refused.success
      ? { ok: false, kind: 'cap', refusal: refused.data }
      : {
          ok: false,
          kind: 'platform',
          problem: statedProblem(answer.body, answer.status, UNREACHABLE),
        };
  }

  if (answer.status >= 400) {
    const refused = issuesSchema.safeParse(answer.body);
    return refused.success && refused.data.issues.length > 0
      ? {
          ok: false,
          kind: 'fields',
          problem: refused.data.error,
          issues: refused.data.issues,
        }
      : {
          ok: false,
          kind: 'platform',
          problem: statedProblem(answer.body, answer.status, UNREACHABLE),
        };
  }

  const started = startedSchema.safeParse(answer.body);
  return started.success
    ? { ok: true, runId: started.data.runId }
    : {
        ok: false,
        kind: 'platform',
        problem: 'The platform started a test but did not say which.',
      };
};

/* ===========================================================================
   The estimate the launch step prints (#283's `POST /runs/estimate`).
   ======================================================================== */

/** A range. Both bounds in the unit of the figure that carries them. */
const rangeSchema = z.object({ low: z.number(), high: z.number() });

export type EstimateRange = z.infer<typeof rangeSchema>;

const tokensSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
});

export type EstimateTokens = z.infer<typeof tokensSchema>;

/** A figure the platform could not compute, named rather than left out of a total. */
const unknownSchema = z.object({ state: z.literal('unknown'), reason: z.string() });

/**
 * Where a figure's bounds came from — **per figure**, and a statement about the bounds
 * rather than about the site: a site whose own sessions have no spread keeps the typical
 * bounds and says so (decision 102, as #283 refined it).
 */
const measuredFromSchema = z.enum(['this-site', 'other-sites']);

export type MeasuredFrom = z.infer<typeof measuredFromSchema>;

const timeSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('known'),
    sessions: z.number(),
    concurrency: z.number(),
    batches: z.number(),
    medianSessionMs: z.number(),
    sessionMs: rangeSchema,
    measuredFrom: measuredFromSchema,
    sessionsMeasured: z.number(),
    /** `null` on every estimate today: nothing has timed a browser starting (#246). */
    browserStartupMs: z.number().nullable(),
    ms: rangeSchema,
  }),
  unknownSchema,
]);

const costSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('known'),
    sessions: z.number(),
    modelId: z.string(),
    prices: z.object({
      inputPerMillionUsd: z.number(),
      cachedInputPerMillionUsd: z.number(),
      outputPerMillionUsd: z.number(),
      ratesReadOn: z.string(),
    }),
    tokensPerSession: z.object({
      low: tokensSchema,
      median: tokensSchema,
      high: tokensSchema,
    }),
    measuredFrom: measuredFromSchema,
    runsMeasured: z.number(),
    usdPerSession: rangeSchema,
    usd: rangeSchema,
  }),
  /** An offline run: there is no cost, which is not the same as a price of zero. */
  z.object({ state: z.literal('nothing-to-pay'), reason: z.string() }),
  unknownSchema,
]);

const storageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('known'),
    sessions: z.number(),
    medianBytesPerSession: z.number(),
    measuredFrom: measuredFromSchema,
    runsMeasured: z.number(),
    bytes: z.number(),
  }),
  unknownSchema,
]);

/**
 * What the launch step is handed: figures and the inputs they were computed from, and **no
 * composed sentence**. Every key is present whatever the state, so the three skeletons sit
 * in the cells the figures arrive in and the layout does not move.
 */
const estimateSchema = z.object({
  siteUrl: z.string(),
  engineMode: z.enum(['offline', 'model'] as const satisfies readonly RunRequest['engineMode'][]),
  agents: z.object({
    participants: z.number(),
    sessions: z.number(),
    concurrency: z.number(),
  }),
  time: timeSchema,
  cost: costSchema,
  storage: storageSchema,
});

export type RunEstimate = z.infer<typeof estimateSchema>;
export type TimeEstimate = RunEstimate['time'];
export type CostEstimate = RunEstimate['cost'];
export type StorageEstimate = RunEstimate['storage'];

/** What an estimate is quoted for: the draft's own figures, each read from the platform. */
export interface EstimateQuery {
  /** The agents, which is the audience's own size as the audience store answers it. */
  readonly participants: number;
  /** The site the feature starts on, as the user typed it. */
  readonly siteUrl: string;
  /**
   * How many sessions run at a time. The **site's own cap**, as `GET /sites` states it: this
   * screen defines no concurrency of its own, and the figure it prints is the one the
   * platform answers with rather than the one sent here (decision 118).
   */
  readonly concurrency: number;
}

export type EstimateResult =
  | { readonly ok: true; readonly estimate: RunEstimate }
  /** No estimate. One sentence for the step, which still offers the launch. */
  | { readonly ok: false; readonly problem: string };

/**
 * What a test would take, before anything launches.
 *
 * It writes nothing and starts nothing: the one request that may start a test is
 * `startSiteTest` above. A refusal here is a sentence and never a reason to withhold the
 * button — an unknown estimate is not a reason to block a test.
 */
export const estimateTest = async (query: EstimateQuery): Promise<EstimateResult> => {
  const answer = await post(ESTIMATE, { ...query, engineMode: LAUNCHES_ON }, NO_ESTIMATE);
  if (!answer.ok) return { ok: false, problem: answer.problem };

  if (answer.status >= 400) {
    return { ok: false, problem: statedProblem(answer.body, answer.status, NO_ESTIMATE) };
  }

  const quoted = estimateSchema.safeParse(answer.body);
  return quoted.success ? { ok: true, estimate: quoted.data } : { ok: false, problem: UNREADABLE };
};
