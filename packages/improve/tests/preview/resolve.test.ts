import { previewSchema } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../../src/github/client.js';
import type { GitHubRepository } from '../../src/github/client.js';
import { createRecordedTransport } from '../../src/github/recorded.js';
import type { RecordedExchange } from '../../src/github/recorded.js';
import type { PreviewProbe } from '../../src/preview/probe.js';
import { previewRecordOf, resolvePreview } from '../../src/preview/resolve.js';
import type { PreviewResolution } from '../../src/preview/resolve.js';

/**
 * The URL the changed version is tested at, and the honest nothing when there is none
 * (#300, `docs/FLOW.md` section 15 point 3).
 *
 * Every test here runs over the recorded transport: no token, no network, and the preview
 * URL's own reachability arrives as an injected probe rather than a request. The three
 * answers — a URL, no preview deployment at all, a preview that is not usable — are
 * asserted as three different shapes, because a caller that cannot tell "there is none"
 * from "not yet" will point a hundred browsers at the wrong thing.
 */

const TOKEN = 'installation-token-for-tests-0123456789';
const REPOSITORY: GitHubRepository = { owner: 'clipforge', repo: 'web' };
const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const PULL_NUMBER = 7;
const PREVIEW_URL = 'https://clipforge-web-git-pv-wait.preview.example';

const deploymentsPath = `/repos/clipforge/web/deployments?sha=${SHA}&per_page=100`;
const statusesPath = (id: number): string =>
  `/repos/clipforge/web/deployments/${String(id)}/statuses?per_page=100`;

const deployment = (id: number, createdAt: string, environment = 'Preview'): unknown => ({
  id,
  environment,
  ref: 'personavision/2026-11-03-1402-clipforge',
  created_at: createdAt,
});

const status = (
  id: number,
  state: string,
  extra: { readonly environment_url?: string; readonly description?: string } = {},
): unknown => ({ id, state, created_at: '2026-11-03T14:05:00Z', ...extra });

const exchangesFor = (
  deployments: readonly unknown[],
  statuses: readonly { readonly id: number; readonly body: readonly unknown[] }[],
): readonly RecordedExchange[] => [
  { method: 'GET', path: deploymentsPath, reply: { body: deployments } },
  ...statuses.map((entry): RecordedExchange => ({
    method: 'GET',
    path: statusesPath(entry.id),
    reply: { body: entry.body },
  })),
];

const reachable: PreviewProbe = (url) =>
  Promise.resolve({ reachable: true, answered: `the request to ${url} answered 200` });

/** A clock and a sleep that move together, so a wait runs its cap out in no real time. */
const fakeClock = (): {
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly slept: readonly number[];
} => {
  let atMs = 0;
  const slept: number[] = [];
  return {
    nowMs: () => atMs,
    sleep: (ms) => {
      slept.push(ms);
      atMs += ms;
      return Promise.resolve();
    },
    slept,
  };
};

const resolve = async (
  exchanges: readonly RecordedExchange[],
  options: Parameters<typeof resolvePreview>[2] = {},
): Promise<{
  readonly resolution: PreviewResolution;
  readonly paths: readonly string[];
}> => {
  const recorded = createRecordedTransport(exchanges);
  const client = createGitHubClient({ token: TOKEN, transport: recorded.transport });
  const resolution = await resolvePreview(
    client,
    { repository: REPOSITORY, pullNumber: PULL_NUMBER, sha: SHA },
    { probe: reachable, ...options },
  );
  return { resolution, paths: recorded.requests.map((request) => request.path) };
};

describe('a pull request whose deployment published a preview', () => {
  it('resolves to that URL, read through the client seam', async () => {
    const { resolution, paths } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [{ id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] }],
      ),
    );

    expect(resolution.kind).toBe('preview');
    expect(resolution.kind === 'preview' ? resolution.url : undefined).toBe(PREVIEW_URL);
    expect(paths).toEqual([deploymentsPath, statusesPath(11)]);
  });

  it('resolves several successful deployments to the most recent one', async () => {
    const { resolution } = await resolve(
      exchangesFor(
        [
          deployment(11, '2026-11-03T14:04:00Z'),
          deployment(12, '2026-11-03T14:09:00Z'),
          deployment(10, '2026-11-03T13:40:00Z'),
        ],
        [
          {
            id: 12,
            body: [status(94, 'success', { environment_url: 'https://newest.preview.example' })],
          },
          { id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] },
          {
            id: 10,
            body: [status(88, 'success', { environment_url: 'https://oldest.preview.example' })],
          },
        ],
      ),
    );

    expect(resolution.kind === 'preview' ? resolution.url : undefined).toBe(
      'https://newest.preview.example',
    );
  });

  it('checks the URL answers before handing it on, and never hands on one that does not', async () => {
    const asked: string[] = [];
    const dead: PreviewProbe = (url) => {
      asked.push(url);
      return Promise.resolve({
        reachable: false,
        answered: `the request to ${url} answered nothing — TypeError: fetch failed`,
      });
    };

    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [{ id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] }],
      ),
      { probe: dead },
    );

    expect(asked).toEqual([PREVIEW_URL]);
    expect(resolution.kind).toBe('unusable');
    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('unreachable');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain('fetch failed');
    // No shape but a found preview carries a URL, so an unreachable host cannot be read as one.
    expect('url' in resolution).toBe(false);
  });
});

