import { runRequestSchema } from '@personavision/contract';
import type { RunRequest } from '@personavision/contract';
import { CliError } from '../cli-error.js';

/**
 * `personavision run` — the same arguments the New test form submits, parsed into the
 * `RunRequest` the contract declares, and rejected the way the form's invalid state
 * rejects them (`#screen-newrun` and `#screen-newrun-invalid` in
 * `docs/design/prototype.html`, whose wording this command uses).
 *
 * It stops there. The decision engine is a later step, so a valid request exits non-zero
 * naming that step rather than writing a half-populated run directory.
 */

/** The step that runs a test. Named in the message, so the developer is not left guessing. */
const ENGINE_STEP = '#8 ("Step: Audience, persona swarm and the agent decision loop")';

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
  /** `--personas`: the audience the test is for, by id. The people are generated from it. */
  personas: string;
  repeats: string;
  seed: string;
  engine: string;
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

  if (argv.personas.trim() === '') {
    problems.push({
      argument: '--personas',
      value: argv.personas,
      message: 'Needs the id of the audience the test is for. The people are generated from it.',
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
  if (!engineMode.safeParse(argv.engine).success) {
    problems.push({
      argument: '--engine',
      value: argv.engine,
      message: `Needs one of: ${engineMode.options.join(', ')}.`,
    });
  }

  if (problems.length > 0) return { problems };

  const request = runRequestSchema.safeParse({
    task: { prompt: task },
    variants: argv.url.map((url, index) => ({ ...VARIANTS[index], url })),
    audienceId: argv.personas.trim(),
    repeats: (repeats as { parsed: number }).parsed,
    seed: (seed as { parsed: number }).parsed,
    engineMode: argv.engine,
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
  log?: (line: string) => void;
}

export const runCommand = ({
  log = (line) => process.stdout.write(`${line}\n`),
  ...argv
}: RunCommandOptions): void => {
  const parsed = parseRunRequest(argv);
  if ('problems' in parsed) {
    const { problems } = parsed;
    throw new CliError(
      [
        `The test was not started. ${problems.length} argument${problems.length === 1 ? '' : 's'} need${problems.length === 1 ? 's' : ''} attention:`,
        ...problems.map(
          (problem) =>
            `  ${problem.argument}${problem.value === '' ? '' : ` ${JSON.stringify(problem.value)}`} — ${problem.message}`,
        ),
      ].join('\n'),
    );
  }

  log('The request parses as a RunRequest:');
  log(JSON.stringify(parsed.request, null, 2));
  throw new CliError(
    [
      'The test was not started: personavision run does not run a test yet.',
      `The decision engine that drives the simulated people through a variant arrives in step ${ENGINE_STEP}.`,
      'Nothing was written: no run directory was created.',
    ].join('\n'),
  );
};
