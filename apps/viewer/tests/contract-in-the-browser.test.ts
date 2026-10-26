import { describe, expect, it } from 'vitest';
import { buildApp } from './built';

/**
 * The run artifact's field names reach the browser; its reader does not.
 *
 * `apps/viewer` imports `@personavision/contract` for the schemas, and that package also
 * holds the run-directory reader, which is built on `node:fs`. The reader is annotated so
 * that a bundler can drop it, and this is what holds that annotation in place: a build
 * that pulled `node:fs` into the browser would be served a module that throws on use, and
 * the app would fail to start rather than fail a test.
 */
describe('the browser bundle', () => {
  it('carries the contract’s schemas without its node-only reader', async () => {
    const built = await buildApp();
    const js = built.files.filter((file) => file.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);

    for (const module of ['node:fs', 'node:path', 'vite-browser-external']) {
      expect(built.js, module).not.toContain(module);
    }
    // The schemas themselves are there: the viewer parses a run with them.
    expect(built.js).toContain('schemaVersion');
  }, 180_000);
});
