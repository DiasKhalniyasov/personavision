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
 * `#screen-site`'s own layout: the URL field, the footer that carries *Remove this site*,
 * and the row of figures the site is bound by.
 *
 * The prototype draws these with its shared `Forms` block; what is asserted here is that this
 * screen takes the same values — the same gaps, the same type roles, the same muted colour —
 * out of `docs/design/tokens.css`, rather than that it shares another screen's stylesheet.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screenDir = join(here, '../../src/screens/site');
const stylesheet = join(screenDir, 'site.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the site’s address, which heads the page', () => {
  it('wraps the heading and the breadcrumb inside the page rather than widening it', () => {
    // A URL is one unbroken word to a line-breaker. Measured in a real browser: without
    // these the site's page scrolls sideways by 76px at 390px wide.
    expect(rule(['.heading', '.crumb'])['overflow-wrap']).toBe('anywhere');
  });
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

describe('what binds the site', () => {
  it('lays the figures out in one wrapping row, as the prototype does', () => {
    expect(rule('.sitestate')['display']).toBe('flex');
    expect(rule('.sitestate')['flex-wrap']).toBe('wrap');
    expect(rule('.sitestate')['gap']).toBe('var(--space-3)');
    expect(rule('.sitestate')['margin-top']).toBe('var(--space-4)');
  });

  it('wraps the figures inside the row rather than widening the page at 390px', () => {
    expect(rule('.sitestate > span')['overflow-wrap']).toBe('anywhere');
  });
});

describe('adding it, and removing it', () => {
  it('is the prototype’s form footer: a rule above it, and a wrapping row', () => {
    expect(rule('.formfoot')['display']).toBe('flex');
    expect(rule('.formfoot')['flex-wrap']).toBe('wrap');
    expect(rule('.formfoot')['gap']).toBe('var(--space-4)');
    expect(rule('.formfoot')['border-top']).toBe('var(--border-width) solid var(--color-border)');
    expect(rule('.formfoot')['padding-top']).toBe('var(--space-6)');
  });
});

describe('the stylesheet itself', () => {
  it('is what the screen lays itself out with', () => {
    expect(readFileSync(join(screenDir, 'SiteScreen.tsx'), 'utf8')).toContain(
      "from './site.module.css'",
    );
  });

  it('moves nothing at all: the screen contract gives it no animation of its own', () => {
    // The declarations, not the prose about them: the comment at the top of the file says
    // this screen declares no animation, and the scan is of what it declares.
    const body = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Nothing to flatten under `prefers-reduced-motion: reduce`, which is why this screen is
    // complete and still there without a rule about it.
    expect(body).not.toMatch(/\banimation\b/);
    expect(body).not.toMatch(/@keyframes/);
    expect(body).not.toMatch(/\btransition\b/);
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
