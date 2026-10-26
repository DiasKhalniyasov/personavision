// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
// Imported for its teardown: the document, and any stylesheet put in it, is reset per test.
import '../setup';

/**
 * The first strip's type scale and its two breakpoints, read off the stylesheet.
 *
 * A font size and a media query are not reachable through a rendered component — jsdom
 * applies no stylesheet of its own — so this suite puts `verdict.css` in a document and
 * reads the rules back through the CSSOM. What it is here to hold is the part of the screen
 * contract that is CSS and nothing else: the headline is set at the display role, it drops
 * to `--text-display-sm` below the prototype's breakpoint, the figures are a wrapping row
 * so they stack rather than squash, and no value is restated by hand.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = join(here, '../../src/screens/verdict/verdict.css');

/** Every rule of the stylesheet, and every rule of each media query, with its condition. */
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

let css: string;
let rules: Rule[];

beforeEach(() => {
  css = readFileSync(stylesheet, 'utf8');
  rules = rulesOf(css);
});

/** One rule, by its selector and the media query it sits in. */
const rule = (selector: string, condition = ''): Record<string, string> => {
  const found = rules.filter((item) => item.selector === selector && item.condition === condition);
  expect(found, `${selector} ${condition}`).toHaveLength(1);
  return (found[0] as Rule).declarations;
};

describe('the headline’s type role', () => {
  it('sets the headline at the display role, in the display weight and tracking', () => {
    expect(rule('.hero h1')['font-size']).toBe('var(--text-display)');
    expect(rule('.hero h1')['font-weight']).toBe('var(--weight-extrabold)');
    expect(rule('.hero h1')['letter-spacing']).toBe('var(--tracking-tighter)');
  });

  it('reserves the headline’s height, so the figures do not jump when the run resolves', () => {
    // Two lines of the headline's own line box: no size of the type scale is restated to
    // get the height, so the reservation follows the font size at every breakpoint.
    expect(rule('.hero h1')['min-block-size']).toBe('2lh');
  });
});

describe('a narrow window', () => {
  it('drops the headline to --text-display-sm below the prototype’s breakpoint', () => {
    expect(rule('.hero h1', '(max-width: 1000px)')['font-size']).toBe('var(--text-display-sm)');
    expect(rule('.hero h1', '(max-width: 640px)')['font-size']).toBe('var(--text-xl)');
  });

  it('stacks the figures rather than squashing them', () => {
    // A wrapping row: side by side while they fit, one under the other when they do not,
    // and the figure itself drops a type step at the narrowest width.
    expect(rule('.figures')['flex-wrap']).toBe('wrap');
    expect(rule('.figures', '(max-width: 1000px)')['gap']).toBe('var(--space-8)');
    expect(rule('.figure .figure-value', '(max-width: 640px)')['font-size']).toBe(
      'var(--text-2xl)',
    );
  });
});

describe('the tokens stay the only source of visual truth', () => {
  // That no value is restated by hand is `tests/skeleton.test.ts`'s rule, over every
  // stylesheet the app ships; what is asserted here is that this screen takes the
  // *right* tokens.
  it('takes the completion colours from the --completion-* ramp', () => {
    expect(rule('.completion-good')['color']).toBe('var(--completion-good)');
    expect(rule('.completion-warn')['color']).toBe('var(--completion-warn)');
    expect(rule('.completion-bad')['color']).toBe('var(--completion-bad)');
  });

  it('is the stylesheet every section of this strip imports', () => {
    const sections = ['AudienceLine', 'Headline', 'CompletionFigures', 'Reasons'];

    for (const section of sections) {
      const source = readFileSync(join(here, `../../src/screens/verdict/${section}.tsx`), 'utf8');
      expect(source, section).toContain("import './verdict.css'");
    }
  });
});
