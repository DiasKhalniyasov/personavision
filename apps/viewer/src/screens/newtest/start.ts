import { runSchema } from '@personavision/contract';
import { z } from 'zod';
import type { RunRequest } from '@personavision/contract';

/**
 * Handing a test to the platform. The New test screen's one request, and the only place in
 * this app that makes it.
 *
 * `POST /runs` with the `RunRequest` the contract declares, answered with the id of the run
 * directory the platform opened. **This screen runs nothing**: the swarm is #54's and the
 * Running state at `/runs/:runId` is #18's, both driven by the artifact the platform starts
 * writing. The browser's whole part is this request and the route it then goes to.
 *
 * A refusal is read as carefully as an answer, and nothing here throws: a test that was not
 * started must leave the form standing with everything typed still in it. The ladder below
 * reads the way `screens/audience/store.ts` reads #102's routes, deliberately: the rule the
 * app is held to is that **the request itself** lives in the one module named for the
 * interface it speaks to (`tests/skeleton.test.ts`), so lifting the `fetch` out into a
 * shared helper would move the call out of this file and break exactly that rule.
 */

const RUNS = '/runs';

/** Run data and the platform are served from the site root; `fetch` wants it absolute. */
const absolute = (path: string): string => new URL(path, window.location.href).toString();

/**
 * What the platform answers with. Only the id is read, and its shape is the contract's own
 * `runId` rather than a second spelling of it: the run's other fields are read from the
 * artifact by `useRun`, through the contract, like every other figure in this app. The
 * object is tolerant on purpose — an answer that carries the whole run is not an answer this
 * screen should refuse.
 */
const startedSchema = z.object({ runId: runSchema.shape.runId });

const refusalSchema = z.object({ error: z.string().optional() });

export type StartResult =
  | { readonly ok: true; readonly runId: string }
  /** The test was not started, with the reason to put above the form. */
  | { readonly ok: false; readonly problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The sentence a reader is given when the platform itself is the problem. */
const UNREACHABLE = 'The test could not be started.';

export const startTest = async (request: RunRequest): Promise<StartResult> => {
  let response: Response;
  try {
    response = await fetch(absolute(RUNS), {
      method: 'POST',
      // `GET /runs/…` is the read-only run-data mount and `/runs` is a screen of this app,
      // so this says what it wants rather than taking whatever a navigation would get.
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return { ok: false, problem: `${UNREACHABLE} ${reason(error)}` };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      problem: response.ok
        ? 'The platform answered something this build cannot read.'
        : `${UNREACHABLE} It answered ${String(response.status)}.`,
    };
  }

  if (!response.ok) {
    const refusal = refusalSchema.safeParse(body);
    const stated = refusal.success ? refusal.data.error : undefined;
    return {
      ok: false,
      problem: stated ?? `${UNREACHABLE} It answered ${String(response.status)}.`,
    };
  }

  const started = startedSchema.safeParse(body);
  return started.success
    ? { ok: true, runId: started.data.runId }
    : { ok: false, problem: 'The platform started a test but did not say which.' };
};
