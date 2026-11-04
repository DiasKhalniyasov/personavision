/**
 * Whether a session observed its run's success criterion, on synthetic screens.
 *
 * No browser, no provider, no network, no key and no file read: a screen here is what a
 * capture holds — the step, the address and the elements' accessible names and visible text
 * — which is exactly what the reader is allowed to look at (#400).
 *
 * The three kinds are `readCriterion`'s (`@personavision/provider`, #259) and are not
 * re-decided here: these tests assert that each of the three is **matched** against a
 * captured screen, that a criterion the reader cannot evaluate is never observed, and that a
 * screen carrying some of what a criterion names is not a screen carrying it.
 */

import { describe, expect, it } from 'vitest';
import { criterionToObserve, observeCriterion } from '../src/index.js';
import type { CriterionToObserve, ObservableScreen } from '../src/index.js';

/** The criterion, read — or a failure naming it, because every test here needs the reading. */
const read = (criterion: string): CriterionToObserve => {
  const reading = criterionToObserve(criterion);
  if (reading === null) throw new Error(`“${criterion}” was read as no criterion at all`);
  return reading;
};

/** One captured screen: where it was, and what the capture extracted from it. */
const screen = (
  url: string,
  elements: readonly { name?: string | null; text?: string | null }[],
  step = 'page',
): ObservableScreen => ({ step, url, elements });

/** The fixture site's cart, as the committed capture set records it. */
const CART = screen('https://fixture.test/cart.html', [
  { name: 'Your cart', text: 'Your cart' },
  { name: 'Cart items', text: null },
  { name: 'Canvas tote bag', text: 'Canvas tote bag' },
  { name: 'Checkout', text: 'Checkout' },
]);

/** And its confirmation page, which is the one the four-step walk ends on. */
const CONFIRMATION = screen(
  'https://fixture.test/confirmation.html',
  [
    { name: 'Order confirmed', text: 'Order confirmed' },
    { name: 'Receipt', text: null },
    { name: 'A printed receipt', text: null },
    { name: 'Order FIX-1001', text: 'Order FIX-1001' },
    { name: 'Continue shopping', text: 'Continue shopping' },
  ],
  'confirmation',
);

describe('the criterion a run was given', () => {
  it('is nothing at all on a run with no goal', () => {
    // The old rule decides those sessions — the task's last declared step — and the reader
    // says so by answering with no criterion rather than with one nothing can satisfy.
    expect(criterionToObserve(undefined)).toBeNull();
    expect(criterionToObserve('   ')).toBeNull();
  });

  it('carries the kind readCriterion classified it as, and does not re-decide it', () => {
    expect(read('The confirmation receipt is visible.').kind).toBe('element');
    expect(read('The address bar reads /confirmation.html.').kind).toBe('url');
    expect(read('The page shows the text “Order confirmed”.').kind).toBe('text');
  });

  it('keeps the criterion in the words the goal states it', () => {
    const criterion = 'The confirmation receipt is visible.';

    expect(read(criterion).criterion).toBe(criterion);
  });
});

describe('matching the three kinds against a captured screen', () => {
  it('matches an element by its accessible name', () => {
    // "Receipt" is the name of a region the page gives no visible text at all: a criterion
    // about it is answered by what the accessibility tree says, which is what a capture has.
    const criterion = read('The confirmation receipt is visible.');

    expect(criterion.kind).toBe('element');
    expect(observeCriterion(criterion, CONFIRMATION).observed).toBe(true);
    expect(observeCriterion(criterion, CART).observed).toBe(false);
  });

  it('matches an element by its visible text', () => {
    const criterion = read('The “Continue shopping” link is visible.');

    expect(criterion.kind).toBe('element');
    expect(
      observeCriterion(criterion, screen('https://fixture.test/x', [{ text: 'Continue shopping' }]))
        .observed,
    ).toBe(true);
    expect(observeCriterion(criterion, CART).observed).toBe(false);
  });

  it('matches a URL by the path it names, and not by the page’s words', () => {
    const criterion = read('The address bar reads /confirmation.html.');

    expect(criterion.kind).toBe('url');
    expect(criterion.terms).toStrictEqual(['/confirmation.html']);
    expect(observeCriterion(criterion, CONFIRMATION).observed).toBe(true);
    expect(observeCriterion(criterion, CART).observed).toBe(false);
    // The path and nothing but the path: a page that merely talks about the confirmation
    // page is not the confirmation page.
    expect(
      observeCriterion(
        criterion,
        screen('https://fixture.test/review.html', [
          { text: 'Placing the order takes you to /confirmation.html.' },
        ]),
      ).observed,
    ).toBe(false);
  });

  it('matches a piece of text by the quoted span, whole', () => {
    const criterion = read('The page shows the text “Order confirmed”.');

    expect(criterion.kind).toBe('text');
    expect(criterion.terms).toStrictEqual(['Order confirmed']);
    expect(observeCriterion(criterion, CONFIRMATION).observed).toBe(true);
    // Both words on the screen, and not that sentence: a quoted span is page copy and not a
    // bag of words that may turn up anywhere.
    expect(
      observeCriterion(
        criterion,
        screen('https://fixture.test/review.html', [
          { text: 'Order summary' },
          { text: 'Payment confirmed' },
        ]),
      ).observed,
    ).toBe(false);
  });
});

