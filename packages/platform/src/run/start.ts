import { runRequestSchema } from '@personavision/contract';
import type { Audience, Goal, ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import type { ModelId } from '@personavision/provider';
import { audienceForNewTest } from '../audience/freeze.js';
import { parseSiteUrl, SiteUrlNotAcceptedError } from '../site/site.js';
import type { AudienceStore, WorkspaceStore } from '../store/types.js';

/**
 * Starting a test: the one place the model mode is decided, and the one place a test that
 * cannot run on the model its workspace pays for is refused rather than run on another.
 *
 * The owner's decision of 2026-10-27 (#144) puts the mode on the **workspace**, because it
 * says who pays and whose content may be used for training — not what is being tested. So
 * no screen offers it, the person starting a test does not pick it, and this function reads
 * it off the workspace record and puts it on the request. There is one request and it is
 * sent once: a refusal is never retried on a cheaper model or on the offline engine.
 *
 * What this function does not do: run anything. The swarm is `TestPipeline`, which #54
 * supplies; this is the step between a submitted draft and that call, and the step between
 * that call and the run being registered as the workspace's.
 */

/**
 * What a New test form (#110) or `personavision run` (#54) submits: a whole `RunRequest`
 * except the mode, which is not theirs to name.
 */
export type TestDraft = Omit<RunRequest, 'modelMode'>;

/**
 * What the pipeline reports back: the run directory it wrote, and **what actually ran** in
 * it — which is what the artifact records (#142) and what the screens show (#18).
 *
 * A contributor test on a machine with no key reports `offline` and no model mode, because
 * that is what happened. Nothing here is the mode that was asked for.
 */
export interface StartedTest {
  readonly runId: string;
  readonly engineMode: RunRequest['engineMode'];
  /** The mode that ran, or absent where no model was called. */
  readonly modelMode?: ModelMode;
}

/**
 * The swarm, behind one call: handed a complete request, it answers with what it ran.
 *
 * It is handed the audience **by value** as well, because `RunRequest` names it by id and
 * `run.json` carries it by value — resolving that id is the platform's, since only the
 * platform knows which workspace asked (`audienceForNewTest`). The pipeline copies this
 * object into the artifact and reads no audience of its own.
 */
export type TestPipeline = (request: RunRequest, audience: Audience) => Promise<StartedTest>;

/** What the pipeline reported it ran, in the words a refusal states it in. */
const whatRan = (started: StartedTest): string => {
  if (started.engineMode !== 'model') return 'ran on the offline deterministic engine';
  if (started.modelMode === undefined) return 'ran on a model it did not name';
  return `ran on the ${started.modelMode} model ${MODEL_ID_BY_MODE[started.modelMode]}`;
};

/**
 * A test that was refused rather than answered by a model nobody asked for.
 *
 * Two cases, and they are told apart because one message is a lie in the other's case:
 *
 * - **Before anything ran.** The model could not be served — no key is configured for this
 *   deployment, or the provider is unavailable — so nothing was simulated. This is the
 *   refusal a standard workspace gets on a machine with no key.
 * - **After something ran.** The pipeline answered on another model, or on the offline
 *   deterministic engine. Sessions did run and a run directory was written, so the refusal
 *   says that, names where it is, and says it is not recorded as this workspace's. Telling
 *   a customer nothing happened while a billed run sits on disk is its own kind of lying.
 *
 * Either way the result is not a test of their site on the model they asked for, which is
 * what the owner's decision forbids presenting as one.
 *
 * The message is written here in full and carries nothing from the error underneath it:
 * what reaches a screen, a response body or a log line is these words, so no key value can
 * travel inside them. The error below it is where it was thrown, which is where a
 * deployment logs its own diagnosis.
 */
export class TestRefusedError extends Error {
  /** The mode the workspace asked for. */
  readonly modelMode: ModelMode;
  /** The model that was asked for, named so the Test failed screen can state it. */
  readonly modelId: ModelId;
  /**
   * The run the pipeline had already written when the substitution was caught, or `null`
   * where nothing ran. It is left where the pipeline wrote it — this package does not own
   * run directories — and it is registered to no workspace, so nothing in the product
   * offers it.
   */
  readonly ranAnywayRunId: string | null;

  constructor(modelMode: ModelMode, ranAnyway: StartedTest | null = null) {
    const modelId = MODEL_ID_BY_MODE[modelMode];
    super(
      ranAnyway === null
        ? `The test was not started: the ${modelMode} model ${modelId} could not be used. Nothing was simulated — no sessions ran, no result was stored, and no other model was tried.`
        : `The test was refused: it was to run on the ${modelMode} model ${modelId}, and ${whatRan(ranAnyway)} instead. That is not a test of your site on ${modelId}, so it is recorded as nobody's: the run directory "${ranAnyway.runId}" was left where it was written and belongs to no workspace.`,
    );
    this.name = 'TestRefusedError';
    this.modelMode = modelMode;
    this.modelId = modelId;
    this.ranAnywayRunId = ranAnyway?.runId ?? null;
  }
}

/**
 * A draft the contract does not accept, reported **at the path each problem is at** so that
 * the New test form can render every message against its own field (#110).
 *
 * A typed caller cannot reach this — `TestDraft` is the contract's own type — so it exists
 * for the one untyped caller there is: a submitted body.
 */
export class DraftNotAcceptedError extends Error {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(issues: readonly { readonly path: string; readonly message: string }[]) {
    super('that test could not be started from what was submitted.');
    this.name = 'DraftNotAcceptedError';
    this.issues = issues;
  }
}

/** A workspace id no workspace answers to. A session carries one that does. */
export class NoSuchWorkspaceError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`there is no workspace "${workspaceId}" to start a test in.`);
    this.name = 'NoSuchWorkspaceError';
    this.workspaceId = workspaceId;
  }
}

