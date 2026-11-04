import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GoalCriterionError,
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  WonderCallError,
  WonderReplyError,
  writeGoal,
} from '@personavision/provider';
import { AudienceNotOfferedError } from '../../audience/freeze.js';
import { CapRefusedError } from '../../caps.js';
import {
  DraftNotAcceptedError,
  NoSuchSiteError,
  seedForLaunchDay,
  startSiteTest,
  startTest,
  TestRefusedError,
} from '../../run/start.js';
import type { SiteTestDraft, TestDraft, TestPipeline } from '../../run/start.js';
import { parseSiteUrl, SiteUrlNotAcceptedError } from '../../site/site.js';
import type { PlatformStore, SessionRecord } from '../../store/types.js';
import { wonderFromEnv } from './audiences.js';
import type { WonderSeam } from './audiences.js';
import { notImplemented, readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * `POST /runs` — starting a test.
 *
 * The New test screen's one request (#110, merged): the `RunRequest` the contract declares,
 * answered with the id of the run directory the platform opened, or refused with a sentence
 * the form renders above itself with everything typed still in it. No route is invented
 * here — `/runs` is the run family `docs/FLOW.md` section 3 lists, and the screen that calls
 * this shipped already.
 *
 * Everything this decides is `startTest`'s: the mode comes off the workspace and nothing in
 * the body can name it, the audience is resolved against the workspace that asked, and a
 * standard workspace whose test cannot run on the standard model is refused rather than
 * answered by another (#144). This route is the HTTP skin on that, and the status codes.
 *
 * **Two forms, one route and one run.** A submission naming its `variants` is the
 * two-variant comparison, unchanged down to its refusals; anything else is read as the
 * one-URL test the New test wizard collects (#273, #276, #279) — the site, the feature in
 * the user's words, the goal as they approved it and the audience. Both answer with
 * the id of one run directory: a path-1 test is a run with one variant and a path-2 test is
 * a run with two, and nothing here branches on a "path" (the auto-decision of 2026-11-03 on
 * #222).
 *
 * The swarm itself is #54. Until it lands, `personavision serve` passes no pipeline and this
 * answers 501 naming that ticket, so a screen built against it fails loudly.
 *
 * **`POST /runs/goal`** is the family's other question about a draft (#397, `docs/FLOW.md`
 * section 12): the site's URL and the feature sentence in, the two sentences Muse Wonder
 * wrote out. It creates nothing, stores nothing and needs no pipeline — a goal is what the
 * goal step shows a user *before* there is a run — and it sits here rather than in a file of
 * its own because `docs/FLOW.md` section 3 lists the `/runs` family and section 8 says the
 * routes are not invented per ticket. It is listed **first** below, so `goal` is never read
 * as the id of a run.
 */

export interface RunRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /** The swarm (#54). Absent means this deployment cannot run a test at all. */
  pipeline?: TestPipeline;
  /**
   * How `POST /runs/goal` reaches Muse Wonder. Absent — as it is in `personavision serve` —
   * means the shipped selection over this process's own environment: the model where
   * `MODEL_API_KEY` is set, and a refusal in words where it is not. It is the same seam the
   * audience routes select through, so a deployment reaches one Wonder and a test replaces
   * one implementation.
   */
  wonder?: WonderSeam;
}

/**
 * The one sentence a request with no session gets from this family. The guard in front of
 * the routes answers a real request first, with the sentence it gives every signed-out data
 * request; this is what a handler reached directly says, so neither route depends on
 * something above it having run.
 */
const SIGNED_OUT = 'Sign in to start a test.';

/** The ticket that runs a test, named in the 501 so the developer is not left guessing. */
const ENGINE_TICKET = 54;

const started = (response: ServerResponse, runId: string): void =>
  sendJson(response, 201, { runId });

/**
 * A test that was not started, as `{ error }` — the shape the New test screen reads, whose
 * `error` is the sentence it puts above the form.
 *
 * Every sentence here is written in this package. Nothing from an error thrown underneath
 * it is interpolated, so no key value can travel out through this body (#144).
 */
const refuse = (response: ServerResponse, status: number, error: string, extra = {}): void =>
  sendJson(response, status, { error, ...extra });

/**
 * Which of the two forms was submitted: a comparison **names its `variants`** and a test of
 * one site does not.
 *
 * Read off `variants` rather than off `site`, because the site is the field most likely to
 * be missing from a one-URL submission — a launch step serialising a draft whose site was
 * never chosen leaves the key out altogether — and such a draft has to be refused at `site`
 * rather than answered with a page of refusals about `task` and `variants`, which are the
 * fields the New test wizard cannot render. A submission naming both is two forms at once,
 * and the one-URL path refuses it with the `variants` it found named rather than guessing
 * which half was meant. `variants` is required of a comparison by the contract, so a body
 * that names none was never one.
 */
const namesTwoVersions = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'variants' in body && !('site' in body);

/**
 * The goal route's own path. It is matched **before** every other route of this family, and
 * it is spelt with its own anchored pattern rather than captured: a run directory is named
 * for the minute it was created (`docs/FLOW.md` section 3), so `/runs/goal` is a path no run
 * can answer to — and the order is what keeps that true of a `/runs/:runId` route somebody
 * adds later rather than a coincidence of today's patterns.
 */
const GOAL_PATH = /^\/runs\/goal$/;

/** The two fields of the wizard a refusal about the ask is rendered against. */
const SITE_URL = 'siteUrl';
const FEATURE = 'feature';

/**
 * What the goal step prints in place of the two sentences when Wonder could not be reached
 * at all: no key where the platform runs, or a call that never came back.
 *
 * It names the key and it names the way on, because both are things the reader can act on —
 * the owner of the deployment sets `MODEL_API_KEY`, and the person at the screen writes the
 * task and the criterion themselves. The goal step is finishable with no key, which is what
 * the screen's single failure shape is for, and it is the sentence decision 161 settles for
 * both steps that ask Wonder anything.
 *
 * **It is written here and nothing thrown is interpolated into it** (#144): what the
 * selection and the model client throw is written for whoever runs the server, and one of
 * their sentences is about a credential.
 */
const WONDER_UNREACHABLE = `Muse Wonder could not be reached, so we could not write your goal — write the task and the success criterion below yourself, or set ${MODEL_API_KEY_ENV} where the platform runs and try again.`;

/**
 * A reply that arrived and was not a goal: two sentences where one was asked for, a field
 * left out, a type the shape does not declare. A refusal with a sentence and never a 500 —
 * nothing broke, the answer was unusable — and the paths such a refusal carries are the
 * reply shape's rather than fields this screen draws, so none of them is rendered.
 */
const UNREADABLE_REPLY =
  "Muse Wonder's answer was not a goal this build can read, so nothing was written — write the task and the success criterion below yourself, or try again.";

/** One problem with an ask, in the shape every refusal in this package carries. */
interface GoalIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A feature sentence with something in it to read: one letter or one digit somewhere.
 *
 * Deliberately **at least as strict as the ask's own rule**: `goalAsk` trims trailing
 * `.,;:!?` as well as whitespace, so a box holding only `...` is empty to it and not to
 * `String.trim`, and it refuses with a bare `TypeError` this route would have answered 500
 * to. The same guard stands in front of `audienceAsk` (`READABLE` in `audiences.ts`), for
 * the same reason and against a different ask: each route is as strict as the ask it calls.
 */
const WRITTEN_IN = /[\p{L}\p{N}]/u;

/**
 * The two things a goal is written from, or every field standing in the way of one.
 *
 * Both are checked **before** anything is asked of the model: a model is not worth a call to
 * be told that the box above it is empty, and `goalAsk` refuses an address it cannot read and
 * a feature nobody wrote with a bare `TypeError`, which is a 500 for something a user typed.
 *
 * The URL goes through `parseSiteUrl` — the rule the Add-a-site form is held to, which is the
 * one place this platform decides what a swarm may be pointed at — and its sentence is kept
 * exactly as that rule writes it. Only the path is this route's: the form that asks for a
 * site calls the field `url` and this ask calls it `siteUrl`, and a refusal has to name the
 * field the screen can draw.
 */
const askedFor = (
  body: unknown,
): { siteUrl: string; feature: string } | { issues: readonly GoalIssue[] } => {
  const submitted: Record<string, unknown> =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const issues: GoalIssue[] = [];

  let siteUrl = '';
  try {
    siteUrl = parseSiteUrl(submitted[SITE_URL]);
  } catch (error) {
    if (!(error instanceof SiteUrlNotAcceptedError)) throw error;
    issues.push(...error.issues.map(({ message }) => ({ path: SITE_URL, message })));
  }

  const feature = submitted[FEATURE];
  if (typeof feature !== 'string' || !WRITTEN_IN.test(feature)) {
    issues.push({
      path: FEATURE,
      message:
        'a goal is written from a feature described in the user’s own words — "checking out with a promo code" — and this ask carries none: an empty feature box is a form nobody has filled in, not a task to invent on their behalf',
    });
  }

  return issues.length === 0 ? { siteUrl, feature: feature as string } : { issues };
};

/**
 * One goal, written by whichever implementation is behind the seam — or the sentence that
 * says why there is none (#397, `docs/FLOW.md` section 12).
 *
 * Three things are the route's and not the body's:
 *
 * - **the seed**, the day the goal was asked for (`seedForLaunchDay`, decision 106), so the
 *   same site and the same sentence give the same goal twice on one day. No screen asks a
 *   person for a seed and the body cannot name one;
 * - **the session**, because the ask spends the workspace's model budget: signed out is the
 *   sentence this file already states and nothing is asked of the model;
 * - **every sentence in a refusal**, except the one `GoalCriterionError` writes. That one is
 *   passed through unchanged: decision 117 is that a user reads both criteria and an example
 *   of each kind the platform would have accepted, and the provider's sentence is the only
 *   place either exists.
 *
 * The answer is the contract's `Goal` and nothing beside it — `task`, `successCriterion` and
 * `lastWrittenBy`, which is `model` because a model wrote it. Nothing is created and nothing
 * is stored: the goal the run records is the one the user approves two steps later, edited or
 * not, and `POST /runs` is the one request that may start anything.
 */
const writtenGoal =
  (readSession: RunRouteOptions['readSession'], wonder: WonderSeam) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      refuse(response, 401, SIGNED_OUT, { signedIn: false });
      return;
    }
    const body = await readJsonBody(request);
    if (body === null) {
      // Not JSON, or past the body cap: what is wrong is the request and not the draft, so
      // this is not a sentence about a field somebody left empty.
      refuse(response, 400, 'That goal could not be read.');
      return;
    }
    const ask = askedFor(body.value);
    if ('issues' in ask) {
      refuse(response, 400, 'That goal could not be asked for.', { issues: ask.issues });
      return;
    }

    try {
      const written = await writeGoal(wonder(), {
        url: ask.siteUrl,
        feature: ask.feature,
        seed: seedForLaunchDay(new Date()),
      });
      sendJson(response, 200, written.value);
    } catch (error) {
      if (error instanceof GoalCriterionError) {
        // **An automation failure** (`docs/FLOW.md` section 8), so it is written to the
        // server's own log the way the router writes a 500: a model that starts answering
        // unobservable criteria for every draft would otherwise take the goal step down
        // while the deployment emitted nothing but 4xx, with two paid-for calls per attempt
        // and no line anywhere saying so. What it cost goes in the same line, because a
        // refused goal is still two calls on the invoice.
        process.stderr.write(
          `personavision: a goal was refused after one send-back (${String(error.usage.estimatedCostUsd)} USD): ${error.reason}\n`,
        );
        // The provider's own sentence, unchanged, and `{ error }` alone: the screen renders
        // it as it stands (decision 117), and what the two calls cost is a figure for whoever
        // runs the server rather than for the person reading the step.
        refuse(response, 400, error.reason);
        return;
      }
      if (error instanceof ModelModeUnavailableError || error instanceof WonderCallError) {
        refuse(response, 503, WONDER_UNREACHABLE);
        return;
      }
      if (error instanceof WonderReplyError) {
        refuse(response, 400, UNREADABLE_REPLY);
        return;
      }
      throw error;
    }
  };

