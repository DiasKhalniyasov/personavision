import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRun, validate } from '@personavision/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMENT_MARKER, SIMULATED_LABEL } from '../../src/index.js';
import { PREVIEW_URL, PULL_NUMBER, PULL_URL, RUN_URL, TOKEN } from '../loop/fixture.js';
import {
  HOLDOUT_SEED,
  HOLDOUT_SIZE,
  holdoutPersonaId,
  RUN_ID,
  SOURCE_RUN_ID,
  walkPathTwo,
} from './fixture.js';
import type { Run, Score, Session } from '@personavision/contract';
import type { ImproveFinished, ImproveStopped } from '../../src/index.js';
import type { Walk } from './fixture.js';

/**
 * **Path 2, walked end to end from a cold start** — the step's own proof, and the half of it
 * that needs no screen (#307).
 *
 * Every piece of path 2 is tested on its own: the client (#297), the change and its refusal
 * (#302), the preview (#300), the holdout (#303), the comparison (#304), the comment (#301)
 * and the loop that runs them in order (#306). What none of them answers is whether somebody
 * on a **fresh clone** can watch path 2 happen: a path-1 run over the demo shop, a change
 * decided from its own recommendations, a pull request on a recorded repository, a preview
 * resolved, both versions and the holdout driven, the before/after written, and the comment
 * the pull request would receive. That walk is this file, and `docs/demo.md` is the same walk
 * written down beat by beat for a person to follow.
 *
 * `tests/path2-cold-start.test.ts` is the other half: it takes what this writes, serves it
 * with the **built** viewer and drives the Improve screen in a real browser, because a green
 * run in this file does not answer layout, stacking or the minified stylesheet.
 *
 * **Nothing here needs a GitHub App, a token or a network.** The repository is the recorded
 * one every test in this step uses, `fetch` is stubbed to throw, Muse Wonder is the offline
 * provider, and the path-1 run is the one committed under `runs/`. Three things are asserted
 * about that, not assumed: no merge, close or default-branch write anywhere in the
 * transcript; no token in any artifact, output or log line; and the run the walk produces
 * validates against the contract.
 *
 * **Both verdicts are walked**, because the product exists to be honest about the second: a
 * change that wins on the seeds it was chosen on and not on the holdout is *not confirmed*,
 * in the sentence and in the comment's first line, and a walk-through that only showed the
 * good news would not have checked the thing that matters.
 */

/** A whole loop writes sixty-four sessions twice over; three walks is the budget. */
const WALK_TIMEOUT = 120_000;

const finished = (walk: Walk): ImproveFinished => {
  if (walk.result.kind !== 'finished') {
    throw new Error(
      `the loop did not finish: ${walk.result.kind === 'stopped' ? `${walk.result.step} — ${walk.result.reason}` : walk.result.kind}`,
    );
  }
  return walk.result;
};

const stopped = (walk: Walk): ImproveStopped => {
  if (walk.result.kind !== 'stopped') {
    throw new Error(`the loop did not stop: it ${walk.result.kind}`);
  }
  return walk.result;
};

const improveOf = (run: Run): NonNullable<Run['improve']> => {
  if (run.improve === undefined) throw new Error(`${run.runId} carries no change`);
  return run.improve;
};

const scoreOf = (run: Run, variant: string): Score => {
  const found = run.scores.find(
    (score) => score.variant === variant && score.taskId === run.task.id,
  );
  if (found === undefined) throw new Error(`${run.runId} carries no score for ${variant}`);
  return found;
};

/** `38 of 93 people`, as the comment's own `population` spells it. */
const population = (figures: { outcomeCounts: { success: number }; scoredSessionCount: number }) =>
  `${String(figures.outcomeCounts.success)} of ${String(figures.scoredSessionCount)} ${figures.scoredSessionCount === 1 ? 'person' : 'people'}`;

/** What a reader sees as a measurement, as `comment/body.ts` reads its own finished text. */
const MEASUREMENT =
  /\d[\d,.]*\s*%|\b\d+\s+(?:of|in)\s+(?:the\s+)?\d+\b|\b\d+\s+people\b|\b\d[\d,.]*\s*m?s\b|\b\d+\s+times\b/;

/** The body of the one comment the walk posted, as the transcript recorded it being sent. */
const postedComment = (walk: Walk): string => {
  const posted = walk.requests.find(
    (call) => call.method === 'POST' && call.path.endsWith('/comments'),
  );
  if (posted === undefined) throw new Error('no comment was posted');
  const body = (posted.body as { body?: unknown } | undefined)?.body;
  if (typeof body !== 'string') throw new Error('the posted comment carried no body');
  return body;
};