describe('a repository with no preview deployment of its own', () => {
  it('answers that no preview deployment exists, with the sentence a user can act on', async () => {
    const { resolution, paths } = await resolve(exchangesFor([], []));

    expect(resolution.kind).toBe('no_preview');
    expect(resolution.kind === 'no_preview' ? resolution.reason : '').toContain(
      'needs a preview deployment',
    );
    expect('url' in resolution).toBe(false);
    expect(paths).toEqual([deploymentsPath]);
  });

  it('never reads a production deployment of the same commit as a preview', async () => {
    const { resolution } = await resolve(
      exchangesFor([deployment(11, '2026-11-03T14:04:00Z', 'Production')], []),
    );

    expect(resolution.kind).toBe('no_preview');
  });
});

describe('a preview that exists but is not usable', () => {
  it('waits for a pending deployment within the caller’s cap and then answers not ready', async () => {
    const clock = fakeClock();
    const pending = [{ id: 11, body: [status(91, 'in_progress', { description: 'Building' })] }];
    const { resolution, paths } = await resolve(
      [
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], pending),
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], pending),
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], pending),
      ],
      { waitMs: 20_000, pollEveryMs: 10_000, nowMs: clock.nowMs, sleep: clock.sleep },
    );

    expect(resolution.kind).toBe('unusable');
    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('not_ready');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain('Building');
    expect(clock.slept).toEqual([10_000, 10_000]);
    expect(clock.nowMs()).toBe(20_000);
    expect(paths).toHaveLength(6);
  });

  it('stops reading when the cap is spent, even if the clock never moves', async () => {
    const slept: number[] = [];
    const pending = [{ id: 11, body: [status(91, 'queued')] }];
    const stuck = [deployment(11, '2026-11-03T14:04:00Z')];

    const { resolution, paths } = await resolve(
      [
        ...exchangesFor(stuck, pending),
        ...exchangesFor(stuck, pending),
        ...exchangesFor(stuck, pending),
        ...exchangesFor(stuck, pending),
        ...exchangesFor(stuck, pending),
      ],
      {
        waitMs: 3,
        pollEveryMs: 1,
        nowMs: () => 0,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    );

    // A cap of 3 ms read every 1 ms is four reads and no more, whatever the clock says.
    expect(paths).toHaveLength(8);
    expect(slept).toEqual([1, 1, 1]);
    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('not_ready');
  });

  it('answers failed, carrying what the status said', async () => {
    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [
          {
            id: 11,
            body: [status(91, 'failure', { description: 'Build failed: exit code 1' })],
          },
        ],
      ),
    );

    expect(resolution.kind).toBe('unusable');
    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('failed');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain(
      'Build failed: exit code 1',
    );
  });

  it('reads the newest status of a deployment, not the first one it was given', async () => {
    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [
          {
            id: 11,
            body: [
              { id: 90, state: 'in_progress', created_at: '2026-11-03T14:05:00Z' },
              {
                id: 91,
                state: 'success',
                created_at: '2026-11-03T14:07:00Z',
                environment_url: PREVIEW_URL,
              },
            ],
          },
        ],
      ),
    );

    expect(resolution.kind === 'preview' ? resolution.url : undefined).toBe(PREVIEW_URL);
  });
});