export const runRoutes = ({
  store,
  readSession,
  pipeline,
  wonder = wonderFromEnv(),
}: RunRouteOptions): Route[] => [
  {
    method: 'POST',
    path: GOAL_PATH,
    handle: writtenGoal(readSession, wonder),
  },
  {
    method: 'POST',
    path: /^\/runs$/,
    handle:
      pipeline === undefined
        ? notImplemented(ENGINE_TICKET, 'Starting a test')
        : async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
            const session = await readSession(request);
            if (session === null) {
              refuse(response, 401, SIGNED_OUT, { signedIn: false });
              return;
            }
            const body = await readJsonBody(request);
            if (body === null) {
              refuse(response, 400, 'That test could not be read.');
              return;
            }

            // The body is whatever was submitted; both functions below parse it against
            // the contract with the workspace's mode over it, and a mode the body named is
            // dropped on the way.
            const test = {
              workspaces: store.workspaces,
              audiences: store.audiences,
              // The workspace's sites: the one the body names is resolved against these
              // alone, and the per-site caps are counted against it.
              sites: store.sites,
              workspaceId: session.workspaceId,
              pipeline,
            };
            try {
              const run = namesTwoVersions(body.value)
                ? await startTest({ ...test, draft: body.value as TestDraft })
                : await startSiteTest({ ...test, draft: body.value as SiteTestDraft });
              started(response, run.runId);
            } catch (error) {
              if (error instanceof DraftNotAcceptedError) {
                refuse(response, 400, 'That test could not be started.', {
                  issues: error.issues,
                });
                return;
              }
              if (error instanceof AudienceNotOfferedError) {
                refuse(response, 400, 'That audience is not one this workspace can test for.');
                return;
              }
              if (error instanceof NoSuchSiteError) {
                // The same sentence `GET /sites/:siteId` gives, and for the same reason: a
                // site of another workspace is missing rather than forbidden. 400 rather
                // than 404, because `POST /runs` is a route that exists — a 404 here would
                // read as the platform not having the route at all.
                refuse(response, 400, error.message);
                return;
              }
              if (error instanceof CapRefusedError) {
                // **429**, with the figures beside the sentence: the cap that refused it, its
                // limit, what was observed and when it next passes. The screen renders the
                // sentence as it is given and draws its countdown from `retryAt`, so the
                // screen, this body and the CLI print one sentence rather than three.
                refuse(response, 429, error.message, {
                  cap: error.cap,
                  limit: error.limit,
                  observed: error.observed,
                  retryAt: error.retryAt,
                });
                return;
              }
              if (error instanceof TestRefusedError) {
                // The model this workspace pays for could not be used. 503, because it is
                // this deployment that cannot serve it rather than the submission that was
                // wrong, and the message is the one the Test failed screen states (#18).
                refuse(response, 503, error.message, { modelMode: error.modelMode });
                return;
              }
              throw error;
            }
          },
  },
];
