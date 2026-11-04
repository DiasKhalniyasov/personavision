/**
 * One table from a region to a browser, and the locale rule over it.
 *
 * An audience declares `regions` in a user's own words — "United Kingdom", "Almaty" — and a
 * persona is drawn one of them (`generate.ts`). This is where that word becomes the three
 * settings a browser context is opened with: a BCP-47 **region subtag**, an IANA **time
 * zone**, and a coarse **latitude and longitude** of the region's largest city.
 *
 * **Why it exists.** A site that geolocates its visitors serves whatever country the machine
 * sits in. Every session of the IKEA test was redirected to `www.ikea.com/ae/ar/` — the
 * United Arab Emirates store, in Arabic — while the audience was UK and US shoppers, and the
 * agents tested a site the audience would never see (#421). The browser has to be told where
 * the person is before the first byte of the page is parsed, and this is the one place a
 * region name turns into something it can be told.
 *
 * **One copy.** `@personavision/personas` publishes this and nothing else in the repository
 * holds a second table of locales, time zones or coordinates: two tables of one fact drift,
 * and the drift would be a session that reports a locale it did not run under.
 *
 * **It is a table to extend**, not a derivation. There is no algorithm from "Almaty" to
 * `Asia/Almaty`; there is a list, and a region nobody has added to it is a region this
 * package says nothing about. Adding one is a data change: a row below, its names, and a
 * line in `tests/regions.test.ts` if it deserves one.
 *
 * ## The fallback, stated
 *
 * - **The region is in the table.** The locale is the persona's own language subtag over the
 *   region's subtag — `en` + `GB` → `en-GB` — and the session is opened with the region's
 *   time zone and location.
 * - **The region is in the table and the persona was drawn no language** (the audience listed
 *   none). The region's own main language is used: a person from Germany reads `de-DE`.
 * - **The region is not in the table.** The locale is the **language subtag alone** — `ru`,
 *   no region — and there is **no** time zone and **no** location. An unrecognised region is
 *   then visible in the artifact as the absence it is, rather than silently becoming
 *   somebody else's country: defaulting an unknown region to `en-US` would be the IKEA bug
 *   with a different flag.
 * - **Neither a region nor a language.** Nothing was said about where or how this person
 *   reads, so there is nothing to open a browser with: `browsingFor` answers `null`, the
 *   session is opened exactly as it is today, and it carries no `browser` block at all.
 *
 * Nothing here sets an `Accept-Language` header. Playwright's `locale` is what sets both
 * `navigator.language` and the `Accept-Language` request header, so a session opened as
 * `en-GB` asks for pages in `en-GB`; a header written out beside the locale would be two
 * spellings of one fact, free to drift from each other.
 */

import type { Persona, SessionBrowser } from '@personavision/contract';

/** What one region is, in a browser. */
export interface BrowsingRegion {
  /**
   * The names this region answers to, matched **case-insensitively** and with surrounding
   * space ignored. The first is the one the product's own audiences are written with; the
   * rest are the spellings the audiences in this repository, the five example templates and
   * a person typing into the audience form actually use.
   */
  readonly names: readonly string[];
  /** The BCP-47 region subtag the locale is built over: `GB`. */
  readonly subtag: string;
  /** The IANA time zone a session from here runs in: `Europe/London`. */
  readonly timeZone: string;
  /** The region's largest city, to one ten-thousandth of a degree — never a person's own address. */
  readonly latitude: number;
  readonly longitude: number;
  /**
   * The language a person from here is taken to read the page in, as a BCP-47 language
   * subtag, where the audience listed none for them to be drawn.
   *
   * It is the language the region's own sites are read in rather than a constitutional
   * claim: Ireland's is `en`, because `en-IE` is what a browser from Dublin asks for.
   */
  readonly language: string;
}

/**
 * The table. Eleven regions: the ones this repository's audiences and the five example
 * templates name, plus the one the IKEA run was wrongly served (the United Arab Emirates),
 * so that the bug's own country is a row rather than an accident.
 *
 * Frozen, because it is the build's: a caller reads a row and changes nothing about it.
 */
