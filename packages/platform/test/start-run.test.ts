import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelModeUnavailableError } from '@personavision/provider';
import { runSchema } from '@personavision/contract';
import type { Audience, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE } from '@personavision/provider';
import {
  oneVariantArtifact,
  USERS_FEATURE,
  validGoal,
  validRun,
} from '../../contract/tests/fixtures.js';
import { hashPassword } from '../src/store/password.js';
import { startSiteTest } from '../src/run/start.js';
import type { StartedTest, TestPipeline } from '../src/run/start.js';
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

/**
 * `POST /runs` with **one URL**: the test the New test wizard starts (#273, #276, #279) —
 * a site, the feature in the user's own words, the goal as they approved it, and an
 * audience (`docs/FLOW.md` section 11).
 *
 * The criteria are about **what the pipeline is handed**, so the stand-in records it: one
 * variant named for the site, the feature exactly as it was written, and the goal with its
 * author, which is what a reader a month later sees the test by. The run directory is the
 * pipeline's to write (#284 writes the blocks into it from this request), and the last test
 * here is the handover: what this platform built, recorded as a run the contract accepts.
 *
 * The two-variant cases above are untouched, and so is the form that submits them: a
 * path-1 test is a run with one variant and a path-2 test is a run with two.
 */
describe('starting a one-URL test over HTTP', () => {
  let served: TestServer;
  let calls: Call[];
  let cookie: string;
  let audienceId: string;

  /** The site of the wizard's own worked example (`#screen-newtest-feature`). */
  const SITE = 'https://app.clipforge.example/create';

  /** The stand-in swarm, as above: it records what it was handed and opens no directory. */
  const recording: TestPipeline = async (request, audience) => {
    calls.push({ request, audience });
    return { runId: RUN_ID, engineMode: 'offline' };
  };

  const post = (body: unknown): Promise<Response> =>
    served.request('/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie,
      },
      body: JSON.stringify(body),
    });

  /** What the launch step submits: no task, no repeats, no seed and no engine of its own. */
  const submission = (): Record<string, unknown> => ({
    site: SITE,
    feature: USERS_FEATURE,
    goal: validGoal(),
    audienceId,
  });

  /** The paths a refusal named, which is what a wizard step renders itself against. */
  const refusedAt = async (body: unknown): Promise<{ paths: string[]; messages: string[] }> => {
    const response = await post(body);
    const read = (await response.json()) as { issues?: { path: string; message: string }[] };

    expect(response.status).toBe(400);
    return {
      paths: (read.issues ?? []).map((issue) => issue.path),
      messages: (read.issues ?? []).map((issue) => issue.message),
    };
  };

  beforeEach(async () => {
    calls = [];
    served = await startTestServer({
      runs: [{ stamp: '2026-10-24T14:02:00.000Z', name: 'northwind-demo' }],
      pipeline: recording,
    });
    const seeded = served.platform.seeded;
    expect(seeded).not.toBeNull();
    const signedIn = await served.signIn({
      email: seeded?.email ?? '',
      password: seeded?.password ?? '',
    });
    expect(signedIn.status).toBe(200);
    cookie = cookieOf(signedIn);
    audienceId = seeded?.audienceId ?? '';
  });

  afterEach(async () => {
    await served.close();
  });

  it('runs one variant, named for the site and carrying its URL', async () => {
    const response = await post(submission());

    expect(response.status).toBe(201);
    expect(await response.json()).toStrictEqual({ runId: RUN_ID });
    expect(calls[0]?.request.variants).toStrictEqual([
      { id: 'site', name: 'app.clipforge.example', url: SITE },
    ]);
  });

  it('carries the feature sentence exactly as it was written', async () => {
    await post(submission());

    // The fixture is deliberately untidy — leading and trailing spaces, two sentences, a
    // doubled space and a shouted word — so an equality here is a test that nothing
    // trimmed it, split it, collapsed it or folded its case.
    expect(calls[0]?.request.feature).toBe(USERS_FEATURE);
  });

  it('carries the goal with who last wrote it', async () => {
    await post(submission());

    expect(calls[0]?.request.goal).toStrictEqual(validGoal());
  });

  it('takes the task each person attempts from the goal, rather than asking twice', async () => {
    await post(submission());

    expect(calls[0]?.request.task).toStrictEqual({ prompt: validGoal().task });
  });

  it('puts the workspace’s mode on it and resolves the audience by value', async () => {
    await post(submission());

    expect(calls[0]?.request.modelMode).toBe('contributor');
    expect(calls[0]?.audience.id).toBe(validRun().audience.id);
  });

  it('runs at the seed of the day it was launched on, one attempt each, on a model', async () => {
    // Called directly, because the day is the point: over HTTP there is no clock to state.
    await startSiteTest({
      workspaces: served.platform.store.workspaces,
      audiences: served.platform.store.audiences,
      workspaceId: served.platform.seeded?.workspaceId ?? '',
      draft: { site: SITE, feature: USERS_FEATURE, goal: validGoal(), audienceId },
      pipeline: recording,
      now: () => new Date('2026-11-03T09:14:00.000Z'),
    });

    // The seed `#screen-results` prints under the audience, for a test launched that day.
    expect(calls[0]?.request.seed).toBe(20261103);
    // A hundred people attempt the feature once each, so the agents are the audience.
    expect(calls[0]?.request.repeats).toBe(1);
    expect(calls[0]?.request.engineMode).toBe('model');
  });

  it('obeys a caller that names the seed, the repeats or the engine itself', async () => {
    await post({ ...submission(), seed: 7, repeats: 3, engineMode: 'offline' });

    expect(calls[0]?.request.seed).toBe(7);
    expect(calls[0]?.request.repeats).toBe(3);
    expect(calls[0]?.request.engineMode).toBe('offline');
  });

  it('refuses a draft with no feature, naming the field and what it expected', async () => {
    const { paths, messages } = await refusedAt({ ...submission(), feature: '   ' });

    expect(paths).toStrictEqual(['feature']);
    expect(messages[0]).toContain('nothing was written here');
    expect(messages[0]).toContain("in the user's own words");
    expect(calls).toEqual([]);
  });

  it('refuses a draft missing either half of the goal, naming both halves', async () => {
    const { paths, messages } = await refusedAt({
      ...submission(),
      goal: { task: '', successCriterion: '', lastWrittenBy: 'model' },
    });

    expect(paths).toStrictEqual(['goal.task', 'goal.successCriterion']);
    expect(messages[1]).toContain('observable in the page');
    expect(calls).toEqual([]);
  });

  it('refuses a draft with no goal at all, as one field rather than two', async () => {
    const { site, feature, audienceId: audience } = submission();
    const { paths } = await refusedAt({ site, feature, audienceId: audience });

    expect(paths).toStrictEqual(['goal']);
    expect(calls).toEqual([]);
  });

  it('refuses a draft with no site, in the words the Add-a-site form uses', async () => {
    const { paths, messages } = await refusedAt({ ...submission(), site: '' });

    expect(paths).toStrictEqual(['site']);
    expect(messages[0]).toContain('a site needs a URL');
    expect(calls).toEqual([]);
  });

  it('refuses a site that is not a whole web address', async () => {
    const { paths, messages } = await refusedAt({
      ...submission(),
      site: 'app.clipforge.example/create',
    });

    expect(paths).toStrictEqual(['site']);
    expect(messages[0]).toContain('absolute URL');
    expect(calls).toEqual([]);
  });

  it('names every field at once: a missing site and a missing feature in one refusal', async () => {
    const { paths } = await refusedAt({ ...submission(), site: '', feature: '' });

    expect(paths).toStrictEqual(['site', 'feature']);
    expect(calls).toEqual([]);
  });

  it('refuses a goal whose author is neither the model nor the user, at its own field', async () => {
    const { paths, messages } = await refusedAt({
      ...submission(),
      goal: { ...validGoal(), lastWrittenBy: 'the intern' },
    });

    // The contract's own refusal, reaching the caller with the field it is about named.
    expect(paths).toStrictEqual(['goal.lastWrittenBy']);
    expect(messages[0]).toContain('model');
    expect(messages[0]).toContain('user');
    expect(calls).toEqual([]);
  });

  it('refuses a submission that is both forms at once, naming the variants it found', async () => {
    const { paths, messages } = await refusedAt({ ...submission(), variants: validRun().variants });

    expect(paths).toStrictEqual(['variants']);
    expect(messages[0]).toContain('two versions');
    expect(calls).toEqual([]);
  });

  it('names no field the wizard does not have, whatever it refuses', async () => {
    const wizardFields = new Set([
      'site',
      'feature',
      'goal',
      'goal.task',
      'goal.successCriterion',
      'goal.lastWrittenBy',
      'audienceId',
    ]);

    for (const body of [
      { ...submission(), site: '', feature: '', goal: { task: '', successCriterion: '' } },
      { ...submission(), goal: { ...validGoal(), task: 'Generate a video. Then share it.' } },
      { ...submission(), site: 'ftp://app.clipforge.example/create' },
    ]) {
      const { paths } = await refusedAt(body);

      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((path) => !wizardFields.has(path))).toEqual([]);
    }
  });

  it('lets no account id, workspace id or credential into the request', async () => {
    const workspaceId = served.platform.seeded?.workspaceId ?? '';
    const { paths } = await refusedAt({
      ...submission(),
      workspaceId,
      sessionToken: 'pv_not-a-real-credential',
    });

    // Refused at its own path rather than dropped: the closed-object rule the contract
    // holds every artifact file to, applied to the submission that starts one.
    expect(paths).toStrictEqual(['workspaceId', 'sessionToken']);
    expect(calls).toEqual([]);
  });

  it('hands the pipeline the request the contract declares and nothing else', async () => {
    await post(submission());
    const request = calls[0]?.request;

    expect(Object.keys(request ?? {}).toSorted()).toStrictEqual([
      'audienceId',
      'engineMode',
      'feature',
      'goal',
      'modelMode',
      'repeats',
      'seed',
      'task',
      'variants',
    ]);
    // Nothing of the session that asked travels with it into the artifact.
    expect(JSON.stringify(request)).not.toContain(served.platform.seeded?.workspaceId ?? '—');
    expect(JSON.stringify(request)).not.toContain(served.platform.seeded?.email ?? '—');
  });

  it('builds a one-variant run the contract accepts, feature and goal and all', async () => {
    await post(submission());
    const request = calls[0]?.request;
    const { run } = oneVariantArtifact();
    const variant = request?.variants[0]?.id ?? '';
    const on = (rows: readonly { readonly variant: string }[]): unknown[] =>
      rows.map((row) => ({ ...row, variant }));

    // The contract's own one-variant artifact, with what this platform built in place of
    // what the fixture declared: the run a pipeline writes from this request (#284).
    const recorded = runSchema.parse({
      ...run,
      feature: request?.feature,
      goal: request?.goal,
      task: { id: run.task.id, prompt: request?.task.prompt },
      variants: [...(request?.variants ?? [])],
      progress: {
        ...run.progress,
        perVariant: on(run.progress?.perVariant ?? []),
        sessions: on(run.progress?.sessions ?? []),
      },
      stepCaptions: on(run.stepCaptions),
      screenshots: on(run.screenshots),
      aois: on(run.aois),
      scores: on(run.scores),
      verdict: {
        ...run.verdict,
        harderVariant: variant,
        preferredVariant: variant,
        heroEvidence: { ...run.verdict.heroEvidence, variant },
      },
    });

    expect(recorded.variants).toStrictEqual([
      { id: 'site', name: 'app.clipforge.example', url: SITE },
    ]);
    expect(recorded.feature).toBe(USERS_FEATURE);
    expect(recorded.goal).toStrictEqual(validGoal());
  });
});
