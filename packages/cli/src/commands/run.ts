import { readFile } from 'node:fs/promises';
import {
  goalSchema,
  modelModeSchema,
  personaSchema,
  runRequestSchema,
} from '@personavision/contract';
import { z } from 'zod';
import { AudienceValidationError } from '@personavision/personas';
import {
  concurrencyForSite,
  SiteUrlNotAcceptedError,
  variantForSite,
} from '@personavision/platform';
import { CliError } from '../cli-error.js';
import { resolveAudience } from '../run/audience.js';
import { engineFailureNotice } from '../run/progress.js';
import { createMetaModelApiProvider } from '@personavision/provider';
import { RunNotStartedError, RunStoppedError, startRun } from '../run/start.js';
import { readTaskSteps } from '../run/task.js';
import type { CaptureSource } from '@personavision/browser';
import type { RunRequest } from '@personavision/contract';
import type { CreateModelProvider } from '../run/engine.js';
import type { ConcurrencyForSite } from '@personavision/platform';

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
 * It takes **two forms**, which are the product's two paths (`docs/FLOW.md` section 11):
 *
 * - **One site.** `--site` with the feature in the user's own words and the goal's two
 *   sentences — what to attempt (`--task`) and what has to be observable for it to have
 *   worked (`--criterion`). It writes a run with one variant, named for the site,
 *   and the goal records its author as `user`, because a person typed it.
 * - **Two versions compared.** `--url` once or twice, which is what sections 2 to 5
 *   describe and what this command has always done, unchanged down to its defaults.
 *
 * The two do not mix: a command naming a site *and* a version is refused with both named,
 * rather than one of them being guessed at.
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
  'find',
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

/**
 * The largest seed a run can be told apart by: what a 32-bit seeded generator can
 * distinguish.
 *
 * Past it a seed stops being a seed. `createSeededRandom` reduces one modulo 2³², so a run
 * at seed 4294967297 would be sampled at seed 1 while its artifact said otherwise — a figure
 * quoted with a number that does not reproduce it, which is the one thing a seed exists to
 * prevent. A negative seed is the same failure from the other side: −1 samples exactly as
 * 4294967295 does.
 *
 * It is declared here, where `--seed` is read, and `calibrate`'s own seeds are held to it
 * too: it is a fact about the generator, not about one command.
 */
export const MAX_SEED = 4_294_967_295;

const saysWhatFinishingMeans = (task: string): boolean => FINISHING_ACT.test(task.toLowerCase());

export interface RunCommandArguments {
  /** `--url`, repeatable: the first is variant A, the second variant B. */
  url: readonly string[];
  /**
   * `--site`: the one URL the test is of. It is what tells the two forms apart — a command
   * that names it is the one-URL form — and a command that names a site and a version too
   * is refused rather than resolved in either direction.
   */
  site?: string;
  /**
   * `--feature`: what the test is about, in the user's own words. Stored as it was typed:
   * nothing trims it or normalises it (`featureSchema`).
   */
  feature?: string;
  /**
   * `--criterion`: what has to be observable in the page for an attempt to count as a
   * success. The other half of the goal; `--task` is the half that says what to attempt.
   */
  successCriterion?: string;
  /**
   * `--task`: what the people attempt. In the one-URL form it is the **goal's task**, so it
   * is held to one sentence as well as to saying what finishing means.
   */
  task: string;
  /**
   * `--audience`, or `--personas` under its published name: a committed preset, or the path
   * of a JSON file. The people are generated from whichever it resolves to.
   */
  audience: string;
  repeats: string;
  seed: string;
  /**
   * `--concurrency`: how many sessions run at a time. Absent leaves the swarm's own default
   * for a small run, which is what this command has always driven; a number above the
   * per-site cap is **bounded to it and said so**, because how many browsers may be on a
   * site at once is a fact about the site being driven and not about who is driving it
   * (`CAPS`, `docs/FLOW.md` section 13). The platform's own runs are handed the cap by
   * `startTest`.
   */
  concurrency?: string;
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
  /** `--people`: a JSON file of hand-written personas, run instead of the generated ones. */
  people?: string;
  /**
   * `--gaze-examples`: narrated eye-tracking sessions of real people (the gaze-example.txt
   * files `.local/eyetrack/narrate.py` writes), shown to a model run as how real eyes move.
   */
  gazeExamples?: readonly string[];
}

/** What a model run is told before the real people's sessions it is given. */
const GAZE_EXAMPLES_HEADER = [
  'How real people’s eyes moved on websites, from an eye-tracking study with a webcam tracker. Each line is one fixation: how long it lasted, what kind of look it was, where on the screen, what they saw and what they thought; their taps and scrolls are in between.',
  'They are not you. Copy how eyes behave — where they land first, the quick glances that take nothing in, what pulls them off-task, coming back to check — not what these people looked at or thought: you have your own profile, task and screen.',
  'Real eyes make more looks than two to ten: report as many as your eyes would really make on the screen, up to twenty, most of them short.',
].join('\n');

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