describe('the states GitHub actually sends', () => {
  it('reads a success that published an empty URL as no URL, not as a dead host', async () => {
    const asked: string[] = [];
    const probe: PreviewProbe = (url) => {
      asked.push(url);
      return Promise.resolve({ reachable: true, answered: 'answered 200' });
    };

    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [
          {
            id: 11,
            body: [status(91, 'success', { environment_url: '', description: 'Deployed' })],
          },
        ],
      ),
      { probe },
    );

    // GitHub sends `environment_url` as "" when none was published, so nothing is probed.
    expect(asked).toEqual([]);
    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('failed');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain('published no URL');
  });

  it('waits on `waiting`, which is what a deployment awaiting its approval reports', async () => {
    const clock = fakeClock();
    const waiting = [
      { id: 11, body: [status(91, 'waiting', { description: 'Awaiting approval' })] },
    ];

    const { resolution } = await resolve(
      [
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], waiting),
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], waiting),
      ],
      { waitMs: 10_000, pollEveryMs: 10_000, nowMs: clock.nowMs, sleep: clock.sleep },
    );

    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('not_ready');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain(
      'Awaiting approval',
    );
  });

  it('waits on a state it does not know rather than calling the change broken', async () => {
    const clock = fakeClock();
    const unknown = [{ id: 11, body: [status(91, 'rolled_out')] }];

    const { resolution } = await resolve(
      [
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], unknown),
        ...exchangesFor([deployment(11, '2026-11-03T14:04:00Z')], unknown),
      ],
      { waitMs: 10_000, pollEveryMs: 10_000, nowMs: clock.nowMs, sleep: clock.sleep },
    );

    expect(resolution.kind === 'unusable' ? resolution.state : undefined).toBe('not_ready');
    expect(resolution.kind === 'unusable' ? resolution.answered : '').toContain('rolled_out');
  });

  it('says a torn-down preview is not running, rather than telling the user to add one', async () => {
    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [{ id: 11, body: [status(91, 'inactive')] }],
      ),
    );

    expect(resolution.kind).toBe('unusable');
    expect(resolution.kind === 'unusable' ? resolution.reason : '').toContain('no longer running');
    expect(resolution.kind === 'unusable' ? resolution.reason : '').not.toContain(
      'add a per-pull-request preview deployment',
    );
  });

  it('waits for a newer deployment of the same commit before using an older URL', async () => {
    const clock = fakeClock();
    const both = [deployment(12, '2026-11-03T14:09:00Z'), deployment(11, '2026-11-03T14:04:00Z')];
    const statuses = [
      { id: 12, body: [status(94, 'in_progress', { description: 'Building' })] },
      { id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] },
    ];

    const { resolution } = await resolve(
      [...exchangesFor(both, statuses), ...exchangesFor(both, statuses)],
      { waitMs: 10_000, pollEveryMs: 10_000, nowMs: clock.nowMs, sleep: clock.sleep },
    );

    // The newer deployment will mark the older one inactive the moment it succeeds, so the
    // wait comes first — and the older URL is handed on only once the cap is spent.
    expect(clock.slept).toEqual([10_000]);
    expect(resolution.kind === 'preview' ? resolution.url : undefined).toBe(PREVIEW_URL);
  });
});

describe('the three answers cannot be confused for one another', () => {
  const none: PreviewResolution = { kind: 'no_preview', reason: 'no preview deployment' };
  const notReady: PreviewResolution = {
    kind: 'unusable',
    state: 'not_ready',
    reason: 'still building',
    answered: 'in_progress',
    waitedMs: 20_000,
  };

  it('is three kinds, and nothing collapses into null', () => {
    expect(new Set([none.kind, notReady.kind, 'preview']).size).toBe(3);
    expect(none.kind === 'no_preview' ? none.reason : null).not.toBeNull();
  });

  it('cannot read "no preview" as "not ready": the state is not on that shape at all', () => {
    // @ts-expect-error — `state` belongs to the unusable answer, and only to it.
    const misread: unknown = none.state;

    expect(misread).toBeUndefined();
    expect('state' in none).toBe(false);
    expect(notReady.kind === 'unusable' ? notReady.state : undefined).toBe('not_ready');
  });

  it('records a URL as a URL and a nothing as a stated reason, as the artifact holds it', () => {
    expect(
      previewSchema.parse(
        previewRecordOf({
          kind: 'preview',
          url: PREVIEW_URL,
          deploymentId: 11,
          environment: 'Preview',
          answered: 'published',
        }),
      ),
    ).toEqual({
      url: PREVIEW_URL,
    });

    const recorded = previewSchema.parse(previewRecordOf(none));

    expect(recorded.url).toBeNull();
    expect(recorded.reason).toContain('no preview deployment');
    expect(previewSchema.parse(previewRecordOf(notReady)).reason).toContain('still building');
  });
});

describe('nothing here needs a token, a network or a log line', () => {
  it('answers without the token reaching the answer', async () => {
    const { resolution } = await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [{ id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] }],
      ),
    );

    expect(JSON.stringify(resolution)).not.toContain(TOKEN);
  });

  it('hands the probe the URL and nothing else, so no header of ours can leave with it', async () => {
    const given: unknown[] = [];
    const probe: PreviewProbe = (...args) => {
      given.push(args);
      return Promise.resolve({ reachable: true, answered: 'answered 200' });
    };

    await resolve(
      exchangesFor(
        [deployment(11, '2026-11-03T14:04:00Z')],
        [{ id: 11, body: [status(91, 'success', { environment_url: PREVIEW_URL })] }],
      ),
      { probe },
    );

    expect(given).toEqual([[PREVIEW_URL]]);
  });
});
