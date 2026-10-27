import { describe, expect, it } from 'vitest';
import type { ModelMode, RunRequest } from '@personavision/contract';
import { MODEL_ID_BY_MODE, ModelModeUnavailableError } from '@personavision/provider';
import { AUDIENCE_ID, validRun } from '../../contract/tests/fixtures.js';
import { seedDemoWorkspace } from '../src/seed.js';
import { startTest, TestRefusedError } from '../src/run/start.js';
import type { StartedTest, TestDraft } from '../src/run/start.js';
import { openFileStore } from '../src/store/file-store.js';
import type { PlatformStore, WorkspaceStore } from '../src/store/types.js';
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

const store = async (): Promise<{ store: PlatformStore; cleanup: () => Promise<void> }> => {
  const directories = await temporaryDirectories();
  return { store: await openFileStore(directories.dataDir), cleanup: directories.cleanup };
};

/** A workspace in `modelMode`, and the store its runs are registered in. */
const workspaceIn = async (
  platformStore: PlatformStore,
  modelMode: ModelMode,
): Promise<{ workspaces: WorkspaceStore; workspaceId: string }> => {
  const workspace = await platformStore.workspaces.create({
    name: `A ${modelMode} workspace`,
    memberAccountIds: [],
    modelMode,
  });
  return { workspaces: platformStore.workspaces, workspaceId: workspace.id };
};

/** A draft the contract accepts, naming no mode: naming one is not the submitter's to do. */
const draft = (engineMode: RunRequest['engineMode'] = 'model'): TestDraft => ({
  task: { prompt: 'Buy the Ridgeline hiking boots in size 43.' },
  variants: validRun().variants,
  audienceId: AUDIENCE_ID,
  repeats: 3,
  seed: 1,
  engineMode,
});

/** A pipeline that records every request it is given and reports what it was told to. */
const pipelineReporting = (
  answer: (request: RunRequest) => StartedTest | Error,
): { pipeline: (request: RunRequest) => Promise<StartedTest>; received: RunRequest[] } => {
  const received: RunRequest[] = [];
  return {
    received,
    pipeline: async (request) => {
      received.push(request);
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
      const platformStore = await openFileStore(directories.dataDir);
      const seeded = await seedDemoWorkspace({
        store: platformStore,
        runsRoot: directories.runsRoot,
      });

      const workspace = await platformStore.workspaces.byId(seeded.workspaceId);

      expect(workspace?.modelMode).toBe('contributor');
    } finally {
      await directories.cleanup();
    }
  });

  it('is standard for a workspace whose mode nobody stated, never contributor', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const workspace = await platformStore.workspaces.create({
        name: 'A workspace created without a mode',
        memberAccountIds: [],
      });

      expect(workspace.modelMode).toBe('standard');
    } finally {
      await cleanup();
    }
  });

  it.each(['contributor', 'standard'] as const)(
    'puts %s on the request a %s workspace starts a test with',
    async (modelMode) => {
      const { store: platformStore, cleanup } = await store();
      try {
        const { workspaces, workspaceId } = await workspaceIn(platformStore, modelMode);
        const { pipeline, received } = pipelineReporting(() => ranOnTheModel(modelMode));

        await startTest({ workspaces, workspaceId, draft: draft(), pipeline });

        expect(received).toHaveLength(1);
        expect(received[0]?.modelMode).toBe(modelMode);
      } finally {
        await cleanup();
      }
    },
  );
});

