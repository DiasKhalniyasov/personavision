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
 * The Improve screen's own layout, which is the part of its screen contract that is CSS.
 *
 * Two things are asserted here and nowhere else: that **every value is a custom property**
 * from `docs/design/tokens.css` — not a colour, a size or a spacing step written out by
 * hand — and that the screen **animates nothing**, so it is complete and still under
 * `prefers-reduced-motion: reduce` without a query of its own.
 *
 * The before/after is deliberately absent from this file: it is the Verdict's own block and
 * takes `screens/verdict/verdict.css`, which that screen's suite owns, so there is no
 * second copy of `.figures` or `.reasons` here to assert.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screenDir = join(here, '../../src/screens/improve');
const stylesheet = join(screenDir, 'improve.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the lock', () => {
  it('is the informational box of the design tokens, not a colour of its own', () => {
    expect(rule('.lockbar')['background']).toBe('var(--sev-info-bg)');
    expect(rule('.lockbar')['color']).toBe('var(--sev-info)');
    expect(rule('.lockbar')['border-radius']).toBe('var(--radius-md)');
  });

  it('keeps its control in the sentence, a spacing step away', () => {
    expect(rule('.connect')['margin-left']).toBe('var(--space-2)');
  });
});

describe('the pull request box', () => {
  it('is a surface panel with the product border and radius', () => {
    expect(rule('.prbox')['background']).toBe('var(--color-surface)');
    expect(rule('.prbox')['border']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.prbox')['border-radius']).toBe('var(--radius-md)');
  });

  it('sets the diff in the mono family on the sunken surface, and lets it scroll', () => {
    expect(rule('.diff')['background']).toBe('var(--color-surface-sunken)');
    expect(rule('.diff')['font']).toContain('var(--font-mono)');
    expect(rule('.diff')['overflow-x']).toBe('auto');
    expect(rule('.diff')['white-space']).toBe('pre');
  });

  it('colours an added and a removed line by the outcome and severity tokens', () => {
    expect(rule('.add')['color']).toBe('var(--outcome-success)');
    expect(rule('.del')['color']).toBe('var(--sev-critical)');
  });

  it('stacks its rows at the prototype narrow width, so nothing is cut off at 390px', () => {
    expect(rule('.kv', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });
});

describe('the stylesheet itself', () => {
  it('is what the screen lays itself out with', () => {
    for (const file of ['ImprovePage.tsx', 'PullRequestBox.tsx']) {
      expect(readFileSync(join(screenDir, file), 'utf8')).toContain("from './improve.module.css'");
    }
  });

  it("introduces no second stylesheet: the before/after takes the Verdict's own", () => {
    const before = readFileSync(join(screenDir, 'BeforeAfter.tsx'), 'utf8');
    expect(before).toContain("import '@/screens/verdict/verdict.css'");
    expect(before).toContain("from '@/screens/verdict/completionBand'");
  });

  it('animates nothing, so the screen is complete and still under reduced motion', () => {
    const source = readFileSync(stylesheet, 'utf8');
    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });

  it('restates no visual value: every colour and every length is a token', () => {
    // A breakpoint is the one number that cannot be a token — a media query cannot read a
    // custom property — so the queries themselves are taken out before the rest is read,
    // and so are the comments, which name that width in prose.
    const body = readFileSync(stylesheet, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*/g, '');

    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(/i);
    expect(body).not.toMatch(/\bhsla?\(/i);
    expect(body).not.toMatch(/\d\s*(px|rem|em)\b/i);
  });
});
