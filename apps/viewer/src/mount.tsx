import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boot } from './boot';
import { readScoreThreshold } from './tokens';

/** The words a boot failure leaves on screen, so that the page is never blank. */
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
 * Both score-band thresholds are read first: they resolve only if `docs/design/tokens.css`
 * reached the page, so this is what tells a missing stylesheet apart from an app that
 * merely looks plain. Anything that goes wrong before the root exists — a missing
 * container included — puts the reason on screen in words instead of leaving it blank.
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

    readScoreThreshold('good');
    readScoreThreshold('bad');

    createRoot(container).render(
      <StrictMode>
        <Boot />
      </StrictMode>,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    (container ?? document.body).replaceChildren(bootFailure(reason));
  }
}
