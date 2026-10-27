import { modelModeSchema, runRequestSchema } from '@personavision/contract';
import { AudienceValidationError } from '@personavision/personas';
import { CliError } from '../cli-error.js';
import { resolveAudience } from '../run/audience.js';
import { engineFailureNotice, FAILURE_CHECKS } from '../run/progress.js';
import { RunNotStartedError, RunStoppedError, startRun } from '../run/start.js';
import { readTaskSteps } from '../run/task.js';
import type { CaptureSource } from '@personavision/browser';
import type { RunRequest } from '@personavision/contract';
import type { CreateModelProvider } from '../run/engine.js';

/**
 * `personavision run` — the command that actually runs a swarm.
 *
 * It takes the same arguments the New test form submits, parses them into the `RunRequest`
 * the contract declares and rejects them the way the form's invalid state rejects them
 * (`#screen-newrun-invalid`), and then does the thing the form's submit does: composes the
 * audience, the people generated from it and the decision layer this environment can run
 * into a run directory, and prints progress as each session lands in the same words, in the
 * same order, as the Running screen (`#screen-running`).
 *
 * It is an **internal tool** — our own development, tests, demos and example audiences. A
 * user of the product starts a test through the platform (`personavision serve`), which
 * drives the same pipeline (`../run/start.ts`) so that the two produce identical run
 * directories.
 *
 * Two arguments are this command's own, beyond what the form submits:
 *
 * - `--audience <name|path>` names the audience, because there is no workspace here to
 *   resolve a stored one. `--personas <audienceId>` is the same argument under the name the
 *   published surface has always spelt it with.
 * - `--mode contributor|standard` names the model a model run calls. It defaults to
 *   `contributor`: this command is the internal one, and that content is ours to give.
 */

/**
 * Variant A is the checkout as it stands and variant B the candidate, named as the New
 * test form says they will be named in results.
 */
const VARIANTS = [
  { id: 'A', name: 'Current checkout' },
  { id: 'B', name: 'Redesign candidate' },
] as const;

/**
 * A task has to say what counts as finishing, because the simulated people stop when they
 * believe the task is done — the form's own hint. The check is a list of acts that can be
 * observed to have happened: "Buy the boots" names one, "Have a look around" names none.
 *
 * ponytail: a word list, not a parser. If the engine ever grows a task reader, this check
 * becomes a call into it.
 */
const FINISHING_ACTS = [
  'activate',
  'add',
  'apply',
  'book',
  'buy',
  'cancel',
  'check out',
  'checkout',
  'claim',
  'complete',
  'confirm',
  'create',
  'delete',
  'donate',
  'download',
  'enable',
  'finish',
  'install',
  'join',
  'log in',
  'order',
  'pay',
  'place',
  'publish',
  'purchase',
  'redeem',
  'register',
  'remove',
  'renew',
  'request',
  'reserve',
  'save',
  'schedule',
  'send',
  'sign in',
  'sign up',
  'submit',
  'subscribe',
  'update',
  'upgrade',
  'upload',
];

/** One alternation, built once: the list is literals, so there is nothing to escape. */
const FINISHING_ACT = new RegExp(`\\b(?:${FINISHING_ACTS.join('|')})\\b`);

const saysWhatFinishingMeans = (task: string): boolean => FINISHING_ACT.test(task.toLowerCase());

export interface RunCommandArguments {
  /** `--url`, repeatable: the first is variant A, the second variant B. */
  url: readonly string[];
  task: string;
  /**
   * `--audience`, or `--personas` under its published name: a committed preset, or the path
   * of a JSON file. The people are generated from whichever it resolves to.
   */
  audience: string;
  repeats: string;
  seed: string;
  /**
   * `--engine`: `offline` or `model`. Absent, a run on the standard model is a model run —
   * naming that model is naming a paying customer's test — and anything else is offline, so
   * that a key in the environment of the machine that re-ran a test cannot upgrade it.
   */
  engine?: string;
  /** `--mode`: which model a model run calls. `contributor` by default. */
  mode: string;
  /** `--steps`: a JSON file declaring the task's steps, for a task that has more than one. */
  steps?: string;
}

/** One argument the test was not started over, reported where the form reports its field. */
interface Problem {
  argument: string;
  value: string;
  message: string;
}

const integer = (
  argument: string,
  value: string,
  check: (parsed: number) => string | null,
): { parsed: number } | Problem => {
  if (!/^-?\d+$/.test(value.trim())) {
    return { argument, value, message: 'Needs a whole number.' };
  }
  const parsed = Number(value);
  const problem = check(parsed);
  return problem === null ? { parsed } : { argument, value, message: problem };
};

