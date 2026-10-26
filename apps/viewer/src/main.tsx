/**
 * The application entry point.
 *
 * `docs/design/tokens.css` is imported straight out of the repository — the file is the
 * single source of visual truth and is never copied into this app, so the repository root
 * is a build input (see `vite.config.ts`). `app.css` follows it and only references the
 * custom properties it declares.
 */
import '../../../docs/design/tokens.css';
import './app.css';
import { mount } from './mount';

mount(document.getElementById('root'));
