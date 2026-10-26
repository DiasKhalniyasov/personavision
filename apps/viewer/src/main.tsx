/**
 * The application entry point.
 *
 * `docs/design/tokens.css` is imported straight out of the repository — the file is the
 * single source of visual truth and is never copied into this app, so the repository root
 * is a build input (see `vite.config.ts`). Everything after it only references the custom
 * properties it declares.
 *
 * The four type roles of `docs/FLOW.md` section 10 are **self-hosted from the repository**,
 * in the weights the direction names, so the platform renders with no network and the
 * offline demo stays honest. Nothing here fetches a font from a CDN; the static design
 * prototype is the one exception, because it is opened as a file.
 */

// Headlines: 400 / 600 / 800.
import '@fontsource/bricolage-grotesque/latin-400.css';
import '@fontsource/bricolage-grotesque/latin-600.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
// Body, buttons and forms: 400 / 500 / 700.
import '@fontsource/schibsted-grotesk/latin-400.css';
import '@fontsource/schibsted-grotesk/latin-500.css';
import '@fontsource/schibsted-grotesk/latin-700.css';
// The occasional editorial headline.
import '@fontsource/instrument-serif/latin-400.css';
// Uppercase overline labels, and every number set in mono.
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-500.css';

// Tailwind and its theme first, so the product's own rules win over the reset.
import './styles/theme.css';
import '../../../docs/design/tokens.css';
import './app.css';
import './styles/base.css';
import './styles/chrome.css';
import { mount } from './mount';

mount(document.getElementById('root'));
