import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, sessionSchema } from '../src/index.js';
import type { Session } from '../src/index.js';
import { validSession } from './fixtures.js';

/**
 * Where a screen was: `screens[].url` (#441).
 *
 * A session's screen used to carry no address at all, so neither a reader of a finished run
 * nor a re-reading of one could say which page a screen was on — and a run of a single-page
 * application, where every screen is one URL's and the address is the only thing that moves,
 * records nothing of the walk the agent actually made.
 *
 * It is **optional with no default**, which is the owner's decision on this ticket: every
 * session written before this revision carries none — the committed example run, every
 * recorded fixture, every webcam session `packages/calibration` converts — and a screen that
 * recorded no address says that rather than claiming the run's variant URL. So an address is
 * a fact a screen may carry and never a field a reader may assume.
 */

/** A session with an address on its one screen. */
const sessionAt = (url: string): Session => {
  const session = validSession('S-01', 'A');
  const [screen] = session.screens;
  if (screen === undefined) throw new Error('the session fixture has a screen');
  return { ...session, screens: [{ ...screen, url }] };
};

/** The committed example run's sessions, as they are on disk. */
const EXAMPLE_RUN = fileURLToPath(
  new URL('../../../runs/2026-10-24-1402-northwind-demo', import.meta.url),
);

describe('the address a screen was captured at', () => {
  it('is parsed and carried through', () => {
    const parsed = sessionSchema.parse(sessionAt('https://shop.invalid/signup'));

    expect(parsed.screens[0]?.url).toBe('https://shop.invalid/signup');
  });

  it('is absent on a session that recorded none, rather than the variant’s URL', () => {
    const session = validSession('S-01', 'A');

    const parsed = sessionSchema.parse(session);

    expect(parsed.screens).toHaveLength(1);
    expect('url' in (parsed.screens[0] as object)).toBe(false);
    expect(parsed.screens[0]?.url).toBeUndefined();
  });

  it('is a web address, so a scheme that runs code or reads disk is not writable there', () => {
    for (const refused of [
      'about:blank',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<p>hi',
      '/signup',
      '',
    ]) {
      expect(() => sessionSchema.parse(sessionAt(refused)), refused).toThrow();
    }
  });

  it('is on no screen of the committed example run, which still parses', async () => {
    const directory = runPaths(EXAMPLE_RUN).sessionsDir;
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const onDisk = JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown;
      const parsed = sessionSchema.parse(onDisk);
      expect(parsed.screens.length).toBeGreaterThan(0);
      for (const screen of parsed.screens) expect(screen.url).toBeUndefined();
    }
  });
});
