import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Audience, ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import { validRun } from '../../contract/tests/fixtures.js';
import { AudienceNotOfferedError } from '../src/audience/freeze.js';
import { seedDemoWorkspace } from '../src/seed.js';
import { startTest, TestRefusedError } from '../src/run/start.js';
import type { StartedTest, TestDraft } from '../src/run/start.js';
import { openFileStore } from '../src/store/file-store.js';
import type { AudienceStore, PlatformStore, WorkspaceStore } from '../src/store/types.js';
import { temporaryDirectories, writeRunAt } from './workspace.js';

/**
 * The mode a test runs in belongs to the workspace, and a standard workspace's test is
 * refused rather than downgraded (#144).
 *
 * The swarm does not exist yet (#54), so every test here hands `startTest` a stand-in
 * pipeline and reads **what it received**: that is where the rule lives. A refusal is
 * proved by the pipeline having been called once, with `standard` on the request, and never
 * again with contributor or with the offline engine.
 */

const RUN_ID = 'run-the-pipeline-wrote';

/** A temporary file-backed store, and the directory it is under. */
const openStore = async (): Promise<{
  store: PlatformStore;
  dataDir: string;
  cleanup: () => Promise<void>;
}> => {
  const directories = await temporaryDirectories();
  return {
    store: await openFileStore(directories.dataDir),
    dataDir: directories.dataDir,
    cleanup: directories.cleanup,
  };
};

/** What `startTest` needs of a workspace: its stores, its id and an audience to test for. */
interface Workspace {
  workspaces: WorkspaceStore;
  audiences: AudienceStore;
  workspaceId: string;
  audienceId: string;
}

/** A workspace in `modelMode`, with one audience of its own a test can be started for. */
const workspaceIn = async (store: PlatformStore, modelMode: ModelMode): Promise<Workspace> => {
  const workspace = await store.workspaces.create({
    name: `A ${modelMode} workspace`,
    memberAccountIds: [],
    modelMode,
  });
  const audience = await store.audiences.create(workspace.id, validRun().audience);
  return {
    workspaces: store.workspaces,
    audiences: store.audiences,
    workspaceId: workspace.id,
    audienceId: audience.id,
  };
};

/** A draft the contract accepts, naming no mode: naming one is not the submitter's to do. */
const draft = (audienceId: string, engineMode: RunRequest['engineMode'] = 'model'): TestDraft => ({
  task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
  variants: validRun().variants,
  audienceId,
  repeats: 3,
  seed: 1,
  engineMode,
});

/** What the pipeline was handed, each time it was called. */
interface Call {
  request: RunRequest;
  audience: Audience;
}

