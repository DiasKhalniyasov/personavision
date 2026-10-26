/**
 * The DOM test setup for this app. A suite that needs a DOM opens with
 *
 *     // @vitest-environment jsdom
 *     import './setup';
 *
 * as the root Vitest configuration asks, rather than editing that configuration. jsdom and
 * Testing Library are dependencies of this package, so a screen step adds a test and no
 * tooling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

declare global {
  /** React flushes a render synchronously only inside `act`, and only when this is set. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

// Under jsdom the global `URL` is jsdom's, and `fileURLToPath` rejects one of those, so
// this resolves the path from the string form of `import.meta.url` instead.
const tokensPath = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/design/tokens.css');

/**
 * Put the real design tokens in the document, the way the app's entry does. jsdom resolves
 * a custom property through the cascade, so a test reads the committed values rather than
 * values it typed out itself.
 */
export function loadDesignTokens(): void {
  const style = document.createElement('style');
  style.textContent = readFileSync(tokensPath, 'utf8');
  document.head.append(style);
}
