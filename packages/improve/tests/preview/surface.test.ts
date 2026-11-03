import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as improve from '../../src/index.js';

/**
 * The test that proves this product *cannot* run a customer's build.
 *
 * The owner answered the preview question on 2026-11-03: previews come from the
 * repository's own deployment, and **we never run a customer's build** — their build
 * script, their dependencies and their secrets stay on their own infrastructure
 * (`docs/adr/0003-previews-come-from-the-repository-s-own-deployment.md`, #232). That is a
 * security boundary, so it is asserted here rather than described: there is no build
 * runner, no container, no shell and no package that could become one, and a later session
 * that adds one fails this file and has to write a new ADR rather than a flag.
 */

const SOURCE_DIRECTORY = fileURLToPath(new URL('../../src/', import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL('../../package.json', import.meta.url));

const sources = (
  directory = SOURCE_DIRECTORY,
): readonly { readonly name: string; readonly text: string }[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = `${directory}${entry}`;
    if (statSync(path).isDirectory()) return sources(`${path}/`);
    return entry.endsWith('.ts')
      ? [{ name: path.slice(SOURCE_DIRECTORY.length), text: readFileSync(path, 'utf8') }]
      : [];
  });

/** What no line of this package may be: a way to execute something of the customer's. */
const NO_RUNNER: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'a child process', pattern: /\bchild_process\b/ },
  { what: 'a spawn', pattern: /\bspawn(Sync)?\s*\(/ },
  { what: 'an exec', pattern: /\bexec(Sync|File|FileSync)?\s*\(/ },
  { what: 'a shell', pattern: /\/bin\/(sh|bash)|\b(ba)?sh\s+-c\b/ },
  { what: 'a container', pattern: /docker|podman|buildpack/i },
  { what: 'a package manager', pattern: /\b(npm|pnpm|yarn)\s+(install|ci|run)\b|\bnpx\b/ },
  {
    what: 'a virtual machine or a worker',
    pattern: /\bnode:vm\b|\bworker_threads\b|\bnode:cluster\b/,
  },
];

/** Exactly what this package depends on. A container client could not be added quietly. */
const DEPENDENCIES = [
  '@personavision/contract',
  '@personavision/provider',
  '@personavision/scoring',
];

describe('nothing in this package runs a customer’s build (ADR 0003)', () => {
  it('has no source line that could start one', () => {
    for (const { name, text } of sources()) {
      for (const { what, pattern } of NO_RUNNER) {
        expect(pattern.test(text), `${name} names ${what}`).toBe(false);
      }
    }
  });

  it('would fail if one were added, which is what makes the list above worth reading', () => {
    const added = [
      "import { spawn } from 'node:child_process';",
      'execSync(`npm install && npm run build`);',
      'await runInDocker({ image: customerImage });',
      "await sh('-c', '/bin/sh ./build.sh');",
      "new Worker(new URL('./build.js', import.meta.url).href); // worker_threads",
    ];

    for (const line of added) {
      expect(
        NO_RUNNER.some(({ pattern }) => pattern.test(line)),
        line,
      ).toBe(true);
    }
  });

  it('depends on three workspace packages and nothing that could host a build', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8')) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };

    expect(Object.keys(manifest.dependencies).sort()).toEqual(DEPENDENCIES);
  });

  it('exports no name that is about building, running or containing anything', () => {
    expect(
      Object.keys(improve).filter((name) =>
        /build|container|shell|spawn|exec|docker|runner/i.test(name),
      ),
    ).toEqual([]);
  });

  it('exports the preview resolution the step reads, so the one way is the only way', () => {
    expect(improve.resolvePreview).toBeTypeOf('function');
    expect(improve.previewRecordOf).toBeTypeOf('function');
    expect(improve.createFetchProbe).toBeTypeOf('function');
    expect(improve.DEFAULT_PREVIEW_WAIT_MS).toBeGreaterThan(0);
  });
});
