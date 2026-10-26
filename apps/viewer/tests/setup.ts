/**
 * The DOM test setup for this app. A suite that needs a DOM opens with
 *
 *     // @vitest-environment jsdom
 *     import './setup';
 *
 * as the root Vitest configuration asks, rather than editing that configuration. jsdom and
 * Testing Library are dependencies of this package, so a screen step adds a test and no
 * tooling.
 *
 * Importing it registers the teardown below, so no suite has to write its own reset and a
 * test cannot inherit another's stylesheet, inline override or leftover DOM.
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

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('style');
});

// Under the jsdom environment `fileURLToPath(new URL(…, import.meta.url))` throws
// "The URL must be of scheme file", so the path comes from the string form instead.
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
