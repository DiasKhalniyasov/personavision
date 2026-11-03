/**
 * The container's entry point: `node dist/runner/task-main.js run-session --run … --session …`,
 * which is what `Dockerfile.session-runner` runs and what `createCloudRunRunner` asks a job
 * execution for.
 *
 * It is thin on purpose. Everything about *what* a session is belongs to `runSessionTask`,
 * which this process and the local pool both call; this file is the three things only a
 * container has to decide:
 *
 * 1. **where to write** — a scratch directory of its own, because the owner's run directory
 *    is on another machine;
 * 2. **what to drive** — a live browser, which is `createLiveSource()`: Playwright's
 *    Chromium, installed into the image with the system libraries it needs
 *    (`docs/deployment.md`);
 * 3. **who decides** — `selectDecisionProvider`, which is the one sanctioned place in this
 *    repository that reads a model credential. Nothing here reads one.
 *
 * **Then it has to get its output home, and that is #316's.** A Cloud Run task cannot write
 * to the owner's disk, so a session, its contributions and its video reach the run directory
 * through the object store `PV_VIDEO_BUCKET` names. Until that store exists this process says
 * so and exits non-zero — which the coordinator reads as a failed execution and records as
 * that one session's typed automation failure, naming what was asked and what was answered.
 * A session reported as collected when nothing was uploaded would be the one lie this whole
 * seam exists to avoid.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveSource, NotImplementedError } from '@personavision/browser';
import { createMetaModelApiProvider, selectDecisionProvider } from '@personavision/provider';
import { readSessionTaskEnvironment, runSessionTask, TASK_ENV } from './session-task.js';
import type { ProviderMode } from '@personavision/provider';

const asMode = (named: string | undefined): ProviderMode =>
  named?.trim() === 'model' ? 'model' : 'offline';

export const main = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> => {
  const runDir = await mkdtemp(join(tmpdir(), 'personavision-task-'));
  const seed = Number(env[TASK_ENV.seed] ?? '0');
  const selected = selectDecisionProvider({
    seed,
    env,
    requestedMode: asMode(env[TASK_ENV.engineMode]),
    createModelProvider: ({ apiKey, modelMode }) =>
      createMetaModelApiProvider({ mode: modelMode, apiKey }),
  });

  const request = readSessionTaskEnvironment(env, {
    runDir,
    source: createLiveSource(),
    providers: { decision: selected.provider },
  });
  await runSessionTask(request);

  const bucket = env[TASK_ENV.videoBucket]?.trim() ?? '';
  throw new NotImplementedError(
    `${request.sessionId} ran and was written to ${runDir}, and uploading it to ${bucket === '' ? 'an object store' : bucket} is the object-store seam's (#316), which this build does not carry: a task cannot write to the coordinator's disk, so the session is reported as uncollected rather than as collected`,
  );
};

/* c8 ignore start -- the executable's own line, which no test runs. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
