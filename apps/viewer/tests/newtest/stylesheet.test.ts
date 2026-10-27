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
 * The New test screen's own layout, read off the stylesheet.
 *
 * What it holds is the part of `#screen-newrun`'s contract that is CSS and nothing else: the
 * two paired rows and the people grid stack in a narrow window rather than squashing, and
 * every value is a token's. That no value is restated by hand is `tests/skeleton.test.ts`'s
 * rule, over every stylesheet the app ships; what is asserted here is that this screen takes
 * the *right* tokens.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../src/screens/newtest');
const stylesheet = join(screen, 'newtest.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('a narrow window', () => {
  it('stacks the URL row and the repeats-and-seed row', () => {
    expect(rule('.inline2')['grid-template-columns']).toBe('repeat(2, minmax(0, 1fr))');
    expect(rule('.inline2', '(max-width: 1000px)')['grid-template-columns']).toBe('1fr');
  });

  it('takes the people down a column at a time', () => {
    expect(rule('.personagrid')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(rule('.personagrid', '(max-width: 1000px)')['grid-template-columns']).toBe(
      'repeat(2, minmax(0, 1fr))',
    );
    expect(rule('.personagrid', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });

  it('keeps the form inside the narrow column the prototype sets it in', () => {
    expect(rule('.form')['max-width']).toBe('var(--layout-max-narrow)');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  it('states a refusal in the critical colour, at the small type size', () => {
    expect(rule('.err')['color']).toBe('var(--sev-critical)');
    expect(rule('.err')['font-size']).toBe('var(--text-xs)');
  });

  it('draws a generated person in the medium radius, on the ordinary border', () => {
    expect(rule('.personachip')['border-radius']).toBe('var(--radius-md)');
    expect(rule('.personachip')['border']).toBe('var(--border-width) solid var(--color-border)');
  });

  it('rules the form off from its foot with the ordinary border', () => {
    expect(rule('.formfoot')['border-top']).toBe('var(--border-width) solid var(--color-border)');
  });

  it('is the stylesheet every part of this screen lays itself out with', () => {
    for (const part of ['NewTestForm', 'AudiencePicker', 'TestPeople']) {
      const source = readFileSync(join(screen, `${part}.tsx`), 'utf8');
      expect(source, part).toContain("from './newtest.module.css'");
    }
  });

  it('declares no animation of its own: the three animated moments are other tickets’', () => {
    const source = readFileSync(stylesheet, 'utf8');

    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });
});
