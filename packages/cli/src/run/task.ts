import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from '../cli-error.js';
import type { TaskDefinition, TaskStep } from '@personavision/browser';
import type { Run, RunRequest } from '@personavision/contract';

/**
 * The task the swarm walks, built from what the command was given.
 *
 * A `RunRequest` carries the task as **one sentence** — it is what the New test form asks
 * for, and what the Verdict screen quotes back — while the browser step walks a task that
 * *declares* its steps: a step is recognised by a URL pattern and a required element, and
 * the control that advances it is named by a selector (#47). Nothing is inferred from a
 * page's words, so the declaration has to come from somewhere, and a request carries none.
 *
 * So there are two shapes of task here, and which one a run gets is visible in its
 * artifact's `steps`:
 *
 * - **The page as one step**, derived from the request. The simulated people open the URL,
 *   look at it in character and say what they make of it; the walk ends there, because the
 *   task declares nowhere to go next. It is what the New test form can express today, and
 *   it is what a run of an arbitrary URL is.
 * - **The steps a file declares** (`--steps`). This command is an internal tool — our own
 *   development, tests and demos — and driving a real multi-step checkout needs the real
 *   selectors. `demo/northwind/demo.config.ts` is the worked example of such a
 *   declaration.
 */

/** The id of the one step a derived task declares, and the name its screenshots go under. */
export const DERIVED_STEP_ID = 'page';

/** How that step is labelled wherever a screen or a log line names it. */
export const DERIVED_STEP_LABEL = 'The page';

/**
 * What a derived step takes as its required element. Every rendered page has one, which is
 * the point: a derived step is "this page", and a page that is on no step at all would make
 * every session an automation failure.
 */
const DERIVED_REQUIRED_SELECTOR = 'body';

/**
 * What a derived step calls its primary action: the page's first control, whichever of these
 * comes first in the document.
 *
 * A step's primary action is the control that advances it, and time to first fixation on it
 * is a headline component — so a declared task names the real one. A derived task cannot
 * know it: the request carries a sentence, and reading a control out of the page's words is
 * exactly what `packages/browser` refuses to do. The page's first control is therefore
 * marked and said to be marked, and a run that needs the real control declares its steps.
 */
const DERIVED_PRIMARY_ACTION = 'button, input[type="submit"], a[href], [role="button"]';

/** How many words of the task's sentence name a run directory and its task id. */
const ID_WORDS = 6;

/** A regular expression that matches this text and nothing else. */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `Buy the hiking boots and pay with the saved card.` → `buy-the-hiking-boots-and`.
 *
 * It is the task's id and the name of its run directory, so it is short enough to read in a
 * path and derived rather than invented. A sentence with nothing ASCII-alphanumeric in it
 * falls back to a word, because both of those have to be names the contract accepts.
 */
export const taskIdFor = (prompt: string): string =>
  prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter((word) => word !== '')
    .slice(0, ID_WORDS)
    .join('-') || 'task';

/**
 * The pattern a derived step matches: the path of every version under test, as an
 * alternation.
 *
 * One task drives both versions — the same people on the same seeds, or the comparison is
 * confounded — so the pattern has to hold for A's URL and for B's. It matches on the
 * **path** rather than the whole URL, as the demo shop's declaration does, because a step
 * reached by a form submit arrives carrying a query string.
 */
const derivedPattern = (variants: readonly { url: string }[]): string => {
  const paths = [...new Set(variants.map((variant) => new URL(variant.url).pathname))];
  return paths.length === 1
    ? escaped(paths[0] as string)
    : `(?:${paths.map((path) => escaped(path)).join('|')})`;
};

/** The one step a derived task declares: the page the request names. */
const derivedStep = (request: RunRequest): TaskStep => ({
  id: DERIVED_STEP_ID,
  label: DERIVED_STEP_LABEL,
  match: {
    urlPattern: derivedPattern(request.variants),
    requiredSelector: DERIVED_REQUIRED_SELECTOR,
  },
  primaryAction: { selector: DERIVED_PRIMARY_ACTION },
});

/**
 * The task the swarm is handed: the request's own sentence, and either the steps a file
 * declared or the one step derived from the URLs.
 */
export const taskFor = (
  request: RunRequest,
  declared: readonly TaskStep[] | null,
): TaskDefinition => ({
  id: taskIdFor(request.task.prompt),
  prompt: request.task.prompt,
  steps: declared === null ? [derivedStep(request)] : declared.map((step) => ({ ...step })),
});

/** The steps as `run.json` lists them: the id a screenshot is written under, and its label. */
export const stepsOf = (task: TaskDefinition): Run['steps'] =>
  task.steps.map((step) => ({ id: step.id, label: step.label }));

const nonEmpty = z.string().min(1);

/** One declared step, exactly as `packages/browser` declares the shape (#47). */
const stepSchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
  match: z.strictObject({ urlPattern: nonEmpty, requiredSelector: nonEmpty }),
  primaryAction: z.strictObject({ selector: nonEmpty }),
});

/**
 * What `--steps` accepts: a bare array of steps, or a whole task declaration whose `steps`
 * is one — so a file written for `demo/northwind/demo.config.ts`'s shape is read as it is.
 * The sentence stays the command's `--task`, because that is the one the artifact quotes.
 *
 * The two shapes are told apart before the steps are parsed rather than as a union of them,
 * because a union reports that the file matched neither — and what a reader needs is the
 * field of the step that is wrong.
 */
const stepsIn = (json: unknown): unknown =>
  Array.isArray(json) || json === null || typeof json !== 'object'
    ? json
    : (json as { steps?: unknown }).steps;

const stepsSchema = z.array(stepSchema).min(1);

const notSteps = (file: string, issues: readonly { path: string; message: string }[]): CliError =>
  new CliError(
    [
      `The test was not started: ${file} does not declare the task’s steps.`,
      ...issues.map((issue) => `  ${issue.path} — ${issue.message}`),
      'A step declares its id, its label, the URL pattern and required element that recognise it, and the selector of the control that advances it.',
      'Nothing was written: no run directory was created.',
    ].join('\n'),
  );

/**
 * The steps a file declares, read and validated before anything is written. Every id has to
 * be distinct: a step id names one screen of the run, and two of them would write one
 * screenshot twice.
 */
export const readTaskSteps = async (file: string): Promise<TaskStep[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new CliError(
      [
        `The test was not started: ${file} could not be read (${(error as Error).message}).`,
        'Nothing was written: no run directory was created.',
      ].join('\n'),
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw notSteps(file, [
      { path: '(the file)', message: `not JSON (${(error as Error).message})` },
    ]);
  }

  const parsed = stepsSchema.safeParse(stepsIn(json));
  if (!parsed.success) {
    throw notSteps(
      file,
      parsed.error.issues.map((issue) => ({
        path: ['steps', ...issue.path].map(String).join('.'),
        message: issue.message,
      })),
    );
  }

  const steps = parsed.data;
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw notSteps(file, [
        {
          path: `steps.${step.id}`,
          message: 'declared twice: a step id names one screen of a run',
        },
      ]);
    }
    seen.add(step.id);
  }
  return steps;
};
