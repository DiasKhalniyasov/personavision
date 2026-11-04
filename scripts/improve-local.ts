/**
 * Improve a site from a finished test, on a repository on your own machine: no GitHub App, no
 * hosted preview. `pnpm improve:local --help` prints the flags; `docs/improve-local.md` walks
 * through a whole run.
 *
 * 1. **Recommendations.** If the run has no `recommendations.json`, Muse Wonder writes them, through the
 *    same stage a run's pipeline uses (`scripts/recommendations.ts`).
 * 2. **Wonder edits the repository, one step at a time.** Every turn resends the whole
 *    conversation: the test, what each person did and thought, the recommendations, and every
 *    earlier action with its result. Wonder answers with one action: read a file, edit or write
 *    one, or finish. After each change the `--check` command runs, and its result is the next
 *    message Wonder reads, so a change that breaks the build is fixed before it is kept.
 * 3. **Before and after.** With `--serve`, the changed repository is started on a second port
 *    and the same people, on the same seeds, take the same test on it.
 * 4. **Pull request.** With `--pr`, the branch is pushed and a pull request opened with the
 *    change, its reasons and the before/after. It never merges.
 *
 * Every change lands on a new branch in a separate git worktree, never on the branch you are on.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readRun, writeRun } from '@personavision/contract';
import {
  createMetaWonderProvider,
  selectWonderProvider,
  WONDER_MODEL_ID,
} from '@personavision/provider';
import type { RunArtifact } from '@personavision/contract';
import type { WonderAsk } from '@personavision/provider';
import { recommendationsOf } from './recommendations.js';

const HELP = `pnpm improve:local <run directory> --repo <dir> --file <path>... [options]

  --repo <dir>        the git repository to change (default: this one)
  --base <branch>     the branch the change starts from (default: main)
  --file <path>       a file Wonder may read and change, relative to --repo; repeat it
  --check <command>   run in the changed worktree after every change; must exit 0 to keep it
  --turns <n>         the most actions Wonder may take (default: 16)
  --serve <command>   starts the changed site; "{port}" in it is replaced by --port
  --port <n>          the port the changed site is served on (default: 5199)
  --path <path>       the page of the changed site the test starts on (default: /)
  --pr                push the branch and open a pull request (never merges)

MODEL_API_KEY must be set: every step calls Muse Wonder, and the rerun calls Muse Spark.`;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const say = (line: string): void => void process.stdout.write(`${line}\n`);
const die = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

/** Muse Wonder on the model, refused rather than answered offline when there is no key. */
const modelWonder = () =>
  selectWonderProvider({
    requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
    createModelProvider: ({ apiKey, modelId }) => createMetaWonderProvider({ apiKey, modelId }),
  }).provider;

/* ===== what Wonder reads ================================================== */

/** The task in words: the goal's own, or the run's task however it was declared. */
const taskOf = (run: RunArtifact['run']): string =>
  run.goal?.task ?? (typeof run.task === 'string' ? run.task : run.task.prompt);

/** The run, condensed to what a person deciding a change needs: who, what they did, why. */
const describeRun = (artifact: RunArtifact): string => {
  const { run, sessions, aggregate, recommendations } = artifact;
  const all = aggregate?.funnelSlices.find((slice) => slice.key === 'all');
  const lines = [
    `Site: ${run.variants.map((variant) => variant.url).join(', ')}`,
    `Task: ${taskOf(run)}`,
    `Success means: ${run.goal?.successCriterion ?? '(none stated)'}`,
    `Audience: ${run.audience.name}; ages ${String(run.audience.ageRange.min)}-${String(run.audience.ageRange.max)}; roles ${run.audience.roles.join(', ')}; goals ${run.audience.goals.join(', ')}.`,
    all === undefined
      ? ''
      : `Outcome: ${String(all.funnel.at(-1)?.completed ?? 0)} of ${String(all.sessionCount)} succeeded.`,
    '',
    'What each person did and thought, in order:',
  ];
  for (const session of sessions) {
    lines.push(`- ${session.sessionId}: ${session.outcome.status}. ${session.outcome.reason}`);
    for (const screen of session.screens) {
      if (screen.intent)
        lines.push(`    thought: "${screen.intent}" -> ${screen.decidedAction ?? ''}`);
    }
  }
  if (recommendations !== undefined) {
    lines.push('', 'Recommendations from this test, ranked:');
    for (const recommendation of recommendations.recommendations) {
      lines.push(`- ${recommendation.id}: ${recommendation.sentence}`);
    }
  }
  return lines.join('\n');
};

