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
 * `#screen-sites`'s own layout: the grid of cards, the card, and the lines of figures on it.
 *
 * The prototype draws this grid with the same `.aud-grid` / `.aud-card` / `.aud-facts` rules
 * it draws the audiences with, so what is asserted here is that this screen takes those
 * values — the same gaps, the same type role, the same muted colour — out of
 * `docs/design/tokens.css`, rather than that it shares the audience screen's stylesheet.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screenDir = join(here, '../../src/screens/sites');
const stylesheet = join(screenDir, 'sites.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('the grid of sites', () => {
  it('fills the row with three cards a spacing step apart, as the prototype does', () => {
    expect(rule('.siteGrid')['display']).toBe('grid');
    expect(rule('.siteGrid')['gap']).toBe('var(--space-5)');
    expect(rule('.siteGrid')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('opens a step further down the page than a section alone', () => {
    expect(rule('.sites')['margin-top']).toBe('var(--space-10)');
  });

  it('takes three cards to two, and two to one, at the prototype’s own breakpoints', () => {
    expect(rule('.siteGrid', '(max-width: 1000px)')['grid-template-columns']).toBe(
      'repeat(2, minmax(0, 1fr))',
    );
    // One column at 640px, which is what makes the screen work at 390px: a card is the
    // width of the column, and nothing on it is laid out beside anything else.
    expect(rule('.siteGrid', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });

  it('lays a workspace’s first visit out as one card, not as a grid with gaps in it', () => {
    expect(rule('.firstRun')['grid-template-columns']).toBe('minmax(0, 1fr)');
    expect(rule('.firstRun')['max-width']).toBe('var(--layout-max-narrow)');
  });
});

describe('a card', () => {
  it('stacks its lines from the top, a spacing step apart', () => {
    expect(rule('.siteCard')['display']).toBe('grid');
    expect(rule('.siteCard')['gap']).toBe('var(--space-3)');
    expect(rule('.siteCard')['align-content']).toBe('start');
    expect(rule('.siteCard')['text-align']).toBe('left');
  });

  it('lifts on hover with the product’s own shadow, and never underlines', () => {
    expect(rule('.siteCard:hover')['box-shadow']).toBe('var(--shadow-md)');
    expect(rule('.siteCard:hover')['text-decoration']).toBe('none');
  });

  it('sets the address at the prototype’s card-heading role', () => {
    expect(rule('.siteName')['font-size']).toBe('var(--text-md)');
    expect(rule('.siteName')['font-weight']).toBe('var(--weight-semibold)');
  });

  it('wraps a long address inside its column rather than widening the card', () => {
    // The one thing that would push this screen past 390px: an address is one unbroken
    // word to a line-breaker, and so is a host inside the platform's own check sentence.
    expect(rule('.siteName')['overflow-wrap']).toBe('anywhere');
    expect(rule('.siteFacts')['overflow-wrap']).toBe('anywhere');
  });

  it('marks the site of the latest test with the accent border, as the prototype does', () => {
    expect(rule(".siteCard[aria-current='true']")['border-color']).toBe('var(--color-accent)');
  });

  it('sets the figures small and muted, and the numbers in them at body colour', () => {
    expect(rule('.siteFacts')['font-size']).toBe('var(--text-sm)');
    expect(rule('.siteFacts')['color']).toBe('var(--color-text-muted)');
    expect(rule('.siteFacts')['gap']).toBe('var(--space-1)');
    expect(rule('.siteFacts b')['color']).toBe('var(--color-text)');
    expect(rule('.siteFacts b')['font-weight']).toBe('var(--weight-medium)');
  });

  it('sets the blurb on the add-a-site card a step down, as the prototype does', () => {
    expect(rule('.addBlurb')['font-size']).toBe('var(--text-sm)');
  });
});

describe('the stylesheet itself', () => {
  it('is what the screen lays itself out with', () => {
    for (const file of ['SitesPage.tsx', 'SiteCard.tsx']) {
      expect(readFileSync(join(screenDir, file), 'utf8')).toContain("from './sites.module.css'");
    }
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
    // and so are the comments, which name those widths in prose.
    const body = readFileSync(stylesheet, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]*/g, '');

    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(/i);
    expect(body).not.toMatch(/\bhsla?\(/i);
    expect(body).not.toMatch(/\d\s*(px|rem|em)\b/i);
  });

  it('reaches into no other screen’s stylesheet', () => {
    for (const file of ['SitesPage.tsx', 'SiteCard.tsx']) {
      const source = readFileSync(join(screenDir, file), 'utf8');
      expect(source).not.toContain('audience.module.css');
      expect(source).not.toMatch(/from '@\/screens\/(?!sites)/);
    }
  });
});
