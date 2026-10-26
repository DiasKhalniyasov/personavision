import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './built';
import type { BuiltApp } from './built';

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
  filesUnder(appDir).filter((path) => relative(appDir, path).split(sep)[0] !== 'tests');

/** The app's own stylesheets: where a restated value would hide. */
const appStylesheets = (): string[] =>
  filesUnder(appDir).filter((path) => extname(path) === '.css');

/** The Tailwind theme, which maps Tailwind's names onto the tokens and declares no value. */
const themeMapping = join(appDir, 'src/styles/theme.css');

/** The registry's own primitive files, which carry Tailwind classes and no stylesheet. */
const primitives = (): string[] =>
  filesUnder(join(appDir, 'src/components/ui')).filter((path) => extname(path) === '.tsx');

/** The four custom properties `docs/design/tokens.css` declares the bands with. */
const THRESHOLD = {
  scoreGood: '--score-threshold-good',
  scoreBad: '--score-threshold-bad',
  completionGood: '--completion-threshold-good',
  completionBad: '--completion-threshold-bad',
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

  it('declares none of the thresholds itself, not even partially', () => {
    // A declaration, not a mention: `src/tokens.ts` names all four in order to read them,
    // which is the point. What must not exist is a value assigned to one.
    const declaration = new RegExp(`(?:${Object.values(THRESHOLD).join('|')})\\s*:`);

    const declaring = appSource()
      .filter((path) => declaration.test(read(path)))
      .map((path) => relative(repoRoot, path));

    expect(declaring).toEqual([]);
  });

  it('declares no custom property of its own, so the tokens are the only source', () => {
    // Guards the checks below from passing on an empty list.
    expect(appStylesheets().length).toBeGreaterThan(0);

    for (const stylesheet of appStylesheets()) {
      // The Tailwind theme mapping is the one exception, and a narrow one: inside its
      // `@theme` blocks it may name a Tailwind theme variable, and every value it gives
      // one is a `var(--…)` reference to a token — never a value of its own. That is
      // asserted against a production build in `theme.test.ts`, which also asserts that
      // nothing the app ships declares a token's own name.
      const source =
        stylesheet === themeMapping
          ? read(stylesheet).replace(/@theme[^{]*\{[^}]*\}/g, '')
          : read(stylesheet);
      const declarations = source.match(/^\s*--[\w-]+\s*:/gm) ?? [];
      expect(declarations, relative(repoRoot, stylesheet)).toEqual([]);
    }
  });

  it('restates no colour, size or spacing value in its own CSS', () => {
    // Viewport units and percentages are layout primitives with no token of their own;
    // every colour, and everything else carrying a unit, comes through a custom property.
    //
    // Scope: stylesheets, not `.tsx`. A screen positions a fixation dot or sizes a heatmap
    // cell from computed run data, so an inline style carrying a number is legitimate
    // there and a scan of it would cry wolf. What is forbidden in a component is a *token*
    // value, and the sibling tests above cover the thresholds specifically.
    const restated = [
      /#[0-9a-fA-F]{3,8}\b/,
      /\b(?:rgba?|hsla?|oklch|lab|color-mix)\(/,
      /\d(?:\.\d+)?(?:px|rem|em|pt|ch|ex|cm|mm|in|ms|s|deg)\b/,
    ];

    for (const stylesheet of appStylesheets()) {
      const declarations = read(stylesheet)
        // A file's own header explains the rule; a comment is not a declaration.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // A breakpoint is not a token: a media query cannot read a custom property, which
        // is why `docs/design/prototype.html` states its own three. What the rule is about
        // is a value the tokens own.
        .replace(/@media[^{]*/g, '@media');
      for (const pattern of restated) {
        expect(declarations, `${relative(repoRoot, stylesheet)} ${String(pattern)}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it('restates no colour in the registry’s primitives either', () => {
    // Their lengths are a primitive's own geometry — a focus ring, an arrow's nudge — but
    // a colour is always the theme's, and so always a token's.
    expect(primitives().length).toBeGreaterThan(0);

    for (const primitive of primitives()) {
      const source = read(primitive);
      expect(source, relative(repoRoot, primitive)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, relative(repoRoot, primitive)).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab)\(/);
      // And no duration of its own: the theme maps the transition onto `--duration-base`,
      // which the tokens zero under `prefers-reduced-motion`.
      expect(source, relative(repoRoot, primitive)).not.toMatch(/\bduration-\d/);
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

describe('the shell publishes one file per screen, so screen tickets do not collide', () => {
  it('gives each Verdict section its own file', () => {
    const sections = [
      'AudienceLine',
      'ExcludedBanner',
      'Headline',
      'CompletionFigures',
      'Reasons',
      'HeroEvidence',
      'HeadlineFindings',
      'DetailDoors',
    ];

    for (const section of sections) {
      const file = join(appDir, `src/screens/verdict/${section}.tsx`);
      expect(statSync(file).isFile(), section).toBe(true);
      // The page composes them; a section never reaches into a sibling.
      for (const other of sections.filter((name) => name !== section)) {
        expect(read(file), `${section} imports ${other}`).not.toContain(`./${other}`);
      }
    }
  });

  it('gives each screen of the route table its own file', () => {
    for (const screen of [
      'src/screens/verdict/VerdictPage.tsx',
      'src/screens/breakdown/BreakdownPage.tsx',
      'src/screens/attention/AttentionPage.tsx',
      'src/screens/sessions/SessionsPage.tsx',
      'src/screens/sessions/SessionReplayPage.tsx',
      'src/screens/signin/SignInPage.tsx',
      'src/screens/audience/AudiencesPage.tsx',
      'src/screens/audience/AudienceSetupPage.tsx',
      'src/screens/newtest/NewTestPage.tsx',
      'src/screens/landing/LandingPage.tsx',
      'src/screens/demo/DemoPage.tsx',
      'src/screens/empty/NoTestsScreen.tsx',
      'src/screens/runstatus/RunningScreen.tsx',
      'src/screens/runstatus/RunFailedScreen.tsx',
    ]) {
      expect(statSync(join(appDir, screen)).isFile(), screen).toBe(true);
    }
  });

  it('reads a run in one place, which every screen goes through', () => {
    // No screen fetches or parses a run file itself: `useRun` is the one module that asks
    // the server for anything, and it parses what comes back with the contract's schemas.
    const asking = appSource()
      .filter((path) => /\bfetch\s*\(/.test(read(path).replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((path) => relative(appDir, path));

    expect(asking).toEqual([join('src', 'shell', 'useRun.ts')]);
  });
});

describe('the build output', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildApp();
  }, 180_000);

  it('carries the band thresholds, so nobody can hard-code one', () => {
    // Whitespace-tolerant: the minifier closes the gap after the colon.
    expect(built.css).toMatch(new RegExp(`${THRESHOLD.scoreGood}:\\s*25\\b`));
    expect(built.css).toMatch(new RegExp(`${THRESHOLD.scoreBad}:\\s*60\\b`));
    expect(built.css).toMatch(new RegExp(`${THRESHOLD.completionGood}:\\s*0?\\.6\\b`));
    expect(built.css).toMatch(new RegExp(`${THRESHOLD.completionBad}:\\s*0?\\.3\\b`));
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
      '--moment-ticker-duration',
    ]) {
      expect(built.css, token).toContain(`${token}:`);
    }
  });

  it("carries the tokens' own dark-mode block, and the app adds no palette beside it", () => {
    expect(built.css).toContain('prefers-color-scheme');
    // The minifier may drop the quotes around the attribute value.
    expect(built.css).toMatch(/\[data-theme=["']?dark["']?\]/);
  });

  it('leaves the boot failure wording on the page, so a failed boot is never blank', () => {
    expect(built.html).toContain('The app did not start.');
    expect(built.html).toContain('needs JavaScript to run');
  });

  it('fetches no font, script or stylesheet from a network', () => {
    const remote = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

    const references = [...built.html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => remote.test(reference))).toEqual([]);

    expect(built.css).not.toContain('@import');
    // A bundled or inlined asset is not a network fetch; only a remote one is.
    const urls = [...built.css.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((match) => match[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => remote.test(url))).toEqual([]);
  });
});
