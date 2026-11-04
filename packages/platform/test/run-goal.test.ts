import { afterEach, describe, expect, it } from 'vitest';
import { goalSchema } from '@personavision/contract';
import type { Goal } from '@personavision/contract';
import {
  createOfflineWonderProvider,
  FREE_USAGE,
  MODEL_API_KEY_ENV,
  parseWonderReply,
  WONDER_MODEL_ID,
  WonderCallError,
} from '@personavision/provider';
import type { WonderAsk, WonderProvider, WonderReply } from '@personavision/provider';
import { DEMO_ACCOUNT_EMAIL } from '../src/seed.js';
import { wonderFromEnv } from '../src/server/routes/audiences.js';
import type { WonderSeam } from '../src/server/routes/audiences.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * `POST /runs/goal` — the goal Muse Wonder writes, over HTTP (#397, `docs/FLOW.md`
 * section 12).
 *
 * Every case here goes **through the real server**, with the one-shot implementation
 * replaced at the seam the route selects it through, because the bug this closes was a route
 * nobody had mounted: the goal step posted the site and the sentence, the server fell
 * through to the app's own HTML, and the step printed *"The platform answered something that
 * is not a goal."* — the owner's walk of 2026-11-04. A test that called the handler as a
 * function would have passed against exactly that product, so none of these do.
 *
 * What the screen does with each answer is `apps/viewer/src/screens/newtest/wizard/goal`'s;
 * what is pinned here is the three fields it reads, the sentence it renders unchanged, and
 * that neither a refused criterion nor a missing key is ever a dead end.
 */

/** The two things one ask is made of, as the goal step sends them. */
const SITE_URL = 'https://app.clipforge.example/create';
const FEATURE = 'generating a video from a text prompt';

/** The ask every stand-in keeps, so a test can read what the model was told — or was not. */
type Asked = WonderAsk<unknown>[];

const stub = (ask: <T>(ask: WonderAsk<T>) => Promise<WonderReply<T>>): WonderProvider => ({
  name: 'wonder-stub',
  mode: 'model',
  modelId: WONDER_MODEL_ID,
  ask,
});

/**
 * A stand-in that answers whatever the ask's own validator makes of `reply` — which is what
 * the model implementation does with the JSON that comes back. `reply` is therefore the two
 * sentences a model writes, with the author still to be stamped on.
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

/** A stand-in whose call fails the way `error` fails, and which records nothing asked. */
const failing = (error: Error): { provider: WonderProvider; asks: Asked } => {
  const asks: Asked = [];
  return {
    asks,
    provider: stub(<T>(ask: WonderAsk<T>): Promise<WonderReply<T>> => {
      asks.push(ask as WonderAsk<unknown>);
      return Promise.reject(error);
    }),
  };
};

/** A criterion no session can evaluate: the one `readCriterion` refuses by name. */
const A_JUDGEMENT = 'The person feels confident that the video will be worth the money.';

/** What the route answers with. Only what these tests read: the rest is the compiler's. */
interface GoalBody extends Partial<Goal> {
  error?: string;
  signedIn?: boolean;
  issues?: { path: string; message: string }[];
}

