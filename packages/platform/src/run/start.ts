import { runRequestSchema } from '@personavision/contract';
import type { Audience, ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import type { ModelId } from '@personavision/provider';
import { audienceForNewTest } from '../audience/freeze.js';
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
