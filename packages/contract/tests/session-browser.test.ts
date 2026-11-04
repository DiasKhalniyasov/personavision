import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPaths, sessionSchema } from '../src/index.js';
import type { Session, SessionBrowser } from '../src/index.js';
import { validSession } from './fixtures.js';

/**
 * What a session's browser was opened as: `browser` (#421).
 *
 * Every session of the IKEA test was redirected to `www.ikea.com/ae/ar/` — the United Arab
 * Emirates store, in Arabic — while the audience was UK and US shoppers, because the browser
 * was opened with no locale, no time zone and no location and the site geolocated the
 * machine. A session now browses in its persona's region, and it records what it was opened
 * with, so a reader of a finished run can say that these sessions ran as `en-GB` in
 * `Europe/London` rather than having to infer it from the audience.
 *
 * Three properties are held here. That the block **parses and is carried through**. That
 * each field is **nullable rather than absent**, because `null` says *this session was
 * opened with none* — the statement that makes an unrecognised region visible instead of
 * silently becoming somebody else's country. And that the block itself is **optional**, so
 * every session written before this revision, the committed example run included, still
 * parses.
 */

const withBrowser = (browser: unknown): Session =>
  ({ ...validSession('S-01', 'A'), browser }) as Session;

/** The committed example run's sessions, as they are on disk. */
const EXAMPLE_RUN = fileURLToPath(
  new URL('../../../runs/2026-10-24-1402-northwind-demo', import.meta.url),
);

const EN_GB: SessionBrowser = {
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  geolocation: { latitude: 51.5074, longitude: -0.1278 },
};

describe('what a session browser was opened as', () => {
  it('is parsed and carried through', () => {
    const parsed = sessionSchema.parse(withBrowser(EN_GB));

    expect(parsed.browser).toStrictEqual(EN_GB);
  });

  it('records a region the mapping table does not know as the absence it is', () => {
    const parsed = sessionSchema.parse(
      withBrowser({ locale: 'ru', timezoneId: null, geolocation: null }),
    );

    expect(parsed.browser).toStrictEqual({ locale: 'ru', timezoneId: null, geolocation: null });
  });

  it('records a session that claimed no country at all', () => {
    const parsed = sessionSchema.parse(
      withBrowser({ locale: null, timezoneId: null, geolocation: null }),
    );

    expect(parsed.browser?.locale).toBeNull();
  });

  it('is absent on a session opened with none of it, rather than three nulls', () => {
    const parsed = sessionSchema.parse(validSession('S-01', 'A'));

    expect('browser' in parsed).toBe(false);
    expect(parsed.browser).toBeUndefined();
  });

  it('refuses an empty locale or time zone, because a session opened with none records null', () => {
    expect(() => sessionSchema.parse(withBrowser({ ...EN_GB, locale: '' }))).toThrow(
      'a session opened with no locale records null, not an empty string',
    );
    expect(() => sessionSchema.parse(withBrowser({ ...EN_GB, timezoneId: '' }))).toThrow(
      'a session opened with no time zone records null, not an empty string',
    );
  });

  it('refuses a position that is not on the earth', () => {
    for (const geolocation of [
      { latitude: 91, longitude: 0 },
      { latitude: -91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: 0, longitude: -181 },
      { latitude: 0 },
      { latitude: 0, longitude: 0, altitude: 5 },
    ]) {
      expect(
        () => sessionSchema.parse(withBrowser({ ...EN_GB, geolocation })),
        String(JSON.stringify(geolocation)),
      ).toThrow();
    }
  });

  it('declares no Accept-Language, because the locale is the one spelling of that fact', () => {
    // Playwright's `locale` sets `navigator.language` **and** the `Accept-Language` request
    // header, so a header written down beside the locale would be two spellings of one fact,
    // free to drift. The closed object is what keeps it unwritable.
    expect(() => sessionSchema.parse(withBrowser({ ...EN_GB, acceptLanguage: 'en-GB' }))).toThrow();
  });

  it('is on no session of the committed example run, which still parses', async () => {
    const directory = runPaths(EXAMPLE_RUN).sessionsDir;
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const onDisk = JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown;

      expect(sessionSchema.parse(onDisk).browser).toBeUndefined();
    }
  });
});
