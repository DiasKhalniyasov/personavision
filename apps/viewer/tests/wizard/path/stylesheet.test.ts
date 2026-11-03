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
 * The path chooser's own layout, read off the stylesheet.
 *
 * The part of `#screen-newtest-paths`'s contract that is CSS: the two cards sit side by side
 * and stack in a narrow window rather than squashing, the chosen path and the locked one are
 * told apart, and every value is a token's. That no value is restated by hand is
 * `tests/skeleton.test.ts`'s rule over every stylesheet the app ships; what is asserted here
 * is that this screen takes the **right** tokens.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../../src/screens/newtest/wizard/path');
const stylesheet = join(screen, 'path.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the two cards', () => {
  it('sits them side by side, and stacks them in a narrow window', () => {
    expect(rule('.paths')['grid-template-columns']).toBe('1fr 1fr');
    // The prototype's own breakpoint, which is what makes this screen work at 390px.
    expect(rule('.paths', '(max-width: 860px)')['grid-template-columns']).toBe('1fr');
  });

  it('draws a card on the surface, in the large radius and the ordinary border', () => {
    expect(rule('.pathCard')['background']).toBe('var(--color-surface)');
    expect(rule('.pathCard')['border-radius']).toBe('var(--radius-lg)');
    expect(rule('.pathCard')['border']).toBe('var(--border-width) solid var(--color-border)');
  });

  it('marks the path a visit stands on with the accent, and the locked one as sunken', () => {
    expect(rule(".pathCard[aria-current='true']")['border-color']).toBe(
      'var(--color-accent-strong)',
    );
    expect(rule(".pathCard[aria-current='true']")['box-shadow']).toBe('var(--shadow-md)');
    expect(rule('.pathCard[data-locked]')['background']).toBe('var(--color-surface-sunken)');
  });

  it('states the lock in the informational colour, at the small type size', () => {
    expect(rule('.lockbar')['background']).toBe('var(--sev-info-bg)');
    expect(rule('.lockbar')['color']).toBe('var(--sev-info)');
    expect(rule('.lockbar')['font-size']).toBe('var(--text-sm)');
    expect(rule('.lockbar')['border-radius']).toBe('var(--radius-md)');
  });

  it('sets what a path delivers in the muted colour, as a disc list', () => {
    expect(rule('.delivers')['color']).toBe('var(--color-text-muted)');
    expect(rule('.delivers')['font-size']).toBe('var(--text-sm)');
    expect(rule('.delivers')['list-style']).toBe('disc');
  });
});

describe('the tokens stay the only source of visual truth', () => {
  it('is the stylesheet this step lays itself out with', () => {
    expect(readFileSync(join(screen, 'PathStep.tsx'), 'utf8')).toContain(
      "from './path.module.css'",
    );
  });

  it('promises no click on a card that is not one: no pointer, no hover lift', () => {
    // The header explains why; a comment is not a declaration.
    const declarations = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(declarations).not.toMatch(/\bcursor\b/);
    expect(declarations).not.toMatch(/:hover/);
  });

  it('declares no animation of its own, so reduce has nothing to shorten', () => {
    const source = readFileSync(stylesheet, 'utf8');

    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });
});
