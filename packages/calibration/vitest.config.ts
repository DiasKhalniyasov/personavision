import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The tickets of step #11 each add a file under `test/`, so a later ticket adds a test
    // rather than editing this configuration. `src/` is included as well, and with the same
    // globs the repository root uses, so a test cannot be run by one command and silently
    // skipped by the other.
    include: ['{src,test}/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
