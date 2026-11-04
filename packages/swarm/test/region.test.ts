/**
 * The persona's region, carried into the session that runs as them (#421).
 *
 * The run loop is the only place that has both halves: the person it was handed, and the
 * capture source it opens a browser through. So this is where the region a persona was drawn
 * becomes a browser context — and where what that context was opened with is written down on
 * the session, so a reader of a finished run can say the IKEA sessions ran as `en-GB` in
 * `Europe/London` rather than inferring it from the audience.
 *
 * **Nothing here spells a locale rule.** `@personavision/personas` publishes the one table
 * from a region to a browser; this suite asserts that the loop asks it, hands the answer to
 * `openSession`, and records the **same object** it opened with. A session that reported a
 * locale it had not run under would be worse than one that reported none.
 *
 * Every session here runs through the committed capture set with nothing running, which is
 * why it can assert the request a fixture source receives: a source that opens no browser
 * ignores where it was told to browse, and the loop still has to tell it.
 */

import { readFile } from 'node:fs/promises';
import { runPaths, sessionSchema } from '@personavision/contract';
import { browsingFor } from '@personavision/personas';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runSession } from '../src/index.js';
import { personaWho, sessionOver, sweep, temporaryRunDir, withNothingRunning } from './harness.js';
import type { CaptureSource, SessionRequest } from '@personavision/browser';
import type { Persona, Session } from '@personavision/contract';
import type { RunSessionInput } from '../src/index.js';

let runDir: string;

beforeEach(async () => {
  runDir = await temporaryRunDir();
});

afterEach(async () => {
  await sweep(runDir);
});

/** The source the harness uses, with every `openSession` request it was handed kept. */
const watching = (source: CaptureSource): { source: CaptureSource; asked: SessionRequest[] } => {
  const asked: SessionRequest[] = [];
  return {
    asked,
    source: {
      ...source,
      openSession: (variant, device, session) => {
        if (session !== undefined) asked.push(session);
        return source.openSession(variant, device, session);
      },
    },
  };
};

/** One session of a person with the fields the region is derived from. */
const sessionOf = async (
  fields: Pick<Persona, 'region' | 'language'>,
): Promise<{ session: Session; asked: readonly SessionRequest[] }> => {
  const base: RunSessionInput = sessionOver(runDir);
  const watched = watching(base.source);
  const session = await withNothingRunning(() =>
    runSession({
      ...base,
      source: watched.source,
      persona: { ...personaWho('careful'), ...fields },
    }),
  );
  return { session, asked: watched.asked };
};

it('opens the session in the person region, and records what it opened with', async () => {
  const { session, asked } = await sessionOf({ region: 'United Kingdom', language: 'English' });

  expect(session.browser).toStrictEqual({
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
  });
  // The same thing the browser was asked for, and not a second reading of it.
  expect(asked.map((request) => request.browsing)).toStrictEqual([session.browser]);
});

it('asks the one table rather than spelling a locale of its own', async () => {
  const person = { region: 'Almaty', language: 'Russian' } as const;
  const { session } = await sessionOf(person);

  expect(session.browser).toStrictEqual(browsingFor(person));
});

it('runs with the bare language, no time zone and no location, from a region nobody mapped', async () => {
  const { session, asked } = await sessionOf({ region: 'Narnia', language: 'Russian' });

  expect(session.browser).toStrictEqual({ locale: 'ru', timezoneId: null, geolocation: null });
  expect(asked[0]?.browsing).toStrictEqual(session.browser);
});

it('says so when a region nobody mapped leaves nothing at all to run under', async () => {
  const { session } = await sessionOf({ region: 'Narnia', language: 'Klingon' });

  // Present, with nothing in it: the unrecognised region is visible in the artifact rather
  // than silently becoming somebody else's country.
  expect(session.browser).toStrictEqual({ locale: null, timezoneId: null, geolocation: null });
});

it('carries no block, and tells the source nothing, for a person drawn neither', async () => {
  const { session, asked } = await sessionOf({});

  expect('browser' in session).toBe(false);
  expect(asked.map((request) => request.browsing)).toStrictEqual([undefined]);
});

it('writes a session the contract accepts, with the block on it', async () => {
  const { session } = await sessionOf({ region: 'United States', language: 'English' });

  expect(sessionSchema.parse(session).browser?.locale).toBe('en-US');
  // And on disk, where a reader of the run finds it.
  const written: unknown = JSON.parse(
    await readFile(runPaths(runDir).session(session.sessionId), 'utf8'),
  );

  expect(sessionSchema.parse(written).browser?.timezoneId).toBe('America/New_York');
});