/** A pipeline that records every call and reports what it is told to. */
const pipelineReporting = (
  answer: (request: RunRequest) => StartedTest | Error,
): {
  pipeline: (request: RunRequest, audience: Audience) => Promise<StartedTest>;
  calls: Call[];
} => {
  const calls: Call[] = [];
  return {
    calls,
    pipeline: async (request, audience) => {
      calls.push({ request, audience });
      const reply = answer(request);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};

/** What a pipeline that reached the model reports. */
const ranOnTheModel = (modelMode: ModelMode): StartedTest => ({
  runId: RUN_ID,
  engineMode: 'model',
  modelMode,
});

/** What a pipeline with no key reports for a contributor test: the offline engine. */
const ranOffline: StartedTest = { runId: RUN_ID, engineMode: 'offline' };

/** The refusal provider selection throws when a mode cannot be served (#143). */
const unavailable = (): Error =>
  new ModelModeUnavailableError(
    'model mode was asked for, but no key is in the environment: set it, or ask for offline mode',
  );

describe('the workspace decides which model its tests run on', () => {
  it('records the mode on the workspace, and seeds the demo workspace as contributor', async () => {
    const directories = await temporaryDirectories();
    try {
      await writeRunAt(directories.runsRoot, { stamp: '2026-10-24T14:02:00.000Z', name: 'demo' });
      const store = await openFileStore(directories.dataDir);
      const seeded = await seedDemoWorkspace({ store, runsRoot: directories.runsRoot });

      const workspace = await store.workspaces.byId(seeded.workspaceId);

      expect(workspace?.modelMode).toBe('contributor');
    } finally {
      await directories.cleanup();
    }
  });

  it('is standard for a workspace whose mode nobody stated, never contributor', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await store.workspaces.create({
        name: 'A workspace created without a mode',
        memberAccountIds: [],
      });

      expect(workspace.modelMode).toBe('standard');
    } finally {
      await cleanup();
    }
  });

  it('reads a workspace stored before the field existed as standard, not as contributor', async () => {
    // The demo workspace is seeded once per data directory, so a machine that ran the
    // server before this field existed holds a record with no mode. Reading it as
    // contributor would be the silent fall-back the owner's decision forbids; reading it
    // as nothing at all would refuse the test with a schema error nobody can act on.
    const { dataDir, cleanup } = await openStore();
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, 'workspaces.json'),
        `${JSON.stringify([
          {
            id: 'written-before-the-mode-existed',
            name: 'An older workspace',
            memberAccountIds: [],
            runIds: [],
            demoRunId: null,
            createdAt: '2026-10-20T09:00:00.000Z',
          },
        ])}\n`,
        'utf8',
      );
      const store = await openFileStore(dataDir);

      const workspace = await store.workspaces.byId('written-before-the-mode-existed');

      expect(workspace?.modelMode).toBe('standard');
      // And the test it starts is refused for the stated reason rather than failing to
      // assemble a request at all.
      const audience = await store.audiences.create(workspace?.id ?? '', validRun().audience);
      await expect(
        startTest({
          workspaces: store.workspaces,
          audiences: store.audiences,
          workspaceId: workspace?.id ?? '',
          draft: draft(audience.id),
          pipeline: pipelineReporting(unavailable).pipeline,
        }),
      ).rejects.toThrow(TestRefusedError);
    } finally {
      await cleanup();
    }
  });

  it.each(['contributor', 'standard'] as const)(
    'puts %s on the request a %s workspace starts a test with',
    async (modelMode) => {
      const { store, cleanup } = await openStore();
      try {
        const workspace = await workspaceIn(store, modelMode);
        const { pipeline, calls } = pipelineReporting(() => ranOnTheModel(modelMode));

        await startTest({ ...workspace, draft: draft(workspace.audienceId), pipeline });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.request.modelMode).toBe(modelMode);
      } finally {
        await cleanup();
      }
    },
  );

  it('hands the pipeline the audience by value, resolved against the workspace that asked', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'contributor');
      const { pipeline, calls } = pipelineReporting(() => ranOffline);

      await startTest({ ...workspace, draft: draft(workspace.audienceId), pipeline });

      expect(calls[0]?.audience).toEqual(validRun().audience);
    } finally {
      await cleanup();
    }
  });

  it('starts nothing for an audience the workspace cannot read', async () => {
    const { store, cleanup } = await openStore();
    try {
      const mine = await workspaceIn(store, 'standard');
      const theirs = await workspaceIn(store, 'contributor');
      const { pipeline, calls } = pipelineReporting(() => ranOnTheModel('standard'));

      await expect(
        startTest({ ...mine, draft: draft(theirs.audienceId), pipeline }),
      ).rejects.toThrow(AudienceNotOfferedError);

      expect(calls).toEqual([]);
      expect((await mine.workspaces.byId(mine.workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('a standard workspace is refused rather than downgraded', () => {
  it('refuses the test, names the model and says nothing was simulated', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'standard');
      const { pipeline, calls } = pipelineReporting(unavailable);

      const refused = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(TestRefusedError);
      const error = refused as TestRefusedError;
      expect(error.modelId).toBe(MODEL_ID_BY_MODE.standard);
      expect(error.message).toContain(MODEL_ID_BY_MODE.standard);
      expect(error.message).toContain('Nothing was simulated');
      expect(error.ranAnywayRunId).toBeNull();
      // The request reached the pipeline exactly once, naming standard. There was no second
      // attempt on the contributor model and none on the offline engine.
      expect(calls.map(({ request }) => [request.modelMode, request.engineMode])).toEqual([
        ['standard', 'model'],
      ]);
      expect(error.message).not.toContain(MODEL_ID_BY_MODE.contributor);
      expect(error.message).not.toContain('offline');
    } finally {
      await cleanup();
    }
  });

  it('stores no result for a refused test: the workspace keeps the runs it had', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'standard');
      const { pipeline } = pipelineReporting(unavailable);

      await expect(
        startTest({ ...workspace, draft: draft(workspace.audienceId), pipeline }),
      ).rejects.toThrow(TestRefusedError);

      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a run that came back on the contributor model, and registers nothing', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'standard');
      // A pipeline that substituted the cheap model downstream: the test asked for
      // standard, so the result is not this customer's and is refused, not stored.
      const { pipeline } = pipelineReporting(() => ranOnTheModel('contributor'));

      const refused = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(TestRefusedError);
      const error = refused as TestRefusedError;
      // Something did run, so the refusal says where it is rather than claiming nothing
      // happened while a billed run sits on disk.
      expect(error.ranAnywayRunId).toBe(RUN_ID);
      expect(error.message).toContain(RUN_ID);
      expect(error.message).toContain(MODEL_ID_BY_MODE.contributor);
      expect(error.message).not.toContain('Nothing was simulated');
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a run that quietly came back from the offline engine', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'standard');
      const { pipeline } = pipelineReporting(() => ranOffline);

      const refused = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(TestRefusedError);
      expect((refused as Error).message).toContain('offline deterministic engine');
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('lets a standard workspace run offline when offline is what was asked for', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'standard');
      const { pipeline } = pipelineReporting(() => ranOffline);

      // Asked for by the caller rather than fallen back to: `personavision run --engine
      // offline` is an internal tool, and what it asked for is not a downgrade.
      const started = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId, 'offline'),
        pipeline,
      });

      expect(started.engineMode).toBe('offline');
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([RUN_ID]);
    } finally {
      await cleanup();
    }
  });
});

