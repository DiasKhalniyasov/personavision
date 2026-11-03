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
 * `/settings/github`'s own layout. The screen is a plain `.wrap-narrow` page in the frame
 * `apps/viewer/src/styles/base.css` already publishes, so the only thing here is the list of
 * what the app would be allowed to do — and it takes the same tokens the rest of the product
 * sets a list in.
 */

const here = dirname(fileURLToPath(import.meta.url));
const screen = join(here, '../../src/screens/settings');
const stylesheet = join(screen, 'settings.module.css');

let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

beforeEach(() => {
  const rules: Rule[] = rulesOf(readFileSync(stylesheet, 'utf8'));
  rule = ruleIn(rules);
});

describe('what the app would be allowed to do', () => {
  it('is a disc list in the muted colour, at the small type size', () => {
    expect(rule('.allowed')['color']).toBe('var(--color-text-muted)');
    expect(rule('.allowed')['font-size']).toBe('var(--text-sm)');
    expect(rule('.allowed')['list-style']).toBe('disc');
  });

  it('brings the line that matters back up to body colour', () => {
    expect(rule('.allowed b')['color']).toBe('var(--color-text)');
  });

  it('is the stylesheet the screen lays itself out with, and animates nothing', () => {
    expect(readFileSync(join(screen, 'GithubPage.tsx'), 'utf8')).toContain(
      "from './settings.module.css'",
    );
    const source = readFileSync(stylesheet, 'utf8');
    expect(source).not.toMatch(/\banimation\b/);
    expect(source).not.toMatch(/@keyframes/);
    expect(source).not.toMatch(/\btransition\b/);
  });
});