const isProblem = (candidate: { parsed: number } | Problem): candidate is Problem =>
  'message' in candidate;

/** `http://` or `https://`, which is what the form's URL fields accept. */
const urlProblem = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Needs a scheme: http:// or https://';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Needs a scheme: http:// or https://';
  }
  return null;
};

/**
 * The request, or every argument that stopped it. Exported so the tests read the same
 * parse the command runs.
 */
export const parseRunRequest = (
  argv: RunCommandArguments,
): { request: RunRequest } | { problems: Problem[] } => {
  const problems: Problem[] = [];

  if (argv.url.length === 0) {
    problems.push({
      argument: '--url',
      value: '',
      message: 'Needs the URL of the version to test. Pass it twice to compare two versions.',
    });
  }
  if (argv.url.length > VARIANTS.length) {
    problems.push({
      argument: '--url',
      value: argv.url.join(' '),
      message: `A test compares at most ${VARIANTS.length} versions: --url once for ${VARIANTS[0].name}, twice for ${VARIANTS[1].name} as well.`,
    });
  }
  for (const value of argv.url.slice(0, VARIANTS.length)) {
    const problem = urlProblem(value);
    if (problem !== null) problems.push({ argument: '--url', value, message: problem });
  }

  const task = argv.task.trim();
  if (task === '') {
    problems.push({
      argument: '--task',
      value: argv.task,
      message: 'Needs one sentence, in the user’s words, saying what to do.',
    });
  } else if (!saysWhatFinishingMeans(task)) {
    problems.push({
      argument: '--task',
      value: argv.task,
      message:
        'The task has to say what finishing means, or nobody can be counted as having completed it. Example: "Buy the hiking boots and pay with the saved card."',
    });
  }

  if (argv.audience.trim() === '') {
    problems.push({
      argument: '--audience',
      value: argv.audience,
      message:
        'Needs the audience the test is for: a committed preset by name, or the path of a JSON file. The people are generated from it.',
    });
  }

  const repeats = integer('--repeats', argv.repeats, (parsed) =>
    parsed > 0
      ? null
      : 'Needs to be at least 1: it is how many times each person repeats the task.',
  );
  if (isProblem(repeats)) problems.push(repeats);
  const seed = integer('--seed', argv.seed, () => null);
  if (isProblem(seed)) problems.push(seed);

  const engineMode = runRequestSchema.shape.engineMode;
  if (argv.engine !== undefined && !engineMode.safeParse(argv.engine).success) {
    problems.push({
      argument: '--engine',
      value: argv.engine,
      message: `Needs one of: ${engineMode.options.join(', ')}.`,
    });
  }
  if (!modelModeSchema.safeParse(argv.mode).success) {
    problems.push({
      argument: '--mode',
      value: argv.mode,
      message: `Needs one of: ${modelModeSchema.options.join(', ')}.`,
    });
  }
  // Naming the standard model is naming the model a paying customer's content goes to, and
  // such a test is refused rather than run on anything else — including the offline engine.
  // Asking for both in one command is a contradiction, so it is reported rather than
  // resolved in either direction.
  if (argv.engine === 'offline' && argv.mode === 'standard') {
    problems.push({
      argument: '--mode',
      value: argv.mode,
      message:
        'The standard model is what a paying customer’s test runs on, and such a test is never run on the offline engine instead. Drop --engine offline, or pass --mode contributor.',
    });
  }

  if (problems.length > 0) return { problems };

  const request = runRequestSchema.safeParse({
    task: { prompt: task },
    variants: argv.url.map((url, index) => ({ ...VARIANTS[index], url })),
    audienceId: argv.audience.trim(),
    repeats: (repeats as { parsed: number }).parsed,
    seed: (seed as { parsed: number }).parsed,
    engineMode: argv.engine ?? (argv.mode === 'standard' ? 'model' : 'offline'),
    modelMode: argv.mode,
  });
  if (request.success) return { request: request.data };
  // The checks above cover the form's fields; anything left is reported at its own path
  // rather than thrown as a stack trace.
  return {
    problems: request.error.issues.map((issue) => ({
      argument: `--${String(issue.path[0] ?? '')}`,
      value: '',
      message: issue.message,
    })),
  };
};

export interface RunCommandOptions extends RunCommandArguments {
  /** Where run directories are written — `./runs`, from where the command was run. */
  runsRoot: string;
  log?: (line: string) => void;
  /** Defaults to `process.env`; a test passes its own and touches nothing global. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Chromium over a URL by default; a test replays a committed capture set instead. */
  source?: CaptureSource;
  /** The Meta Model API provider by default; a test passes one of its own. */
  createModelProvider?: CreateModelProvider;
  now?: () => Date;
  /**
   * How the command learns it is to stop. Defaults to `SIGINT` and `SIGTERM`: the run ends
   * on the sessions already written, and a second signal gives up on the ones in flight.
   */
  onStop?: (stop: () => void) => () => void;
}

