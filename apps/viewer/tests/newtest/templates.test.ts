import { runRequestSchema } from '@personavision/contract';
import { parseSiteUrl, seedForLaunchDay, variantForSite } from '@personavision/platform';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_TESTS } from '../../src/screens/newtest/templates';
// The rule itself, from the file that states it, rather than through the provider's barrel:
// `readCriterion` is a function of the sentence alone — no model, no network, no state —
// and it is what `packages/swarm/src/criterion.ts` decides a session's outcome with.
import { readCriterion } from '../../../../packages/provider/src/wonder-goal.js';
import type { ExampleTest } from '../../src/screens/newtest/templates';

/**
 * The five example tests, held to **the same validation a typed test is held to**.
 *
 * A template is not a special kind of test: it is a site, a feature and a goal somebody
 * could have typed, offered on two screens so that a first visit does not have to invent
 * four things before seeing a result. So nothing here asserts a screen — what it asserts is
 * that every one of the five would survive the path a typed test takes:
 *
 * - the **URL** through the platform's own `parseSiteUrl`, which is what `POST /sites` and
 *   `POST /runs` both put a site through;
 * - the **feature and the goal** through the contract's own `runRequestSchema`, built the way
 *   `packages/platform/src/run/start.ts` builds a one-URL request — so the request a template
 *   would start parses;
 * - the **success criterion** through `readCriterion`, because a criterion that names nothing
 *   observable is not refused by any schema and is instead refused once a run is walking:
 *   `criterionToObserve` reads it, finds nothing to look for, and **every session of that run
 *   is a failure by construction**. A template whose first result is 0% would be the one
 *   thing these five exist to prevent.
 *
 * The rules are imported, never copied: a template is held to what the platform, the
 * contract and the provider say, so a template cannot pass a test here and be refused by the
 * product. Adding a sixth with an address nobody can request, a two-sentence task or a
 * criterion no session can evaluate fails CI rather than a run.
 */

/** The owner's five, by site and by what each test is about (the input of 2026-11-04 on #1). */
const THE_OWNERS_FIVE: readonly { readonly siteUrl: string; readonly feature: string }[] = [
  { siteUrl: 'https://docs.stripe.com', feature: 'testing payments' },
  { siteUrl: 'https://vercel.com', feature: 'starting a project from a template' },
  { siteUrl: 'https://www.ikea.com', feature: 'furniture take-back' },
  { siteUrl: 'https://www.canva.com', feature: 'making short social videos' },
  { siteUrl: 'https://www.apple.com', feature: 'trading in an old phone' },
];

/**
 * The request a template would start, built the way the platform builds one from a site, a
 * feature and a goal (`draftForSite`): the goal's own task **is** the task, the site becomes
 * the single variant, and the audience and the site record are named by id.
 *
 * The two ids are a workspace's, not a template's — a template carries no audience and no
 * site record, which is the point of it — so they stand in here as any launch's would.
 */
const requestFrom = (template: ExampleTest): unknown => ({
  task: { prompt: template.task },
  variants: [variantForSite(template.siteUrl)],
  feature: template.feature,
  goal: {
    task: template.task,
    successCriterion: template.successCriterion,
    // What a template's goal is recorded as: the user chose it, and no model wrote it.
    lastWrittenBy: 'user',
  },
  audienceId: 'aud-example',
  siteId: 'site-example',
  repeats: 1,
  seed: seedForLaunchDay(new Date()),
  // A model run, which is what a launch from the wizard is, and the model it runs on: the
  // workspace's, which `startTest` reads rather than the wizard sending it.
  engineMode: 'model',
  modelMode: 'standard',
});

describe('the five the owner asked for', () => {
  it('is five, in the owner’s order, on the owner’s sites and about the owner’s features', () => {
    expect(EXAMPLE_TESTS.map(({ siteUrl, feature }) => ({ siteUrl, feature }))).toEqual(
      THE_OWNERS_FIVE,
    );
  });

  it('names each of them once, and says something for every field', () => {
    expect(new Set(EXAMPLE_TESTS.map((template) => template.id)).size).toBe(EXAMPLE_TESTS.length);

    for (const template of EXAMPLE_TESTS) {
      expect(template.id, 'id').not.toBe('');
      expect(template.task.trim(), `${template.id} task`).not.toBe('');
      expect(template.successCriterion.trim(), `${template.id} criterion`).not.toBe('');
      // The sentence the audience step's box is seeded with. A template with none would
      // land a reader on that step with an empty box, which is the typed path.
      expect(template.audienceSentence.trim(), `${template.id} audience`).not.toBe('');
    }
  });

  it('is frozen: a screen renders a template and changes nothing about it', () => {
    expect(Object.isFrozen(EXAMPLE_TESTS)).toBe(true);
  });
});

describe('every template passes the validation a typed test passes', () => {
  it('gives an address the platform accepts, and keeps it exactly as it stores it', () => {
    for (const template of EXAMPLE_TESTS) {
      // Unchanged, because `POST /sites` stores the URL as it is given and the draft, the
      // card and the run all read that one string.
      expect(parseSiteUrl(template.siteUrl), template.id).toBe(template.siteUrl);
    }
  });

  it('builds a run request the contract parses', () => {
    for (const template of EXAMPLE_TESTS) {
      const parsed = runRequestSchema.safeParse(requestFrom(template));
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
        template.id,
      ).toEqual([]);
    }
  });

  it('states a success criterion a session can observe', () => {
    for (const template of EXAMPLE_TESTS) {
      const reading = readCriterion(template.successCriterion);
      expect(reading.observable ? '' : reading.reason, template.id).toBe('');
    }
  });
});

describe('what a sixth template would be refused for', () => {
  const sixth = (over: Partial<ExampleTest>): ExampleTest => ({
    id: 'sixth',
    siteUrl: 'https://example.com',
    feature: 'signing up',
    task: 'Find out how to open an account',
    successCriterion: 'A heading with the words “Create account” is visible.',
    audienceSentence: 'everyday people on phones, from very confident online to not at all',
    ...over,
  });

  it('is itself valid, so the three refusals below are about what they change', () => {
    const template = sixth({});
    expect(runRequestSchema.safeParse(requestFrom(template)).success).toBe(true);
    expect(readCriterion(template.successCriterion).observable).toBe(true);
  });

  it('refuses an address nobody can request', () => {
    expect(() => variantForSite(sixth({ siteUrl: 'example.com/signup' }).siteUrl)).toThrow();
    expect(() => parseSiteUrl(sixth({ siteUrl: 'ftp://example.com' }).siteUrl)).toThrow();
  });

  it('refuses a task of two sentences', () => {
    const parsed = runRequestSchema.safeParse(
      requestFrom(sixth({ task: 'Open an account. Then find the fees.' })),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses a criterion no session can evaluate', () => {
    // The whole class: a criterion about the page rather than about something on it, and a
    // criterion about how the page felt.
    for (const criterion of ['The sign-up page is shown.', 'The form is easy to understand.']) {
      expect(readCriterion(criterion).observable, criterion).toBe(false);
    }
  });
});