/**
 * A sentence of the goal that is more than one sentence, reported at the flag that carries
 * it. The contract holds each half of a goal to one sentence (`docs/FLOW.md` section 12),
 * and the request's own rejection would name `goal.task` — so it is checked here, where the
 * flag a reader typed can be named back to them rather than a `--goal` nobody passed.
 */
const notOneSentence = (
  argument: string,
  value: string,
  schema: typeof goalSchema.shape.task,
): Problem | null => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  return { argument, value, message: parsed.error.issues[0]?.message ?? 'Needs one sentence.' };
};

/**
 * A refusal written elsewhere, in the shape this command's refusals are read in: the
 * platform's site messages are clauses of a longer sentence ("a site is an http:// or
 * https:// URL"), and every problem printed here is a sentence of its own.
 */
const sentence = (message: string): string =>
  `${message.charAt(0).toUpperCase()}${message.slice(1)}${message.endsWith('.') ? '' : '.'}`;

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
): { request: RunRequest; concurrency?: ConcurrencyForSite } | { problems: Problem[] } => {
  const problems: Problem[] = [];
  /** Which form this is: the one that names a site, or the one that names versions. */
  const site = argv.site?.trim() ?? '';
  const oneUrl = site !== '';
  /** The one variant of a one-URL run, once its URL has been accepted. */
  let variant: RunRequest['variants'][number] | null = null;

  if (!oneUrl) {
    if (argv.url.length === 0) {
      problems.push({
        argument: '--url',
        value: '',
        message:
          'Needs the URL of the version to test, or --site with the feature and the goal to test one site. Pass --url twice to compare two versions.',
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
  } else if (argv.url.length > 0) {
    // Both forms at once. One site and two versions are two different tests, and which was
    // meant is not something to guess at — so both are named back, with what they were
    // given, rather than one of them being quietly dropped.
    problems.push({
      argument: '--site',
      value: site,
      message: `A test is of one site or of versions compared, and this names both: --site ${site} and --url ${argv.url.join(' ')}. Drop whichever the test is not.`,
    });
  } else {
    // `variantForSite` is the platform's own (#282): the command line and the New test form
    // accept the same addresses, refuse the rest in the same words, and write the one
    // variant a one-URL test runs — `site`, named for the host — under one spelling rather
    // than two. `site` and not `A`, because `A` promises a `B` that a run of one site has
    // not got.
    try {
      variant = variantForSite(site);
    } catch (error) {
      if (!(error instanceof SiteUrlNotAcceptedError)) throw error;
      problems.push({ argument: '--site', value: site, message: sentence(error.message) });
    }
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
  } else if (oneUrl) {
    // In this form the sentence *is* the goal's task, and a goal is two sentences and not
    // two paragraphs.
    const problem = notOneSentence('--task', task, goalSchema.shape.task);
    if (problem !== null) problems.push(problem);
  }

  // The feature and the goal: what makes one URL a test rather than a comparison. Both are
  // asked for only in that form, so the two-variant command is held to exactly what it
  // always was.
  const criterion = argv.successCriterion ?? '';
  if (oneUrl) {
    if ((argv.feature ?? '').trim() === '') {
      problems.push({
        argument: '--feature',
        value: argv.feature ?? '',
        message:
          'Needs the feature the test is about, in your own words — "generating a video from a prompt", "checking out with a promo code". It is stored as you type it.',
      });
    }
    if (criterion.trim() === '') {
      problems.push({
        argument: '--criterion',
        value: criterion,
        message:
          'Needs what has to be observable in the page for an attempt to count as a success: a visible element, a URL, a piece of text. Not a judgement and not a feeling.',
      });
    } else {
      const problem = notOneSentence('--criterion', criterion, goalSchema.shape.successCriterion);
      if (problem !== null) problems.push(problem);
    }
  } else {
    // The same refusal from the other side: these two describe the one site under test, and
    // a flag that is read in one form and silently dropped in the other is a flag that lies
    // about what the run recorded.
    for (const [argument, value] of [
      ['--feature', argv.feature],
      ['--criterion', argv.successCriterion],
    ] as const) {
      if (value === undefined) continue;
      problems.push({
        argument,
        value,
        message:
          'Describes the one site a test is of: pass --site with it, or drop it. A comparison of versions has the versions as its subject.',
      });
    }
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
  const seed = integer('--seed', argv.seed, (parsed) =>
    parsed >= 0 && parsed <= MAX_SEED
      ? null
      : `Needs to be 0..${String(MAX_SEED)}: past that a seed is reduced to one inside it, and the run would record a number that does not reproduce it.`,
  );
  if (isProblem(seed)) problems.push(seed);

  // Bounded rather than refused: a developer who asks for fifty is asking for a faster run,
  // not for a cap to move, and the run they get is the one the product allows. The sentence
  // that says so is the platform's, so the terminal and a screen say the same thing.
  let concurrency: ConcurrencyForSite | undefined;
  if (argv.concurrency !== undefined) {
    const asked = integer('--concurrency', argv.concurrency, (parsed) =>
      parsed > 0 ? null : 'Needs to be at least 1: it is how many sessions run at a time.',
    );
    if (isProblem(asked)) problems.push(asked);
    else concurrency = concurrencyForSite(asked.parsed);
  }

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
    variants:
      variant === null ? argv.url.map((url, index) => ({ ...VARIANTS[index], url })) : [variant],
    // A person typed this goal, so `user` is who last wrote it: the author is what a
    // completion rate is read against a month later (`docs/FLOW.md` section 12).
    ...(oneUrl
      ? {
          feature: argv.feature,
          goal: { task, successCriterion: criterion, lastWrittenBy: 'user' },
        }
      : {}),
    audienceId: argv.audience.trim(),
    repeats: (repeats as { parsed: number }).parsed,
    seed: (seed as { parsed: number }).parsed,
    engineMode: argv.engine ?? 'model',
    modelMode: argv.mode,
  });
  if (request.success) {
    return { request: request.data, ...(concurrency === undefined ? {} : { concurrency }) };
  }
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
      // Only the checks this failure is about: the prototype's three are about a page that
      // could not be opened, and printing them under a missing credential would send a
      // reader to look at a URL that was never the problem.
      ...error.checks.map((check) => `  - ${check}`),
      `  ${engineFailureNotice(error.run.engine)}`,
      `The failure is recorded in ${error.runDir}`,
    ].join('\n'),
  );

/**
 * The default stop: the two signals a terminal and a test runner send.
 *
 * **It never exits the process itself.** The sessions in flight cannot be cancelled — a page
 * operation in Chromium is not interruptible — and exiting from under them would abandon the
 * write of `run.json` that is in flight at every session boundary, leaving a truncated file
 * and a directory nobody can read. That is the opposite of what the line above it promises,
 * so the wait is honoured instead: every session is capped, so the wait is a bounded one, and
 * the second signal says how long it can be rather than cutting a write in half.
 */
const onSignals = (stop: () => void): (() => void) => {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  let asked = false;
  const handle = (): void => {
    if (asked) {
      process.stderr.write(
        'Still stopping: a session in Chromium cannot be cancelled, so the ones in flight are being waited for. Each ends at its own cap, within a minute of when it started.\n',
      );
      return;
    }
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
  const { request, concurrency } = parsed;
  // Said before the run starts, not after: a developer whose fifty became the cap should be
  // told as the run opens, rather than left to count the sessions and work it out.
  const lowered = concurrency?.lowered ?? null;
  if (lowered !== null) log(lowered);

  // Both read before anything is written, so a test that was never going to run leaves no
  // half-made run directory behind.
  const audience = await resolveAudience(argv.audience);
  const steps = argv.steps === undefined ? null : await readTaskSteps(argv.steps);
  const people =
    argv.people === undefined
      ? undefined
      : z
          .array(personaSchema)
          .min(1)
          .parse(JSON.parse(await readFile(argv.people, 'utf8')));
  const gazeExamples =
    argv.gazeExamples === undefined || argv.gazeExamples.length === 0
      ? undefined
      : [
          GAZE_EXAMPLES_HEADER,
          ...(await Promise.all(argv.gazeExamples.map((f) => readFile(f, 'utf8')))),
        ].join('\n\n');
  const modelProvider: CreateModelProvider | undefined =
    createModelProvider ??
    (gazeExamples === undefined
      ? undefined
      : // More looks are a longer answer: a call gets two minutes rather than one.
        ({ apiKey, modelMode }) =>
          createMetaModelApiProvider({
            mode: modelMode,
            apiKey,
            gazeExamples,
            timeoutMs: 120_000,
          }));

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
      ...(concurrency === undefined ? {} : { concurrency: concurrency.concurrency }),
      ...(people === undefined ? {} : { people }),
      report: log,
      stopping: () => stopping,
      ...(env === undefined ? {} : { env }),
      ...(source === undefined ? {} : { source }),
      ...(modelProvider === undefined ? {} : { createModelProvider: modelProvider }),
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