/** Every file the walk wrote under the run directory, by its path. */
const writtenFiles = async (runDir: string): Promise<[string, string][]> => {
  const files: [string, string][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push([path, await readFile(path, 'utf8')]);
    }
  };
  await walk(runDir);
  return files;
};

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('a cold-start walk of path 2 reaches no network');
    }),
  );
  return () => void vi.unstubAllGlobals();
});

describe('the confirmed walk', () => {
  let walk: Walk;
  let run: Run;
  let sessions: readonly Session[];

  beforeAll(async () => {
    walk = await walkPathTwo({ went: 'confirmed' });
    const artifact = await readRun(walk.runDir);
    run = artifact.run;
    sessions = artifact.sessions;
  }, WALK_TIMEOUT);

  afterAll(async () => {
    await walk.cleanup();
  });

  it('beat 1 — starts from the path-1 run a fresh clone holds, and decides one change from it', () => {
    expect(walk.source.run.runId).toBe(SOURCE_RUN_ID);
    // The recommendations are the committed run's own file, not a fixture of this suite's.
    expect(walk.source.recommendations?.runId).toBe(SOURCE_RUN_ID);
    expect(walk.recommendation.rank).toBe(
      Math.min(...(walk.source.recommendations?.recommendations ?? []).map((one) => one.rank)),
    );

    const improve = improveOf(run);
    expect(improve.recommendationId).toBe(walk.recommendation.id);
    expect(improve.recommendationSentence).toBe(walk.recommendation.sentence);
    // One change, and the file it touches is the one the repository handed in.
    expect(improve.changedFile).toBe('app/checkout/page.tsx');
    expect(improve.patch).toContain(`+++ b/${improve.changedFile}`);
    expect(improve.patch).toContain(walk.recommendation.sentence);
  });

  it('beat 2 — opens it as a pull request that states the recommendation, the evidence and the simulation', () => {
    const opened = finished(walk).pullRequest;

    expect(opened).toEqual({
      repository: 'clipforge/web',
      number: PULL_NUMBER,
      url: PULL_URL,
      title: walk.recommendation.sentence,
      state: 'open',
    });
    const body = walk.requests.find(
      (call) => call.method === 'POST' && call.path.endsWith('/pulls'),
    )?.body as { body?: string; head?: string; base?: string } | undefined;
    expect(body?.base).toBe('main');
    expect(body?.head).toBe(`personavision/${RUN_ID}`);
    expect(body?.body).toContain(walk.recommendation.sentence);
    expect(body?.body).toContain(walk.recommendation.evidence);
    expect(body?.body).toContain(SIMULATED_LABEL);
  });

  it('beat 3 — resolves the preview from the pull request’s own deployment statuses', () => {
    expect(improveOf(run).preview).toEqual({ url: PREVIEW_URL });
    expect(walk.requests.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/clipforge/web/git/ref/heads/personavision/${RUN_ID}`,
      'GET /repos/clipforge/web/git/ref/heads/main',
      'GET /repos/clipforge/web/contents/app/checkout/page.tsx?ref=9f1c0b7e5d3a2f4b6c8d0e1f2a3b4c5d6e7f8a9b',
      'POST /repos/clipforge/web/git/refs',
      'PUT /repos/clipforge/web/contents/app/checkout/page.tsx',
      'POST /repos/clipforge/web/pulls',
      'GET /repos/clipforge/web/deployments?sha=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b&per_page=100',
      'GET /repos/clipforge/web/deployments/7701/statuses?per_page=100',
      `GET /repos/clipforge/web/issues/${String(PULL_NUMBER)}/comments?per_page=100`,
      `POST /repos/clipforge/web/issues/${String(PULL_NUMBER)}/comments`,
    ]);
  });

  it('beat 4 — drives both versions on the same seeds plus the holdout, and writes a run the contract accepts', async () => {
    expect(run.runId).toBe(RUN_ID);
    expect(run.status).toBe('finished');
    expect(await validate(walk.runDir)).toEqual([]);

    const improve = improveOf(run);
    expect(improve.baselineVariant).toBe('A');
    expect(improve.changeVariant).toBe('B');
    expect(improve.holdout.personaIds).toEqual(
      Array.from({ length: HOLDOUT_SIZE }, (_, position) => holdoutPersonaId(position)),
    );
    // The participants are the audience's own people; the holdout is people beside them.
    expect(run.personas).toHaveLength(run.audience.size + HOLDOUT_SIZE);
    expect(run.seedGroups).toEqual(walk.source.run.seedGroups);

    const heldOut = new Set(improve.holdout.personaIds);
    const seedsOf = (held: boolean): number[] => [
      ...new Set(
        sessions
          .filter((session) => heldOut.has(session.persona?.id ?? '') === held)
          .map((session) => session.seed)
          .filter((seed): seed is number => seed !== null),
      ),
    ];
    // The whole point of a holdout: seeds the change was never chosen against.
    expect(seedsOf(false).sort()).toEqual([...run.seedGroups].sort());
    expect(seedsOf(true)).toEqual([HOLDOUT_SEED]);
    expect(seedsOf(true).filter((seed) => run.seedGroups.includes(seed))).toEqual([]);
    // Both versions, driven on the same people: a like-for-like comparison.
    for (const variant of ['A', 'B']) {
      expect(
        [
          ...new Set(
            sessions
              .filter(
                (session) => session.variant === variant && !heldOut.has(session.persona?.id ?? ''),
              )
              .map((session) => session.persona?.id),
          ),
        ].sort(),
        variant,
      ).toEqual(
        run.personas
          .slice(0, run.audience.size)
          .map((person) => person.id)
          .sort(),
      );
    }
  });

  it('beat 5 — the before and after: three figures and a holdout that confirmed the gain', () => {
    const baseline = scoreOf(run, 'A');
    const change = scoreOf(run, 'B');

    // The change is the version more of the audience completed, by the figures the run stored.
    expect(change.completionRate).toBeGreaterThan(baseline.completionRate);
    expect(run.verdict.preferredVariant).toBe('B');
    expect(run.verdict.bandsDisjoint).toBe(true);
    expect(run.verdict.seedGroupsAgreeing).toBe(run.seedGroups.length);
    // The third figure is the holdout's own on the change, and it is about the twenty.
    expect(change.holdout?.scoredSessionCount).toBe(HOLDOUT_SIZE);
    expect(baseline.holdout?.scoredSessionCount).toBe(HOLDOUT_SIZE);
    // Never pooled: the two main figures are of the audience, not of the audience plus the
    // holdout (decision 92).
    expect(baseline.scoredSessionCount + change.scoredSessionCount).toBeLessThan(sessions.length);

    expect(run.verdict.holdout).toBe('confirmed');
    expect(improveOf(run).holdout.confirmed).toBe(true);
    expect(run.verdict.audienceSentence).toContain(
      `Confirmed on the holdout: the ${String(HOLDOUT_SIZE)} people the change was never chosen against did the same.`,
    );
    expect(run.verdict.reasons).toContain(
      'The holdout moved with them, so the gain is the change and not the swarm agreeing with itself.',
    );
  });

  it('beat 6 — the comment the pull request receives, in full', () => {
    const baseline = scoreOf(run, 'A');
    const change = scoreOf(run, 'B');
    const holdout = change.holdout;
    if (holdout === undefined) throw new Error('the change carries no holdout figures');

    const expected = [
      COMMENT_MARKER,
      '',
      `### Before and after, ${SIMULATED_LABEL} for ${run.audience.name}`,
      '',
      // The run's own sentence, with the label this comment puts on every line that
      // states a number — and it states twenty people.
      `**Confirmed on the holdout.** ${run.verdict.audienceSentence} (${SIMULATED_LABEL})`,
      '',
      `- **Baseline** — 0% completed the task (${SIMULATED_LABEL}), ${population(baseline)}`,
      `- **With the change** — 92% completed the task (${SIMULATED_LABEL}), ${population(change)}`,
      `- **Holdout** — 100% completed the task (${SIMULATED_LABEL}), ${population(holdout)}, on seeds this change was never chosen against`,
      '',
      '**Why**',
      '',
      ...run.verdict.reasons.map((reason) => `- ${reason}`),
      '',
      `[See this run on PersonaVision](${RUN_URL})`,
      '',
      `Simulated for ${run.audience.name}. It says this change helps these people; it does not estimate what it will do to your conversion rate. Merging is yours.`,
      '',
    ].join('\n');

    expect(postedComment(walk)).toBe(expected);
    // Every line that states a number says it is simulated — read off the text a reader
    // sees, line by line, because a reader cannot see an intention.
    const link = `[See this run on PersonaVision](${RUN_URL})`;
    expect(
      postedComment(walk)
        .split('\n')
        .filter((line) => line !== link && MEASUREMENT.test(line) && !/simulated/i.test(line)),
    ).toEqual([]);
    expect(postedComment(walk)).toContain(RUN_URL);
    // One comment, posted once: the pull request carried none of ours.
    expect(finished(walk).comment.kind).toBe('posted');
  });

  it('never merges, closes or writes to the default branch, anywhere in the transcript', () => {
    const writes = walk.requests.filter((call) => call.method !== 'GET');

    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /repos/clipforge/web/git/refs',
      'PUT /repos/clipforge/web/contents/app/checkout/page.tsx',
      'POST /repos/clipforge/web/pulls',
      `POST /repos/clipforge/web/issues/${String(PULL_NUMBER)}/comments`,
    ]);
    for (const call of walk.requests) {
      expect(call.path, call.path).not.toContain('/merge');
      expect(JSON.stringify(call.body ?? {})).not.toContain('"state":"closed"');
    }
    // The branch a write names is this run's own, never the base branch it was cut from.
    const created = writes.find((call) => call.path.endsWith('/git/refs'))?.body as
      { ref?: string } | undefined;
    expect(created?.ref).toBe(`refs/heads/personavision/${RUN_ID}`);
    expect(
      writes.filter((call) => JSON.stringify(call.body ?? {}).includes('"branch":"main"')),
    ).toEqual([]);
  });

  it('writes no token into an artifact, an output line or a log line', async () => {
    for (const [path, text] of await writtenFiles(walk.runDir)) {
      expect(text, path).not.toContain(TOKEN);
    }
    expect(walk.printed.join('\n')).not.toContain(TOKEN);
    expect(postedComment(walk)).not.toContain(TOKEN);
    // And the progress a person reads says which step it is on, in words.
    expect(walk.printed.some((line) => line.startsWith('Step 1 of 5'))).toBe(true);
    expect(walk.printed.some((line) => line.startsWith('Step 5 of 5'))).toBe(true);
  });
});

