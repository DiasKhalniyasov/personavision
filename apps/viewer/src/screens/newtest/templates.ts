/**
 * The five example tests, as data.
 *
 * A first visit has nothing to test yet, and inventing a site, a feature, a task and a
 * success criterion before seeing a single result is four decisions in a row. These five are
 * the owner's own (the input of **2026-11-04** on #1): a real public site each, none of them
 * behind a login, offered on the first New test screen and on the **No tests** state.
 *
 * **The rule they exist to demonstrate.** Each task names a need **in everyday words and
 * never the site's own label for the feature** — *"a way to get rid of your old furniture"*,
 * not *"the take-back service"*. The product's claim is that people with different
 * personalities look for the same thing differently, and a task written in the site's own
 * vocabulary would be testing whether somebody can read a menu we already read for them.
 *
 * **They are data and nothing fetches them.** One frozen array, part of the build: the two
 * screens that offer them read this file, so neither spells a template and the two cannot
 * drift apart. `tests/newtest/templates.test.ts` puts every one of them through the same
 * validation a typed test is held to — the URL through the platform's own `parseSiteUrl`,
 * the feature and the goal through the contract's own `runRequestSchema`, and the criterion
 * through `readCriterion`, which is the rule a session's outcome is decided by
 * (`packages/swarm/src/criterion.ts`) — so a sixth template with an address nobody can
 * request, a two-sentence task or a criterion no session can evaluate fails CI rather than a
 * run.
 *
 * **Every criterion here is one phrase to find.** The owner's five each named *the page* —
 * and three of them offered two or three names for it. A criterion is read as a conjunction:
 * `criterionToObserve` turns *"Canva's video editor or social-video templates page is
 * shown"* into five words that must **all** be on one screen, so a sentence offering
 * alternatives asks for all of them and a template's every session fails. Each criterion
 * below therefore names the element that carries the claim and quotes **one** phrase as the
 * words to find, with the owner's own sentence beside it in a comment.
 *
 * **Each one carries its audience as a sentence**, not as a structured audience: the
 * sentence lands in the audience step's own box and that step's own control is what reads it
 * (`POST /audiences/from-sentence`). So a template takes no shortcut past `docs/FLOW.md`
 * section 12 — the audience is still shown to the user before anything can launch — and
 * decision 161's refusal with no key still appears where it always does.
 */

/** One example test: the four things a path-1 test is made of, and who to run it with. */
export interface ExampleTest {
  /** Stable, and the key of the card: the site and what the test is about. */
  readonly id: string;
  /** The address the feature starts on, exactly as it goes to `POST /sites`. */
  readonly siteUrl: string;
  /** The feature whose experience is tested, in the register a user writes it in. */
  readonly feature: string;
  /** What the hundred of them attempt — **a need in everyday words**, never the site's label. */
  readonly task: string;
  /** What has to be observable in the page for an attempt to count as a success. */
  readonly successCriterion: string;
  /**
   * The suggested audience, as the sentence the audience step's box invites — *"first-time
   * creators in Kazakhstan, mostly on phones, who have never used a video tool"*. It is
   * carried into that box and read there, never on the user's behalf.
   */
  readonly audienceSentence: string;
}

/**
 * The five, in the owner's order.
 *
 * Frozen because they are the build's and not a screen's: a card renders one and changes
 * nothing about it, and a draft is filled from a copy of these strings.
 */
export const EXAMPLE_TESTS: readonly ExampleTest[] = Object.freeze([
  {
    id: 'stripe-testing-payments',
    siteUrl: 'https://docs.stripe.com',
    feature: 'testing payments',
    task: 'Find out how to check a payment works without spending real money',
    // The owner wrote *"the testing page with test card numbers is visible"*: the same claim,
    // with the heading that carries it named rather than the page, and **as one phrase**.
    successCriterion: 'A heading with the words “Test card numbers” is visible.',
    audienceSentence:
      'developers integrating payments for the first time, on laptops, comfortable reading ' +
      'technical documentation',
  },
  {
    id: 'vercel-start-from-a-template',
    siteUrl: 'https://vercel.com',
    feature: 'starting a project from a template',
    task: "Find a ready-made starting point for a small online shop so you don't start from zero",
    // The owner wrote *"a template page for an ecommerce or online-store starter is shown"*.
    // A criterion has to name something a session can **see** on the page, and "a page is
    // shown" names the page itself — so the sentence is the owner's claim with the thing
    // that carries it named (the auto-decision of 2026-11-04 on #417).
    successCriterion: 'A template card showing the word “Ecommerce” is visible.',
    audienceSentence:
      'developers starting a side project on their own time, on laptops, who have shipped a ' +
      'site before but never a shop',
  },
  {
    id: 'ikea-furniture-take-back',
    siteUrl: 'https://www.ikea.com',
    feature: 'furniture take-back',
    task: 'Find a way to get rid of your old furniture when the new one arrives',
    // The owner wrote *"the page for IKEA's take-back, buy-back or old-furniture removal
    // service is shown"*. Every term of a criterion has to be on one screen, so a sentence
    // offering three names for the service asks for all three; this names the one IKEA's own
    // pages use, as the words to find.
    successCriterion: 'A heading with the words “Buy back” is visible.',
    audienceSentence:
      'everyday shoppers of all ages, some on phones and some on laptops, from very confident ' +
      'online to not confident at all',
  },
  {
    id: 'canva-short-social-video',
    siteUrl: 'https://www.canva.com',
    feature: 'making short social videos',
    task: "Find out what you'd need to make a short video for social media",
    // The owner wrote *"Canva's video editor or social-video templates page is shown"*. A
    // criterion offering two pages asks for the words of both, so this names the one its own
    // editor is headed with.
    successCriterion: 'A heading with the words “Video editor” is visible.',
    audienceSentence:
      'everyday people of all ages who want to post a video, mostly on phones, from very ' +
      'confident online to not confident at all',
  },
  {
    id: 'apple-trade-in',
    siteUrl: 'https://www.apple.com',
    feature: 'trading in an old phone',
    task: 'Find out what you can do with your old phone if you buy a new one',
    // The owner wrote *"the Apple Trade In page with trade-in values is visible"*: the same
    // claim, with the heading that carries it named rather than the page.
    successCriterion: 'A heading with the words “Trade In” is visible.',
    audienceSentence:
      'everyday phone owners of all ages, half on phones and half on laptops, from very ' +
      'confident online to not confident at all',
  },
  {
    id: 'meta-cheapest-vision-model',
    siteUrl: 'https://dev.meta.ai',
    feature: 'choosing an affordable vision model for browsing agents',
    // The owner's sixth (2026-11-05): the need, never a model's name. The prices page is the
    // one place a few hundred agents can be costed, so reaching it is the success.
    task: 'Find out which is the cheapest model that is good at visual tasks like browsing websites, and what it would cost to run a few hundred agents',
    successCriterion: 'The address bar reads /docs/pricing-rate-limits.',
    audienceSentence:
      'developers building AI agents on a budget, mostly on laptops, who compare models and ' +
      'prices before signing up',
  },
]);