describe('POST /runs/goal', () => {
  let served: TestServer;
  let cookie: string;

  /**
   * A server whose routes select Wonder through `wonder`, and a session on it.
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

  /** The call the goal step makes: the site, the feature, as JSON, with the session's cookie. */
  const post = (body: unknown, as: string = cookie): Promise<Response> =>
    served.request('/runs/goal', {
      method: 'POST',
      headers: { cookie: as, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const ask = (fields: Record<string, unknown> = {}): Promise<Response> =>
    post({ siteUrl: SITE_URL, feature: FEATURE, ...fields });

  const bodyOf = async (response: Response): Promise<GoalBody> =>
    (await response.json()) as GoalBody;

  afterEach(() => served.close());

  describe('a draft the offline implementation reads', () => {
    it('answers 200 with the contract’s goal, written by the model', async () => {
      await open(() => createOfflineWonderProvider());

      const response = await ask();

      expect(response.status).toBe(200);
      const body = await bodyOf(response);
      // The contract's own schema and not a shape spelt here: the screen parses the answer
      // against `goalSchema`'s three fields, so a goal it would refuse is not a 200.
      const goal = goalSchema.parse(body);
      expect(goal.lastWrittenBy).toBe('model');
      expect(goal.task).not.toBe('');
      expect(goal.successCriterion).not.toBe('');
      // Three fields and no more: the screen reads these and the route answers these.
      expect(Object.keys(body).sort()).toStrictEqual(['lastWrittenBy', 'successCriterion', 'task']);
    });

    it('is the same goal twice on one day, because the seed is the launch day', async () => {
      await open(() => createOfflineWonderProvider());

      const first = await bodyOf(await ask());
      const again = await bodyOf(await ask());

      // Decision 106: no screen asks for a seed and the body cannot name one, so the day is
      // what makes one site and one sentence repeatable.
      expect(again).toStrictEqual(first);
      expect(await bodyOf(await ask({ seed: 12345 }))).toStrictEqual(first);
    });

    it('is not reachable without a session, and asks the model nothing', async () => {
      const reading = replying({ task: 'A', successCriterion: 'B' });
      await open(() => reading.provider);

      const response = await post({ siteUrl: SITE_URL, feature: FEATURE }, '');

      expect(response.status).toBe(401);
      // The guard in front of the routes answers first, with the sentence it gives every
      // signed-out data request; the handler states this family's own for a direct call.
      // Either way the model is asked nothing: the ask spends the workspace's model budget.
      expect((await bodyOf(response)).error).toBe('Sign in to read this.');
      expect((await bodyOf(await post({ siteUrl: SITE_URL, feature: FEATURE }, ''))).signedIn).toBe(
        false,
      );
      expect(reading.asks).toHaveLength(0);
    });
  });

  describe('a body that is not a site and a sentence', () => {
    let asks: Asked;

    const refused = async (body: unknown): Promise<GoalBody> => {
      const response = await post(body);
      expect(response.status).toBe(400);
      return await bodyOf(response);
    };

    /**
     * A server whose stand-in records every ask and answers a goal — so a case that expects
     * a refusal *before* the model is asked anything can show that the list stayed empty.
     */
    const openCounting = async (): Promise<void> => {
      const reading = replying({ task: 'A', successCriterion: 'B' });
      asks = reading.asks;
      await open(() => reading.provider);
    };

    it('refuses a URL the platform will not point a swarm at, at siteUrl', async () => {
      await openCounting();

      for (const siteUrl of ['app.clipforge.example', '', 'ftp://clipforge.example', 42]) {
        const body = await refused({ siteUrl, feature: FEATURE });

        expect(
          body.issues?.map((issue) => issue.path),
          JSON.stringify(siteUrl),
        ).toStrictEqual(['siteUrl']);
      }
      expect(asks).toHaveLength(0);
    });

    it('refuses a feature box with nothing to read in it, at feature', async () => {
      await openCounting();

      // `...` is the one that matters: `String.trim` leaves it standing and the ask's own
      // rule does not, so a route trimming only whitespace would have handed `goalAsk` a
      // feature it refuses with a bare `TypeError` — a 500 for something a user typed.
      for (const feature of ['   ', '...', '???', '', undefined, 7]) {
        const body = await refused({ siteUrl: SITE_URL, feature });

        expect(
          body.issues?.map((issue) => issue.path),
          JSON.stringify(feature),
        ).toStrictEqual(['feature']);
      }
      expect(asks).toHaveLength(0);
    });

    it('names both fields of a body that carries neither', async () => {
      await openCounting();

      const body = await refused({});

      expect(body.issues?.map((issue) => issue.path)).toStrictEqual(['siteUrl', 'feature']);
      expect(body.error).toBe('That goal could not be asked for.');
      expect(asks).toHaveLength(0);
    });

    it('tells a body it could not read apart from a draft with a field missing', async () => {
      await openCounting();

      const response = await served.request('/runs/goal', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{"siteUrl": "https://app.clipforge.example"',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error).toBe('That goal could not be read.');
      expect(asks).toHaveLength(0);
    });
  });

  describe('a criterion no session can evaluate, twice', () => {
    it('refuses with the provider’s own sentence, having sent it back once', async () => {
      const judging = replying({
        task: 'A person tries to make a video.',
        successCriterion: A_JUDGEMENT,
      });
      await open(() => judging.provider);

      const response = await ask();

      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      // One send-back, then the refusal: two calls, and the second carries the criterion.
      expect(judging.asks).toHaveLength(2);
      expect(judging.asks[1]?.document).toContain(A_JUDGEMENT);
      // Decision 117: both criteria quoted, with an example of each kind the platform would
      // have accepted — the provider's sentence, unchanged and whole.
      expect(body.error).toContain(A_JUDGEMENT);
      expect(body.error).toContain('/checkout/success');
      // `{ error }` and nothing else, which is what the screen's `refusalSchema` reads.
      expect(Object.keys(body)).toStrictEqual(['error']);
      expect(typeof body.error).toBe('string');
    });

    it('is a refusal with a sentence, not a 500, when the reply is not a goal', async () => {
      // Two sentences where the shape holds each field to one: what a model answers when it
      // has explained the task instead of writing it.
      const chatty = replying({
        task: 'A person opens the page. Then they try to make a video.',
        successCriterion: 'The video player is visible.',
      });
      await open(() => chatty.provider);

      const response = await ask();

      expect(response.status).toBe(400);
      const body = await bodyOf(response);
      expect(body.error).toContain('not a goal this build can read');
      // The paths such a refusal carries are the reply shape's, so none is rendered as a
      // field of this step.
      expect(body.issues).toBeUndefined();
    });
  });

  describe('a call that could not be made at all', () => {
    it('answers one sentence and never the thrown message', async () => {
      const unreachable = failing(
        new WonderCallError({
          kind: 'transport',
          message: 'getaddrinfo ENOTFOUND graph.meta.example',
          use: 'goal',
        }),
      );
      await open(() => unreachable.provider);

      const response = await ask();

      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body.error).toContain(MODEL_API_KEY_ENV);
      expect(JSON.stringify(body)).not.toContain('ENOTFOUND');
    });
  });

  describe('with no model key where the platform runs', () => {
    it('names the key, points at the two fields, and leaks nothing that was thrown', async () => {
      // The **real** selection, over an environment holding nothing: this is the refusal
      // `personavision serve` gives on a machine with no key, and it does not depend on what
      // the machine running this test happens to export.
      await open(wonderFromEnv({}));

      const response = await ask();

      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body.error).toBe(
        `Muse Wonder could not be reached, so we could not write your goal — write the task and the success criterion below yourself, or set ${MODEL_API_KEY_ENV} where the platform runs and try again.`,
      );
      const printed = JSON.stringify(body);
      expect(printed).not.toContain('ModelModeUnavailableError');
      expect(printed).not.toContain('    at ');
    });
  });

  describe('the route family it sits in', () => {
    it('shadows no run, and is shadowed by none', async () => {
      await open(() => createOfflineWonderProvider());

      // The run written before the platform started is still read at its own path: the goal
      // route claims `/runs/goal` and nothing else.
      const run = await served.request(`/runs/${served.runIds[0] ?? ''}/run.json`, {
        headers: { cookie, accept: 'application/json' },
      });
      expect(run.status).toBe(200);

      // And `goal` is never read as the id of a run: the answer is a goal, not the 404 the
      // run-data mount gives a run nobody has, and not the app's own HTML.
      const goal = await ask();
      expect(goal.status).toBe(200);
      expect(goal.headers.get('content-type')).toContain('application/json');
      goalSchema.parse(await bodyOf(goal));

      // `POST /runs` is untouched: this deployment passes no pipeline, so starting a test is
      // still the 501 naming #54 rather than anything the goal route answered.
      const started = await served.request('/runs', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ site: SITE_URL, feature: FEATURE }),
      });
      expect(started.status).toBe(501);
    });
  });
});