export interface StartTestOptions {
  workspaces: WorkspaceStore;
  /** The workspace's audiences: the one the draft names is resolved against these alone. */
  audiences: AudienceStore;
  /** The workspace the test belongs to — the session's, and the one that names the mode. */
  workspaceId: string;
  draft: TestDraft;
  pipeline: TestPipeline;
}

/**
 * Whether what ran is what the workspace asked for.
 *
 * A model that ran has to be the one that was asked for, **in either direction**: standard
 * served by contributor sends a paying customer's content to the model Meta may train on,
 * and contributor served by standard bills a development run at twelve times what it should
 * be. `packages/provider`'s own selection guards both (#143), and so does this, because the
 * rule is about the result and not only about the request.
 *
 * Where no model ran at all, the offline deterministic engine is today's answer for a
 * contributor workspace — no key means offline, said plainly on the screen, which is what
 * keeps the demo and a cold start working — and is never an answer for a standard one.
 */
const servedAsAsked = (request: RunRequest, started: StartedTest): boolean =>
  started.engineMode === 'model'
    ? started.modelMode === request.modelMode
    : request.modelMode !== 'standard' || request.engineMode !== 'model';

export const startTest = async ({
  workspaces,
  audiences,
  workspaceId,
  draft,
  pipeline,
}: StartTestOptions): Promise<StartedTest> => {
  const workspace = await workspaces.byId(workspaceId);
  if (workspace === null) throw new NoSuchWorkspaceError(workspaceId);

  // Parsed rather than spread together, so that what the pipeline receives is a request the
  // contract has already accepted — the mode included. The spread comes first, so a
  // submitted body naming a mode of its own is overridden rather than honoured: the model a
  // test is billed at is not the submitter's to choose.
  const parsed = runRequestSchema.safeParse({ ...draft, modelMode: workspace.modelMode });
  if (!parsed.success) {
    throw new DraftNotAcceptedError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  const request = parsed.data;
  // Resolved against the workspace that asked, and frozen: a test is never started for an
  // audience this workspace cannot read, and it is refused here rather than by the
  // pipeline, which is handed no workspace to scope it against. Throws before anything
  // runs, so an unofferable audience costs no sessions either.
  const audience = await audienceForNewTest(audiences, workspaceId, request.audienceId);

  let started: StartedTest;
  try {
    started = await pipeline(request, audience);
  } catch (error) {
    // Provider selection refusing to serve the mode is this workspace's test being
    // refused (#143). For contributor it is not supposed to happen — no key means offline,
    // not an error — so it is left as the failure it is rather than dressed up as a
    // refusal nobody can act on.
    if (error instanceof ModelModeUnavailableError && workspace.modelMode === 'standard') {
      throw new TestRefusedError('standard');
    }
    throw error;
  }

  if (!servedAsAsked(request, started)) throw new TestRefusedError(workspace.modelMode, started);

  // Registered only once something ran: a refused test leaves the workspace's runs as they
  // were, so nothing in the product offers a result that does not exist.
  await workspaces.addRun(workspaceId, started.runId);
  // What ran, not what was asked for. The caller reports this and so does the artifact.
  return started;
};

/**
 * A **one-URL test** (`docs/FLOW.md` section 11): the same `startTest` above, handed a
 * request this module builds from what the New test wizard collected.
 *
 * Nothing below forks on a "path". A path-1 test is a run with one variant and a path-2 test
 * is a run with two, which is the A/B run the product already writes (the auto-decision of
 * 2026-11-03 on #222), so there is one start path, one request shape and one refusal shape.
 * What this adds is the translation: a site becomes the one variant, the goal's task becomes
 * the task, and the three numbers no screen asks for are resolved here.
 */

/**
 * What the New test wizard holds and the launch step submits: a site, the feature in the
 * user's own words, the goal as the user approved it, and the audience
 * (`apps/viewer/src/screens/newtest/wizard/draft.ts`, and `#screen-newtest-feature` and
 * `#screen-newtest-goal` in `docs/design/prototype.html`).
 *
 * The goal is the contract's `Goal` — `task`, `successCriterion`, `lastWrittenBy` — and not
 * the wizard's own spelling of it, because what a run records is the contract's.
 *
 * Three fields are optional because no screen of the wizard asks for them, and what each
 * absence means is written where it is resolved below.
 */
export interface SiteTestDraft {
  /** The site under test: the URL the feature starts on, and the one variant's URL. */
  readonly site: string;
  /** The feature, in the user's words, carried on exactly as it was typed. */
  readonly feature: string;
  /** The goal the user read and approved before launch, with whoever last wrote it. */
  readonly goal: Goal;
  /** The workspace's audience the test is for, by id, as every request names it. */
  readonly audienceId: string;
  /** Attempts per person. Absent is one each, so a test's agents are its audience. */
  readonly repeats?: number;
  /** Absent is the day it was launched on — `seedForLaunchDay`. */
  readonly seed?: number;
  /** Absent is a model run: a test of somebody's live site is not a dry run. */
  readonly engineMode?: RunRequest['engineMode'];
}

/**
 * The id of the one variant a one-URL test runs.
 *
 * Not `A`: `A` is half of a pair, and a reader meeting `screenshots/A/…` in a run with no
 * `B` would be looking for a comparison nobody asked for. `site` says what the variant is,
 * and the name beside it says which site.
 */
export const ONE_URL_VARIANT_ID = 'site';

/** Attempts per person where a draft names none: one, so the agents are the audience. */
const ONE_ATTEMPT_EACH = 1;

/**
 * A test of somebody's live site, where a draft names no engine: the product's test is a
 * model run, and `startTest` above puts the workspace's mode on it. A deployment with no key
 * is recorded and run as offline by the pipeline rather than upgraded, and a standard
 * workspace whose model cannot be served is refused rather than served by another (#144).
 */
const A_MODEL_RUN = 'model';

/**
 * The one variant a one-URL test runs: the site, under the name a person reads it by.
 *
 * The name is the URL's host — `app.clipforge.example` — which is how `#screen-sites` lists
 * a site and how `#screen-newtest-estimate` names the one a launch is about. The port is
 * part of it, so two sites on `localhost` are told apart. The URL itself is the address that
 * was typed.
 *
 * It takes whatever was submitted and parses it through `parseSiteUrl` rather than trusting
 * a caller to have done it, exactly as `addSite` does: this is exported so that
 * `personavision run` writes the same variant from the command line (#284) instead of
 * spelling the id and the name again, and a caller handing it `app.clipforge.example` — or
 * nothing at all — should get the sentence that names what is wrong with it rather than a
 * bare `TypeError` out of `new URL`.
 */
export const variantForSite = (url: unknown): RunRequest['variants'][number] => {
  const site = parseSiteUrl(url);
  return { id: ONE_URL_VARIANT_ID, name: new URL(site).host, url: site };
};

/**
 * The seed a launch runs at where nothing names one: the day it was launched on, written the
 * way the prototype prints it under the audience on `#screen-results` — *"generated from
 * this audience with seed 20261103"*.
 *
 * The day is the **UTC** day, which is the clock `run.createdAt` is written in, so the seed
 * and the date the run records are the same day rather than two.
 *
 * No step of the wizard asks for a seed and none should: it is a number a person has no way
 * to choose well. The day is the one number that is both already on the screen and
 * repeatable — a second test of the same audience on the same day draws the same hundred
 * people, and a user who wants last month's hundred back passes the seed the results screen
 * printed for them, which is why it is printed. Recorded as decision 106 for the owner; a
 * caller that names a seed is obeyed.
 */
export const seedForLaunchDay = (at: Date): number => {
  const [day = ''] = at.toISOString().split('T');
  return Number(day.replaceAll('-', ''));
};

/** One problem with a draft, as `DraftNotAcceptedError` carries it. */
type DraftIssue = DraftNotAcceptedError['issues'][number];

/** The fields of the wizard the messages below are rendered against. */
const SITE = 'site';
const FEATURE = 'feature';
const GOAL = 'goal';
const GOAL_TASK = 'goal.task';
const GOAL_SUCCESS_CRITERION = 'goal.successCriterion';

/**
 * What a one-URL submission may carry. Anything else is refused **at its own path** rather
 * than dropped: a body naming both a `site` and `variants` is two forms at once and neither
 * is guessed at, and a misspelt field is a violation rather than a silence — the rule the
 * contract's closed objects hold every artifact file to.
 *
 * `modelMode` is accepted and then ignored, exactly as the two-variant form ignores one: the
 * model a test is billed at comes off the workspace and is never the submitter's (#144).
 */
const SITE_DRAFT_FIELDS: readonly string[] = [
  SITE,
  FEATURE,
  GOAL,
  'audienceId',
  'repeats',
  'seed',
  'engineMode',
  'modelMode',
];

/** What was found where a sentence was expected. Never "something went wrong". */
const insteadOfASentence = (value: unknown): string =>
  value === undefined || value === null || typeof value === 'string'
    ? 'nothing was written here'
    : `this is ${typeof value === 'object' ? 'an object' : `a ${typeof value}`} and not a sentence`;

/**
 * What was found where the goal was expected. A goal is two sentences in an object, so
 * "nothing was written here" is true of an absent one and a lie about anything else.
 */
const insteadOfAGoal = (value: unknown): string =>
  value === undefined || value === null
    ? 'nothing was written here'
    : `this is ${Array.isArray(value) ? 'a list' : `a ${typeof value}`} and not a goal`;

/** The sentence a field holds, or `null` where it holds none. Returned **untrimmed**. */
const sentenceIn = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * The fields a one-URL test cannot be started without, which the contract leaves optional.
 *
 * `runRequestSchema` has to accept a request carrying no feature and no goal: that is
 * today's two-variant request, and every run written before this revision (#247). So *"a
 * test of one site says what it is about"* is this platform's rule rather than the
 * contract's, and it is stated here once, in the shape `#screen-newrun-invalid` prints — the
 * field, what it found and what it expected.
 */
const whatAOneUrlTestNeeds = (draft: SiteTestDraft): DraftIssue[] => {
  const issues: DraftIssue[] = Object.keys(draft)
    .filter((field) => !SITE_DRAFT_FIELDS.includes(field))
    .map((path) => ({
      path,
      message: `a one-URL test is started from a site, a feature, a goal and an audience, and this is none of them: a comparison of two versions submits its own "variants" rather than a site`,
    }));

  if (sentenceIn(draft.feature) === null) {
    issues.push({
      path: FEATURE,
      message: `${insteadOfASentence(draft.feature)}: a test of one site says what feature it is about, in the user's own words — "checking out with a promo code"`,
    });
  }

  if (typeof draft.goal !== 'object' || draft.goal === null || Array.isArray(draft.goal)) {
    issues.push({
      path: GOAL,
      message: `${insteadOfAGoal(draft.goal)}: a one-URL test runs a goal — the task each person attempts, and what counts as having done it, as a sentence each`,
    });
    return issues;
  }
  if (sentenceIn(draft.goal.task) === null) {
    issues.push({
      path: GOAL_TASK,
      message: `${insteadOfASentence(draft.goal.task)}: the task is the one sentence each person attempts — "Generate a video from a text prompt, and wait until it is ready to watch."`,
    });
  }
  if (sentenceIn(draft.goal.successCriterion) === null) {
    issues.push({
      path: GOAL_SUCCESS_CRITERION,
      message: `${insteadOfASentence(draft.goal.successCriterion)}: a success criterion is what has to be observable in the page for an attempt to count — an element, a URL or a piece of text`,
    });
  }
  return issues;
};

/** Whether a contract path is that field of the request, or something inside it. */
const isAt = (path: string, field: string): boolean =>
  path === field || path.startsWith(`${field}.`);

/**
 * A contract path, as the field of the wizard a person typed in.
 *
 * Two of the request's fields are built here rather than submitted — the variant from the
 * site, the task from the goal's own task — so a refusal at `variants.0.url` or at
 * `task.prompt` would send a screen looking for a field it does not have. Both are checked
 * before the request is built, by `parseSiteUrl` and `whatAOneUrlTestNeeds`, so this is the
 * second line rather than the first: it holds if the contract ever refuses a URL or a
 * sentence those two let through. Every other path is already a field of the draft —
 * `feature`, `goal`, `goal.task`, `goal.successCriterion`, `goal.lastWrittenBy`,
 * `audienceId`, `repeats`, `seed`, `engineMode` — and passes through untouched.
 */
const asAFieldOfTheDraft = (issue: DraftIssue): DraftIssue => {
  if (isAt(issue.path, 'variants')) return { path: SITE, message: issue.message };
  if (isAt(issue.path, 'task')) return { path: GOAL_TASK, message: issue.message };
  return issue;
};

/**
 * The request a one-URL draft starts, or the refusal that names every field standing in the
 * way of one.
 *
 * The feature is copied **as it was typed** — nothing here trims it, collapses its spaces,
 * splits it or folds its case, because the sentence a user wrote about their own site is the
 * one the results heading reads back. The goal is passed through whole rather than rebuilt
 * field by field, so a key the contract does not declare is refused at its own path instead
 * of being quietly dropped on the way to the artifact.
 */
const draftForSite = (draft: SiteTestDraft, launchedAt: Date): TestDraft => {
  const issues = whatAOneUrlTestNeeds(draft);
  let variant: RunRequest['variants'][number] | null = null;
  try {
    variant = variantForSite(draft.site);
  } catch (error) {
    if (!(error instanceof SiteUrlNotAcceptedError)) throw error;
    // The same rule the Add-a-site form is held to, reported at the field this person typed
    // in: `site` on the wizard rather than the `url` of that form.
    issues.unshift(...error.issues.map(({ message }) => ({ path: SITE, message })));
  }
  if (variant === null || issues.length > 0) throw new DraftNotAcceptedError(issues);

  return {
    // The goal's task **is** the task: a one-URL test has one sentence saying what to
    // attempt, the user approved it, and a second copy of it is a second thing to disagree.
    task: { prompt: draft.goal.task },
    variants: [variant],
    feature: draft.feature,
    goal: draft.goal,
    audienceId: draft.audienceId,
    // Resolved only where the field is **absent**, which is a screen that does not collect
    // it. A field that was submitted is passed on as it was submitted, `null` included, so
    // the contract refuses it at its own path rather than this standing in for it: a client
    // that sends `engineMode: null` gets a refusal and not a model run nobody asked for.
    repeats: draft.repeats === undefined ? ONE_ATTEMPT_EACH : draft.repeats,
    seed: draft.seed === undefined ? seedForLaunchDay(launchedAt) : draft.seed,
    engineMode: draft.engineMode === undefined ? A_MODEL_RUN : draft.engineMode,
  };
};

export interface StartSiteTestOptions extends Omit<StartTestOptions, 'draft'> {
  /** What the New test wizard collected. */
  draft: SiteTestDraft;
  /** The clock the default seed is read off, so a test can state the day it launched on. */
  now?: () => Date;
}

/**
 * Starting a **one-URL test**: the wizard's draft as a request the contract accepts, handed
 * to `startTest` above.
 *
 * Everything that makes a test a test is still that function's — the mode off the workspace,
 * the audience resolved by value against the workspace that asked, the refusal that is never
 * retried on a cheaper model or on the offline engine. What this one adds is the shape: one
 * variant named for the site, the feature as it was written, and the goal with its author,
 * which is what makes one URL a test rather than half a comparison.
 *
 * It states **no cap and no concurrency**. The agents-per-run cap, the hundred maximum, the
 * runs per site per hour and the typed refusal that prints them are #239's; the per-site
 * concurrency the pipeline is handed is #241's. A number here would be a second place one
 * could be missed. The site is likewise not resolved against the workspace's sites: it
 * reaches the pipeline as the one variant's URL, and `siteId` arrives with #239.
 */
export const startSiteTest = async ({
  draft,
  now,
  ...test
}: StartSiteTestOptions): Promise<StartedTest> => {
  const clock = now ?? ((): Date => new Date());
  // Spread rather than read straight, for the same reason `startTest` spreads what it was
  // given: a submitted body that is not an object — an empty request, `null`, a number —
  // spreads to no fields at all, which is a draft with everything missing and a refusal that
  // says what a one-URL test needs, rather than a crash on the way to one.
  const request = draftForSite({ ...draft }, clock());
  try {
    return await startTest({ ...test, draft: request });
  } catch (error) {
    // The contract's own refusals, renamed to the fields the wizard renders them against.
    if (error instanceof DraftNotAcceptedError) {
      throw new DraftNotAcceptedError(error.issues.map(asAFieldOfTheDraft));
    }
    throw error;
  }
};
