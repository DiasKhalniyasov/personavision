import { randomUUID } from 'node:crypto';
import { runRequestSchema } from '@personavision/contract';
import type { Audience, Goal, ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import type { ModelId } from '@personavision/provider';
import { audienceForNewTest } from '../audience/freeze.js';
import { refuseTooManyAgents, refuseTooManyRunsThisHour, sessionsInFlight } from '../caps.js';
import { parseSiteUrl, SiteUrlNotAcceptedError } from '../site/site.js';
import type { AudienceStore, SiteRecord, SiteStore, WorkspaceStore } from '../store/types.js';

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
 *
 * `concurrency` is **how many of this site's sessions may be in flight at once**, and it is
 * handed over for the same reason the audience is: only the platform knows which site is
 * being driven, and the number is a fact about that site (`CAPS.concurrentSessionsPerSite`,
 * `docs/FLOW.md` section 13). The swarm's pool holds whatever bound it is given and names no
 * per-site number of its own (#275), so handing it the caps module's number is what makes
 * the cap a cap — and is why no submitted body can raise it: `startTest` computes it, and
 * nothing it was sent is consulted.
 *
 * It is optional on this type so that a pipeline with no use for it — a stand-in in a test
 * about something else — still satisfies it. A pipeline that ignores it runs unbounded, so
 * the real one does not.
 */
export type TestPipeline = (
  request: RunRequest,
  audience: Audience,
  site?: SiteAtLaunch,
  concurrency?: number,
) => Promise<StartedTest>;

/**
 * The site a run was launched against, as the artifact records it (`site.verifiedAtLaunch`,
 * #243).
 *
 * **Recorded, not enforced.** `verifiedAtLaunch` is read off the site once, here, so that a
 * reader of a committed run can see whether the figures came from a site somebody had proved
 * they control. No cap reads it: the owner's answer of 2026-11-03 settled decision 71 as _no
 * gate on testing_, and `caps.ts` is handed no site state at all. A site that is verified
 * today and unverified tomorrow runs under exactly the same caps; the only thing that
 * differs between the two runs is this field.
 *
 * Absent for `personavision run`, which has no workspace and no site.
 */
export interface SiteAtLaunch {
  readonly id: string;
  /** The URL as the user typed it when they added the site. */
  readonly url: string;
  /** Whether the site was verified at the moment this run was launched. */
  readonly verifiedAtLaunch: boolean;
}

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

/**
 * A site id the session's workspace does not hold — one that was never added, one that was
 * removed, or **one of another workspace**.
 *
 * All three are the same answer, and deliberately: that another workspace holds this site is
 * not news we owe anybody, which is the rule `visibleRuns` and the site routes already
 * follow. A typed refusal rather than a 500, because a body naming a site that is not yours
 * is a request to be told no, not a bug in the platform.
 */
export class NoSuchSiteError extends Error {
  readonly siteId: string;

  constructor(siteId: string) {
    super('There is no such site.');
    this.name = 'NoSuchSiteError';
    this.siteId = siteId;
  }
}

export interface StartTestOptions {
  workspaces: WorkspaceStore;
  /** The workspace's audiences: the one the draft names is resolved against these alone. */
  audiences: AudienceStore;
  /**
   * The workspace's sites: the one the draft names is resolved against these alone, and the
   * one the per-site caps are counted against.
   */
  sites: SiteStore;
  /** The workspace the test belongs to — the session's, and the one that names the mode. */
  workspaceId: string;
  draft: TestDraft;
  pipeline: TestPipeline;
  /**
   * The clock the hourly cap's window is measured from, and the instant the launch is
   * recorded at. Absent is the real one; a test fixes it so the fifth run in an hour and the
   * run sixty-one minutes later are assertable without waiting.
   */
  now?: () => Date;
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

/** The field a one-URL wizard and a comparison form alike name their site in. */
const SITE_ID = 'siteId';

/**
 * The site a request names, resolved in the workspace that asked.
 *
 * A request naming **no** site is refused at `siteId`, because the platform's start path
 * requires one: a test launched through the product is a test against a site the product
 * knows, and a cap counted against nothing is not a cap. The contract leaves the field
 * optional for `personavision run`, which has no workspace and no site and never reaches
 * here, so this is the platform's own rule rather than the contract's — stated once.
 *
 * A **removed** site resolves and launches: `list` hides a soft-deleted site from the pickers
 * so nothing offers it, but a request that still names one is counted against it like any
 * other, because the address is still somebody's and still gets the browsers. Refusing it
 * here would mean a user could clear a site's hourly ledger by deleting it.
 */
const siteForNewTest = async (
  sites: SiteStore,
  workspaceId: string,
  siteId: string | undefined,
): Promise<SiteRecord> => {
  if (siteId === undefined) {
    throw new DraftNotAcceptedError([
      {
        path: SITE_ID,
        message:
          'a test names the site it runs against: the id of one of this workspace’s sites, which is what the per-site caps are counted against',
      },
    ]);
  }
  const site = await sites.byId(workspaceId, siteId);
  if (site === null) throw new NoSuchSiteError(siteId);
  return site;
};

/**
 * The runs in flight, by site: the tail of each site's queue, so a launch can wait for
 * whatever is ahead of it.
 *
 * **One run per site at a time.** Two runs on one site would otherwise be twenty browsers
 * on it — each run holding its own ten — which is exactly the load the cap exists to keep
 * off a small site. A second launch therefore **waits** for the first rather than being
 * refused: the run was allowed (its agents are under the hundred, its site has runs left
 * this hour), so refusing it here would be refusing a launch no cap refused. What it loses
 * is time, not sessions.
 *
 * It is keyed by **site id**, so a launch on another site starts at once: the cap is about
 * one site being driven, and two sites are two sites' worth of browsers. **Per site record,
 * not per address** — a record belongs to one workspace, so one address added by two
 * workspaces is two sites and two queues. That is the same ceiling the hourly ledger already
 * has, since it is counted per record too, and moving either to the address means deciding
 * what makes two URLs one site, which no ticket has.
 *
 * `ponytail:` an in-process gate. One server process owns its data directory, which is the
 * same ceiling the file store already has, so a second process would not see this map — nor
 * the file store's writes. Per-host coordination, if the platform is ever more than one
 * process, is #229's and would replace both together.
 */
const queueBySite = new Map<string, Promise<void>>();

/**
 * `run`, once every launch already queued on this site has finished.
 *
 * The queue is a chain of promises rather than a counter, so the order launches arrived in
 * is the order they run in — a second launch that waited ten minutes is not overtaken by a
 * third that arrived after it.
 *
 * `mine` only ever **resolves**: it is settled in a `finally`, so a run that throws releases
 * the site rather than leaving every launch behind it waiting for a run that is over. The
 * last one out deletes the key, so the map holds an entry per site being driven rather than
 * one per site that ever was.
 */
const whileNothingElseRunsOnTheSite = async <T>(
  siteId: string,
  run: () => Promise<T>,
): Promise<T> => {
  const ahead = queueBySite.get(siteId);
  let done: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  queueBySite.set(siteId, mine);
  await ahead;
  try {
    return await run();
  } finally {
    if (queueBySite.get(siteId) === mine) queueBySite.delete(siteId);
    done();
  }
};

export const startTest = async ({
  workspaces,
  audiences,
  sites,
  workspaceId,
  draft,
  pipeline,
  now,
}: StartTestOptions): Promise<StartedTest> => {
  const clock = now ?? ((): Date => new Date());
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
  const site = await siteForNewTest(sites, workspaceId, request.siteId);

  // The caps, read from the one module that states them and enforced **before** anything
  // runs, so a refused launch costs the site nothing — not one browser. They are checked
  // here rather than in the pipeline because the pipeline is handed no workspace and no
  // site, and after the audience because one of them is about how many people it generates.
  //
  // Nothing below consults `site.verification`. The caps take the audience's size and the
  // site's own ledger, and no third thing: a verified site and an unverified one are refused
  // and allowed at exactly the same numbers (decision 71, settled 2026-11-03).
  //
  // `engineMode` is not consulted either, and that is the point: the offline deterministic
  // engine drives the same browsers at the same site, so it is bound by the same caps. The
  // cap is about the site being driven, not about what a run costs us.
  //
  // The agents cap comes first. Both can refuse one launch — a hundred and forty people
  // against a site that has had its four runs — and this is the one the user can act on
  // without waiting, so it is the one they are told about.
  const tooManyAgents = refuseTooManyAgents(audience.size);
  if (tooManyAgents !== null) throw tooManyAgents;
  const launchedAt = clock();
  const tooManyRuns = refuseTooManyRunsThisHour(site.launches ?? [], launchedAt);
  if (tooManyRuns !== null) throw tooManyRuns;

  // **Reserved before the pipeline is called**, which is the difference between a cap and a
  // count of the runs that happened to finish. The sessions start the moment the pipeline is
  // handed the request, so that is the moment the site has taken a run:
  //
  // - four launches in flight at once each read an empty ledger if the entry is written
  //   afterwards, and all four start — four hundred browsers on a site whose cap is four.
  //   The person pressing Launch twice is the case the cap exists for.
  // - a pipeline that **throws** leaves nothing written at all if the entry comes
  //   afterwards, so a crash-retry loop walks straight through the cap.
  //
  // The run directory is not open yet, so `runId` is `null` until the pipeline reports it.
  // `id` is what makes the second write an annotation of this launch rather than a second
  // launch against the site.
  const launchId = randomUUID();
  const at = launchedAt.toISOString();
  await sites.recordLaunch(workspaceId, site.id, { id: launchId, runId: null, at });

  // What was true of the site at this instant, read **once** and only to be recorded. The
  // pipeline copies it into the artifact (#243); no cap above has read it.
  //
  // What this does not check is that the request's variants are pages **of** this site: a
  // body naming one site's id and another address's URL is counted against the site it
  // named. The product cannot send one — the wizard holds the site record it picked, and a
  // comparison runs two versions of one page — but the platform does not yet refuse it, and
  // #239 was not scoped to decide what "a variant belongs to this site" means for the
  // two-variant form. Whoever owns that next has the seam here, with the record in hand.
  const siteAtLaunch: SiteAtLaunch = {
    id: site.id,
    url: site.url,
    verifiedAtLaunch: site.verification.state === 'verified',
  };

  let started: StartedTest;
  try {
    // The concurrency is **computed here and handed over**, which is the whole of the
    // per-site concurrency cap: the swarm holds whatever bound it is given (#275), and the
    // number it is given is the caps module's. `request` is never consulted for it, so a
    // submitted body naming a concurrency of its own raises nothing — the contract declares
    // no such field, so a body that invented one is refused by the parse above rather than
    // honoured, and even a body the contract accepted would be read for no number here.
    //
    // `engineMode` is not consulted either: an offline run drives the same browsers at the
    // same site, so it is held to the same ten.
    started = await whileNothingElseRunsOnTheSite(site.id, () =>
      // The per-site cap, held down by our own ceiling where one is set
      // (`sessionsInFlight`), so the run runs at the number the estimate quoted.
      pipeline(request, audience, siteAtLaunch, sessionsInFlight()),
    );
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

  // The run the reserved launch opened, noted on the entry that is already there — before
  // the substitution check below, because a run refused for having run on the wrong model
  // still used one of the site's four.
  //
  // A failure here is **swallowed deliberately, and it is the only thing here that is**: the
  // launch is already recorded and already counted against the cap, so what a failed write
  // loses is the run id a reader would have seen beside it. Letting it throw would mean a
  // completed run — a hundred finished sessions, an artifact on disk — never reaching
  // `addRun` below, and so never being offered by the product. Bookkeeping for a cap does
  // not get to discard a run that ran.
  try {
    await sites.recordLaunch(workspaceId, site.id, { id: launchId, runId: started.runId, at });
  } catch {
    // Left where it is: the cap is intact, and the deployment's own logs carry the throw.
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
  /**
   * That same site as the **record** in this workspace that holds it, by id — what the
   * per-site caps are counted against and what the run records as the site it ran
   * (`SiteAtLaunch`).
   *
   * Optional in this type and required by `startTest`, so that the one sentence saying a
   * test names its site is written in one place rather than two. The wizard holds both
   * halves already (`apps/viewer/src/screens/newtest/wizard/draft.ts` keeps the site as
   * `{ id, url }`), so the launch step has nothing to look up.
   */
  readonly siteId?: string;
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
  SITE_ID,
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
    // Passed through as it was submitted, absent included: `startTest` is the one place that
    // says a test names its site, and it refuses an absent one at this field.
    siteId: draft.siteId,
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
 * It states **no cap number and no concurrency**. The agents-per-run cap, the hundred
 * maximum, the runs per site per hour and the typed refusal that prints them are stated in
 * `caps.ts` and enforced by `startTest` below, for this form and the two-variant one alike;
 * the per-site concurrency the pipeline is handed is #241's. A number here would be a second
 * place one could be missed.
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
    // The same clock, so the day the seed names and the hour the cap measures are one.
    return await startTest({ ...test, draft: request, now: clock });
  } catch (error) {
    // The contract's own refusals, renamed to the fields the wizard renders them against.
    if (error instanceof DraftNotAcceptedError) {
      throw new DraftNotAcceptedError(error.issues.map(asAFieldOfTheDraft));
    }
    throw error;
  }
};
