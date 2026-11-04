// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
// Imported for its teardown: the document, and any stylesheet put in it, is reset per test.
import '../../setup';
import { ruleIn, rulesOf } from '../../cssom';
import type { Rule } from '../../cssom';

/**
 * The launch step's own layout, read off the stylesheet.
 *
 * The part of `#screen-newtest-estimate`'s contract that is CSS: three figures side by side
 * that stack rather than squash in a narrow window, the card and the `.formfoot` the
 * prototype draws with inline margins, and a skeleton the size of the figure it is waiting
 * for — which is what makes the layout stand still when the estimate arrives. That no value
 * is restated by hand is `tests/skeleton.test.ts`'s rule over every stylesheet the app
 * ships; what is asserted here is that this screen takes the **right** tokens.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../../src/screens/newtest/wizard/estimate');
const stylesheet = join(screen, 'estimate.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the three figures', () => {
  it('sits them side by side, and stacks them in a narrow window', () => {
    expect(rule('.estimate')['grid-template-columns']).toBe('repeat(3, 1fr)');
    // The prototype's own breakpoint, which is what makes this screen work at 390px.
    expect(rule('.estimate', '(max-width: 860px)')['grid-template-columns']).toBe('1fr');
  });

  it('draws a cell on the surface, in the medium radius and the ordinary border', () => {
    expect(rule('.cell')['background']).toBe('var(--color-surface)');
    expect(rule('.cell')['border-radius']).toBe('var(--radius-md)');
    expect(rule('.cell')['border']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.cell')['padding']).toBe('var(--space-5)');
  });

  it('sets a figure in the display family at the section headline size', () => {
    expect(rule('.figure')['font-family']).toBe('var(--font-display)');
    expect(rule('.figure')['font-size']).toBe('var(--text-xl)');
    expect(rule('.figure')['letter-spacing']).toBe('var(--tracking-tight)');
  });

  it('gives a figure on its way a box the size of the figure it is waiting for', () => {
    // The loading state must not move the layout when it resolves, so the skeleton's height
    // is the type role's own rather than a number somebody picked.
    expect(rule('.figureWaiting')['height']).toBe('calc(var(--text-xl) * var(--leading-normal))');
    expect(rule('.figureWaiting')['margin-top']).toBe(rule('.figure')['margin-top']);
    expect(rule('.lineWaiting')['height']).toBe('calc(var(--text-base) * var(--leading-normal))');
  });
});

describe('the card and the foot', () => {
  it('lays the arithmetic out as the prototype’s key-value list', () => {
    expect(rule('.kv')['grid-template-columns']).toBe('auto 1fr');
    expect(rule('.kv')['gap']).toBe('var(--space-2) var(--space-5)');
    expect(rule('.kv')['font-size']).toBe('var(--text-sm)');
    expect(rule('.kv dt')['color']).toBe('var(--color-text-muted)');
  });

  it('rules the foot off above the launch button', () => {
    expect(rule('.formfoot')['border-top']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.formfoot')['padding-top']).toBe('var(--space-6)');
    expect(rule('.formfoot')['flex-wrap']).toBe('wrap');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  it('is the stylesheet this step lays itself out with', () => {
    expect(readFileSync(join(screen, 'EstimateStep.tsx'), 'utf8')).toContain(
      "from './estimate.module.css'",
    );
  });

  it('declares no animation of its own, so reduce has nothing to shorten', () => {
    const source = readFileSync(stylesheet, 'utf8');

    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });

  it('declares the margins the prototype writes inline, so the step carries no style attribute', () => {
    expect(rule('.estimate')['margin-top']).toBe('var(--space-6)');
    expect(rule('.made')['margin-top']).toBe('var(--space-5)');
    expect(rule('.formfoot')['margin-top']).toBe('var(--space-6)');
  });
});
