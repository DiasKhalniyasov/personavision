import { findingsSchema, runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Findings, Run, Session } from '@personavision/contract';

/**
 * Reading one run's sessions, manifest first.
 *
 * `run.json` carries `sessionIds`, so the list of people in a test is known as soon as the
 * run is open and a session's own file is fetched only when something asks for that
 * session: the Sessions screen renders its rows before every session has been read, and the
 * replay reads one file. Nothing here is eager, and nothing is read twice.
 *
 * Every path comes from `runPaths` and every file is parsed by the schema that declares it,
 * both from `@personavision/contract`. This module restates no field name and no path, and
 * it reads the same URLs `personavision open` serves
 * (`docs/adr/0001-run-data-over-http-as-static-files.md`).
 */

/** The layout, run-directory-relative, to resolve against a run's base URL. */
const LAYOUT = runPaths('');

export interface RunSource {
  /** The run's directory as a URL — `/runs/<runId>/`, as the run-data mount serves it. */
  readonly baseUrl: string | URL;
  /** The fetch to read through. Defaults to the global one; a test passes its own. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface RunSessions {
  readonly run: Run;
  /** `run.json`'s `sessionIds`, in its order: the list, before any session is read. */
  readonly sessionIds: readonly string[];
  /** One session, fetched the first time it is asked for and remembered after. */
  session(sessionId: string): Promise<Session>;
  /** `findings.json`, fetched the first time it is asked for. */
  findings(): Promise<Findings>;
}

/**
 * A run is a directory, so its files hang off a base that ends in a slash: without one,
 * `run.json` would resolve beside the run rather than inside it.
 */
function runBase(baseUrl: string | URL): URL {
  const url = new URL(baseUrl, globalThis.location?.href);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/**
 * One artifact file, parsed. A file that is missing, unreadable or not what the contract
 * declares is named in the error, because at that point the run directory is the thing at
 * fault and the screen can say which file it was.
 */
async function read<Parsed>(
  from: typeof globalThis.fetch,
  url: URL,
  parse: (value: unknown) => Parsed,
): Promise<Parsed> {
  const response = await from(url);
  if (!response.ok) {
    throw new Error(`${url.pathname} could not be read: HTTP ${response.status}`);
  }
  try {
    return parse(await response.json());
  } catch (cause) {
    throw new Error(`${url.pathname} is not a valid artifact file: ${(cause as Error).message}`, {
      cause,
    });
  }
}

/** The run, open: its `run.json` read, and nothing else fetched yet. */
export async function openRun(source: RunSource): Promise<RunSessions> {
  const base = runBase(source.baseUrl);
  const from = source.fetch ?? globalThis.fetch;
  const run = await read(from, new URL(LAYOUT.run, base), (value) => runSchema.parse(value));

  const sessions = new Map<string, Promise<Session>>();
  let findings: Promise<Findings> | undefined;

  return {
    run,
    sessionIds: run.sessionIds,

    session(sessionId) {
      // The manifest is the list of what there is to read, so a session it does not name
      // is a mistake worth saying out loud rather than a fetch that comes back 404.
      if (!run.sessionIds.includes(sessionId)) {
        return Promise.reject(new Error(`run.json lists no session "${sessionId}"`));
      }
      const pending =
        sessions.get(sessionId) ??
        read(from, new URL(LAYOUT.session(sessionId), base), (value) =>
          sessionSchema.parse(value),
        ).catch((error: unknown) => {
          // A failed read is forgotten, so that a row whose fetch broke can be asked for
          // again rather than staying broken for as long as the page is open.
          sessions.delete(sessionId);
          throw error;
        });
      sessions.set(sessionId, pending);
      return pending;
    },

    findings() {
      findings ??= read(from, new URL(LAYOUT.findings, base), (value) =>
        findingsSchema.parse(value),
      ).catch((error: unknown) => {
        findings = undefined;
        throw error;
      });
      return findings;
    },
  };
}
