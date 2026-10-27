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
import { afterEach, beforeEach } from 'vitest';

declare global {
  /** React flushes a render synchronously only inside `act`, and only when this is set. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

/**
 * jsdom implements no `ResizeObserver`, and the shadcn primitives that measure themselves —
 * the slider's thumb among them — construct one as they mount. A screen built out of the
 * registry's own controls would otherwise be untestable, so the stub lives here with the
 * rest of the DOM setup rather than in each suite.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/**
 * jsdom implements no `matchMedia` either, and the shell asks it who has asked for reduced
 * motion wherever a moment of `docs/FLOW.md` section 10 mounts (`src/shell/motion.tsx`,
 * #125). The stub matches nothing, which is a reader who has set no preference; a suite that
 * is *about* the preference stubs the global for itself, as `tests/motion.test.tsx` does.
 */
const matchesNothing = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;

// Per test, not once per file: a suite that stubs the global for itself has its stub taken
// away again by `vi.unstubAllGlobals()` (`forgetRuns`), and the next test in that file would
// otherwise mount a screen over nothing.
beforeEach(() => {
  if (typeof window.matchMedia !== 'function') window.matchMedia = matchesNothing;
});

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
