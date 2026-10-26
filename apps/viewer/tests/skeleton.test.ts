import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const read = (path: string): string => readFileSync(path, 'utf8');

/** Every file under `directory`, recursively, skipping installed and built output. */
const SKIPPED = new Set(['node_modules', 'dist']);

const filesUnder = (directory: string): string[] =>
  readdirSync(directory)
    .filter((entry) => !SKIPPED.has(entry))
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });

/** The app's own source — everything it ships, tests aside. */
const appSource = (): string[] =>
  filesUnder(appDir).filter((path) => !relative(appDir, path).startsWith('tests'));

/** The app's own stylesheets: where a restated value would hide. */
const appStylesheets = (): string[] =>
  filesUnder(appDir).filter((path) => extname(path) === '.css');

/** The two custom properties `docs/design/tokens.css` declares the score bands with. */
const THRESHOLD = {
  good: '--score-threshold-good',
  bad: '--score-threshold-bad',
} as const;

describe('the app imports the design tokens and never copies them', () => {
  it('imports docs/design/tokens.css straight out of the repository', () => {
    expect(read(join(appDir, 'src/main.tsx'))).toContain(
      "import '../../../docs/design/tokens.css'",
    );
  });

  it('holds no copy of the tokens file', () => {
    const tokens = read(join(repoRoot, 'docs/design/tokens.css')).trim();

    const copies = filesUnder(appDir)
      .filter((path) => read(path).includes(tokens))
      .map((path) => relative(repoRoot, path));

    expect(copies).toEqual([]);
  });

  it('declares neither threshold itself, not even partially', () => {
    // A declaration, not a mention: `src/tokens.ts` names both properties in order to read
    // them, which is the point. What must not exist is a value assigned to one.
    const declaration = new RegExp(`(?:${THRESHOLD.good}|${THRESHOLD.bad})\\s*:`);

    const declaring = appSource()
      .filter((path) => declaration.test(read(path)))
      .map((path) => relative(repoRoot, path));

    expect(declaring).toEqual([]);
  });

  it('declares no custom property of its own, so the tokens are the only source', () => {
    for (const stylesheet of appStylesheets()) {
      const declarations = read(stylesheet).match(/^\s*--[\w-]+\s*:/gm) ?? [];
      expect(declarations, relative(repoRoot, stylesheet)).toEqual([]);
    }
  });

  it('restates no colour, size or spacing value in its own CSS', () => {
    // Viewport units and percentages are layout primitives with no token of their own;
    // every colour, and everything else carrying a unit, comes through a custom property.
    const restated = [
      /#[0-9a-fA-F]{3,8}\b/,
      /\b(?:rgba?|hsla?|oklch|lab|color-mix)\(/,
      /\d(?:\.\d+)?(?:px|rem|em|pt|ch|ex|cm|mm|in)\b/,
    ];

    for (const stylesheet of appStylesheets()) {
      // A file's own header explains the rule; a comment is not a declaration.
      const declarations = read(stylesheet).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of restated) {
        expect(declarations, `${relative(repoRoot, stylesheet)} ${String(pattern)}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it('defines no second palette: dark mode is the tokens file alone', () => {
    for (const stylesheet of appStylesheets()) {
      const source = read(stylesheet);
      expect(source, relative(repoRoot, stylesheet)).not.toContain('prefers-color-scheme');
      expect(source, relative(repoRoot, stylesheet)).not.toContain('[data-theme');
    }
  });
});

describe('the skeleton owns the document shell and nothing else', () => {
  it("stubs none of the prototype's screens, so no later step has to unpick one", () => {
    const owned = ['tabbar', 'screen-empty', 'screen-newrun', 'screen-running', 'screen-error']
      .concat(['screen-comparison', 'screen-attention', 'screen-sessions', 'screen-replay'])
      .flatMap((id) =>
        appSource()
          .filter((path) => read(path).includes(id))
          .map((path) => `${relative(repoRoot, path)}: ${id}`),
      );

    expect(owned).toEqual([]);
  });
});

describe('the build output', () => {
  let outDir: string;
  let html: string;
  let css: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'personavision-viewer-'));

    await build({
      root: appDir,
      configFile: join(appDir, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });

    const assets = filesUnder(outDir).map((path) => ({
      extension: extname(path),
      source: read(path),
    }));
    const joined = (extension: string): string =>
      assets
        .filter((asset) => asset.extension === extension)
        .map((asset) => asset.source)
        .join('\n');

    html = joined('.html');
    css = joined('.css');
  }, 180_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('carries the score-band thresholds, so nobody can hard-code one', () => {
    // Whitespace-tolerant: the minifier closes the gap after the colon.
    expect(css).toMatch(new RegExp(`${THRESHOLD.good}:\\s*25\\b`));
    expect(css).toMatch(new RegExp(`${THRESHOLD.bad}:\\s*60\\b`));
  });

  it('carries the rest of the design tokens, group by group', () => {
    for (const token of [
      '--font-sans',
      '--text-score',
      '--space-4',
      '--radius-lg',
      '--duration-base',
      '--layout-max',
      '--color-canvas',
      '--color-accent',
      '--sev-critical',
      '--outcome-success',
      '--attr-product',
      '--score-good',
      '--variant-a',
      '--gaze-fixation',
      '--heat-5',
    ]) {
      expect(css, token).toContain(`${token}:`);
    }
  });

  it("carries the tokens' own dark-mode block, and the app adds no palette beside it", () => {
    expect(css).toContain('prefers-color-scheme');
    // The minifier may drop the quotes around the attribute value.
    expect(css).toMatch(/\[data-theme=["']?dark["']?\]/);
  });

  it('leaves the boot failure wording on the page, so a failed boot is never blank', () => {
    expect(html).toContain('The app did not start.');
    expect(html).toContain('needs JavaScript to run');
  });

  it('fetches no font, script or stylesheet from a network', () => {
    const remote = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

    const references = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => remote.test(reference))).toEqual([]);

    expect(css).not.toContain('@import');
    expect([...css.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((match) => match[1] ?? '')).toEqual([]);
  });
});
