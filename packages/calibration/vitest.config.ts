import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The tickets of step #11 each add a file under `test/`, so a later ticket adds a
    // test rather than editing this configuration.
    include: ['test/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
