import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // The design contract and the run directories are inputs, not source.
      'docs/**',
      'runs/**',
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
