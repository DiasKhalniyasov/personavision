import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultEngineConfig, resolveEngineConfig } from '../src/config.js';
import type { Aoi } from '../src/aggregate.js';
import { relevanceByArea } from '../src/relevance.js';
import type { RelevanceArea } from '../src/relevance.js';
import type { CaptureElement } from '../src/types.js';

const { floor } = defaultEngineConfig.relevance;

/**
 * One screen of the fixture shop's checkout step, as areas of interest, inline: this
 * ticket needs no screenshot and no capture fixture, because relevance reads only an
 * area's accessible name, its text and its role.
 *
 * The banner and the body text carry the same word count on purpose — six words each — so
 * that a completion goal favouring the button proves the role table rather than length.
 */
const PRICE = { id: 'price', role: 'text', name: 'Price', text: '$19.99' };
const TOTAL = { id: 'total', role: 'text', name: 'Total', text: '$42.00' };
const PLACE_ORDER = { id: 'place-order', role: 'button', name: 'Place order', text: 'Place order' };
const BANNER = {
  id: 'banner',
  role: 'banner',
  name: 'Free shipping on every order today',
  text: 'Free shipping on every order today',
};
const BODY = {
  id: 'body',
  role: 'paragraph',
  name: '',
  text: 'Our team packs each parcel carefully',
};

const SCREEN: readonly RelevanceArea[] = [PRICE, TOTAL, PLACE_ORDER, BANNER, BODY];

/** The goals the bounded-range criterion sweeps, and the ones the other criteria name. */
const GOALS = [
  'find the cheapest option',
  'how much is the total',
  'place the order',
  'compare the two bundles on price',
  'water the plants in the garden',
  '',
];

const relevanceOf = (goalText: string, area: string): number => {
  const value = relevanceByArea({ areas: SCREEN, goal: { text: goalText } }).get(area);
  if (value === undefined) throw new Error(`no relevance for area "${area}"`);
  return value;
};

const ranking = (goalText: string, areas: readonly RelevanceArea[] = SCREEN): string[] =>
  [...relevanceByArea({ areas, goal: { text: goalText } })]
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id);

