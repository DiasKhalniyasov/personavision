import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AudienceValidationError, GENERATOR_VERSION, parseAudience } from '@personavision/personas';
import type { Audience } from '@personavision/contract';
import type { AudienceIssue } from '@personavision/personas';
import {
  createMetaWonderProvider,
  MODEL_API_KEY_ENV,
  ModelModeUnavailableError,
  selectWonderProvider,
  WONDER_MODEL_ID,
  WonderCallError,
  WonderReplyError,
  writeAudience,
} from '@personavision/provider';
import type { WonderProvider } from '@personavision/provider';
import { peopleOf, withPeople } from '../../audience/people.js';
import { refuseTooManyAgents } from '../../caps.js';
import type { AudienceWithPeople, GeneratedPeople } from '../../audience/people.js';
import { seedForLaunchDay } from '../../run/start.js';
import type { AudienceStore, PlatformStore, SessionRecord } from '../../store/types.js';
import { readJsonBody, sendJson } from './types.js';
import type { Route } from './types.js';

/**
 * Audience storage: the workspace's audiences, and the people each would generate.
 *
 * Five routes, all of them the session's own workspace and no other, and every one of them
 * answering with the audience **and the people it generates** — the Audience screens (#109)
 * show who a test would run on before the test exists, and they read it here rather than
 * running the generator in a browser.
 *
 * The fifth is `POST /audiences/from-sentence` (#396, `docs/FLOW.md` section 12): one
 * sentence in, one **stored** audience out, by way of Muse Wonder. It answers with the same
 * body as the other four because the screen that shows what the model made of the sentence
 * renders its editable fields straight from it — and the audience is stored rather than
 * drafted because an audience the user can see but the platform has not accepted would be a
 * form able to refuse the audience it has already drawn.
 *
 * The two `GET`s are `jsonOnly`, because `/audiences` and `/audiences/:audienceId` are also
 * the app's own screens (`docs/FLOW.md` section 3) and a browser navigating to one wants the
 * screen. There is no `DELETE`: section 3 lists the routes, section 8 says they are not
 * invented per ticket, and retiring an audience is `AudienceStore.softDelete`.
 */

/** Matched by the router, and read here for the id it captures. */
const AUDIENCE_PATH = /^\/audiences\/([^/]+)$/;

/**
 * The sentence route's own path. It is matched **before** {@link AUDIENCE_PATH}, which it
 * also looks like: this is a `POST` and the two routes under that pattern are a `GET` and a
 * `PATCH`, so nothing shadows anything today — but the order is what keeps that true of a
 * route somebody adds later rather than a coincidence of the methods.
 */
const FROM_SENTENCE_PATH = /^\/audiences\/from-sentence$/;

/**
 * Muse Wonder, as this route reaches it: the selection, performed **per request**.
 *
 * Per request rather than once at start-up because the key is read at call time — a platform
 * started before the key was set answers the next sentence without a restart, and one whose
 * key was taken away says so rather than holding a provider built from it.
 *
 * It is an option on the routes so that a test can replace the implementation at the one
 * seam the route has, instead of reaching the model or standing in for the whole route.
 * Throwing {@link ModelModeUnavailableError} is part of the shape: it is how
 * `selectWonderProvider` says this process cannot call Wonder, and the route answers it in
 * words.
 */
export type WonderSeam = () => WonderProvider;

/**
 * The shipped selection: Muse Wonder on the one model this package runs one-shot, built from
 * `MODEL_API_KEY` where the environment holds it and refused where it does not.
 *
 * **Model or nothing.** There is no offline fall-back here, although
 * `@personavision/provider` ships one and every other Wonder caller may have it: a
 * deterministic stand-in would answer a *customer's* sentence with an audience this
 * repository invented, and a simulated answer standing in for a model run is worse than a
 * refusal (owner decision, 2026-10-28). The way on with no key is the structured form, which
 * is always there — `docs/FLOW.md` section 12 makes the box an input to that form and not an
 * alternative to it.
 *
 * `env` is a parameter so that a test can select over an environment of its own and reach
 * the real refusal without touching `process.env` or depending on what the machine exports.
 */
export const wonderFromEnv =
  (env: Readonly<Record<string, string | undefined>> = process.env): WonderSeam =>
  () =>
    selectWonderProvider({
      env,
      requestedMode: { mode: 'model', modelId: WONDER_MODEL_ID },
      createModelProvider: ({ apiKey, modelId }) => createMetaWonderProvider({ apiKey, modelId }),
    }).provider;