describe('the not-confirmed walk', () => {
  let walk: Walk;
  let run: Run;

  beforeAll(async () => {
    walk = await walkPathTwo({ went: 'not_confirmed' });
    run = (await readRun(walk.runDir)).run;
  }, WALK_TIMEOUT);

  afterAll(async () => {
    await walk.cleanup();
  });

  it('is the same gain on the original seeds, and a holdout that did not move with it', () => {
    expect(scoreOf(run, 'B').completionRate).toBeGreaterThan(scoreOf(run, 'A').completionRate);
    expect(run.verdict.bandsDisjoint).toBe(true);
    expect(run.verdict.holdout).toBe('not_confirmed');
    expect(improveOf(run).holdout.confirmed).toBe(false);
  });

  it('says so in the sentence, and the sentence does not read as a gain', () => {
    const sentence = run.verdict.audienceSentence;

    expect(sentence).toContain(
      `the ${String(HOLDOUT_SIZE)} people the change was never chosen against did not move with them: this gain is not confirmed.`,
    );
    // The headline is **replaced** rather than appended to: no sentence of it states the
    // gain and then takes it back, and nothing in it reads as confirmation (decision 96).
    expect(sentence).not.toContain('Confirmed on the holdout');
    expect(sentence.toLowerCase()).not.toContain('confirmed on the holdout.');
    expect(run.verdict.reasons).toContain(
      'The holdout did not move with them, so the gain may be the swarm agreeing with itself rather than the change.',
    );
  });

  it('leads the comment with it, where a reader who stops after two lines still sees it', () => {
    const text = postedComment(walk);
    const [marker, heading, holdoutLine] = text.split('\n\n');

    expect(marker).toBe(COMMENT_MARKER);
    expect(heading).toBe(`### Before and after, ${SIMULATED_LABEL} for ${run.audience.name}`);
    expect(holdoutLine).toBe(
      `**Not confirmed on the holdout.** ${run.verdict.audienceSentence} (${SIMULATED_LABEL})`,
    );
    expect(text).not.toContain('**Confirmed on the holdout.**');
    expect(
      text.split('\n').filter((line) => MEASUREMENT.test(line) && !/simulated/i.test(line)),
    ).toEqual([]);
  });
});