interface Action {
  readonly thought: string;
  readonly action: 'read' | 'edit' | 'write' | 'done';
  readonly path: string | null;
  readonly find: string | null;
  readonly replace: string | null;
  readonly content: string | null;
  readonly title: string | null;
  readonly summary: string | null;
}

const nullableString = { type: ['string', 'null'] } as const;
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thought', 'action', 'path', 'find', 'replace', 'content', 'title', 'summary'],
  properties: {
    thought: { type: 'string' },
    action: { type: 'string', enum: ['read', 'edit', 'write', 'done'] },
    path: nullableString,
    find: nullableString,
    replace: nullableString,
    content: nullableString,
    title: nullableString,
    summary: nullableString,
  },
} as const;

const briefing = (run: string, files: readonly string[], check: string | undefined): string =>
  `You are Muse Wonder. A group of simulated people just tried a website, and you are now changing the website's own code so that the next people like them succeed.

# The test
${run}

# What you may change
These files of the site's repository, and no other: ${files.join(', ')}.
${check === undefined ? '' : `After every change, \`${check}\` runs; a failing result is shown to you and the change must be fixed before you finish.`}

# How to work
Read before you change. Make visible, concrete changes a person would notice on the page: the headline, what the product is for, who it is for, the first action to take. Ground every change in what the people above did or said. Keep the site's existing components and style. Make a few focused edits rather than rewriting everything.