export interface AudienceRouteOptions {
  store: PlatformStore;
  /** The session a request carries, or `null` — the platform's own reader. */
  readSession: (request: IncomingMessage) => Promise<SessionRecord | null>;
  /**
   * How the sentence reaches Muse Wonder. Absent — as it is in `personavision serve` —
   * means {@link wonderFromEnv} over this process's own environment.
   */
  wonder?: WonderSeam;
}

/**
 * The one sentence a request with no session gets. The guard in front of these routes
 * answers it first for a signed-out request; this is the same answer where the handler is
 * reached directly, so the seam does not depend on something above it having run.
 */
const SIGNED_OUT = 'Sign in to read this.';

/** An audience of another workspace is missing, not forbidden: that it exists is not news. */
const NO_SUCH_AUDIENCE = 'There is no such audience.';

/**
 * What the screen prints beside the box when the sentence could not be read at all: no key
 * where the platform runs, or a call that never came back.
 *
 * It names the key and it names the way on, because both are things the reader can act on —
 * the owner of the deployment sets `MODEL_API_KEY`, and the person at the screen fills the
 * six fields in. The step is finishable with no key at all, which is the point.
 *
 * **It is written here and nothing thrown is interpolated into it** (#144). What
 * `selectWonderProvider` and the model client throw is written for whoever runs the server:
 * it names tiers, endpoints, statuses and what was built for what, and one of them is a
 * sentence about a credential. None of that is the customer's to read, and a message from
 * `fetch` or from a transport is not ours to vouch for in the first place.
 */
const WONDER_UNREACHABLE = `Muse Wonder could not be reached, so we could not read your sentence — fill the fields below in yourself, or set ${MODEL_API_KEY_ENV} where the platform runs and try again.`;

/** A body that is not JSON, or is past the reader's size cap: nothing was validated. */
const UNREADABLE_BODY = 'That audience could not be read.';

/** An empty box is a form nobody has filled in, and not a hundred people to invent. */
const NO_SENTENCE =
  'Describe your customers in a sentence, and Muse Wonder will fill the form in from it.';

/**
 * A reply the ask's own validator refused, reported against **the box the sentence was
 * typed in**.
 *
 * Not against the paths the refusal carries, although it carries some: they are the paths of
 * the *ask's own reply shape* and not of `audienceSchema`. One of them names the device
 * **class** the model was asked to choose out of a closed list, which is a field the reply
 * has and the audience has not, and an empty path names the whole reply — so rendering them
 * as audience issues would attach a message to a field the form cannot draw. The one field
 * this refusal is really about is the one the reader can act on, and it is the box.
 *
 * A reply that reached the platform and then failed `audienceSchema` is a different case and
 * keeps the contract's own messages at its own paths: see {@link accepted}.
 *
 * The message is this file's, for the same reason {@link WONDER_UNREACHABLE} is.
 */
const UNREADABLE_REPLY =
  "Muse Wonder's answer was not an audience this build can store, so nothing was saved: fill the fields below in yourself, or try your sentence again.";

/** The field the free-text box is, as a refusal about the sentence names it. */
const SENTENCE_FIELD = 'sentence';

/**
 * How many simulated people an audience created here generates when the submission names no
 * number: a hundred (`docs/FLOW.md` section 12).
 *
 * Stated once, and stated **here** rather than in the contract. The contract's audience is
 * also the copy a finished run carries, and a run of four people is still a run of four — a
 * default down there would quietly answer for every audience ever written, including the
 * committed example's. This is the platform's own answer to a field a form left empty, so
 * the form (#273) and the free text that fills it (#257) read this name rather than typing a
 * hundred again.
 */
export const DEFAULT_PARTICIPANTS = 100;

const audienceIdOf = (request: IncomingMessage): string => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const captured = AUDIENCE_PATH.exec(pathname)?.[1] ?? '';
  try {
    return decodeURIComponent(captured);
  } catch {
    // A half-escaped path names no audience, and it is not worth a 500 to say so.
    return captured;
  }
};

/** What a route answers with: the audience, its people, and when it was last written. */
const answer = (response: ServerResponse, status: number, record: AudienceWithPeople): void =>
  sendJson(response, status, record);

/**
 * An audience that cannot be saved, reported **at the path it is wrong at** so that the form
 * can render each message against the field it concerns (#109). The messages are the
 * schema's own: the audience is declared once, so what is wrong with one is stated once.
 */
