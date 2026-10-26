import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boot } from './boot';
import { assertTokensLoaded } from './tokens';

/**
 * The words a boot failure leaves on screen, so that the page is never blank.
 *
 * The same wrapper appears in `index.html`, which has to say something with no JavaScript
 * at all, and in `boot.tsx`, which says it through React. Three runtimes, so the markup is
 * stated three times on purpose; `app.css` holds the one copy of the styling.
 */
function bootFailure(reason: string): HTMLElement {
  const main = document.createElement('main');
  main.className = 'boot';

  const name = document.createElement('h1');
  name.className = 'boot-name';
  name.textContent = 'PersonaVision';

  const line = document.createElement('p');
  line.className = 'boot-line';
  line.textContent = `The app could not start: ${reason}`;

  main.append(name, line);
  return main;
}

/**
 * Mount the app into `container`, replacing the boot fallback that `index.html` holds.
 *
 * The tokens are checked first: they resolve only if `docs/design/tokens.css` reached the
 * page, which is what tells a missing stylesheet apart from an app that merely looks
 * plain. Anything that goes wrong before the root exists — a missing container included —
 * puts the reason on screen in words instead of leaving it blank, and on the console with
 * its stack for whoever has to fix it.
 *
 * An error thrown later, from inside the tree, is not this function's to catch: React
 * reports it after `render` returns, and the boundary that handles it belongs with the app
 * shell that has a tree to guard.
 */
export function mount(container: HTMLElement | null): void {
  try {
    if (!container) {
      throw new Error('index.html has no #root element to mount into.');
    }

    assertTokensLoaded();

    createRoot(container).render(
      <StrictMode>
        <Boot />
      </StrictMode>,
    );
  } catch (error) {
    console.error(error);
    const reason = error instanceof Error ? error.message : String(error);
    (container ?? document.body).replaceChildren(bootFailure(reason));
  }
}