Answer with exactly one action each turn, as JSON:
- {"action":"read","path":...} to see a file.
- {"action":"edit","path":...,"find":...,"replace":...} to replace one exact, unique piece of a file you have read.
- {"action":"write","path":...,"content":...} to replace a whole file.
- {"action":"done","title":...,"summary":...} when the change is finished and the check passes. The title is a pull request title; the summary says what changed and which behaviour of which person it answers.
Always fill "thought" with one sentence on why. Unused fields are null.`;

/* ===== doing an action ===================================================== */

const runCheck = (command: string, cwd: string): { ok: boolean; output: string } => {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 600_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output: output.slice(-2500) };
};

const perform = (
  action: Action,
  tree: string,
  allowed: ReadonlySet<string>,
  check: string | undefined,
): string => {
  const path = action.path ?? '';
  if (!allowed.has(path)) return `refused: ${path} is not one of the files you may change`;
  const file = join(tree, path);
  if (action.action === 'read') {
    return existsSync(file) ? readFileSync(file, 'utf8') : `${path} does not exist yet`;
  }
  if (action.action === 'edit') {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const find = action.find ?? '';
    const count = find === '' ? 0 : text.split(find).length - 1;
    if (count !== 1) {
      return `refused: "find" occurs ${String(count)} times in ${path}; it must occur exactly once`;
    }
    writeFileSync(
      file,
      text.replace(find, () => action.replace ?? ''),
    );
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, action.content ?? '');
  }
  if (check === undefined) return `${path} changed`;
  const result = runCheck(check, tree);
  return result.ok
    ? `${path} changed; the check passed`
    : `${path} changed; the check FAILED:\n${result.output}`;
};

/* ===== the loop ============================================================= */

const iterate = async (input: {
  artifact: RunArtifact;
  tree: string;
  files: readonly string[];
  check: string | undefined;
  turns: number;
}): Promise<{ title: string; summary: string; transcript: string[] }> => {
  const wonder = modelWonder();
  const brief = briefing(describeRun(input.artifact), input.files, input.check);
  const allowed = new Set(input.files);
  const transcript: string[] = [];
  let lastCheckFailed = false;
  let changed = false;

  for (let turn = 1; turn <= input.turns; turn += 1) {
    const ask: WonderAsk<Action> = {
      use: 'change',
      document: `${brief}\n\n# The conversation so far\n${transcript.join('\n\n') || '(nothing yet: start by reading)'}\n\nTurn ${String(turn)} of at most ${String(input.turns)}. Reply with only the JSON object of your next action.`,
      seed: turn,
      replySchema: { name: 'wonder_repo_action', schema: ACTION_SCHEMA },
      effort: 'medium',
      parse: (reply) => reply as Action,
      offline: () => die('improve:local needs a model: set MODEL_API_KEY'),
    };
    // A reply that drifted into prose is a turn to say so, not the end of the loop.
    const reply = await wonder.ask(ask).catch((error: unknown) => error);
    if (reply instanceof Error) {
      say(`  ${String(turn)}. (no action: ${reply.message.slice(0, 120)})`);
      transcript.push(
        `Turn ${String(turn)}, you: (a reply that was not the JSON action)\nResult: refused; answer with one JSON action only.`,
      );
      continue;
    }
    const action = (reply as { value: Action }).value;
    say(
      `  ${String(turn)}. ${action.action}${action.path === null ? '' : ` ${action.path}`}: ${action.thought}`,
    );
    if (action.action === 'done') {
      const refusal = !changed
        ? 'refused: nothing has changed yet'
        : lastCheckFailed
          ? 'refused: the last check failed; fix it first'
          : '';
      if (refusal === '') {
        return {
          title: action.title ?? 'Improve the page from a PersonaVision test',
          summary: action.summary ?? '',
          transcript,
        };
      }
      transcript.push(`Turn ${String(turn)}, you: done\nResult: ${refusal}`);
      continue;
    }
    const result = perform(action, input.tree, allowed, input.check);
    if (action.action !== 'read' && !result.startsWith('refused')) {
      changed = true;
      lastCheckFailed = result.includes('check FAILED');
    }
    const shown = { ...action, content: action.content === null ? null : '(the whole file)' };
    transcript.push(`Turn ${String(turn)}, you: ${JSON.stringify(shown)}\nResult: ${result}`);
  }
  return die(
    `Wonder did not finish within ${String(input.turns)} turns; the worktree is left as it is`,
  );
};

/* ===== before and after ===================================================== */

const completion = (artifact: RunArtifact): { done: number; of: number } => {
  const all = artifact.aggregate?.funnelSlices.find((slice) => slice.key === 'all');
  return { done: all?.funnel.at(-1)?.completed ?? 0, of: all?.sessionCount ?? 0 };
};

