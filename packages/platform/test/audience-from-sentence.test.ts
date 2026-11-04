import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Audience, Persona } from '@personavision/contract';
import { GENERATOR_VERSION, OUTDOOR_GEAR_SHOPPERS } from '@personavision/personas';
import {
  createOfflineWonderProvider,
  FREE_USAGE,
  MODEL_API_KEY_ENV,
  parseWonderReply,
  WONDER_MODEL_ID,
  WonderCallError,
} from '@personavision/provider';
import type { WonderAsk, WonderProvider, WonderReply } from '@personavision/provider';
import { CAPS } from '../src/caps.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { seedForLaunchDay } from '../src/run/start.js';
import { DEFAULT_PARTICIPANTS, wonderFromEnv } from '../src/server/routes/audiences.js';
import type { WonderSeam } from '../src/server/routes/audiences.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * `POST /audiences/from-sentence` — the one call the New test wizard's audience step makes
 * (#396, `docs/FLOW.md` section 12).
 *
 * Every case here goes **through the real server**, with the one-shot implementation
 * replaced at the seam the route selects it through, because the bug this closes was a
 * route nobody had mounted: the screen posted the sentence, the server fell through to the
 * app's own HTML, and the step printed *"The audience store answered something that is not
 * JSON"*. A test that called the handler as a function would have passed against exactly
 * that product, so none of these do.
 *
 * Three stand-ins, and each is the least pretending one its case allows:
 *
 * - the project's **own offline implementation** for the happy path, so the audience that
 *   reaches the store went through the ask's real reply validator on the way, as a model's
 *   would;
 * - {@link replying}, which runs the ask's own validator over a reply the way every
 *   implementation of the seam does, for what the model is asked and what it may not
 *   choose;
 * - {@link answering}, which hands the route a reply **nothing validated**, for the
 *   platform's own second net under a reply the contract does not accept.
 */

/** The sentence a user types into the box, as `docs/FLOW.md` section 12 writes it. */
const SENTENCE = 'busy parents in Almaty who shop on their phones';

/** What the route answers with. Only what these tests read: the rest is the compiler's. */
interface AudienceBody {
  id: string;
  audience: Audience;
  people: Persona[];
  issues: { path: string; message: string }[];
  error?: string;
}

/** The ask every stand-in keeps, so a test can read what the model was told. */
type Asked = WonderAsk<unknown>[];

const stub = (ask: <T>(ask: WonderAsk<T>) => Promise<WonderReply<T>>): WonderProvider => ({
  name: 'wonder-stub',
  mode: 'model',
  modelId: WONDER_MODEL_ID,
  ask,
});

/**
 * A stand-in that answers whatever the ask's own validator makes of `reply` — which is what
 * the model implementation does with the JSON that comes back, and what the offline one does
 * with its generator's output. `reply` is therefore the **described** audience: the fields a
 * sentence can describe, with the caller's id and provenance still to be stamped on.
 */
const replying = (reply: unknown): { provider: WonderProvider; asks: Asked } => {
  const asks: Asked = [];
  return {
    asks,
    provider: stub(async <T>(ask: WonderAsk<T>): Promise<WonderReply<T>> => {
      asks.push(ask as WonderAsk<unknown>);
      return { value: parseWonderReply(ask, reply, null), model: null, usage: FREE_USAGE };
    }),
  };
};

/** A stand-in that hands the route `value` with nothing validated on the way. */
const answering = (value: unknown): WonderProvider =>
  stub(<T>(): Promise<WonderReply<T>> =>
    Promise.resolve({ value: value as T, model: null, usage: FREE_USAGE }),
  );

/** A stand-in whose call fails the way `error` fails. */
const failing = (error: Error): WonderProvider =>
  stub(<T>(): Promise<WonderReply<T>> => Promise.reject(error));

/** One reply in the shape the ask asks for: every field a sentence can describe. */
const DESCRIBED = {
  name: 'Busy parents in Almaty',
  ageRange: { min: 25, max: 44 },
  roles: ['Parent'],
  regions: ['Almaty'],
  languages: ['Russian', 'Kazakh'],
  genderSplit: { male: 0.4, female: 0.6 },
  ageGroups: [
    { group: '25–34', share: 0.5 },
    { group: '35–44', share: 0.5 },
  ],
  goals: ['Shop on a phone'],
  devices: [
    { class: 'mobile', share: 0.72 },
    { class: 'desktop', share: 0.28 },
  ],
  techSavviness: 0.45,
  priceSensitivity: 0.7,
  size: 12,
};

/** A whole audience the contract accepts, for the cases that validate nothing first. */
const whole = (): Audience => ({
  ...OUTDOOR_GEAR_SHOPPERS,
  id: 'an-id-the-model-chose',
  name: 'Busy parents in Almaty',
});

describe('POST /audiences/from-sentence', () => {
  let served: TestServer;
  let cookie: string;

  /**
   * A server whose audience routes select Wonder through `wonder`, and a session on it.
   *
   * The seam itself and not a provider, because one case under test is a **selection that
   * refuses**: it throws where the environment holds no key, and it has to throw inside the
   * request rather than at start-up for the route to answer it in words.
   */
  const open = async (wonder: WonderSeam): Promise<void> => {
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind demo' }],
      wonder,
    });
    const response = await served.signIn({
      email: DEMO_ACCOUNT_EMAIL,
      password: served.platform.seeded?.password ?? '',
    });
    expect(response.status).toBe(200);
    cookie = cookieOf(response);
  };

  /** The call the screen makes: the sentence, as JSON, with the session's cookie. */
  const post = (sentence: unknown, as: string = cookie): Promise<Response> =>
    served.request('/audiences/from-sentence', {
      method: 'POST',
      headers: { cookie: as, 'content-type': 'application/json' },
      body: JSON.stringify({ sentence }),
    });

  const bodyOf = async (response: Response): Promise<AudienceBody> =>
    (await response.json()) as AudienceBody;

  const listed = async (): Promise<AudienceBody[]> => {
    const response = await served.request('/audiences', {
      method: 'GET',
      headers: { cookie, accept: 'application/json' },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { audiences: AudienceBody[] }).audiences;
  };

  /** The one audience the seeded workspace opens with: "nothing was stored" is this. */
  const SEEDED_ONLY = 1;

  afterEach(() => served.close());

  describe('a sentence the offline implementation reads', () => {
    beforeEach(() => open(() => createOfflineWonderProvider()));

    it('answers 201 with the audience and the people it generates', async () => {
      const response = await post(SENTENCE);

      expect(response.status).toBe(201);
      const body = await bodyOf(response);
      expect(body.audience.name).not.toBe('');
      expect(body.issues).toEqual([]);
      // The people come back in the same answer, because the screen renders them: it shows
      // who a test would run on before the test exists.
      expect(body.people).toHaveLength(body.audience.size);
      expect(body.people.every((person) => person.audienceId === body.audience.id)).toBe(true);
    });

    it("stores it in the session's own workspace, so GET /audiences lists it afterwards", async () => {
      const { id } = await bodyOf(await post(SENTENCE));

      expect((await listed()).map((entry) => entry.id)).toContain(id);
    });

    it('stamps the seed and the generator on it, because neither is the model to choose', async () => {
      const before = seedForLaunchDay(new Date());
      const body = await bodyOf(await post(SENTENCE));
      const after = seedForLaunchDay(new Date());

      expect([before, after]).toContain(body.audience.generatedFrom.seed);
      expect(body.audience.generatedFrom.generatorVersion).toBe(GENERATOR_VERSION);
    });

    it('asks nothing and stores nothing for a box with nothing to read in it', async () => {
      // `???` is the one that matters: `String.trim` leaves it standing and the ask's own
      // rule does not, so a route trimming only whitespace would have handed `audienceAsk`
      // a sentence it refuses with a bare `TypeError` — a 500 for something a user typed.
      for (const typed of ['   ', '???', '. . .', '-', '']) {
        const response = await post(typed);

        expect(response.status, typed).toBe(400);
        expect((await bodyOf(response)).error, typed).toContain('sentence');
      }
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });

    it('tells a body it could not read apart from a box with nothing in it', async () => {
      const response = await served.request('/audiences/from-sentence', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{"sentence": "busy parents in Almaty"',
      });

      expect(response.status).toBe(400);
      // Not "describe your customers in a sentence": they just did, and what went wrong is
      // the request. The sibling routes answer a body they could not read this way.
      expect((await bodyOf(response)).error).toBe('That audience could not be read.');
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });

    it('is not reachable without a session, and answers the signed-out sentence', async () => {
      const response = await post(SENTENCE, '');

      expect(response.status).toBe(401);
      expect((await bodyOf(response)).error).toBe('Sign in to read this.');
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });
  });

  describe('what the model is asked, and what it may not answer', () => {
    it("carries the user's own sentence, and keeps the id the platform minted", async () => {
      const reading = replying(DESCRIBED);
      await open(() => reading.provider);

      const body = await bodyOf(await post(SENTENCE));
      const again = await bodyOf(await post(SENTENCE));

      expect(reading.asks).toHaveLength(2);
      expect(reading.asks[0]?.use).toBe('audience');
      expect(reading.asks[0]?.document).toContain(SENTENCE);
      expect(body.audience.name).toBe(DESCRIBED.name);
      expect(body.audience.size).toBe(DESCRIBED.size);
      expect(body.people).toHaveLength(DESCRIBED.size);
      // The id the audience is stored under is minted per request and never read off the
      // reply: the same sentence read twice, answered identically twice, is two audiences
      // — a test records the audience it ran for by this id, so it names one of them.
      expect(body.audience.id).not.toBe('');
      expect(again.audience.id).not.toBe(body.audience.id);
    });

    it('is refused with the field named when the reply is not an audience, and nothing is stored', async () => {
      // A device mix that does not sum to one, straight past the ask's own validator:
      // refused here by the same words a person typing that mix into the form is refused by.
      const refused = answering({
        ...whole(),
        devices: whole().devices.map((device) => ({ ...device, share: 0.3 })),
      });
      await open(() => refused);

      const response = await post(SENTENCE);

      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      expect(body.issues.map((issue) => issue.path)).toContain('devices');
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });

    it('fills the hundred in for an audience that reaches it naming no number of people', async () => {
      // Through the ask this cannot happen — the reply shape requires a size, and a reply
      // without one is refused before it arrives — so the stand-in here is the raw one on
      // purpose. What it pins is that the two routes that create an audience share one
      // answer to an absent size, rather than one defaulting it and the other refusing it.
      const { size, ...noSize } = whole();
      expect(size).not.toBe(DEFAULT_PARTICIPANTS);
      const sizeless = answering(noSize);
      await open(() => sizeless);

      const body = await bodyOf(await post(SENTENCE));

      expect(body.audience.size).toBe(DEFAULT_PARTICIPANTS);
      expect(body.people).toHaveLength(DEFAULT_PARTICIPANTS);
    });

    it('refuses more people than a test may run, in the cap own words and before generating any', async () => {
      // "three million shoppers in Jakarta" is a number a model read out of a sentence, not
      // one a person typed into a form. Stored and then generated from, it is three million
      // personas in one response body.
      const crowd = answering({ ...whole(), size: 3_000_000 });
      await open(() => crowd);

      const response = await post('three million shoppers in Jakarta');

      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      expect(body.issues.map((issue) => issue.path)).toStrictEqual(['size']);
      expect(body.issues[0]?.message).toContain(String(CAPS.agentsPerRun));
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });

    it("is a refusal with a sentence, not a 500, when the ask's own validator refused", async () => {
      // A viewport where a class name was asked for: what a model answers when it has
      // described a screen instead of choosing from the closed list it was given.
      const viewport = replying({ ...DESCRIBED, devices: [{ class: '390x844', share: 1 }] });
      await open(() => viewport.provider);

      const response = await post(SENTENCE);

      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      // Against the box, and not against `devices[0].class`: the paths such a refusal
      // carries are the reply shape's, and that one names a field no audience form can draw.
      expect(body.issues.map((issue) => issue.path)).toStrictEqual(['sentence']);
      expect(body.issues[0]?.message).not.toContain('class');
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });
  });

  describe('a call that could not be made at all', () => {
    it('answers one sentence and never the thrown message', async () => {
      const unreachable = failing(
        new WonderCallError({
          kind: 'transport',
          message: 'getaddrinfo ENOTFOUND graph.meta.example',
          use: 'audience',
        }),
      );
      await open(() => unreachable);

      const response = await post(SENTENCE);

      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body.error).toContain(MODEL_API_KEY_ENV);
      expect(JSON.stringify(body)).not.toContain('ENOTFOUND');
      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });
  });

  describe('with no model key where the platform runs', () => {
    // The **real** selection, over an environment holding nothing: this is the refusal
    // `personavision serve` gives on a machine with no key, and it does not depend on what
    // the machine running this test happens to export.
    beforeEach(() => open(wonderFromEnv({})));

    it('names the key, points at the form, and leaks nothing that was thrown', async () => {
      const response = await post(SENTENCE);

      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body.error).toBe(
        `Muse Wonder could not be reached, so we could not read your sentence — fill the fields below in yourself, or set ${MODEL_API_KEY_ENV} where the platform runs and try again.`,
      );
      // No stack frame, no class name, and no word of the sentence the selection throws.
      const printed = JSON.stringify(body);
      expect(printed).not.toContain('ModelModeUnavailableError');
      expect(printed).not.toContain('    at ');
      expect(printed).not.toContain('refused rather than');
    });

    it('leaves the structured form as the way on, having stored nothing', async () => {
      await post(SENTENCE);

      expect(await listed()).toHaveLength(SEEDED_ONLY);
    });
  });
});