describe('the walk where the repository publishes no preview', () => {
  let walk: Walk;

  beforeAll(async () => {
    walk = await walkPathTwo({ noPreview: true });
  }, WALK_TIMEOUT);

  afterAll(async () => {
    await walk.cleanup();
  });

  it('stops at the preview step, and the pull request it opened stays open', async () => {
    const stop = stopped(walk);

    expect(stop.step).toBe('preview');
    expect(stop.reason).toContain(
      `Path 2 needs a preview deployment: pull request #${String(PULL_NUMBER)} of clipforge/web has none`,
    );
    expect(stop.reason).toContain('PersonaVision never runs your build');
    expect(stop.pullRequest?.number).toBe(PULL_NUMBER);
    expect(stop.pullRequest?.state).toBe('open');
    expect(stop.preview?.url).toBeNull();
    // What was already done stays done, and nothing about it was undone.
    expect(
      walk.requests.filter((call) => call.method !== 'GET').map((call) => call.method),
    ).toEqual(['POST', 'PUT', 'POST']);
    // No comment: there is no comparison to report, so there is nothing to post.
    expect(walk.requests.filter((call) => call.path.includes('/comments'))).toEqual([]);
    // And the run on disk says which step stopped it, and is still a run the contract reads.
    const { run } = await readRun(walk.runDir);
    expect(run.status).toBe('failed');
    expect(run.failure?.reason).toBe('The change has no preview deployment to be tested at');
    expect(run.failure?.detail).toContain(`Pull request #${String(PULL_NUMBER)}`);
    expect(await validate(walk.runDir)).toEqual([]);
  });
});
