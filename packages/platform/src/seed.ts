import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listRunDirs, runPaths, runSchema } from '@personavision/contract';
import type { Audience } from '@personavision/contract';
import { generatePassword, hashPassword } from './store/password.js';
import type { PlatformStore } from './store/types.js';

/**
 * The demo workspace a fresh data directory comes up with: one workspace, one account,
 * the demo audience and the committed example run registered as that workspace's run.
 *
 * It is what makes a clone of this repository a working hosted product with no cloud
 * account, no managed database and no API key (`docs/FLOW.md` section 1). It runs exactly
 * once per data directory: a restart reads what is there and seeds nothing.
 */

export const DEMO_WORKSPACE_NAME = 'Northwind Outdoors';
export const DEMO_ACCOUNT_EMAIL = 'owner@northwind.example';
export const DEMO_ACCOUNT_NAME = 'Northwind Outdoors owner';

export interface SeededWorkspace {
  workspaceId: string;
  workspaceName: string;
  accountId: string;
  email: string;
  /**
   * Generated at this first start. It is returned here and nowhere else: it is not
   * stored, not logged and not recoverable — only the scrypt verifier is kept.
   */
  password: string;
  /** The demo audience, or `null` when there was no run to take it from. */
  audienceId: string | null;
  runIds: readonly string[];
  /** The run `/demo` and the landing page read with no session. */
  demoRunId: string | null;
}

/**
 * The audience of a run, read from its own `run.json`, or `null` if that file does not
 * read as this build's schema version.
 *
 * The demo audience is the one the committed example run was run for, taken from the
 * artifact rather than restated here — `@personavision/contract` is the only place an
 * artifact field is declared (`CONTEXT.md`).
 */
const audienceOfRun = async (runsRoot: string, runId: string): Promise<Audience | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runPaths(join(runsRoot, runId)).run, 'utf8'));
  } catch {
    return null;
  }
  const run = runSchema.safeParse(parsed);
  return run.success ? run.data.audience : null;
};

export const seedDemoWorkspace = async ({
  store,
  runsRoot,
}: {
  store: PlatformStore;
  runsRoot: string;
}): Promise<SeededWorkspace> => {
  const password = generatePassword();
  const account = await store.accounts.create({
    email: DEMO_ACCOUNT_EMAIL,
    displayName: DEMO_ACCOUNT_NAME,
    password: await hashPassword(password),
  });

  // Newest first, so the audience below is the one the newest test was run for.
  const runIds = await listRunDirs(runsRoot);
  const newestRunId = runIds[0] ?? null;
  // The demo run is readable with no session, so it is only ever the one run of a runs
  // root that holds exactly one — the committed example on a fresh clone. A developer
  // whose `./runs` already holds tests of their own gets a workspace that owns them all
  // and publishes none of them: nothing is made public by having been run most recently.
  const demoRunId = runIds.length === 1 ? newestRunId : null;

  const workspace = await store.workspaces.create({
    name: DEMO_WORKSPACE_NAME,
    memberAccountIds: [account.id],
    runIds,
    demoRunId,
    // The demo, the example audiences and our own development run on the contributor
    // model: twelve times cheaper, and nothing in here is a customer's content (#144).
    modelMode: 'contributor',
  });

  const audience = newestRunId === null ? null : await audienceOfRun(runsRoot, newestRunId);
  const audienceRecord =
    audience === null ? null : await store.audiences.create(workspace.id, audience);

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    accountId: account.id,
    email: account.email,
    password,
    audienceId: audienceRecord?.id ?? null,
    runIds,
    demoRunId,
  };
};
