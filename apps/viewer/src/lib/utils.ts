/**
 * The class helper every component in this app uses: conditional classes, with a later
 * Tailwind utility beating an earlier one.
 *
 * The shadcn registry's own files import it from the `cn` package directly. This module is
 * the seam the *product's* components import, so that the helper is named in one place and
 * the registry's files stay byte-identical to the registry.
 */
export { cn } from 'cn';