/** The same test, same audience and same seed, on another URL, through the CLI's own `run`. */
const rerun = async (artifact: RunArtifact, url: string): Promise<RunArtifact> => {
  const { run } = artifact;
  const audienceFile = join(root, 'runs', `.${run.runId}-audience.json`);
  writeFileSync(audienceFile, JSON.stringify(run.audience));
  const out = execFileSync(
    process.execPath,
    [
      join(root, 'packages/cli/dist/cli.js'),
      'run',
      '--site',
      url,
      '--feature',
      run.feature ?? taskOf(run),
      '--task',
      taskOf(run),
      '--criterion',
      run.goal?.successCriterion ?? '',
      '--audience',
      audienceFile,
      '--repeats',
      '1',
      '--seed',
      String(run.seedGroups[0] ?? 0),
      '--engine',
      'model',
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return readRun(out.trim().split('\n').at(-1) ?? '');
};

const serveChanged = async (command: string, cwd: string, port: number): Promise<() => void> => {
  const child = spawn(command.replaceAll('{port}', String(port)), {
    cwd,
    shell: true,
    stdio: 'ignore',
    detached: true,
  });
  for (let wait = 0; wait < 300; wait += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  return () => process.kill(-(child.pid ?? 0));
};

/* ===== the command ========================================================== */

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string', default: root },
      base: { type: 'string', default: 'main' },
      file: { type: 'string', multiple: true, default: [] },
      check: { type: 'string' },
      turns: { type: 'string', default: '16' },
      serve: { type: 'string' },
      port: { type: 'string', default: '5199' },
      path: { type: 'string', default: '/' },
      pr: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || positionals[0] === undefined) return void say(HELP);
  if (!process.env.MODEL_API_KEY) die('MODEL_API_KEY is not set');
  if (values.file.length === 0) die('name at least one --file Wonder may change');

  const runDir = resolve(positionals[0]);
  const repo = resolve(values.repo);
  let artifact = await readRun(runDir);

  if (artifact.recommendations === undefined) {
    say('Step 1: Muse Wonder writes the recommendations');
    if (artifact.aggregate === undefined) die(`${runDir} has no aggregate.json`);
    const recommendations = await recommendationsOf({
      run: artifact.run,
      sessions: artifact.sessions,
      findings: artifact.findings,
      aggregate: artifact.aggregate!,
      wonder: modelWonder(),
      report: say,
    });
    artifact = { ...artifact, recommendations };
    await writeRun(runDir, artifact);
  }

  const branch = `personavision/improve-${artifact.run.runId}`;
  const tree = join(dirname(repo), `${basename(repo)}-improve-${artifact.run.runId}`);
  say(`Step 2: Muse Wonder changes ${repo} on ${branch}, in ${tree}`);
  execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin', values.base]);
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    branch,
    tree,
    `origin/${values.base}`,
  ]);
  if (values.check !== undefined && existsSync(join(tree, 'pnpm-lock.yaml'))) {
    runCheck('pnpm install --frozen-lockfile', tree);
  }
  const change = await iterate({
    artifact,
    tree,
    files: values.file,
    check: values.check,
    turns: Number(values.turns),
  });
  writeFileSync(join(runDir, 'improve-transcript.md'), change.transcript.join('\n\n'));
  execFileSync('git', [
    '-C',
    tree,
    'add',
    '--',
    ...values.file.filter((file) => existsSync(join(tree, file))),
  ]);
  execFileSync('git', ['-C', tree, 'commit', '-q', '-m', `${change.title}\n\n${change.summary}`]);
  say(`  committed: ${change.title}`);

  let comparison = '';
  if (values.serve !== undefined) {
    say('Step 3: the same people take the same test on the changed site');
    const port = Number(values.port);
    const stop = await serveChanged(values.serve, tree, port);
    try {
      const after = await rerun(artifact, `http://127.0.0.1:${String(port)}${values.path}`);
      const [before, now] = [completion(artifact), completion(after)];
      comparison = `| | Before | After |\n|---|---|---|\n| Succeeded | ${String(before.done)} of ${String(before.of)} | ${String(now.done)} of ${String(now.of)} |\n| Run | \`${artifact.run.runId}\` | \`${after.run.runId}\` |`;
      say(
        `  before ${String(before.done)}/${String(before.of)}, after ${String(now.done)}/${String(now.of)}`,
      );
    } finally {
      stop();
    }
  }

  if (values.pr) {
    say('Step 4: pull request');
    execFileSync('git', ['-C', tree, 'push', '-q', '-u', 'origin', branch]);
    const reasons = (artifact.recommendations?.recommendations ?? [])
      .map((recommendation) => `- ${recommendation.sentence}`)
      .join('\n');
    const body = [
      change.summary,
      '## Why',
      `Muse Wonder made this change after reading test \`${artifact.run.runId}\`: ${artifact.run.audience.name}, task "${taskOf(artifact.run)}".`,
      reasons,
      comparison === '' ? '' : `## Before and after\n${comparison}`,
      'Opened by `pnpm improve:local`. It never merges; the owner does.',
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const url = execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        values.base,
        '--title',
        change.title,
        '--body',
        body,
      ],
      { cwd: tree, encoding: 'utf8' },
    ).trim();
    say(`  ${url}`);
  }
};

await main();
