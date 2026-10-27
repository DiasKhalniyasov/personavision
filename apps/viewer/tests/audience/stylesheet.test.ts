// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
// Imported for its teardown: the document, and any stylesheet put in it, is reset per test.
import '../setup';

/**
 * The audience screens' own layout, read off the stylesheet.
 *
 * A media query and a border colour are not reachable through a rendered component — jsdom
 * applies no stylesheet of its own — so this suite puts `audience.module.css` in a document
 * and reads the rules back through the CSSOM. What it holds is the part of the screen
 * contract that is CSS and nothing else: the paired age fields and the two-column row stack
 * in a narrow window, and every value is a token's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screens = join(here, '../../src/screens/audience');
const stylesheet = join(screens, 'audience.module.css');

interface Rule {
  selector: string;
  condition: string;
  declarations: Record<string, string>;
}

const declarationsOf = (rule: CSSStyleRule): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: rule.style.length }, (_unused, index) => rule.style.item(index)).map(
      (property) => [property, rule.style.getPropertyValue(property)],
    ),
  );

function rulesOf(css: string): Rule[] {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const sheet = style.sheet as CSSStyleSheet;

  return [...sheet.cssRules].flatMap((rule) => {
    if (rule instanceof CSSMediaRule) {
      return [...rule.cssRules].map((inner) => ({
        selector: (inner as CSSStyleRule).selectorText,
        condition: rule.conditionText,
        declarations: declarationsOf(inner as CSSStyleRule),
      }));
    }
    if (rule instanceof CSSStyleRule) {
      return [{ selector: rule.selectorText, condition: '', declarations: declarationsOf(rule) }];
    }
    return [];
  });
}

let rules: Rule[];

beforeEach(() => {
  rules = rulesOf(readFileSync(stylesheet, 'utf8'));
});

/** The selectors of one rule, in the order they are written, however they are spaced. */
const selectorsOf = (rule: Rule): string[] =>
  rule.selector.split(',').map((selector) => selector.trim());

/** One rule, by the selectors it is written for and the media query it sits in. */
const rule = (selectors: string | string[], condition = ''): Record<string, string> => {
  const wanted = typeof selectors === 'string' ? [selectors] : selectors;
  const found = rules.filter(
    (item) =>
      item.condition === condition &&
      selectorsOf(item).length === wanted.length &&
      selectorsOf(item).every((selector, index) => selector === wanted[index]),
  );
  expect(found, `${wanted.join(', ')} ${condition}`).toHaveLength(1);
  return (found[0] as Rule).declarations;
};

describe('a narrow window', () => {
  it('stacks the paired age fields and the two-column row', () => {
    expect(rule('.inline3')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(rule('.inline2')['grid-template-columns']).toBe('repeat(2, minmax(0, 1fr))');
    expect(rule(['.inline2', '.inline3'], '(max-width: 1000px)')['grid-template-columns']).toBe(
      '1fr',
    );
  });

  it('takes the cards and the people down a column at a time', () => {
    expect(rule('.audGrid')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(rule(['.audGrid', '.personagrid'], '(max-width: 1000px)')['grid-template-columns']).toBe(
      'repeat(2, minmax(0, 1fr))',
    );
    expect(
      rule(['.audGrid', '.personagrid', '.meter'], '(max-width: 640px)')['grid-template-columns'],
    ).toBe('1fr');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  // That no value is restated by hand is `tests/skeleton.test.ts`'s rule, over every
  // stylesheet the app ships; what is asserted here is that these screens take the
  // *right* tokens.
  it('marks the audience of the latest test, and a pressed chip, in the accent', () => {
    expect(rule(".audCard[aria-current='true']")['border-color']).toBe('var(--color-accent)');
    expect(rule(".chip[aria-pressed='true']")['border-color']).toBe('var(--color-accent)');
    expect(rule(".chip[aria-pressed='true']")['background']).toBe('var(--color-accent-soft)');
  });

  it('states a refusal in the critical colour, at the small type size', () => {
    expect(rule('.err')['color']).toBe('var(--sev-critical)');
    expect(rule('.err')['font-size']).toBe('var(--text-xs)');
  });

  it('draws a generated person in the medium radius, on the ordinary border', () => {
    expect(rule('.personachip')['border-radius']).toBe('var(--radius-md)');
    expect(rule('.personachip')['border']).toBe('var(--border-width) solid var(--color-border)');
  });

  it('is the stylesheet every part of these screens lays itself out with', () => {
    const parts = [
      'AudiencesPage',
      'AudienceCard',
      'AudienceSetupPage',
      'AudienceForm',
      'ChipField',
      'DeviceField',
      'BehaviourMeters',
      'GeneratedPeople',
    ];

    for (const part of parts) {
      const source = readFileSync(join(screens, `${part}.tsx`), 'utf8');
      expect(source, part).toContain("from './audience.module.css'");
    }
  });

  it('declares no animation of its own: the three animated moments are other tickets’', () => {
    const source = readFileSync(stylesheet, 'utf8');

    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });
});
