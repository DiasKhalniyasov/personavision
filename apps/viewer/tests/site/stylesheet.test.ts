// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
// Imported for its teardown: the document, and any stylesheet put in it, is reset per test.
import '../setup';
import { ruleIn, rulesOf } from '../cssom';
import type { Rule } from '../cssom';

/**
 * `#screen-site`'s own layout: the URL field, the state line, the four methods and the
 * exact line to copy inside each of them.
 *
 * The prototype draws these with its shared `Forms` block and its own `.verify` rules; what
 * is asserted here is that this screen takes the same values — the same gaps, the same type
 * roles, the same muted colour — out of `docs/design/tokens.css`, rather than that it shares
 * another screen's stylesheet.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screenDir = join(here, '../../src/screens/site');
const stylesheet = join(screenDir, 'site.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the URL field', () => {
  it('is one column of the prototype’s width, a form step apart', () => {
    expect(rule('.form')['display']).toBe('grid');
    expect(rule('.form')['gap']).toBe('var(--space-6)');
    expect(rule('.form')['max-width']).toBe('var(--layout-max-narrow)');
    // A track sized `auto` grows to its widest item, so a long address would widen the
    // card rather than wrap inside it.
    expect(rule('.form')['grid-template-columns']).toBe('minmax(0, 1fr)');
  });

  it('labels the field at the prototype’s own role, and says a refusal in the severity colour', () => {
    expect(rule('.fieldGroup > label')['font-size']).toBe('var(--text-sm)');
    expect(rule('.fieldGroup > label')['font-weight']).toBe('var(--weight-semibold)');
    expect(rule('.err')['color']).toBe('var(--sev-critical)');
    expect(rule('.err')['font-size']).toBe('var(--text-xs)');
    expect(rule('.hint')['color']).toBe('var(--color-text-muted)');
  });
});

describe('how the site stands', () => {
  it('lays the tag and the figures out in one wrapping row, as the prototype does', () => {
    expect(rule('.sitestate')['display']).toBe('flex');
    expect(rule('.sitestate')['flex-wrap']).toBe('wrap');
    expect(rule('.sitestate')['gap']).toBe('var(--space-3)');
    expect(rule('.sitestate')['margin-top']).toBe('var(--space-4)');
  });

  it('wraps the figures inside the row rather than widening the page at 390px', () => {
    expect(rule('.sitestate > span')['overflow-wrap']).toBe('anywhere');
  });
});

describe('the four methods', () => {
  it('stacks them a step apart under the state line', () => {
    expect(rule('.verify')['display']).toBe('grid');
    expect(rule('.verify')['gap']).toBe('var(--space-3)');
    expect(rule('.verify')['margin-top']).toBe('var(--space-5)');
    expect(rule('.verify')['grid-template-columns']).toBe('minmax(0, 1fr)');
  });

  it('draws each as the prototype’s bordered block on the surface', () => {
    expect(rule('.method')['padding']).toBe('var(--space-5)');
    expect(rule('.method')['border']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.method')['border-radius']).toBe('var(--radius-md)');
    expect(rule('.method')['background']).toBe('var(--color-surface)');
    expect(rule('.method')['gap']).toBe('var(--space-2)');
    // The block must be allowed to be narrower than the line it holds, or the line's own
    // scrollbar never appears and the page widens instead.
    // jsdom prints the computed `0` with its unit; the stylesheet states it without one.
    expect(rule('.method')['min-width']).toBe('0px');
  });

  it('marks the current method with the accent border and the raised surface', () => {
    expect(rule(".method[aria-current='true']")['border-color']).toBe('var(--color-accent-strong)');
    expect(rule(".method[aria-current='true']")['background']).toBe('var(--color-surface-raised)');
  });

  it('sets the heading row and the explanation at the prototype’s roles', () => {
    expect(rule('.method header')['display']).toBe('flex');
    expect(rule('.method header')['gap']).toBe('var(--space-3)');
    expect(rule('.method h2')['font-size']).toBe('var(--text-base)');
    expect(rule('.method p')['color']).toBe('var(--color-text-muted)');
    expect(rule('.method p')['font-size']).toBe('var(--text-sm)');
  });
});

describe('the line to copy', () => {
  it('is the prototype’s sunken monospace block', () => {
    expect(rule('.tokenline')['display']).toBe('block');
    expect(rule('.tokenline')['padding']).toBe('var(--space-3)');
    expect(rule('.tokenline')['background']).toBe('var(--color-surface-sunken)');
    expect(rule('.tokenline')['border-radius']).toBe('var(--radius-sm)');
    expect(rule('.tokenline')['font']).toBe(
      'var(--weight-regular) var(--text-xs) / var(--leading-normal) var(--font-mono)',
    );
  });

  it('scrolls inside its own box rather than widening the page, and is never broken up', () => {
    // A record, a meta tag and a URL are each one unbroken line: broken across lines they
    // are a line that does not work when it is pasted, so the box scrolls instead.
    expect(rule('.tokenline')['white-space']).toBe('pre');
    expect(rule('.tokenline')['overflow-x']).toBe('auto');
  });
});

describe('the check under each method', () => {
  it('is the prototype’s form footer: a rule above it, and a wrapping row', () => {
    expect(rule('.formfoot')['display']).toBe('flex');
    expect(rule('.formfoot')['flex-wrap']).toBe('wrap');
    expect(rule('.formfoot')['gap']).toBe('var(--space-4)');
    expect(rule('.formfoot')['border-top']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.formfoot')['padding-top']).toBe('var(--space-6)');
  });

  it('wraps the platform’s own sentence, which quotes a host back', () => {
    expect(rule('.formfoot > span')['overflow-wrap']).toBe('anywhere');
  });
});

describe('the stylesheet itself', () => {
  it('is what the screen lays itself out with', () => {
    expect(readFileSync(join(screenDir, 'SiteScreen.tsx'), 'utf8')).toContain(
      "from './site.module.css'",
    );
  });

  it('moves one thing and only while a check is running: the tokens’ own pulse', () => {
    const source = readFileSync(stylesheet, 'utf8');
    expect(rule('.running')['animation']).toBe(
      'pv-pulse var(--pulse-duration) var(--ease) infinite',
    );
    // No second animation, no keyframes of its own, and no transition: the pulse is the
    // product's one moving thing, and `docs/design/tokens.css` flattens it to a still frame
    // under `prefers-reduced-motion: reduce`, so this screen is complete without it.
    expect(source.match(/\banimation\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });

  it('restates no visual value: every colour and every length is a token', () => {
    const body = readFileSync(stylesheet, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*/g, '');

    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(/i);
    expect(body).not.toMatch(/\bhsla?\(/i);
    expect(body).not.toMatch(/\d\s*(px|rem|em)\b/i);
  });
});
