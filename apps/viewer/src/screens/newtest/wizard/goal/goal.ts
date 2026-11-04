import { z } from 'zod';

/**
 * The goal Muse Wonder writes, asked for in one place: **`POST /runs/goal` and nothing
 * else** (`docs/FLOW.md` section 12; the provider's own call is
 * `packages/provider/src/wonder-goal.ts`).
 *
 * The browser does not write a goal and does not read a site. It states the two things the
 * ask is made of — the site's URL and the feature sentence the previous step carried — and
 * the platform answers the contract's `Goal`: the task, the success criterion, and the model
 * recorded as the last author. The observability rule, the one send-back and the refusal are
 * the provider's (`writeGoal`), so there is no second opinion in here about what counts as a
 * criterion a session can see.
 *
 * **A refusal is an answer.** Wonder twice unable to state an observable criterion comes
 * back as a `4xx` carrying the sentence `GoalCriterionError` wrote, and that sentence is
 * rendered unchanged — decision 117, as the owner settled it: a user reads both criteria and
 * what was asked for instead, rather than a short message they can learn nothing from. A
 * platform that could not be reached reads the same way on screen: the reason, and both
 * fields left for the user to write themselves, because the step is never a dead end.
 *
 * The route is `POST` and sits inside the `/runs` family beside `POST /runs/estimate`, which
 * is the other question this wizard asks about a draft: nothing is created, nothing is
 * stored, and a run directory is named for the minute it was created, so `/runs/goal` is a
 * path no run can ever answer to. It is mounted by the Muse Wonder step (#219); until then
 * the request falls through to the app and comes back as something that is not a goal, which
 * is read as a refusal and renders the two empty fields — the same place a user lands when
 * Wonder gives up, and the one state this screen must never turn into a dead end.
 */

/** The route the platform answers a goal with (#219 mounts it). */
export const GOAL_PATH = '/runs/goal';

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/**
 * The goal, as the platform answers it: the contract's own `goalSchema`, read here with the
 * three fields this screen renders and no more.
 *
 * `lastWrittenBy` is read rather than assumed, so a goal that came back naming somebody else
 * as its author is rendered as what it says it is instead of as the model's work.
 */
const answerSchema = z.object({
  task: z.string().min(1),
  successCriterion: z.string().min(1),
  lastWrittenBy: z.union([z.literal('model'), z.literal('user')]),
});

/** The two sentences and their author, exactly as the platform answered them. */
export type WrittenGoal = z.infer<typeof answerSchema>;

/**
 * What the ask answers with: the goal, or the one sentence the screen shows in its place.
 *
 * One failure and not three. A refused goal, an unreachable platform and an answer this
 * build cannot read are the same thing on this screen — a reason to read and two fields to
 * write by hand — so a caller cannot accidentally treat one of them as a dead end.
 */
export type GoalResult =
  | { readonly ok: true; readonly value: WrittenGoal }
  | { readonly ok: false; readonly reason: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The first thing wrong with what the server sent, at the place it is wrong. */
const firstViolation = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return 'it is not a goal this build can read';
  const at = issue.path.length === 0 ? 'the answer itself' : issue.path.map(String).join('.');
  return `${at}: ${issue.message}`;
};

/** A platform refusal, which states its own sentence. */
const refusalSchema = z.object({ error: z.string().optional() });

/** What one ask is made of: the site the agents are pointed at, and the user's own words. */
export interface GoalAsk {
  readonly siteUrl: string;
  readonly feature: string;
}

/**
 * Ask Muse Wonder for the goal of this draft — and ask again for another wording, which is
 * the same request: the same site and the same sentence, answered afresh.
 *
 * Nothing here throws. A step that lost its fields to an exception would be a step a user
 * cannot finish by hand, which is the one thing this screen promises.
 */
export const askForGoal = async (ask: GoalAsk): Promise<GoalResult> => {
  let response: Response;
  try {
    response = await fetch(absolute(GOAL_PATH), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ siteUrl: ask.siteUrl, feature: ask.feature }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `The goal could not be asked for: the platform could not be reached. ${reason(error)}`,
    };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      reason: response.ok
        ? 'The platform answered something that is not a goal.'
        : `The goal could not be asked for: the platform answered ${String(response.status)}.`,
    };
  }

  if (!response.ok) {
    const stated = refusalSchema.safeParse(body);
    // The platform's own sentence, shown unchanged: the refusal `GoalCriterionError` writes
    // names both criteria and what was asked for instead, and nothing here can say it better.
    return {
      ok: false,
      reason:
        (stated.success ? stated.data.error : undefined) ??
        `The goal could not be asked for: the platform answered ${String(response.status)}.`,
    };
  }

  const parsed = answerSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        reason: `The platform answered a goal this build cannot read — ${firstViolation(parsed.error)}.`,
      };
};