const refuse = (response: ServerResponse, issues: readonly AudienceIssue[]): void =>
  sendJson(response, 400, { error: 'That audience could not be saved.', issues });

/** A plain object: something a `PATCH` merges into rather than replaces. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The submitted audience with the platform's defaults under it, for the fields it leaves
 * out. One field has one, and it is read as **absent** and not as wrong: a submission that
 * names the number and gets it wrong is the contract's to refuse, at its own path.
 *
 * Only a `POST` passes through here. A `PATCH` is merged over a stored audience that was
 * validated when it was written, so every field it does not name already has a value — and
 * defaulting there would resize the demo audience's four people to a hundred the first time
 * somebody renamed it.
 */
const withDefaults = (submitted: unknown): unknown =>
  isPlainObject(submitted) && submitted.size === undefined
    ? { ...submitted, size: DEFAULT_PARTICIPANTS }
    : submitted;

/**
 * The stored audience with the submitted fields over it, as deep as the submission goes: a
 * `PATCH` naming one end of the age range leaves the other end as it was.
 *
 * A list the submission names replaces the stored list rather than being merged into it
 * position by position — the second device of a mix is not an edit to the first — and a
 * body that is not an object at all replaces the audience, which the schema then refuses.
 */
const merge = (stored: unknown, submitted: unknown): unknown => {
  if (!isPlainObject(stored) || !isPlainObject(submitted)) return submitted;
  return Object.fromEntries([
    ...Object.entries(stored),
    ...Object.entries(submitted).map(([key, value]) => [key, merge(stored[key], value)]),
  ]);
};

/**
 * An audience the contract accepts, or the 400 that says where it is wrong.
 *
 * It takes the audience rather than the request because two things arrive here: a body
 * somebody typed, and a reply Muse Wonder wrote. Both are held to the same schema by the
 * same call, which is what makes *"a model that answers shares not summing to one is
 * refused by the same words a person typing them is"* one behaviour rather than two.
 */
const accepted = (
  response: ServerResponse,
  submitted: unknown,
  /** What a `PATCH` is merged over; `null` for an audience that arrives whole. */
  stored: Audience | null,
): Audience | null => {
  // The merged result is validated whole, so a changed field cannot break an invariant
  // that spans two of them: the device shares and the age range are checked against the
  // audience as it would stand, not against the fields the submission happened to name.
  try {
    return parseAudience(stored === null ? withDefaults(submitted) : merge(stored, submitted));
  } catch (error) {
    if (error instanceof AudienceValidationError) {
      refuse(response, error.issues);
      return null;
    }
    throw error;
  }
};

/** The submitted audience, validated, or the 400 that says where it is wrong. */
const validated = async (
  request: IncomingMessage,
  response: ServerResponse,
  /** What a `PATCH` is merged over; `null` for a `POST`, which carries the whole audience. */
  stored: Audience | null,
): Promise<Audience | null> => {
  const body = await readJsonBody(request);
  if (body === null) {
    sendJson(response, 400, { error: UNREADABLE_BODY });
    return null;
  }
  return accepted(response, body.value, stored);
};

/**
 * The people the audience generates, or the 400 that says why it generates none.
 *
 * Generated **before** the audience is stored, so that a record nothing can be generated
 * from is never written: every answer carries the people, so one such record would answer
 * for the audience it is in and for every list it appears in — and with no route to delete
 * it, the workspace's audiences would stay unreadable until somebody edited the file.
 */
const generatedOrRefused = (
  response: ServerResponse,
  audience: Audience,
): GeneratedPeople | null => {
  const generated = peopleOf(audience);
  if (generated.issues.length === 0) return generated;
  refuse(response, generated.issues);
  return null;
};

/**
 * `null`, or the 400 saying this workspace already has an audience under the `id` the
 * submission carries.
 *
 * An audience's own `id` is what a run artifact carries by value and what every generated
 * person's `audienceId` names, so it has to name one audience per workspace: a second
 * record under the same id leaves a finished test unable to say which stored audience it
 * was run for, and the people of two audiences indistinguishable by the field that exists
 * to tell them apart. A soft-deleted record keeps its id for the same reason — the tests
 * that used it still name it.
 */
const idTaken = async (
  audiences: AudienceStore,
  workspaceId: string,
  audience: Audience,
  /** The record being edited, whose own id is not a clash with itself. */
  exceptRecordId: string | null,
): Promise<boolean> => {
  const records = await audiences.list(workspaceId, { includeDeleted: true });
  return records.some(
    (record) => record.id !== exceptRecordId && record.audience.id === audience.id,
  );
};