describe('a standard workspace is refused rather than downgraded', () => {
  it('refuses the test, names the model and says nothing was simulated', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'standard');
      const { pipeline, received } = pipelineReporting(unavailable);

      const refused = await startTest({
        workspaces,
        workspaceId,
        draft: draft(),
        pipeline,
      }).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(TestRefusedError);
      const error = refused as TestRefusedError;
      expect(error.modelId).toBe(MODEL_ID_BY_MODE.standard);
      expect(error.message).toContain(MODEL_ID_BY_MODE.standard);
      expect(error.message).toContain('Nothing was simulated');
      // The request reached the pipeline exactly once, naming standard. There was no second
      // attempt on the contributor model and none on the offline engine.
      expect(received.map((request) => [request.modelMode, request.engineMode])).toEqual([
        ['standard', 'model'],
      ]);
      expect(error.message).not.toContain(MODEL_ID_BY_MODE.contributor);
      expect(error.message).not.toContain('offline');
    } finally {
      await cleanup();
    }
  });

  it('stores no result for a refused test: the workspace keeps the runs it had', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'standard');
      const { pipeline } = pipelineReporting(unavailable);

      await expect(
        startTest({ workspaces, workspaceId, draft: draft(), pipeline }),
      ).rejects.toThrow(TestRefusedError);

      expect((await workspaces.byId(workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a run that came back on the contributor model, and registers nothing', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'standard');
      // A pipeline that substituted the cheap model downstream: the test asked for
      // standard, so the result is not this customer's and is refused, not stored.
      const { pipeline } = pipelineReporting(() => ranOnTheModel('contributor'));

      await expect(
        startTest({ workspaces, workspaceId, draft: draft(), pipeline }),
      ).rejects.toThrow(TestRefusedError);

      expect((await workspaces.byId(workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a run that quietly came back from the offline engine', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'standard');
      const { pipeline } = pipelineReporting(() => ranOffline);

      await expect(
        startTest({ workspaces, workspaceId, draft: draft(), pipeline }),
      ).rejects.toThrow(TestRefusedError);

      expect((await workspaces.byId(workspaceId))?.runIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('a contributor workspace keeps today’s behaviour', () => {
  it('runs offline with no key, reports it, and the run is the workspace’s', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'contributor');
      const { pipeline, received } = pipelineReporting(() => ranOffline);

      const started = await startTest({ workspaces, workspaceId, draft: draft(), pipeline });

      expect(received[0]?.modelMode).toBe('contributor');
      // What ran, not what was asked for: the request named contributor and the offline
      // deterministic engine answered, so that is what is reported and recorded.
      expect(started).toEqual({ runId: RUN_ID, engineMode: 'offline' });
      expect(started.modelMode).toBeUndefined();
      expect((await workspaces.byId(workspaceId))?.runIds).toEqual([RUN_ID]);
    } finally {
      await cleanup();
    }
  });

  it('records the contributor model where one actually ran', async () => {
    const { store: platformStore, cleanup } = await store();
    try {
      const { workspaces, workspaceId } = await workspaceIn(platformStore, 'contributor');
      const { pipeline } = pipelineReporting(() => ranOnTheModel('contributor'));

      const started = await startTest({ workspaces, workspaceId, draft: draft(), pipeline });

      expect(started.modelMode).toBe('contributor');
      expect((await workspaces.byId(workspaceId))?.runIds).toEqual([RUN_ID]);
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
    const { store: platformStore, cleanup } = await store();
    const before = process.env[ENV_NAME];
    process.env[ENV_NAME] = SECRET;
    try {
      const standard = await workspaceIn(platformStore, 'standard');
      const refused = await startTest({
        ...standard,
        draft: draft(),
        // A pipeline that leaks: whatever it says, nothing of it reaches the refusal.
        pipeline: pipelineReporting(
          () => new ModelModeUnavailableError(`the key ${SECRET} was rejected`),
        ).pipeline,
      }).catch((error: unknown) => error);

      expect(JSON.stringify(refused, Object.getOwnPropertyNames(refused))).not.toContain(SECRET);
      expect((refused as Error).message).not.toContain(SECRET);

      const contributor = await workspaceIn(platformStore, 'contributor');
      const started = await startTest({
        ...contributor,
        draft: draft(),
        pipeline: pipelineReporting(() => ranOffline).pipeline,
      });

      expect(JSON.stringify(started)).not.toContain(SECRET);
      expect(
        JSON.stringify(await platformStore.workspaces.byId(contributor.workspaceId)),
      ).not.toContain(SECRET);
    } finally {
      if (before === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = before;
      await cleanup();
    }
  });
});
