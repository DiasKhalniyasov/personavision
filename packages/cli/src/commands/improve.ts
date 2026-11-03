import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLiveSource } from '@personavision/browser';
import { readRun, runRequestSchema, SCHEMA_VERSION, writeRun } from '@personavision/contract';
import { aggregate } from '@personavision/engine';
import { createGitHubClient, runImproveLoop } from '@personavision/improve';
import { generateHoldout } from '@personavision/personas';
import {
  createMetaWonderProvider,
  ModelModeUnavailableError,
  selectWonderProvider,
  WONDER_MODEL_ID,
} from '@personavision/provider';
import { planSwarm, runSwarm } from '@personavision/swarm';
import { CliError } from '../cli-error.js';
import { openRunRecord } from '../run/artifact.js';
import { selectEngine } from '../run/engine.js';
import { reportLine } from '../run/progress.js';
import { taskFor } from '../run/task.js';
import type { CaptureSource, TaskStep } from '@personavision/browser';
import type { Run } from '@personavision/contract';
import type {
  ComparisonDriven,
  ComparisonRequest,
  GitHubTokenSource,
  ImproveResult,
} from '@personavision/improve';
import type { ChangeFile, WonderProvider } from '@personavision/provider';
import type { CreateModelProvider } from '../run/engine.js';

/**
 * `personavision improve <runId>` — path 2's closed loop, as one command.
 *
 * It takes a finished path-1 run in `./runs` and does the whole of `docs/FLOW.md` section 15
 * on the connected repository: decides one change, opens it as a pull request, finds the URL
 * the changed version is served at, drives the baseline and the change on the same people and
 * the same seeds plus a holdout, scores the before and after, writes the run and posts one
 * comment on the pull request. It reports each step the way `personavision run` reports each
 * session, and **its exit status says whether the loop finished**: 0 when it did, 3 when a
 * step stopped it, and the sentence names which step and why.
 *
 * The order, the refusals and the idempotence are `@personavision/improve`'s
 * (`packages/improve/src/loop.ts`). What this file owns is the two things the loop is handed
 * and does not reach for itself:
 *
 * - **The comparison.** The swarm, the browser and the people — `generateHoldout` for the
 *   people the change was never chosen against, `runSwarm` for both sides and the holdout in
 *   one run, `aggregate` for the per-area figures the scoring reads. The loop declares this as
 *   a seam so that `@personavision/improve` reaches neither Playwright nor the audience
 *   generator, and so that a test of the loop is a test of the order.
 * - **The credential.** The installation token is read from the file `--token-file` names, at
 *   call time, every call, and goes straight into the client's one `Authorization` header. It
 *   is never written to the run, the progress output, a log line or an error — and it is read
 *   from a **file** rather than an environment variable or an argument, so it is in neither
 *   this process's environment nor the shell's history.
 *
 * **Run `--dry-run` first against a real repository.** It reports the change it would open,
 * the file, the diff and the preview it would look for, and makes no write call at all.
 */

/** What the exit status says: a loop a step stopped is not a loop that failed to start. */
export const IMPROVE_EXIT_CODES = Object.freeze({
  /** The arguments, the run directory or the repository: nothing was attempted. */
  notStarted: 1,
  /** The loop ran and a step stopped it. The sentence names the step and the reason. */
  stopped: 3,
});

/** A sensible ceiling for a comparison driven from the command line. */
const DEFAULT_CONCURRENCY = 4;

export interface ImproveCommandArguments {
  /** The finished path-1 run to improve, by its directory name under `./runs`. */
  runId: string;
  /** `--repository owner/name`: the repository the GitHub App is installed on. */
  repository?: string;
  /** `--base`: the branch the pull request is opened against. Read only. */
  base: string;
  /** `--file`, repeatable: the files in the repository the change may touch. */
  file: readonly string[];
  /** `--token-file`: the file holding the installation token, read at call time. */
  tokenFile?: string;
  /** `--dry-run`: report what it would do and write nothing. */
  dryRun?: boolean;
  /** `--run-url`: where the run is on the platform; the comment links to it. */
  runUrl?: string;
  /** `--engine`: `offline` or `model`, as `personavision run` reads it. */
  engine?: string;
  /** `--mode`: which model a model run calls. */
  mode: string;
  /** `--steps`: a JSON file declaring the task's steps, when the run's own are not enough. */
  steps?: string;
  concurrency?: number;
}