/**
 * The audience stored and answered with its people, or the 400 saying why it was not: the
 * tail both routes that create one share.
 *
 * Both of them are a new audience under an id nothing else in this workspace may hold, and
 * both answer 201 with the record. The only difference between them is where the audience
 * came from, which is over by the time it gets here.
 */
const created = async (
  response: ServerResponse,
  audiences: AudienceStore,
  workspaceId: string,
  audience: Audience,
): Promise<void> => {
  if (await idTaken(audiences, workspaceId, audience, null)) {
    refuse(response, [
      {
        path: 'id',
        message: `this workspace already has an audience with the id "${audience.id}": a test records the audience it ran for by this id, so it names one audience`,
      },
    ]);
    return;
  }
  const generated = generatedOrRefused(response, audience);
  if (generated === null) return;
  answer(response, 201, withPeople(await audiences.create(workspaceId, audience), generated));
};

/**
 * A box with something in it to read: one letter or one digit somewhere.
 *
 * It is the route's own rule about its own input, and it is deliberately **at least as
 * strict as the ask's**. `audienceAsk` refuses a sentence it reads as empty by trimming
 * whitespace *and* trailing `.,;:!?` — so a box holding only `???` is empty to it and not to
 * `String.trim` — and it refuses with a bare `TypeError`, which this route would have had to
 * answer 500 to. Anything carrying a letter or a digit survives that trim, so a sentence
 * this accepts is one the ask accepts, and the `TypeError` is unreachable rather than
 * caught. Going the other way, `-` passes the ask and is not a description of anybody.
 *
 * The provider's regular expression is not copied here: it is one package's rule about what
 * it will prompt a model with, and this is another's about what a person typed.
 */
const READABLE = /[\p{L}\p{N}]/u;

/** The sentence the body carries, or `''` where it carries nothing to read. */
const sentenceOf = (body: unknown): string => {
  if (!isPlainObject(body)) return '';
  const { sentence } = body;
  if (typeof sentence !== 'string') return '';
  const typed = sentence.trim();
  return READABLE.test(typed) ? typed : '';
};

/**
 * One audience written from one sentence, or the sentence that says why there is none.
 *
 * Four things are the route's and not the model's, and all four are decided before the ask:
 *
 * - **the id**, minted here, because `AudienceAskInput.id` is the caller's — a test records
 *   the audience it ran for by this id and every generated person's `audienceId` names it,
 *   so it cannot be a value the model chose, nor one derived from a name the user is about
 *   to edit. A fresh id per request is also why reading the same sentence twice is two
 *   audiences rather than a clash;
 * - **the seed**, the day it was described on (`seedForLaunchDay`, decision 106), which is
 *   the one number that is both repeatable and already printed on the screen for a one-URL
 *   test, and which no step of the wizard asks a person to choose;
 * - **the generator**, this build's, because the people this audience answers with are
 *   generated here and reproducible against this version and no other;
 * - **the number of participants**, where the audience that arrives names none:
 *   {@link DEFAULT_PARTICIPANTS}, through the same defaulting a submitted audience gets, so
 *   the hundred is read here and never written a second time. Through `writeAudience` it is
 *   a net and not the mechanism: the reply shape requires a size and the ask already tells
 *   the model to answer the hundred where the sentence names no number, so a reply without
 *   one is refused by the ask before it arrives. It is still read through the one shared
 *   `accepted`, because the alternative is a second path that treats an absent size as
 *   wrong in one route and as a default in the other.
 *
 * And one thing is the **cap's**: an audience of more people than a test may run is refused
 * here, in the cap's own words, *before* anybody is generated from it. The size used to be a
 * number a person typed into a form; it is now a number a model read out of a sentence, and
 * "three million shoppers in Jakarta" is a reply that would otherwise be stored and then
 * generated from — a hundred-agent cap the launch would have refused, reached by way of
 * three million people in one response body.
 *
 * Nothing is launched, and nothing is half-stored: a reply that cannot be used leaves the
 * workspace exactly as it was, with the form below the box as the way on.
 */
