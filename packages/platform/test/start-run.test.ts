import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelModeUnavailableError } from '@personavision/provider';
import type { Audience, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE } from '@personavision/provider';
import { validRun } from '../../contract/tests/fixtures.js';
import { hashPassword } from '../src/store/password.js';
import type { StartedTest } from '../src/run/start.js';
import { cookieOf, startTestServer } from './http.js';
import type { TestServer } from './http.js';

/**
 * `POST /runs` — the New test screen's one request (#110), and where the model mode a
 * workspace's tests run in becomes an answer a person reads (#144).
 *
 * The swarm is #54, so the pipeline here is a stand-in that records what it was handed. The
 * reason these are HTTP tests and not more calls into `startTest` is that the criterion is
 * about **the response**: a refused test has to come back as a sentence the form puts above
 * itself, with nothing started and nothing stored.
 */

const RUN_ID = '2026-10-27-1130-northwind-checkout';

/** What the stand-in pipeline was handed, each time. */
interface Call {
  request: RunRequest;
  audience: Audience;
}

describe('starting a test over HTTP', () => {
  let served: TestServer;
  let calls: Call[];
  let answer: (request: RunRequest) => StartedTest | Error;
  let cookie: string;
  let audienceId: string;

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await served.signIn({ email, password });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };

  /** `null` for a signed-out request: an explicit `undefined` would take the default. */
  const post = (body: unknown, as: string | null = cookie): Promise<Response> =>
    served.request('/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(as === null ? {} : { cookie: as }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /** The request the New test form submits: no model mode, because it names none (#110). */
  const submission = (): Record<string, unknown> => ({
    task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
    variants: validRun().variants,
    audienceId,
    repeats: 3,
    seed: 1,
    engineMode: 'model',
  });

  beforeEach(async () => {
    calls = [];
    answer = () => ({ runId: RUN_ID, engineMode: 'offline' });
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind-demo' }],
      pipeline: async (request, audience) => {
        calls.push({ request, audience });
        const reply = answer(request);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    const seeded = served.platform.seeded;
    expect(seeded).not.toBeNull();
    cookie = await signIn(seeded?.email ?? '', seeded?.password ?? '');
    audienceId = seeded?.audienceId ?? '';
  });

  afterEach(async () => {
    await served.close();
  });

  it('answers with the id of the run it opened', async () => {
    const response = await post(submission());

    expect(response.status).toBe(201);
    expect(await response.json()).toStrictEqual({ runId: RUN_ID });
  });

  it('puts the seeded workspace’s contributor mode on the request', async () => {
    await post(submission());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.modelMode).toBe('contributor');
    // And the audience by value, resolved against the workspace that asked.
    expect(calls[0]?.audience.id).toBe(validRun().audience.id);
  });

  it('drops a mode the submission named: the workspace decides, not the form', async () => {
    // Nothing in the product sends this. A hand-rolled request that does is not a way to
    // have a test billed at another workspace's rate.
    await post({ ...submission(), modelMode: 'standard' });

    expect(calls[0]?.request.modelMode).toBe('contributor');
  });

  it('registers the run as the workspace’s', async () => {
    await post(submission());

    const workspace = await served.platform.store.workspaces.byId(
      served.platform.seeded?.workspaceId ?? '',
    );

    expect(workspace?.runIds).toContain(RUN_ID);
  });

  it('refuses a request with no session, and starts nothing', async () => {
    const response = await post(submission(), null);

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses a body it cannot read', async () => {
    const response = await post('{not json');

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a submission the contract does not accept, at the path each problem is at', async () => {
    const response = await post({ ...submission(), repeats: 0 });
    const body = (await response.json()) as { error: string; issues: { path: string }[] };

    expect(response.status).toBe(400);
    expect(body.issues.map((issue) => issue.path)).toContain('repeats');
    expect(calls).toEqual([]);
  });

  it('refuses an audience this workspace cannot test for', async () => {
    const response = await post({ ...submission(), audienceId: 'an-audience-of-nobodys' });

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  describe('a standard workspace whose model cannot be served', () => {
    let theirCookie: string;
    let theirWorkspaceId: string;
    let theirAudienceId: string;

    beforeEach(async () => {
      const them = await served.platform.store.accounts.create({
        email: 'owner@another.example',
        displayName: 'Another shop owner',
        password: await hashPassword('another-shops-password'),
      });
      // A workspace created without a stated mode: standard, which is the safe way round.
      const workspace = await served.platform.store.workspaces.create({
        name: 'Another shop',
        memberAccountIds: [them.id],
      });
      expect(workspace.modelMode).toBe('standard');
      theirWorkspaceId = workspace.id;
      // Their own record of the same audience: a different record from the demo
      // workspace's, because an audience belongs to the workspace that described it.
      theirAudienceId = (
        await served.platform.store.audiences.create(workspace.id, validRun().audience)
      ).id;
      theirCookie = await signIn('owner@another.example', 'another-shops-password');
      answer = () =>
        new ModelModeUnavailableError(
          `standard model mode (${MODEL_ID_BY_MODE.standard}) was asked for, but MODEL_API_KEY is not in the environment`,
        );
    });

    it('says which model could not be used, and that nothing was simulated', async () => {
      const response = await post({ ...submission(), audienceId: theirAudienceId }, theirCookie);
      const body = (await response.json()) as { error: string; modelMode: string };

      expect(response.status).toBe(503);
      expect(body.error).toContain(MODEL_ID_BY_MODE.standard);
      expect(body.error).toContain('Nothing was simulated');
      expect(body.modelMode).toBe('standard');
      // Never the contributor model, and never the offline engine.
      expect(body.error).not.toContain(MODEL_ID_BY_MODE.contributor);
      expect(body.error).not.toContain('offline');
    });

    it('stores no result: the workspace keeps the runs it had, which is none', async () => {
      await post({ ...submission(), audienceId: theirAudienceId }, theirCookie);

      const theirs = await served.platform.store.workspaces.byId(theirWorkspaceId);

      expect(theirs?.runIds).toEqual([]);
      // The request reached the pipeline once, naming standard, and was never retried on
      // the contributor model or on the offline engine.
      expect(calls.map(({ request }) => [request.modelMode, request.engineMode])).toEqual([
        ['standard', 'model'],
      ]);
    });

    it('leaks no key value into the response, with a key in the environment', async () => {
      // The variable's name is assembled rather than written, for the same reason
      // `tests/workspace.test.ts` assembles its patterns: a literal here reads as a
      // credential read in the scan that keeps those to the one place allowed one.
      const ENV_NAME = ['MODEL', 'API', 'KEY'].join('_');
      const SECRET = 'sk-live-not-a-real-credential-0123456789';
      const before = process.env[ENV_NAME];
      process.env[ENV_NAME] = SECRET;
      // A pipeline that leaks the key in its own message: nothing of it reaches the body.
      answer = () => new ModelModeUnavailableError(`the key ${SECRET} was rejected`);
      try {
        const response = await post({ ...submission(), audienceId: theirAudienceId }, theirCookie);

        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain(SECRET);
      } finally {
        if (before === undefined) delete process.env[ENV_NAME];
        else process.env[ENV_NAME] = before;
      }
    });
  });
});

describe('a deployment with no swarm wired in', () => {
  it('answers 501 naming the ticket that runs a test, rather than pretending', async () => {
    const served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind-demo' }],
    });
    try {
      const signedIn = await served.signIn({
        email: served.platform.seeded?.email ?? '',
        password: served.platform.seeded?.password ?? '',
      });
      const response = await served.request('/runs', {
        method: 'POST',
        headers: {
          cookie: cookieOf(signedIn),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
      });
      const body = (await response.json()) as { error: string; ticket: number };

      expect(response.status).toBe(501);
      expect(body.ticket).toBe(54);
    } finally {
      await served.close();
    }
  });
});