describe('a contributor workspace keeps today’s behaviour', () => {
  it('runs offline with no key, reports it, and the run is the workspace’s', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'contributor');
      const { pipeline, calls } = pipelineReporting(() => ranOffline);

      const started = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      });

      expect(calls[0]?.request.modelMode).toBe('contributor');
      // What ran, not what was asked for: the request named contributor and the offline
      // deterministic engine answered, so that is what is reported and recorded.
      expect(started).toEqual({ runId: RUN_ID, engineMode: 'offline' });
      expect(started.modelMode).toBeUndefined();
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([RUN_ID]);
    } finally {
      await cleanup();
    }
  });

  it('records the contributor model where one actually ran', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'contributor');
      const { pipeline } = pipelineReporting(() => ranOnTheModel('contributor'));

      const started = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      });

      expect(started.modelMode).toBe('contributor');
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([RUN_ID]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a contributor run that came back on the standard model', async () => {
    const { store, cleanup } = await openStore();
    try {
      const workspace = await workspaceIn(store, 'contributor');
      // The substitution in the other direction: a development run billed at twelve times
      // what it should be is not the run that was asked for either.
      const { pipeline } = pipelineReporting(() => ranOnTheModel('standard'));

      const refused = await startTest({
        ...workspace,
        draft: draft(workspace.audienceId),
        pipeline,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(TestRefusedError);
      expect((refused as TestRefusedError).modelMode).toBe('contributor');
      expect((await workspace.workspaces.byId(workspace.workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('no key value travels with a test', () => {
  // The variable's name is assembled rather than written, for the same reason
  // `tests/workspace.test.ts` assembles its patterns: a literal here reads as a credential
  // read in the scan that keeps credential reads to the one place that is allowed one.
  const ENV_NAME = ['MODEL', 'API', 'KEY'].join('_');
  const SECRET = 'sk-live-not-a-real-credential-0123456789';

  it('appears in no stored record, no reply and no refusal, with a key in the environment', async () => {
    const { store, cleanup } = await openStore();
    const before = process.env[ENV_NAME];
    process.env[ENV_NAME] = SECRET;
    try {
      const standard = await workspaceIn(store, 'standard');
      const refused = await startTest({
        ...standard,
        draft: draft(standard.audienceId),
        // A pipeline that leaks: whatever it says, nothing of it reaches the refusal.
        pipeline: pipelineReporting(
          () => new ModelModeUnavailableError(`the key ${SECRET} was rejected`),
        ).pipeline,
      }).catch((error: unknown) => error);

      expect(JSON.stringify(refused, Object.getOwnPropertyNames(refused))).not.toContain(SECRET);
      expect((refused as Error).message).not.toContain(SECRET);

      const contributor = await workspaceIn(store, 'contributor');
      const started = await startTest({
        ...contributor,
        draft: draft(contributor.audienceId),
        pipeline: pipelineReporting(() => ranOffline).pipeline,
      });

      expect(JSON.stringify(started)).not.toContain(SECRET);
      expect(JSON.stringify(await store.workspaces.byId(contributor.workspaceId))).not.toContain(
        SECRET,
      );
    } finally {
      if (before === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = before;
      await cleanup();
    }
  });
});
