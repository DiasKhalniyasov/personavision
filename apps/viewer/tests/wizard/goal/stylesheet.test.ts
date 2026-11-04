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
 * The goal step's own layout, read off the stylesheet.
 *
 * The part of `#screen-newtest-goal`'s contract that is CSS: the form is the narrow column
 * the prototype draws it in, the label sits over its field, the two buttons wrap rather than
 * overflow at 390px, and the one thing that moves is the pulse on a field whose sentence has
 * not arrived. That no value is restated by hand is `tests/skeleton.test.ts`'s rule over
 * every stylesheet the app ships; what is asserted here is that this screen takes the
 * **right** tokens.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../../src/screens/newtest/wizard/goal');
const stylesheet = join(screen, 'goal.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the form', () => {
  it('is the prototype’s narrow column, one field under another', () => {
    expect(rule('.form')['max-width']).toBe('var(--layout-max-narrow)');
    expect(rule('.form')['gap']).toBe('var(--space-6)');
    // One track, floored at zero: a long sentence wraps inside the card rather than
    // widening it, which is what makes this step work at 390px.
    expect(rule('.form')['grid-template-columns']).toBe('minmax(0, 1fr)');
    // The prototype's own `margin-top` on the form, which is a token and not an inline style.
    expect(rule('.form')['margin-top']).toBe('var(--space-6)');
  });

  it('sets the label over its field, at the prototype’s size and weight', () => {
    expect(rule('.fieldGroup')['gap']).toBe('var(--space-2)');
    expect(rule('.fieldGroup > label')['font-size']).toBe('var(--text-sm)');
    expect(rule('.fieldGroup > label')['font-weight']).toBe('var(--weight-semibold)');
  });

  it('wraps the two buttons under a rule rather than overflowing the card', () => {
    expect(rule('.formfoot')['flex-wrap']).toBe('wrap');
    expect(rule('.formfoot')['gap']).toBe('var(--space-4)');
    expect(rule('.formfoot')['border-top']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.formfoot')['padding-top']).toBe('var(--space-6)');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  it('is the stylesheet this step lays itself out with', () => {
    expect(readFileSync(join(screen, 'GoalStep.tsx'), 'utf8')).toContain(
      "from './goal.module.css'",
    );
  });

  it('pulses a pending field with the tokens’ own keyframe, and nothing else moves', () => {
    expect(rule('.pending')['animation']).toBe(
      'pv-pulse var(--pulse-duration) var(--ease) infinite',
    );

    const declarations = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // `pv-pulse` is the tokens' keyframe, which that file flattens under reduce: this
    // stylesheet declares no keyframe, no transition and no second animation of its own.
    expect(declarations).not.toMatch(/@keyframes/);
    expect(declarations).not.toMatch(/\btransition\b/);
    expect([...declarations.matchAll(/\banimation\b/g)]).toHaveLength(1);
  });
});
