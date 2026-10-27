import { runRequestSchema } from '@personavision/contract';
import type { RunRequest } from '@personavision/contract';

/**
 * What the New test form holds, and what has to be true of it before a test is started.
 *
 * The form's three decisions and two settings become the `RunRequest` the contract
 * declares — the same shape `personavision run` submits — so the browser invents no
 * argument of its own and a field the pipeline does not take cannot be added to this screen
 * without the contract changing first.
 *
 * The wording of every refusal is `#screen-newrun-invalid` in
 * `docs/design/prototype.html`, and `packages/cli/src/commands/run.ts` rejects the same
 * arguments with the same sentences at the command line. The two are **twins, and will have
 * to drift together**: the CLI is a Node package the browser cannot import — its barrel
 * reads files and serves them — so the only place that could hold the check once is
 * `packages/contract`, as a refinement on `runRequestSchema`. That is a contract change, not
 * a screen change: the schema is what the pipeline validates a request with, and a product
 * sentence moved into it binds every caller to this screen's copy. Worth doing deliberately,
 * by a ticket that owns the contract; the ticket that owns this screen says so instead.
 */

/** Variant A is the checkout as it stands, B the candidate; the names results carry. */
export const VARIANTS = [
  { id: 'A', name: 'Current checkout' },
  { id: 'B', name: 'Redesign candidate' },
] as const;

/** The prototype's own defaults: three repeats, and the seed the example run was made with. */
export const DEFAULT_REPEATS = 3;
export const DEFAULT_SEED = 20261024;

/**
 * Repeats per person, each with what it does to the result — the prototype's four options
 * in its own order, the default first.
 */
export const REPEAT_CHOICES: readonly { readonly repeats: number; readonly label: string }[] = [
  { repeats: 3, label: '3 — shows run-to-run spread' },
  { repeats: 1, label: '1 — fastest, no spread' },
  { repeats: 5, label: '5' },
  { repeats: 10, label: '10' },
];

/**
 * The engine a test started here runs on.
 *
 * The offline deterministic engine: no API key, and a run anybody can reproduce from the
 * seed below it. The prototype's third select offers the two model modes as well, and this
 * screen does not: whether a key is there is not something the browser can know, and which
 * mode a workspace may spend on is **#144**'s ("a customer test never falls back to
 * contributor"). The field arrives with that ticket, against a platform that can answer it.
 */
const ENGINE_MODE = 'offline';

/**
 * What the form holds. The typed fields are strings, exactly as they were typed, so nothing
 * a reader entered is lost to a parse before they have pressed Start; the repeats are a
 * number because they are chosen from a list rather than typed.
 */
export interface TestDraft {
  /**
   * The **record's** id in the audience store, which is what a test names. Empty while the
   * reader has chosen none, which is how the default survives a list that arrives late.
   */
  readonly audienceId: string;
  readonly urlA: string;
  readonly urlB: string;
  readonly task: string;
  readonly repeats: number;
  readonly seed: string;
}

/** Nothing chosen yet: the form opens on the audience the most recent test used. */
export const emptyDraft = (): TestDraft => ({
  audienceId: '',
  urlA: '',
  urlB: '',
  task: '',
  repeats: DEFAULT_REPEATS,
  seed: String(DEFAULT_SEED),
});

/**
 * The fields a refusal is rendered against, one message each. `form` is the field that does
 * not exist: a refusal no field on this screen owns is said above the form rather than
 * dropped, because a test that was not started for a reason the reader cannot see looks
 * like a bug.
 */
export type FieldKey = 'audience' | 'urlA' | 'urlB' | 'task' | 'seed' | 'form';

export type IssuesByField = Readonly<Partial<Record<FieldKey, string>>>;

/**
 * A task has to say what counts as finishing, because the simulated people stop when they
 * believe the task is done — the form's own hint. The check is a list of acts that can be
 * observed to have happened: "Buy the boots" names one, "Have a look around" names none.
 *
 * ponytail: a word list, not a parser, and the same list `personavision run` checks against.
 * If the engine ever grows a task reader, both become a call into it.
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

/** `http://` or `https://`, which is what the form's URL fields accept. */
const NEEDS_SCHEME = 'Needs a scheme: http:// or https://';

const urlProblem = (value: string): string | null => {
  if (value.trim() === '') return 'Needs the URL of this version of the page.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return NEEDS_SCHEME;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? null : NEEDS_SCHEME;
};

/** The example the invalid state offers under a task that says nothing about finishing. */
export const TASK_EXAMPLE = 'Example: “Buy the hiking boots and pay with the saved card.”';

/**
 * How many fields the reader has to look at, in the prototype's own words: *The test was
 * not started. Two fields need attention.*
 */
// Index 0 is never read — the summary is only written when a field was refused — and is
// there so that the word for a count sits at that count.
const COUNT_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five'];

export const attentionSummary = (count: number): string => {
  const named = COUNT_WORDS[count] ?? String(count);
  return count === 1
    ? `The test was not started. ${named} field needs attention.`
    : `The test was not started. ${named} fields need attention.`;
};

/** `4 people`, `1 person` — the audience's own people, which is never a session count. */
export const peopleCount = (count: number): string =>
  `${String(count)} ${count === 1 ? 'person' : 'people'}`;

export type DescribedTest =
  | { readonly ok: true; readonly request: RunRequest }
  | { readonly ok: false; readonly issues: IssuesByField };

/**
 * The request this draft describes, or the fields that stopped it.
 *
 * Nothing is started while a field is refused, and nothing typed is thrown away: the caller
 * keeps the draft and renders these messages against the fields they name.
 */
export const describedTest = (draft: TestDraft): DescribedTest => {
  const issues: Partial<Record<FieldKey, string>> = {};

  if (draft.audienceId === '') {
    issues.audience = 'Choose the audience this test runs with: the people are generated from it.';
  }

  const urlA = draft.urlA.trim();
  const urlB = draft.urlB.trim();
  const problemA = urlProblem(draft.urlA);
  const problemB = urlProblem(draft.urlB);
  if (problemA !== null) issues.urlA = problemA;
  if (problemB !== null) issues.urlB = problemB;
  // Against B, which is the version a reader changes: A is the page as it stands. Compared
  // as URLs rather than as text, so a difference only a parser can see — the case of the
  // host, an explicit `:80` — is not two versions to compare.
  if (problemA === null && problemB === null && new URL(urlA).href === new URL(urlB).href) {
    issues.urlB = 'The same URL as variant A: there would be nothing to compare.';
  }

  const task = draft.task.trim();
  if (task === '') {
    issues.task = 'Needs one sentence, in the user’s words, saying what to do.';
  } else if (!saysWhatFinishingMeans(task)) {
    issues.task =
      'The task has to say what finishing means, or nobody can be counted as having completed it.';
  }

  const seed = draft.seed.trim();
  if (!/^-?\d+$/.test(seed)) issues.seed = 'Needs a whole number.';

  if (Object.keys(issues).length > 0) return { ok: false, issues };

  const request = runRequestSchema.safeParse({
    task: { prompt: task },
    variants: [
      { ...VARIANTS[0], url: urlA },
      { ...VARIANTS[1], url: urlB },
    ],
    audienceId: draft.audienceId,
    repeats: draft.repeats,
    seed: Number(seed),
    engineMode: ENGINE_MODE,
  });
  // The checks above cover every field this form has; a refusal from the schema would be a
  // disagreement between them, reported where a reader can see it rather than thrown.
  if (request.success) return { ok: true, request: request.data };
  return {
    ok: false,
    issues: {
      form: request.error.issues[0]?.message ?? 'This test cannot be started as described.',
    },
  };
};