export interface ImproveCommandOptions extends ImproveCommandArguments {
  /** Where run directories sit — `./runs`, from where the command was run. */
  runsRoot: string;
  log?: (line: string) => void;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Chromium over a URL by default; a test replays a committed capture set instead. */
  source?: CaptureSource;
  /** The Meta Model API provider by default; a test passes one of its own. */
  createModelProvider?: CreateModelProvider;
  /**
   * The installation token, instead of `--token-file`. The platform (#319) passes its own
   * minting function; a test passes a string that is not a credential.
   */
  token?: GitHubTokenSource;
  /** Muse Wonder, instead of the selection. A test passes the offline implementation. */
  wonder?: WonderProvider;
  /** How a GitHub call is sent. A test passes the recorded transport and reaches no network. */
  transport?: Parameters<typeof createGitHubClient>[0]['transport'];
  now?: () => Date;
  /** The preview's caps and the probe that asks the URL; a test passes one that answers. */
  preview?: Parameters<typeof runImproveLoop>[0]['preview'];
  /** The task's steps, already read. */
  taskSteps?: readonly TaskStep[] | null;
}

/**
 * The task's steps: the ones `--steps` names, or the ones the source run recorded itself.
 *
 * A run that said how to reproduce itself said how each of its steps is recognised and what
 * advances it (`reproduce.steps`), and a comparison of two versions walks the same steps the
 * test did — so a path-2 run of such a run needs no `--steps` at all. A run that carries no
 * recipe falls back to the page as the task's single step, which is `run`'s own default.
 */
const stepsFor = (
  source: Run,
  given: readonly TaskStep[] | null | undefined,
): readonly TaskStep[] | null => {
  if (given !== undefined && given !== null) return given;
  const recorded = source.reproduce?.steps;
  if (recorded === undefined) return null;
  return recorded.map((step) => ({
    id: step.id,
    label: step.label,
    match: { urlPattern: step.urlPattern, requiredSelector: step.requiredSelector },
    primaryAction: { selector: step.primaryActionSelector },
    ...(step.goal === undefined ? {} : { goal: step.goal }),
  }));
};

/** `owner/name`, or the sentence that says what it has to be. */
const repositoryOf = (spelling: string): { owner: string; repo: string } => {
  const [owner = '', repo = '', ...rest] = spelling.split('/');
  if (owner === '' || repo === '' || rest.length > 0) {
    throw new CliError(
      `--repository ${JSON.stringify(spelling)} is not a repository: pass owner/name, as GitHub spells one.`,
      IMPROVE_EXIT_CODES.notStarted,
    );
  }
  return { owner, repo };
};

/**
 * The token, read from its file at call time rather than held.
 *
 * It is a function and not a string, so that the file is read for each call the client makes:
 * an installation token is good for an hour, and the file is the one place its value lives.
 * Nothing here logs it, returns it or puts it in an error — a file that cannot be read is
 * reported by its path.
 */
const tokenFromFile =
  (file: string): GitHubTokenSource =>
  async () => {
    const token = await readFile(file, 'utf8').catch(() => {
      throw new CliError(
        `the installation token could not be read from ${file}: --token-file names the file holding it, and its contents are never printed.`,
        IMPROVE_EXIT_CODES.notStarted,
      );
    });
    return token.trim();
  };

/** Muse Wonder, offline unless a model was asked for. */
const wonderFor = (
  engine: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): WonderProvider => {
  try {
    return selectWonderProvider({
      ...(env === undefined ? {} : { env }),
      requestedMode:
        engine === 'model' ? { mode: 'model', modelId: WONDER_MODEL_ID } : ('offline' as const),
      createModelProvider: ({ apiKey, modelId }) => createMetaWonderProvider({ apiKey, modelId }),
    }).provider;
  } catch (error) {
    if (!(error instanceof ModelModeUnavailableError)) throw error;
    throw new CliError(
      `The change this loop would open could not be decided: ${error.message}`,
      IMPROVE_EXIT_CODES.notStarted,
    );
  }
};