export const BROWSING_REGIONS: readonly BrowsingRegion[] = Object.freeze([
  {
    names: ['United Kingdom', 'UK', 'GB', 'Great Britain', 'England'],
    subtag: 'GB',
    timeZone: 'Europe/London',
    latitude: 51.5074,
    longitude: -0.1278,
    language: 'en',
  },
  {
    names: ['United States', 'USA', 'US', 'United States of America'],
    subtag: 'US',
    timeZone: 'America/New_York',
    latitude: 40.7128,
    longitude: -74.006,
    language: 'en',
  },
  {
    names: ['Ireland', 'IE', 'Republic of Ireland'],
    subtag: 'IE',
    timeZone: 'Europe/Dublin',
    latitude: 53.3498,
    longitude: -6.2603,
    language: 'en',
  },
  {
    names: ['Germany', 'DE', 'Deutschland'],
    subtag: 'DE',
    timeZone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
    language: 'de',
  },
  {
    names: ['France', 'FR'],
    subtag: 'FR',
    timeZone: 'Europe/Paris',
    latitude: 48.8566,
    longitude: 2.3522,
    language: 'fr',
  },
  {
    names: ['Spain', 'ES', 'España'],
    subtag: 'ES',
    timeZone: 'Europe/Madrid',
    latitude: 40.4168,
    longitude: -3.7038,
    language: 'es',
  },
  {
    names: ['Netherlands', 'NL', 'The Netherlands', 'Holland'],
    subtag: 'NL',
    timeZone: 'Europe/Amsterdam',
    latitude: 52.3676,
    longitude: 4.9041,
    language: 'nl',
  },
  {
    names: ['Canada', 'CA'],
    subtag: 'CA',
    timeZone: 'America/Toronto',
    latitude: 43.6532,
    longitude: -79.3832,
    language: 'en',
  },
  {
    names: ['Australia', 'AU'],
    subtag: 'AU',
    timeZone: 'Australia/Sydney',
    latitude: -33.8688,
    longitude: 151.2093,
    language: 'en',
  },
  {
    names: ['United Arab Emirates', 'UAE', 'AE', 'Dubai'],
    subtag: 'AE',
    timeZone: 'Asia/Dubai',
    latitude: 25.2048,
    longitude: 55.2708,
    language: 'ar',
  },
  {
    // "Almaty" is here as a name of the region it is the largest city of, because that is
    // how this repository's own audiences are written — `docs/FLOW.md` section 12's worked
    // example is *"busy parents in Almaty"* — and a city nobody mapped would otherwise be
    // an unrecognised region with no time zone, which is the one answer that is wrong when
    // we do know the answer.
    names: ['Kazakhstan', 'KZ', 'Almaty'],
    subtag: 'KZ',
    timeZone: 'Asia/Almaty',
    latitude: 43.222,
    longitude: 76.8512,
    language: 'kk',
  },
]);

/**
 * The language names this project's audiences are written with, as BCP-47 language subtags.
 *
 * A second table to extend, for the same reason as the first: an audience says "Russian",
 * and `navigator.language` is `ru`. It covers the languages this repository's audiences use
 * and the main language of every region above, so that neither table can name a language
 * the other cannot spell.
 *
 * A value that is **already** a subtag is read as one, so an audience written `en` or
 * `en-GB` needs no row here (`languageSubtag`).
 */
export const LANGUAGE_SUBTAGS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    english: 'en',
    irish: 'ga',
    german: 'de',
    french: 'fr',
    spanish: 'es',
    dutch: 'nl',
    arabic: 'ar',
    russian: 'ru',
    kazakh: 'kk',
    italian: 'it',
    portuguese: 'pt',
    polish: 'pl',
    turkish: 'tr',
    uzbek: 'uz',
  }),
);

/** `  United Kingdom ` and `united kingdom` are one region name. */
const key = (text: string): string => text.trim().toLowerCase();

/**
 * A BCP-47 language tag as it is actually written: `en`, `pt-BR`, `zh-Hant`. Only the
 * **language** part is read off it, because the region part is the audience's region's to
 * say and a persona drawn from Germany who reads `en-US` reads `en-DE`.
 */
const BCP47_LANGUAGE = /^([a-z]{2,3})(?:-[a-z\d]{2,8})*$/i;

const BY_NAME: ReadonlyMap<string, BrowsingRegion> = new Map(
  BROWSING_REGIONS.flatMap((region) => region.names.map((spelling) => [key(spelling), region])),
);

/**
 * The row a region name names, or `null` where the table does not know it.
 *
 * Exported because an unrecognised region is a real answer — the locale drops to the bare
 * language and the session runs with no time zone and no location — and a caller that wants
 * to say so needs to be able to ask.
 */
export const browsingRegion = (region: string): BrowsingRegion | null =>
  BY_NAME.get(key(region)) ?? null;

/**
 * A language name as a BCP-47 language subtag, or `null` where it is neither a name this
 * table knows nor already a tag.
 *
 * `null` is treated exactly as a persona who was drawn no language at all: the region's own
 * main language is used where there is a region, and there is no locale where there is not.
 * Guessing a subtag off the first two letters of a word would invent locales — "Kazakh"
 * would be `ka`, which is Georgian — and a wrong locale is worse than none.
 */
export const languageSubtag = (language: string): string | null => {
  const named = LANGUAGE_SUBTAGS.get(key(language));
  if (named !== undefined) return named;
  const written = BCP47_LANGUAGE.exec(language.trim());
  return written === null ? null : (written[1] as string).toLowerCase();
};

/**
 * What this person's browser is opened as, or `null` where they said nothing about where or
 * how they read.
 *
 * The three settings are the ones `browser.newContext` takes, spelt as the artifact's own
 * `browser` block spells them, so one object is what the context is opened with **and** what
 * the session records. Two spellings of one fact would let a session report a locale it did
 * not run under.
 */
export const browsingFor = (
  persona: Pick<Persona, 'region' | 'language'>,
): SessionBrowser | null => {
  const region = persona.region === undefined ? null : browsingRegion(persona.region);
  const language = persona.language === undefined ? null : languageSubtag(persona.language);
  // Nothing said, nothing to open a browser with: the session runs exactly as it does today.
  if (persona.region === undefined && language === null) return null;
  if (region === null) {
    // A region the table does not know. The language is all there is, and it is said alone:
    // no time zone, no location, and no country claimed on this person's behalf.
    return { locale: language, timezoneId: null, geolocation: null };
  }
  return {
    locale: `${language ?? region.language}-${region.subtag}`,
    timezoneId: region.timeZone,
    geolocation: { latitude: region.latitude, longitude: region.longitude },
  };
};
