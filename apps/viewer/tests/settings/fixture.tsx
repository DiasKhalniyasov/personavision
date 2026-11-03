import { vi } from 'vitest';
import { serveRunData } from '../app';
import { CONNECTION_PATH, forgetGithubConnection } from '../../src/screens/settings/connection';

/**
 * The platform's answer about this workspace's GitHub connection, served over the stubbed
 * `fetch` the run data already uses.
 *
 * Both screens that render the connection — `/new`'s path-2 card and `/settings/github` —
 * read it through one module, so one fixture serves both suites. Everything the platform
 * can answer it can answer here: the App not registered, no repository, a repository, a
 * route that is not mounted yet, a server that is not there, and a read still in flight.
 */

export interface ConnectionBehaviour {
  /** Whether the GitHub App is registered, which is the platform's own answer (#319). */
  registered?: boolean;
  /** The connected repository, by name. `null` is a workspace that has connected none. */
  repository?: string | null;
  /** Answer with this status and body instead — a route that is not mounted, say. */
  answers?: { status: number; body?: unknown; text?: string };
  /** The platform is not there at all. */
  unreachable?: boolean;
  /** Hold the answer until `release` is called, for a test about the loading state. */
  hold?: boolean;
}

export interface ServedConnection {
  /** How many times the connection was read. */
  reads: () => number;
  /** Answer a held read. */
  release: () => void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function serveConnection(
  behaviour: ConnectionBehaviour = {},
): Promise<ServedConnection> {
  // Anything read before this test is another test's answer.
  forgetGithubConnection();
  await serveRunData();
  // `serveRunData` has just stubbed `fetch` with the run-data mount; this route sits in
  // front of it and everything else falls through, exactly as the server composes them.
  const runData = globalThis.fetch;
  let reads = 0;

  let release = (): void => {};
  const held =
    behaviour.hold === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== CONNECTION_PATH) return runData(input as RequestInfo, init);

    reads += 1;
    if (behaviour.unreachable === true) throw new TypeError('Failed to fetch');
    if (held !== null) await held;

    const answers = behaviour.answers;
    if (answers !== undefined) {
      return answers.text === undefined
        ? json(answers.status, answers.body ?? {})
        : new Response(answers.text, {
            status: answers.status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
    }

    const repository = behaviour.repository ?? null;
    return json(200, {
      registered: behaviour.registered ?? false,
      connection: repository === null ? null : { repository },
    });
  });

  return {
    reads: () => reads,
    release: () => {
      release();
    },
  };
}

/** The repository the connected states below are about. */
export const CONNECTED_REPOSITORY = 'northwind/storefront';