export const improveCommand = async (options: ImproveCommandOptions): Promise<ImproveResult> => {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.now ?? ((): Date => new Date());
  const dryRun = options.dryRun ?? false;

  if (options.repository === undefined) {
    throw new CliError(
      'The loop was not started: --repository owner/name names the repository the PersonaVision GitHub App is installed on, and there is no workspace here to read a connection from.',
      IMPROVE_EXIT_CODES.notStarted,
    );
  }
  const repository = repositoryOf(options.repository);
  if (options.file.length === 0) {
    throw new CliError(
      'The loop was not started: --file names a file in the repository the change may touch, and a change touches one file its recommendation named. Pass it once per candidate file.',
      IMPROVE_EXIT_CODES.notStarted,
    );
  }
  const token =
    options.token ??
    (options.tokenFile === undefined ? undefined : tokenFromFile(options.tokenFile));
  if (token === undefined) {
    throw new CliError(
      'The loop was not started: --token-file names the file holding the installation token for the GitHub App. It is read at call time and never printed.',
      IMPROVE_EXIT_CODES.notStarted,
    );
  }

  const sourceDir = join(options.runsRoot, options.runId);
  const artifact = await readRun(sourceDir).catch((error: unknown) => {
    throw new CliError(
      `${sourceDir} is not a run this loop can read: ${error instanceof Error ? error.message : String(error)}`,
      IMPROVE_EXIT_CODES.notStarted,
    );
  });
  const source = artifact.run;
  if (source.status === 'failed') {
    throw new CliError(
      `${options.runId} failed to start, so it simulated nobody and recommended nothing: there is no change to decide from it.`,
      IMPROVE_EXIT_CODES.notStarted,
    );
  }
  const recommendations = artifact.recommendations?.recommendations ?? [];

  const client = createGitHubClient({
    token,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });

  // The files the change may touch, read from the repository rather than from this machine:
  // the patch has to apply to what the repository holds, which is the only copy that counts.
  const base = await client.readBranch(repository, options.base);
  const files: ChangeFile[] = [];
  for (const path of options.file) {
    const held = await client.readFile(repository, { path, ref: base.sha });
    files.push({ path: held.path, text: held.text });
  }

  const result = await runImproveLoop({
    runsRoot: options.runsRoot,
    source: { runId: options.runId, run: source, recommendations },
    repository,
    baseBranch: options.base,
    files,
    wonder: options.wonder ?? wonderFor(options.engine, options.env),
    client,
    drive: comparisonDriver(options, clock, stepsFor(source, options.taskSteps)),
    runUrl: (runId) =>
      options.runUrl ?? `https://app.personavision.local/runs/${encodeURIComponent(runId)}`,
    report: log,
    dryRun,
    ...(options.preview === undefined ? {} : { preview: options.preview }),
  });

  if (result.kind === 'stopped') {
    throw new CliError(
      [
        `The loop stopped at the ${result.step} step.`,
        `  ${result.reason}`,
        ...(result.pullRequest === undefined
          ? []
          : [
              `  Pull request #${String(result.pullRequest.number)} is ${result.pullRequest.state} at ${result.pullRequest.url} and stays open: nothing about it was undone.`,
            ]),
        ...(result.run === undefined ? [] : [`  What it recorded is in ${result.runDir}`]),
      ].join('\n'),
      IMPROVE_EXIT_CODES.stopped,
    );
  }
  if (result.kind === 'finished') log(result.runDir);
  return result;
};

