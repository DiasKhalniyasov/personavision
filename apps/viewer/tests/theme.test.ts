import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { Badge } from '../src/components/ui/badge';
import { Button } from '../src/components/ui/button';
import { buildApp, declarationCount, declarationsFor } from './built';
import type { BuiltApp } from './built';

/**
 * The visual direction, asserted against a production build rather than by eye.
 *
 * `docs/FLOW.md` section 10 fixes four fingerprints — the lime primary button with dark fir
 * text, fully rounded buttons, 20px cards, mono overline labels — and one rule that
 * outlives every value: the tokens file is the only source of visual truth, so the app
 * declares no custom property of its own and the Tailwind theme only references the tokens.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const appDir = fileURLToPath(new URL('..', import.meta.url));

const read = (path: string): string => readFileSync(path, 'utf8');

/** The classes a rendered primitive carries. */
const classesOf = (markup: string): string[] =>
  (/class="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/).filter((name) => name !== '');

/** The one declaration of `property` among a primitive's classes. */
const resolved = (built: BuiltApp, markup: string, property: string): string | undefined => {
  for (const className of classesOf(markup)) {
    const value = declarationsFor(built.css, className)[property];
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * A utility themed from a name the tokens already declare reads the token where it is
 * used — `var(--radius-xl,var(--radius-xl))` — so that dark mode and a token edit both
 * reach it. What matters is the token it names.
 */
const expectToken = (value: string | undefined, token: string): void => {
  expect(value, token).toBeDefined();
  expect(value as string, token).toContain(`var(${token}`);
};

let built: BuiltApp;

beforeAll(async () => {
  built = await buildApp();
}, 180_000);

describe('the shadcn primitives are themed from the tokens', () => {
  it('renders the primary button in the lime accent with dark fir text', () => {
    const markup = renderToStaticMarkup(Button({ children: 'New test' }));

    expect(resolved(built, markup, 'background-color')).toBe('var(--color-accent)');
    expect(resolved(built, markup, 'color')).toBe('var(--color-on-accent)');
  });

  it('renders every button fully rounded', () => {
    for (const markup of [
      renderToStaticMarkup(Button({ children: 'New test' })),
      renderToStaticMarkup(Button({ children: 'Open', size: 'lg' })),
      renderToStaticMarkup(Badge({ children: 'Simulated' })),
    ]) {
      expectToken(resolved(built, markup, 'border-radius'), '--radius-full');
    }
  });

  it('draws a focus ring at the width the direction names', () => {
    const markup = renderToStaticMarkup(Button({ children: 'New test' }));

    expect(classesOf(markup)).toContain('focus-visible:ring-[length:var(--border-width-strong)]');
  });

  it('gives a card the 20px radius and an overline label the mono family', () => {
    expect(declarationsFor(built.css, 'card')['border-radius']).toBe('var(--radius-xl)');
    expect(declarationsFor(built.css, 'microlabel')['font-family']).toBe('var(--font-mono)');
    // And the utility a screen would reach for resolves to the same token.
    expectToken(declarationsFor(built.css, 'font-mono')['font-family'], '--font-mono');
    expectToken(declarationsFor(built.css, 'rounded-xl')['border-radius'], '--radius-xl');
  });

  it('maps the primary colour, the radius scale and the type scale onto the tokens', () => {
    const utility = (className: string, property: string) =>
      declarationsFor(built.css, className)[property];

    // A role the tokens do not use is inlined; a name they declare is referenced.
    expect(utility('bg-primary', 'background-color')).toBe('var(--color-accent)');
    expect(utility('text-primary-foreground', 'color')).toBe('var(--color-on-accent)');
    expect(utility('bg-muted', 'background-color')).toBe('var(--color-surface-sunken)');
    expectToken(utility('rounded-md', 'border-radius'), '--radius-md');
    expectToken(utility('text-sm', 'font-size'), '--text-sm');
    expectToken(utility('font-display', 'font-family'), '--font-display');
    expectToken(utility('border-border', 'border-color'), '--color-border');
  });
});

describe('the tokens file stays the only source of visual truth', () => {
  it('declares every token exactly as often as docs/design/tokens.css does, and no more', () => {
    const tokens = read(join(repoRoot, 'docs/design/tokens.css'));

    for (const property of [
      '--color-accent',
      '--color-on-accent',
      '--color-canvas',
      '--color-text',
      '--color-border',
      '--font-sans',
      '--font-display',
      '--font-mono',
      '--text-sm',
      '--text-lg',
      '--text-xl',
      '--radius-md',
      '--radius-xl',
      '--shadow-sm',
      '--leading-snug',
      '--tracking-tighter',
      '--duration-base',
      '--ease',
      '--score-threshold-good',
      '--completion-threshold-good',
    ]) {
      expect(declarationCount(built.css, property), property).toBe(
        declarationCount(tokens, property),
      );
    }
  });

  it('ships no palette of Tailwind’s own beside it', () => {
    // The theme clears Tailwind's namespaces, so none of its default values reaches the
    // document: a screen that wants a colour has to name a token.
    for (const property of ['--color-red-500', '--color-gray-200', '--color-slate-900']) {
      expect(declarationCount(built.css, property), property).toBe(0);
    }
  });

  it('restates no value in the Tailwind theme mapping: every one of them is a var(--…)', () => {
    const mapping = read(join(appDir, 'src/styles/theme.css')).replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [...mapping.matchAll(/@theme[^{]*\{([^}]*)\}/g)].map((match) => match[1] ?? '');
    expect(blocks.length).toBeGreaterThan(0);

    const declarations = blocks
      .flatMap((block) => block.split(';'))
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.startsWith('--'));
    expect(declarations.length).toBeGreaterThan(0);

    for (const declaration of declarations) {
      const value = declaration.slice(declaration.indexOf(':') + 1).trim();
      // `initial` clears a namespace of Tailwind's; everything else references a token.
      expect(value === 'initial' || value.includes('var(--'), declaration).toBe(true);
      expect(declaration).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(declaration).not.toMatch(/\d(?:\.\d+)?(?:px|rem|em|pt|ch|ex|deg)\b/);
    }
  });
});

describe('the fonts are in the bundle', () => {
  it('fetches none of the four families from a third-party host', () => {
    for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      expect(built.css, host).not.toContain(host);
      expect(built.html, host).not.toContain(host);
    }
  });

  it('self-hosts all four, in the weights the direction names', () => {
    const faces = [...built.css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
      (match) => match[1] ?? '',
    );
    expect(faces.length).toBeGreaterThan(0);

    const families = new Set(
      faces.flatMap((face) => /font-family:\s*([^;]+)/.exec(face)?.[1]?.trim() ?? []),
    );
    expect([...families].map((family) => family.replaceAll(/["']/g, '')).sort()).toEqual([
      'Bricolage Grotesque',
      'Instrument Serif',
      'Roboto Mono',
      'Schibsted Grotesk',
    ]);

    const weightsOf = (family: string) =>
      new Set(
        faces
          .filter((face) => face.includes(family))
          .flatMap((face) => /font-weight:\s*([^;]+)/.exec(face)?.[1]?.trim() ?? []),
      );
    expect([...weightsOf('Bricolage Grotesque')].sort()).toEqual(['400', '600', '800']);
    expect([...weightsOf('Schibsted Grotesk')].sort()).toEqual(['400', '500', '700']);
    expect([...weightsOf('Roboto Mono')].sort()).toEqual(['400', '500']);
    expect([...weightsOf('Instrument Serif')].sort()).toEqual(['400']);

    // Every face is served from the bundle itself.
    const sources = faces.flatMap((face) =>
      [...face.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1] ?? ''),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source, source).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    }
    expect(built.files.some((file) => file.endsWith('.woff2'))).toBe(true);
  });
});