/** What the exit code says about a run somebody stopped: the conventional code for Ctrl-C. */
const STOPPED_EXIT_CODE = 130;

/** The arguments the test was not started over, as the form reports its fields. */
const notStarted = (problems: readonly Problem[]): CliError =>
  new CliError(
    [
      `The test was not started. ${problems.length} argument${problems.length === 1 ? '' : 's'} need${problems.length === 1 ? 's' : ''} attention:`,
      ...problems.map(
        (problem) =>
          `  ${problem.argument}${problem.value === '' ? '' : ` ${JSON.stringify(problem.value)}`} — ${problem.message}`,
      ),
    ].join('\n'),
  );

/**
 * A run that never started, as the Test failed screen shows it: what could not be done,
 * that nobody was simulated, the captured detail, the things to check, and what the engine
 * has to do with it.
 *
 * The same words as `#screen-error`, because the artifact the screen reads is the one this
 * command just wrote.
 */
const failedToStart = (error: RunNotStartedError): CliError =>
  new CliError(
    [
      'Test failed to start',
      `  ${error.run.failure?.reason ?? error.message}`,
      '  Nobody was simulated and no result was saved.',
      ...(error.run.failure === undefined || error.run.failure.detail === ''
        ? ['  Nothing was captured from the attempt.']
        : error.run.failure.detail.split('\n').map((line) => `  | ${line}`)),
      ...FAILURE_CHECKS.map((check) => `  - ${check}`),
      `  ${engineFailureNotice(error.run.engine)}`,
      `The failure is recorded in ${error.runDir}`,
    ].join('\n'),
  );

/** The default stop: the two signals a terminal and a test runner send. */
const onSignals = (stop: () => void): (() => void) => {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  let asked = false;
  const handle = (): void => {
    // The second signal is somebody who meant it: the sessions in flight cannot be
    // cancelled, and waiting for them is not what a person pressing Ctrl-C twice wants.
    if (asked) process.exit(STOPPED_EXIT_CODE);
    asked = true;
    process.stderr.write('\nStopping: the sessions already finished are kept.\n');
    stop();
  };
  for (const signal of signals) process.on(signal, handle);
  return () => {
    for (const signal of signals) process.off(signal, handle);
  };
};

export const runCommand = async ({
  runsRoot,
  log = (line) => process.stdout.write(`${line}\n`),
  env,
  source,
  createModelProvider,
  now,
  onStop = onSignals,
  ...argv
}: RunCommandOptions): Promise<void> => {
  const parsed = parseRunRequest(argv);
  if ('problems' in parsed) throw notStarted(parsed.problems);
  const { request } = parsed;

  // Both read before anything is written, so a test that was never going to run leaves no
  // half-made run directory behind.
  const audience = await resolveAudience(argv.audience);
  const steps = argv.steps === undefined ? null : await readTaskSteps(argv.steps);

  let stopping = false;
  const release = onStop(() => {
    stopping = true;
  });

  try {
    const started = await startRun({
      runsRoot,
      request,
      audience,
      steps,
      report: log,
      stopping: () => stopping,
      ...(env === undefined ? {} : { env }),
      ...(source === undefined ? {} : { source }),
      ...(createModelProvider === undefined ? {} : { createModelProvider }),
      ...(now === undefined ? {} : { now }),
    });
    log(started.runDir);
    if (started.stopped) {
      throw new CliError(
        `The test was stopped. ${String(started.run.progress?.finishedSessions ?? 0)} of ${String(started.run.progress?.totalSessions ?? 0)} sessions were kept in ${started.runDir}.`,
        STOPPED_EXIT_CODE,
      );
    }
  } catch (error) {
    if (error instanceof RunNotStartedError) throw failedToStart(error);
    if (error instanceof RunStoppedError) {
      throw new CliError(
        [`The test did not finish: ${error.message}`, `What it kept is in ${error.runDir}`].join(
          '\n',
        ),
      );
    }
    if (error instanceof AudienceValidationError) {
      throw new CliError(
        [
          `The test was not started: the audience "${request.audienceId}" cannot generate people.`,
          ...error.issues.map((issue) => `  ${issue.path} — ${issue.message}`),
          'Nothing was written: no run directory was created.',
        ].join('\n'),
      );
    }
    throw error;
  } finally {
    release();
  }
};
