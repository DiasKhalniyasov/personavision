import { readFile } from 'node:fs/promises';

/**
 * The committed example run, served to the module the way a browser would get it.
 *
 * Test-only, and the only thing in this directory that touches a file system: the module
 * under test reads through a `fetch`, so a test hands it one backed by the repository's own
 * run directory and can then see exactly which files were asked for.
 */

export const EXAMPLE_RUN_ID = '2026-10-24-1402-northwind-demo';

/** The repository root, from this file. */
const REPOSITORY = new URL('../../../../', import.meta.url);

/** Where the run data sits in the URL space `personavision open` serves. */
export const EXAMPLE_RUN_BASE = new URL(`/runs/${EXAMPLE_RUN_ID}/`, 'http://run-data.test/');

export interface RecordedFetch {
  readonly fetch: typeof globalThis.fetch;
  /** The paths asked for, in order, including ones that came back 404. */
  readonly requested: string[];
}

/** A `fetch` over the repository's run directories that records what it was asked for. */
export function exampleRunFetch(): RecordedFetch {
  const requested: string[] = [];

  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    requested.push(pathname);
    try {
      const body = await readFile(new URL(pathname.slice(1), REPOSITORY), 'utf8');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch {
      return new Response('not found\n', { status: 404 });
    }
  };

  return { fetch: fetch as typeof globalThis.fetch, requested };
}
