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
 * How many screens a session of a **derived** task may capture: the whole visit's budget.
 *
 * A walk is capped in screens, and the swarm's own default is eight per step the task
 * declares — a sensible budget for one declared step of a checkout, where a step is one
 * screen of an errand and the next step is somewhere else to be. The one step a derived
 * task declares is not that: it stands for the **whole site**, so eight actions made every
 * session of every one-URL run eight actions long — a long landing page scrolled exactly
 * eight times, never reaching the nav, never trying a link (#413).
 *
 * Forty is a visit: room to read a page down, follow something, come back and try another.
 * It is the figure in this repository, passed as the swarm request's `maxScreens` by
 * whoever builds a request from a derived task, so that the browser and the swarm keep one
 * budget between them rather than two constants that can drift. A task that declares its
 * own steps passes none and keeps the swarm's `8 × steps.length`.
 */
export const DERIVED_STEP_SCREENS = 40;

/**
 * What a derived step takes as its required element. Every rendered page has one, which is
 * the point: a derived step is "this page", and a page that is on no step at all would make
 * every session an automation failure.
 */
const DERIVED_REQUIRED_SELECTOR = 'body';

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

/**
 * The one step a derived task declares: the page the request names, and **no primary
 * action**.
 *
 * A step's primary action is the control that advances it, and a derived step has none to
 * name: the request carries a sentence and a URL, nobody designed a control on the site
 * under test, and reading one out of the page's words is exactly what `packages/browser`
 * refuses to do. So the declaration is absent, and `resolvePrimaryAction` marks nothing.
 *
 * It used to stand a selector in — the page's first control, whichever came first in the
 * document of a button, a submit input, a link, or anything carrying a button role — and
 * that was wrong twice (#418). Where it resolved, the first such element is a visually
 * hidden skip link or an off-screen menu item as often as it is anything, and marking one as
 * "the control that advances the task" put a 35% score component on it and quoted it in the
 * session's outcome sentence. Where it did not resolve — a box of zeros, or a box no
 * extracted candidate occupied — the screen was refused as `selector_not_found`, on **every**
 * screen, so a session's two retries were spent at once and the whole session excluded. Four
 * of the owner's five real one-site runs failed every session that way.
 *
 * A task that declares its own steps is untouched: it names its real controls.
 */
const derivedStep = (request: RunRequest): TaskStep => ({
  id: DERIVED_STEP_ID,
  label: DERIVED_STEP_LABEL,
  match: {
    urlPattern: derivedPattern(request.variants),
    requiredSelector: DERIVED_REQUIRED_SELECTOR,
  },
});

/**
 * The task the swarm is handed: the request's own sentence, either the steps a file declared
 * or the one step derived from the URLs, and — where the request carries a goal — what the
 * goal says counts as having done it.
 *
 * **The criterion rides on the task** because the task is what a session is run with: one
 * object reaches `runSwarm`, `runSession` and, serialised whole, the far end of the runner
 * seam, so the criterion needs no field of its own on any of the three. It is why a
 * one-URL run's sessions can be decided by what they observed rather than by having
 * arrived: the derived step below is matched the moment the page loads, and on a run with a
 * goal that is no longer what finishes a session (#400).
 *
 * A request with no goal carries none, and such a run keeps the rule it has: the last
 * declared step is the end of the task.
 */
export const taskFor = (
  request: RunRequest,
  declared: readonly TaskStep[] | null,
): TaskDefinition => ({
  id: taskIdFor(request.task.prompt),
  prompt: request.task.prompt,
  steps: declared === null ? [derivedStep(request)] : declared.map((step) => ({ ...step })),
  ...(request.goal === undefined ? {} : { successCriterion: request.goal.successCriterion }),
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
  /**
   * The control that advances the step. Optional, as it is on `TaskStep` itself: a step a
   * file declares without one is a step that is a whole page, and nothing is marked on it
   * (#418). A file that names a control keeps every rule it had.
   */
  primaryAction: z
    .strictObject({ selector: nonEmpty, optional: z.boolean().optional() })
    .optional(),
  /**
   * What the person wants on that screen, where the file says. Optional, and the step
   * inherits the task's own sentence without it (#78): the sentence is the errand, and a
   * step goal is the thought at one screen of doing it.
   */
  goal: nonEmpty.optional(),
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
      'A step declares its id, its label, and the URL pattern and required element that recognise it. It may also declare the selector of the control that advances it — a step that declares none is a step that is a whole page — and the goal the person has on that screen.',
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