describe('relevanceByArea', () => {
  it('scores a price and a total above an unrelated paragraph for a price-seeking goal', () => {
    for (const goal of ['find the cheapest option', 'how much is the total']) {
      expect(relevanceOf(goal, 'price')).toBeGreaterThan(relevanceOf(goal, 'body'));
      expect(relevanceOf(goal, 'total')).toBeGreaterThan(relevanceOf(goal, 'body'));
    }
  });

  it('scores the task-advancing button above a banner and body text of equal word count', () => {
    const goal = 'place the order';

    expect(relevanceOf(goal, 'place-order')).toBeGreaterThan(relevanceOf(goal, 'banner'));
    expect(relevanceOf(goal, 'place-order')).toBeGreaterThan(relevanceOf(goal, 'body'));
    expect(ranking(goal)[0]).toBe('place-order');
  });

  /**
   * The floor, not a negative term: `sampleFixations` feeds relevance to a softmax, where a
   * negative value for the areas a goal says nothing about would dominate every other term.
   */
  it('gives every area the floor, and nothing negative, for a goal that names nothing', () => {
    const values = [
      ...relevanceByArea({
        areas: SCREEN,
        goal: { text: 'water the plants in the garden' },
      }).values(),
    ];

    expect(values).toHaveLength(SCREEN.length);
    for (const value of values) {
      expect(value).toBe(floor);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('keeps every value within the documented range for every fixture and goal', () => {
    for (const goal of GOALS) {
      for (const value of relevanceByArea({ areas: SCREEN, goal: { text: goal } }).values()) {
        expect(value).toBeGreaterThanOrEqual(floor);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ignores case, plural and punctuation differences between the goal and a name', () => {
    expect(ranking('HOW MUCH IS THE TOTALS?!')).toEqual(ranking('how much is the total'));
    expect(ranking('Place the Orders.')).toEqual(ranking('place the order'));
  });

  it('matches an area of interest whose accessible name the contract spells `label`', () => {
    const aoiShaped: readonly RelevanceArea[] = [
      { id: 'total-aoi', role: 'text', label: 'Order total' },
      { id: 'body-aoi', role: 'paragraph', label: 'Our team packs each parcel carefully' },
    ];

    expect(ranking('how much is the total', aoiShaped)[0]).toBe('total-aoi');
  });

  describe('a relevance hint from the agent’s per-screen decision (#33)', () => {
    const goal = { text: 'place the order' };

    it('raises the area toward the hint by the configured weight', () => {
      const { hintWeight } = defaultEngineConfig.relevance;
      const offline = relevanceOf('place the order', 'body');
      const hinted = relevanceByArea({ areas: SCREEN, goal, hints: { body: 1 } }).get('body');

      expect(hinted).toBeCloseTo(offline + (1 - offline) * hintWeight, 12);
      expect(hinted).toBeGreaterThan(offline);
    });

    it('reproduces the offline value exactly when no hint is given', () => {
      const offline = relevanceByArea({ areas: SCREEN, goal });
      const hintedElsewhere = relevanceByArea({ areas: SCREEN, goal, hints: { price: 1 } });

      expect(relevanceByArea({ areas: SCREEN, goal, hints: {} })).toEqual(offline);
      for (const [id, value] of offline) {
        if (id !== 'price') expect(hintedElsewhere.get(id)).toBe(value);
      }
    });

    it('keeps a hint outside the documented range inside it', () => {
      const hinted = relevanceByArea({ areas: SCREEN, goal, hints: { body: -5, price: 9 } });

      expect(hinted.get('body')).toBeGreaterThanOrEqual(floor);
      expect(hinted.get('price')).toBeLessThanOrEqual(1);
    });
  });

  /**
   * Which roles a goal verb favours is data: the calibration step (#11) fits these numbers,
   * so a ranking that can only be changed by editing code is a number out of its reach.
   */
  it('reads the roles a goal verb favours from the configuration object', () => {
    const favoursControls = resolveEngineConfig({
      relevance: { goalVerbRoleWeights: { find: { control: 1, value: 0, prose: 0 } } },
    }).config;

    expect(ranking('find the cheapest option')[0]).toBe('price');
    expect(
      [
        ...relevanceByArea({
          areas: SCREEN,
          goal: { text: 'find the cheapest option' },
          config: favoursControls,
        }),
      ]
        .sort(([, a], [, b]) => b - a)
        .map(([id]) => id)[0],
    ).toBe('place-order');
  });

  describe('pure and offline', () => {
    it('produces the same output for the same inputs', () => {
      const goal = { text: 'how much is the total' };

      expect(relevanceByArea({ areas: SCREEN, goal })).toEqual(
        relevanceByArea({ areas: SCREEN, goal }),
      );
    });

    it('mutates neither the areas nor the goal nor the hints', () => {
      const areas = structuredClone(SCREEN) as RelevanceArea[];
      const goal = { text: 'place the order' };
      const hints = { body: 0.9 };

      relevanceByArea({ areas, goal, hints });

      expect(areas).toEqual(SCREEN);
      expect(goal).toEqual({ text: 'place the order' });
      expect(hints).toEqual({ body: 0.9 });
    });

    /**
     * Asserted over the source rather than by spying at run time: an ESM import reads its
     * own module file from disk by definition, so what can be proved is that this module
     * asks for no file and no socket — the same test `config.test.ts` runs over the package.
     */
    it.each(['node:fs', 'node:net', 'node:http', 'node:dns', 'fetch(', 'XMLHttpRequest'])(
      'never reaches for %s while computing relevance',
      (forbidden) => {
        const source = readFileSync(new URL('../src/relevance.ts', import.meta.url), 'utf8');

        expect(source).not.toContain(forbidden);
      },
    );
  });

  /**
   * The vocabularies are looked up with normalised goal tokens, so they have to be
   * normalised themselves: a word written in a form no normalised token can equal is a
   * word the goal can never reach, and the failure is silent.
   */
  describe('normalisation reaches the vocabularies themselves', () => {
    it('neither drops nor matches a stop word whose singular form differs', () => {
      const areas: readonly RelevanceArea[] = [
        { id: 'named-this', role: 'paragraph', name: 'This', text: '' },
        { id: 'named-else', role: 'paragraph', name: 'Zubrowka', text: '' },
      ];

      const relevance = relevanceByArea({ areas, goal: { text: 'is this the cheapest option' } });

      expect(relevance.get('named-this')).toBe(relevance.get('named-else'));
    });

    it('recognises a comparison goal written with “versus”', () => {
      const goal = 'the blue bundle versus the red bundle';

      expect(relevanceOf(goal, 'price')).toBeGreaterThan(relevanceOf(goal, 'body'));
    });

    it('matches a goal and a name written in a non-Latin script', () => {
      const areas: readonly RelevanceArea[] = [
        { id: 'total', role: 'text', name: 'Итого', text: '4 200 ₸' },
        { id: 'body', role: 'paragraph', name: '', text: 'Описание товара в двух словах' },
      ];

      const relevance = relevanceByArea({ areas, goal: { text: 'итого по заказу' } });

      expect(relevance.get('total')).toBeGreaterThan(relevance.get('body') ?? 0);
    });
  });

  it('reaches the top of the range on areas that carry no text, as an `Aoi` does', () => {
    const areas: readonly RelevanceArea[] = [
      { id: 'place-order', role: 'button', label: 'Place order' },
    ];

    expect(relevanceByArea({ areas, goal: { text: 'place order' } }).get('place-order')).toBe(1);
  });

  it('classes a banner that mentions a price as prose rather than as a value', () => {
    const promo = {
      id: 'promo',
      role: 'banner',
      name: 'Free shipping on all orders over $50 this week',
      text: 'Free shipping on all orders over $50 this week',
    };

    const relevance = relevanceByArea({
      areas: [PRICE, promo, BODY],
      goal: { text: 'find the cheapest option' },
    });

    expect(relevance.get('price')).toBeGreaterThan(relevance.get('promo') ?? 0);
  });

  /** Ids are what every aggregate joins on, so a repeat is a defect worth hearing about. */
  it('refuses two areas of interest that share an id on one screen', () => {
    expect(() =>
      relevanceByArea({ areas: [PRICE, { ...PRICE }], goal: { text: 'how much is the total' } }),
    ).toThrow(/share the id/);
  });

  /** And so does an area of interest as `buildAois` (#64) and the contract publish it. */
  it('accepts an area of interest structurally', () => {
    const aoi: Aoi = {
      id: 'place-order',
      variant: 'a',
      step: 'checkout',
      label: 'Place order',
      source: 'dom',
      role: 'button',
      bbox: { x: 0, y: 0, width: 120, height: 40 },
      isPrimaryAction: true,
      belowFold: false,
    };

    expect(
      relevanceByArea({ areas: [aoi], goal: { text: 'place order' } }).get('place-order'),
    ).toBe(1);
  });

  /** The browser step's capture element satisfies the input with no adapter and no import. */
  it('accepts a capture element structurally', () => {
    const element: CaptureElement = {
      id: 'place-order',
      source: 'dom',
      role: 'button',
      name: 'Place order',
      text: 'Place order',
      bbox: { x: 0, y: 0, width: 120, height: 40 },
      isPrimaryAction: true,
      belowFold: false,
      selector: '#place-order',
    };

    expect(
      relevanceByArea({ areas: [element], goal: { text: 'place the order' } }).get('place-order'),
    ).toBeGreaterThan(floor);
  });
});
