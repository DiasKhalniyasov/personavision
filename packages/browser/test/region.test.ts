/**
 * A session browses in its persona's region: the locale, the time zone and the location a
 * context is opened with (#421).
 *
 * Every session of the IKEA test was redirected to `www.ikea.com/ae/ar/` — the United Arab
 * Emirates store, in Arabic — while the audience was UK and US shoppers. `openSession` set a
 * viewport, a scale factor, touch and a mobile user agent and **nothing about where the
 * person was**, so Chromium reported the host's locale and the site geolocated the machine's
 * address. The agents tested a site the audience would never see.
 *
 * Both sides of the claim are asserted, because they are different facts:
 *
 * - **what the page says** — `navigator.language` and
 *   `Intl.DateTimeFormat().resolvedOptions().timeZone`, read out of the page by
 *   `readSessionState` rather than echoed back from what was asked for;
 * - **what the site was told** — the `Accept-Language` of the document request, read off the
 *   fixture server's own recorded headers, because that header is what a real site reads
 *   when it decides which country's store to serve. Nothing sets it by hand: Playwright's
 *   `locale` sets both, and asserting the header is asserting that it did.
 *
 * Nothing here knows what a *region* is. Turning "United Kingdom" into `en-GB`,
 * `Europe/London` and a point in London is `@personavision/personas`' one table, and this
 * package is handed the answer.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeSession, createLiveSource, openSession, readSessionState } from '../src/index.js';
import type { Browsing, Device, PageHandle, Variant } from '../src/index.js';
import { CHROMIUM_INSTALLED } from './helpers/chromium.js';
import { serveFixtureSite } from './helpers/static-site.js';
import type { FixtureSite } from './helpers/static-site.js';

const describeWithChromium = CHROMIUM_INSTALLED || process.env.CI ? describe : describe.skip;

/** A session opens a browser; the cap is the one the other suites of this package use. */
const BROWSER_TIMEOUT_MS = 60_000;

const DESKTOP: Device = {
  name: 'desktop',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  touch: false,
};

/** What `@personavision/personas` answers for a UK shopper who reads English. */
const UK_ENGLISH: Browsing = {
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  geolocation: { latitude: 51.5074, longitude: -0.1278 },
};

/** What it answers for a person from a region the table does not know, who reads Russian. */
const NOWHERE_RUSSIAN: Browsing = { locale: 'ru', timezoneId: null, geolocation: null };

describeWithChromium(
  CHROMIUM_INSTALLED || process.env.CI
    ? 'a session opened in a region'
    : 'a session opened in a region (skipped: no Chromium on this machine)',
  () => {
    let site: FixtureSite;
    let runDir: string;

    beforeAll(async () => {
      site = await serveFixtureSite();
      runDir = await mkdtemp(join(tmpdir(), 'personavision-region-'));
    });

    afterAll(async () => {
      await site.close();
      await rm(runDir, { recursive: true, force: true });
    });

    const PATH = '/cart.html';
    const variantFor = (id: string): Variant => ({ id, url: `${site.url}${PATH}` });

    const open = (browsing?: Browsing): Promise<PageHandle> =>
      openSession(variantFor(`v-${String(site.requests.length)}`), DESKTOP, {
        ...(browsing === undefined ? {} : { browsing }),
      });

    /** The `Accept-Language` of the last document request this site was asked for. */
    const lastAcceptLanguage = (): string | undefined =>
      [...site.requests].reverse().find((request) => request.path === PATH)?.headers[
        'accept-language'
      ];

    it(
      'reports its locale and time zone in the page, and asks the site for pages in that language',
      async () => {
        const handle = await open(UK_ENGLISH);
        try {
          const state = await readSessionState(handle);

          expect(state.locale).toBe('en-GB');
          expect(state.timeZone).toBe('Europe/London');
          // The header the real site read. Playwright builds it from the locale, so this is
          // the assertion that no second spelling of the fact is needed.
          expect(lastAcceptLanguage()).toContain('en-GB');
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'answers the site where it is, because a context given a location is granted the permission',
      async () => {
        const handle = await open(UK_ENGLISH);
        try {
          const position = await handle.page.evaluate(
            async () =>
              await new Promise<{ latitude: number; longitude: number } | string>((settle) => {
                navigator.geolocation.getCurrentPosition(
                  ({ coords }) =>
                    settle({ latitude: coords.latitude, longitude: coords.longitude }),
                  (error) => settle(`refused: ${error.message}`),
                );
              }),
          );

          expect(position).toStrictEqual({ latitude: 51.5074, longitude: -0.1278 });
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'runs under the bare language, with the time zone it would have had, for a region nobody mapped',
      async () => {
        const handle = await open(NOWHERE_RUSSIAN);
        // Read before anything else opens: `lastAcceptLanguage` is the last request this
        // site was asked for, and the session below makes one of its own.
        const header = lastAcceptLanguage();
        // What a session asked for nothing resolves, so the time-zone comparison is Chromium
        // against Chromium: Node's own time zone is a second resolution of the same
        // environment rather than the thing being claimed.
        const asked = await open();
        try {
          const state = await readSessionState(handle);

          expect(state.locale).toBe('ru');
          expect(header).toContain('ru');
          // No time zone was asked for, so the session keeps the one it would have had: an
          // unrecognised region claims no country, and that includes not claiming a clock.
          expect(state.timeZone).toBe((await readSessionState(asked)).timeZone);
        } finally {
          await Promise.all([handle, asked].map((session) => closeSession(session)));
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'behaves exactly as it does today when it is opened with none of them',
      async () => {
        const plain = await open();
        const empty = await open({});
        try {
          const [one, two] = await Promise.all([readSessionState(plain), readSessionState(empty)]);

          expect(one.locale).toBe(two.locale);
          expect(one.timeZone).toBe(two.timeZone);
          // Both are the browser's own default, which is the claim. Comparing either against
          // Node's resolution would be comparing two resolutions of one environment, and this
          // package has a history of environment-dependent flakes.
          expect(one.timeZone).not.toBe('');
        } finally {
          await Promise.all([plain, empty].map((handle) => closeSession(handle)));
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'is not granted the geolocation permission when it was opened with no location',
      async () => {
        const handle = await open({ locale: 'en-GB', timezoneId: 'Europe/London' });
        try {
          const answer = await handle.page.evaluate(
            async () =>
              await new Promise<string>((settle) => {
                navigator.geolocation.getCurrentPosition(
                  () => settle('answered'),
                  () => settle('refused'),
                );
              }),
          );

          expect(answer).toBe('refused');
        } finally {
          await closeSession(handle);
        }
      },
      BROWSER_TIMEOUT_MS,
    );

    it(
      'takes the session own region over the source own, because one source drives many people',
      async () => {
        // A swarm of UK and US shoppers runs through one `createLiveSource`, and each session
        // names where its own person reads from.
        const source = createLiveSource({ browsing: NOWHERE_RUSSIAN });
        const theirs = await source.openSession(variantFor('theirs'), DESKTOP, {
          browsing: UK_ENGLISH,
        });
        const sources = await source.openSession(variantFor('source'), DESKTOP);
        try {
          expect((await readSessionState(theirs)).locale).toBe('en-GB');
          expect((await readSessionState(sources)).locale).toBe('ru');
        } finally {
          await Promise.all([theirs, sources].map((handle) => source.close(handle)));
        }
      },
      BROWSER_TIMEOUT_MS,
    );
  },
);
