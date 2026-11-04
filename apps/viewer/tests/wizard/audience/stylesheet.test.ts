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
 * The audience-and-feature step's own layout, read off the stylesheet.
 *
 * The part of `#screen-newtest-feature`'s contract that is CSS: the form is one column in
 * the narrow measure, the six fields of what we read sit three across and stack in a narrow
 * window rather than squashing, and the only thing that moves is the heading while a
 * sentence is being read. That no value is restated by hand is `tests/skeleton.test.ts`'s
 * rule over every stylesheet the app ships; what is asserted here is that this screen takes
 * the **right** tokens.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../../src/screens/newtest/wizard/audience');
const stylesheet = join(screen, 'audience.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the form', () => {
  it('is one column in the narrow measure, at the prototype’s own gap', () => {
    expect(rule('.form')['grid-template-columns']).toBe('minmax(0, 1fr)');
    expect(rule('.form')['max-width']).toBe('var(--layout-max-narrow)');
    expect(rule('.form')['gap']).toBe('var(--space-6)');
    // The prototype sets this card's own distance from the page head inline; here it is a
    // rule, which is why the component writes no `style` attribute at all.
    expect(rule('.form')['margin-top']).toBe('var(--space-6)');
  });

  it('stacks a field’s label, control and refusal, and never lets one widen the card', () => {
    expect(rule('.fieldGroup')['display']).toBe('grid');
    expect(rule('.fieldGroup')['gap']).toBe('var(--space-2)');
    expect(rule('.fieldGroup')['min-inline-size']).toBe('0px');
  });

  it('sets the pair of controls under the sentence on one wrapping row', () => {
    expect(rule('.formfoot')['display']).toBe('flex');
    expect(rule('.formfoot')['flex-wrap']).toBe('wrap');
    expect(rule('.formfoot')['gap']).toBe('var(--space-4)');
  });

  it('states a refusal in the critical colour, at the small type size', () => {
    expect(rule('.err')['color']).toBe('var(--sev-critical)');
    expect(rule('.err')['font-size']).toBe('var(--text-xs)');
  });
});

describe('what we read from that sentence', () => {
  it('sits the six fields three across, and stacks them in a narrow window', () => {
    expect(rule('.segbar')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    // The prototype's own `.segbar` breakpoint, which is what makes this card work at 390px.
    expect(rule('.segbar', '(max-width: 640px)')['grid-template-columns']).toBe('minmax(0, 1fr)');
  });

  it('takes the prototype’s own spacing above the bar and the footnote under it', () => {
    expect(rule('.segbar')['margin-top']).toBe('var(--space-4)');
    expect(rule('.segbar')['gap']).toBe('var(--space-4)');
    expect(rule('.segbar + :global(.footnote)')['margin-top']).toBe('var(--space-4)');
  });

  it('sets the audience’s name at the prototype’s type role', () => {
    expect(rule('.audienceName')['font-size']).toBe('var(--text-md)');
    expect(rule('.audienceName')['margin-top']).toBe('var(--space-2)');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  it('is the stylesheet this step lays itself out with', () => {
    expect(readFileSync(join(screen, 'AudienceStep.tsx'), 'utf8')).toContain(
      "from './audience.module.css'",
    );
  });

  it('moves one thing and only while a sentence is being read, in the tokens’ own pulse', () => {
    const declarations = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(rule('.reading')['animation']).toBe(
      'pv-pulse var(--pulse-duration) var(--ease) infinite',
    );
    // One animation on the sheet, no keyframes of its own — `pv-pulse` is the tokens', and
    // `prefers-reduced-motion: reduce` flattens it there — and nothing transitions.
    expect(declarations.match(/\banimation\b/g)).toHaveLength(1);
    expect(declarations).not.toMatch(/@keyframes/);
    expect(declarations).not.toMatch(/\btransition\b/);
  });

  it('restates no colour and no length of its own', () => {
    const declarations = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(declarations).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab)\(/);
    // The breakpoint is the one number here, and a media query cannot read a token.
    expect(declarations.match(/\d+px/g)).toEqual(['640px']);
  });
});
