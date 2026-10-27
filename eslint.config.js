import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // The design contract and the run directories are inputs, not source.
      'docs/**',
      'runs/**',
      // Run data the suites read, written by `pnpm seed:example-run`: data, not source.
      'tests/fixtures/runs/**',
      // Whatever a developer's `PERSONAVISION_CALIBRATION_CACHE` or a scratch script left
      // here. `.gitignore` already says this is not the repository's; neither is it source.
      '.cache/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      sourceType: 'module',
    },
  },
);
