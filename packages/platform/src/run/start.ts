import { runRequestSchema } from '@personavision/contract';
import type { ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import type { WorkspaceStore } from '../store/types.js';

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

/** The swarm, behind one call: handed a complete request, it answers with what it ran. */
export type TestPipeline = (request: RunRequest) => Promise<StartedTest>;

/**
 * A test that was not started, and never will be under another model.
 *
 * The standard model could not be served — no key is configured for this deployment, or
 * the provider is unavailable — so the test is refused. The alternative is what the owner
 * forbade: a result produced by the contributor model, or by the offline deterministic
 * engine, presented to a paying customer as a test of their own site.
 *
 * The message is written here in full and carries nothing from the error underneath it:
 * what reaches a screen, a response body or a log line is these words, so no key value can
 * travel inside them.
 */
export class TestRefusedError extends Error {
  /** The mode that was asked for and could not be served. */
  readonly modelMode: ModelMode;
  /** The model that could not be used, named so the Test failed screen can state it. */
  readonly modelId: string;

  constructor(modelMode: ModelMode) {
    const modelId = MODEL_ID_BY_MODE[modelMode];
    super(
      `The test was not started: the ${modelMode} model ${modelId} could not be used. Nothing was simulated — no sessions ran, no result was stored, and no other model was tried.`,
    );
    this.name = 'TestRefusedError';
    this.modelMode = modelMode;
    this.modelId = modelId;
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
  /** The workspace the test belongs to — the session's, and the one that names the mode. */
  workspaceId: string;
  draft: TestDraft;
  pipeline: TestPipeline;
}

/**
 * Whether what ran is what a standard workspace asked for.
 *
 * Only standard is checked, and it is checked on the way back as well as on the way out,
 * because the rule is about the result and not only about the request: a run that reports
 * the contributor model, or reports the offline engine, is not this customer's test. A
 * contributor workspace keeps today's behaviour — no key means offline, said plainly on the
 * screen, which is what keeps the demo and a cold start working.
 */
const servedAsAsked = (request: RunRequest, started: StartedTest): boolean =>
  request.modelMode !== 'standard' ||
  request.engineMode !== 'model' ||
  (started.engineMode === 'model' && started.modelMode === 'standard');

export const startTest = async ({
  workspaces,
  workspaceId,
  draft,
  pipeline,
}: StartTestOptions): Promise<StartedTest> => {
  const workspace = await workspaces.byId(workspaceId);
  if (workspace === null) throw new NoSuchWorkspaceError(workspaceId);

  // Parsed rather than spread together, so that what the pipeline receives is a request the
  // contract has already accepted — the mode included.
  const request = runRequestSchema.parse({ ...draft, modelMode: workspace.modelMode });

  let started: StartedTest;
  try {
    started = await pipeline(request);
  } catch (error) {
    // Provider selection refusing to serve the mode is this workspace's test being
    // refused (#143). For contributor it is not supposed to happen — no key means offline,
    // not an error — so it is left as the failure it is rather than dressed up as a
    // refusal nobody can act on.
    if (error instanceof ModelModeUnavailableError && request.modelMode === 'standard') {
      throw new TestRefusedError('standard');
    }
    throw error;
  }

  if (!servedAsAsked(request, started)) throw new TestRefusedError('standard');

  // Registered only once something ran: a refused test leaves the workspace's runs as they
  // were, so nothing in the product offers a result that does not exist.
  await workspaces.addRun(workspaceId, started.runId);
  // What ran, not what was asked for. The caller reports this and so does the artifact.
  return started;
};