const fromSentence =
  (audiences: AudienceStore, wonder: WonderSeam) =>
  async (
    workspaceId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonBody(request);
    if (body === null) {
      // Not JSON, or past the body cap: the sibling routes' answer, because what is wrong
      // is the request and not the box. Telling somebody to write a sentence they have just
      // written is the one thing this must not say.
      sendJson(response, 400, { error: UNREADABLE_BODY });
      return;
    }
    const sentence = sentenceOf(body.value);
    if (sentence === '') {
      sendJson(response, 400, { error: NO_SENTENCE });
      return;
    }

    let written: Audience;
    try {
      const reply = await writeAudience(wonder(), {
        sentence,
        id: randomUUID(),
        seed: seedForLaunchDay(new Date()),
        generatorVersion: GENERATOR_VERSION,
      });
      written = reply.value;
    } catch (error) {
      // No key, no implementation to build one with, or a call that never came back: one
      // sentence, and the form is still there.
      if (error instanceof ModelModeUnavailableError || error instanceof WonderCallError) {
        sendJson(response, 503, { error: WONDER_UNREACHABLE });
        return;
      }
      // A reply the ask's own validator refused: a refusal with a sentence against the box,
      // and never a 500 — nothing broke, the answer was unusable.
      if (error instanceof WonderReplyError) {
        refuse(response, [{ path: SENTENCE_FIELD, message: UNREADABLE_REPLY }]);
        return;
      }
      throw error;
    }

    const audience = accepted(response, written, null);
    if (audience === null) return;
    // Before `created`, which generates the people to decide whether to store them.
    const tooMany = refuseTooManyAgents(audience.size);
    if (tooMany !== null) {
      refuse(response, [{ path: 'size', message: tooMany.message }]);
      return;
    }
    await created(response, audiences, workspaceId, audience);
  };

/** A handler that needs a workspace: the session's, or 401. */
const inWorkspace =
  (
    { readSession }: AudienceRouteOptions,
    handle: (
      workspaceId: string,
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const session = await readSession(request);
    if (session === null) {
      sendJson(response, 401, { error: SIGNED_OUT, signedIn: false });
      return;
    }
    await handle(session.workspaceId, request, response);
  };

export const audienceRoutes = (options: AudienceRouteOptions): Route[] => {
  const { audiences } = options.store;
  const wonder = options.wonder ?? wonderFromEnv();

  return [
    {
      method: 'POST',
      path: FROM_SENTENCE_PATH,
      handle: inWorkspace(options, fromSentence(audiences, wonder)),
    },
    {
      method: 'GET',
      path: /^\/audiences$/,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, _request, response) => {
        // Soft-deleted audiences are left out: this is the list a new test chooses from.
        const records = await audiences.list(workspaceId);
        sendJson(response, 200, { audiences: records.map((record) => withPeople(record)) });
      }),
    },
    {
      method: 'POST',
      path: /^\/audiences$/,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const audience = await validated(request, response, null);
        if (audience === null) return;
        await created(response, audiences, workspaceId, audience);
      }),
    },
    {
      method: 'GET',
      path: AUDIENCE_PATH,
      jsonOnly: true,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        // A soft-deleted audience is readable here: a finished test names it, and the
        // screen that reports that test has to be able to say which audience it was.
        const record = await audiences.byId(workspaceId, audienceIdOf(request));
        if (record === null) {
          sendJson(response, 404, { error: NO_SUCH_AUDIENCE });
          return;
        }
        answer(response, 200, withPeople(record));
      }),
    },
    {
      method: 'PATCH',
      path: AUDIENCE_PATH,
      handle: inWorkspace(options, async (workspaceId, request, response) => {
        const audienceId = audienceIdOf(request);
        const record = await audiences.byId(workspaceId, audienceId);
        // A soft-deleted audience is readable and is not editable: the user said they were
        // done describing these customers, and the tests that used it report what it was
        // then. It is the same answer `audienceForNewTest` gives for the same reason.
        if (record === null || record.deletedAt !== null) {
          sendJson(response, 404, { error: NO_SUCH_AUDIENCE });
          return;
        }
        const audience = await validated(request, response, record.audience);
        if (audience === null) return;
        if (await idTaken(audiences, workspaceId, audience, record.id)) {
          refuse(response, [
            {
              path: 'id',
              message: `this workspace already has another audience with the id "${audience.id}"`,
            },
          ]);
          return;
        }
        const generated = generatedOrRefused(response, audience);
        if (generated === null) return;
        answer(
          response,
          200,
          withPeople(await audiences.update(workspaceId, audienceId, audience), generated),
        );
      }),
    },
  ];
};
