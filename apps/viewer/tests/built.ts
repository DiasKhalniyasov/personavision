/**
 * A production build of this app, for the tests that can only be answered by one: what the
 * browser finally gets.
 *
 * It is the real `vite build` with the app's own configuration, in production mode, so what
 * a test reads is the stylesheet, the document and the script a reader is served —
 * Tailwind's generated theme layer, the imported design tokens and the self-hosted fonts
 * included.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appDir = fileURLToPath(new URL('..', import.meta.url));

export interface BuiltApp {
  /** Every built stylesheet, joined. */
  css: string;
  /** Every built document, joined. */
  html: string;
  /** Every built script, joined. */
  js: string;
  /** The names of the files the build wrote, relative to the output directory. */
  files: string[];
}

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/** Build the app once and read the result. The caller is one test file, so once is enough. */
export async function buildApp(): Promise<BuiltApp> {
  const outDir = mkdtempSync(join(tmpdir(), 'personavision-viewer-'));
  // What a reader is served. Vitest runs with `NODE_ENV=test`, and Vite decides from that
  // — not from `mode` — whether a build is a production one: without this it would resolve
  // every workspace package through its `development` condition, bundle the development
  // React and tree-shake less, so the three things these tests are here to check would all
  // be answered about a build nobody is served.
  const environment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({
      root: appDir,
      configFile: join(appDir, 'vite.config.ts'),
      mode: 'production',
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });

    const assets = filesUnder(outDir).map((path) => ({
      name: path.slice(outDir.length + 1),
      extension: extname(path),
      read: () => readFileSync(path, 'utf8'),
    }));
    const joined = (extension: string): string =>
      assets
        .filter((asset) => asset.extension === extension)
        .map((asset) => asset.read())
        .join('\n');

    return {
      css: joined('.css'),
      html: joined('.html'),
      js: joined('.js'),
      files: assets.map((asset) => asset.name),
    };
  } finally {
    process.env.NODE_ENV = environment;
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * The declarations a stylesheet gives one class, by property, later rules winning.
 *
 * Tailwind escapes the punctuation of a class name in its selector, so the pattern below
 * accepts a backslash before any character that is not a letter, a digit, a dash or an
 * underscore.
 */
export function declarationsFor(css: string, className: string): Record<string, string> {
  const escaped = [...className]
    .map((character) =>
      /[a-zA-Z0-9_-]/.test(character)
        ? character
        : `\\\\?${character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`,
    )
    .join('');
  // The class, as a whole token: what follows it is a combinator, a pseudo, another class,
  // a comma or the start of the block.
  const rules = new RegExp(`(^|[},])([^{}]*\\.${escaped}(?![\\w-])[^{}]*)\\{([^{}]*)\\}`, 'g');

  const declarations: Record<string, string> = {};
  for (const [, , , body] of css.matchAll(rules)) {
    for (const declaration of (body ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return declarations;
}

/** How many times a stylesheet declares a custom property. */
export const declarationCount = (css: string, property: string): number =>
  css.split(new RegExp(`${property}\\s*:`)).length - 1;