describe('what a screen has to have', () => {
  it('needs every word the criterion names, not one of them', () => {
    // The defect this exists to remove: a site whose navigation says "Pricing" satisfies
    // nothing about a plan's price, and a completion rate built on it would be a count of
    // pages that loaded.
    const criterion = read('The pricing page is shown, with at least one plan’s price visible.');
    const home = screen('https://usestring.ai/', [
      { name: 'Pricing', text: 'Pricing' },
      { name: 'Make a video', text: 'Make a video' },
    ]);
    const pricing = screen('https://usestring.ai/pricing', [
      { name: 'Pricing', text: 'Pricing' },
      { text: 'Starter plan' },
      { text: 'Price: $20 a month' },
    ]);

    expect(criterion.terms).toStrictEqual(['pricing', 'plan', 'price']);
    expect(observeCriterion(criterion, home)).toMatchObject({
      observed: false,
      found: ['pricing'],
      missing: ['plan', 'price'],
    });
    expect(observeCriterion(criterion, pricing).observed).toBe(true);
  });

  it('takes one word as the beginning of another, and no shorter word as a prefix', () => {
    const plural = read('The prices are visible.');
    const short = read('The tab is visible.');

    expect(observeCriterion(plural, screen('https://x.test/', [{ text: 'Price' }])).observed).toBe(
      true,
    );
    expect(observeCriterion(plural, screen('https://x.test/', [{ text: 'Priced' }])).observed).toBe(
      true,
    );
    // Four characters is the floor: a three-letter word has to be the word.
    expect(observeCriterion(short, screen('https://x.test/', [{ text: 'Table' }])).observed).toBe(
      false,
    );
    expect(observeCriterion(short, screen('https://x.test/', [{ text: 'Tab' }])).observed).toBe(
      true,
    );
  });

  it('reads the address as part of the screen, whatever kind the criterion is', () => {
    // The step is ours and the page's words are the page's; the address is the one other
    // thing a session captured, and a criterion naming where it ended up is answered by it.
    const criterion = read('The confirmation receipt is visible.');

    expect(criterion.terms).toStrictEqual(['confirmation', 'receipt']);
    expect(
      observeCriterion(criterion, screen('https://fixture.test/thanks', [{ name: 'Receipt' }]))
        .observed,
    ).toBe(false);
    expect(
      observeCriterion(
        criterion,
        screen('https://fixture.test/confirmation', [{ name: 'Receipt' }]),
      ).observed,
    ).toBe(true);
  });

  it('names the step it looked on, so a reason can say where it looked', () => {
    const sighting = observeCriterion(read('The confirmation receipt is visible.'), CART);

    expect(sighting.step).toBe('page');
    expect(sighting.missing).toStrictEqual(['confirmation', 'receipt']);
    expect(observeCriterion(read('The cart is visible.'), CART).step).toBe('page');
  });

  it('leaves out of the terms the scaffolding every criterion is made of', () => {
    // The articles, the auxiliaries and the visibility vocabulary are what makes a sentence
    // a criterion rather than a noun — and a page shows a receipt, never the word "visible".
    expect(read('The receipt is visible.').terms).toStrictEqual(['receipt']);
    expect(read('A video preview is shown on the page.').terms).toStrictEqual(['video', 'preview']);
  });
});

describe('a criterion nothing can look for', () => {
  it('is never observed, on any screen, and says why in the reader’s own words', () => {
    const judgement = read('The page feels trustworthy.');

    expect(judgement.kind).toBeNull();
    expect(judgement.terms).toStrictEqual([]);
    expect(judgement.unobservable).toContain('judgement');
    // Not promoted to a success by falling back to a weaker test: every screen there is
    // answers the same way.
    for (const where of [CART, CONFIRMATION]) {
      expect(observeCriterion(judgement, where).observed).toBe(false);
    }
  });

  it('is a criterion naming none of the three kinds, as well as one naming a feeling', () => {
    const vague = read('The confirmation screen shows an order number.');

    expect(vague.kind).toBeNull();
    expect(vague.unobservable).toContain('not something a session can see');
    expect(observeCriterion(vague, CONFIRMATION).observed).toBe(false);
  });
});
