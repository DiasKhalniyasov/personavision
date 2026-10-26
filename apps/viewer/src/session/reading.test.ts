import { describe, expect, it } from 'vitest';
import { openRun } from './index.js';
import { EXAMPLE_RUN_BASE, exampleRunFetch } from './fixtures.js';

/**
 * Reading is manifest first: the list of people in a test comes out of `run.json`, and a
 * session's own file is read only when something asks for that session. These tests watch
 * the fetches to say so, because "renders before every session has been read" is a claim
 * about what was fetched and when.
 */
describe('opening a run', () => {
  it('knows every session from run.json before a session file is read', async () => {
    const { fetch, requested } = exampleRunFetch();

    const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });

    expect(run.sessionIds).toHaveLength(24);
    expect(run.sessionIds[0]).toBe('S-01');
    expect(run.sessionIds.at(-1)).toBe('S-24');
    expect(requested, 'run.json and nothing else').toEqual([
      `${EXAMPLE_RUN_BASE.pathname}run.json`,
    ]);
  });

  it('reads one session file when one session is asked for, and remembers it', async () => {
    const { fetch, requested } = exampleRunFetch();
    const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });

    const first = await run.session('S-15');
    const again = await run.session('S-15');

    expect(first.sessionId).toBe('S-15');
    expect(again).toBe(first);
    expect(requested.filter((path) => path.endsWith('S-15.json'))).toEqual([
      `${EXAMPLE_RUN_BASE.pathname}sessions/S-15.json`,
    ]);
    expect(requested.some((path) => path.endsWith('S-01.json'))).toBe(false);
  });

  it('asks for a session file once when two callers want it at the same time', async () => {
    const { fetch, requested } = exampleRunFetch();
    const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });

    const [left, right] = await Promise.all([run.session('S-01'), run.session('S-01')]);

    expect(left).toBe(right);
    expect(requested.filter((path) => path.endsWith('S-01.json'))).toHaveLength(1);
  });

  it('reads findings.json only when the findings are asked for', async () => {
    const { fetch, requested } = exampleRunFetch();
    const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });
    expect(requested.some((path) => path.endsWith('findings.json'))).toBe(false);

    const findings = await run.findings();

    expect(findings.findings.map((finding) => finding.id)).toContain('F-2');
    expect(requested.filter((path) => path.endsWith('findings.json'))).toHaveLength(1);
  });

  it('says so, without fetching, when asked for a session the run does not list', async () => {
    const { fetch, requested } = exampleRunFetch();
    const run = await openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });
    const before = requested.length;

    await expect(run.session('S-99')).rejects.toThrow('run.json lists no session "S-99"');
    expect(requested).toHaveLength(before);
  });

  it('names the file when the run data is not there', async () => {
    const { fetch } = exampleRunFetch();

    await expect(
      openRun({ baseUrl: new URL('/runs/no-such-run/', EXAMPLE_RUN_BASE), fetch }),
    ).rejects.toThrow('/runs/no-such-run/run.json could not be read: HTTP 404');
  });

  it('addresses a run given without its trailing slash from inside the run, not beside it', async () => {
    const { fetch, requested } = exampleRunFetch();

    await openRun({ baseUrl: EXAMPLE_RUN_BASE.href.replace(/\/$/, ''), fetch });

    expect(requested).toEqual([`${EXAMPLE_RUN_BASE.pathname}run.json`]);
  });
});