/**
 * The comparison: the baseline, the change and the holdout in one run.
 *
 * It is the one part of path 2 that reaches the swarm, and so Chromium, which is why the loop
 * takes it as a seam. The people and the seeds are the source run's **by value** — the same
 * audience and the same seeds, so the comparison is like for like (`docs/FLOW.md` section 15,
 * point 4) — and the holdout is generated from that same audience on seeds the change was
 * never chosen against, with the run's own seed groups spent.
 *
 * The open run it writes carries the holdout's people in `personas` and in
 * `improve.holdout.personaIds`, because the contract counts a path-2 run's people as the
 * participants plus the people held out beside them. `confirmed` is left `null` until scoring
 * has judged it, which is the loop's own last step.
 */
const comparisonDriver =
  (options: ImproveCommandOptions, clock: () => Date, steps: readonly TaskStep[] | null) =>
  async (request: ComparisonRequest): Promise<ComparisonDriven> => {
    const source = request.source;
    const personas = source.personas;
    const seedGroups = source.seedGroups;
    const holdout = generateHoldout({ audience: source.audience, spentSeeds: seedGroups });
    const variants = [
      { id: request.baseline.id, url: request.baseline.url },
      { id: request.change.id, url: request.change.url },
    ];
    // The same request shape `personavision run` is parsed into, so the task, the steps and
    // the engine of a path-2 comparison are resolved by exactly the code a path-1 run's are.
    const runRequest = runRequestSchema.parse({
      task: { prompt: source.task.prompt },
      variants: [{ ...request.baseline }, { ...request.change }],
      audienceId: source.audience.id,
      repeats: Math.max(1, seedGroups.length),
      seed: seedGroups[0] ?? 1,
      engineMode: options.engine === 'model' ? 'model' : 'offline',
      modelMode: options.mode,
    });
    const task = taskFor(runRequest, steps);
    const selected = selectEngine({
      request: runRequest,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.createModelProvider === undefined
        ? {}
        : { createModelProvider: options.createModelProvider }),
    });
    request.report(`  ${selected.reason}`);

    const plan = planSwarm({ variants, personas, seedGroups, holdout });
    const open: Run = {
      ...openRunRecord(
        {
          runId: request.runId,
          createdAt: clock(),
          task,
          variants: [{ ...request.baseline }, { ...request.change }],
          audience: source.audience,
          // The holdout's people are the run's own personas too: the contract counts a
          // path-2 run's people as its participants plus the people held out beside them.
          personas: [...personas, ...holdout.personas],
          seedGroups,
          engine: selected.engine,
        },
        {
          totalSessions: plan.length,
          perVariant: variants.map((variant) => ({
            variant: variant.id,
            totalSessions: plan.filter((session) => session.variant.id === variant.id).length,
          })),
        },
      ),
      improve: {
        ...request.improve,
        // Who ran. Whether the holdout confirmed the gain is scoring's answer, and the loop
        // writes it once the run is scored — the contract takes `null` for "not judged yet".
        holdout: { personaIds: holdout.personas.map((person) => person.id), confirmed: null },
      },
    };
    await writeRun(request.runDir, {
      run: { ...open, verdict: { ...open.verdict, holdout: 'none' } },
      sessions: [],
      findings: { schemaVersion: SCHEMA_VERSION, runId: request.runId, findings: [] },
    });

    const walked = await runSwarm({
      runDir: request.runDir,
      variants,
      personas,
      seedGroups,
      holdout,
      task,
      source: options.source ?? createLiveSource(),
      providers: { decision: selected.provider },
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      now: clock,
      onProgress: async (event) => {
        if (event.kind !== 'session-finished') return;
        const run = await readRun(request.runDir).then(
          (held) => held.run,
          () => null,
        );
        const entry = run?.progress?.sessions.find(
          (landed) => landed.sessionId === event.sessionId,
        );
        request.report(
          run === null || entry === undefined
            ? `  ${String(event.finishedSessions)} of ${String(event.totalSessions)} people are done`
            : `  ${reportLine(run, entry)}`,
        );
      },
    });

    return {
      run: walked.run,
      sessions: walked.sessions,
      aoiMetrics: aggregate(walked.sessions, walked.run.aois),
      holdoutPersonaIds: walked.holdoutPersonaIds,
    };
  };
