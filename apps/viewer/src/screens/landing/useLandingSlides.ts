import { useEffect, useState } from 'react';
import { landingSlidesSchema } from '@personavision/contract';
import type { LandingSlides } from '@personavision/contract';

/**
 * The read behind the front page's carousel: `slides.json`, parsed by the contract (#428).
 *
 * **It is not a network read, and that is deliberate.** The slide set is baked from a
 * committed run directory (#427) and lives in this app's own source, so it is the same file
 * for every visitor and there is nothing about it to ask a server. It is imported `?raw` and
 * parsed here rather than `import`ed as a module so that the parse is the contract's own —
 * `landingSlidesSchema` is `strictObject`, so a file that has drifted from the schema fails
 * to load and the section says so, instead of rendering half a person.
 *
 * The import is **dynamic**, for two reasons. It is a 200 kB file behind the fold of the one
 * page every visitor lands on, so it belongs in its own chunk rather than in the bundle that
 * draws the headline; and a read that resolves after the first paint is what gives the
 * section the loading state its ticket asks for — the space is reserved from the first frame,
 * so the page below never jumps when the slides arrive.
 *
 * **Nothing is cached, and there is nothing to clear.** Every other read in this app
 * (`useRun`, `useSession`, the audience and sites stores) caches something that belongs to
 * one workspace, which is why each of them is emptied on sign-in and on sign-up. This read
 * holds nothing about anybody: it is a constant of the build, parsed once per mount of a
 * section that mounts once per visit to `/`. A cache here would save one parse and leave a
 * module-level copy for a test and a sign-in to reason about.
 */

/** How far the read has got. The three states the section renders. */
export type LandingSlidesState =
  /** Still being read. The section reserves its space and draws nothing. */
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly set: LandingSlides }
  /** The file could not be read or does not match the contract, with the reason. */
  | { readonly status: 'unreadable'; readonly problem: string };

/**
 * The slide set, read and parsed.
 *
 * The chunk itself is loaded once — that is the module registry's doing, not ours — and the
 * parse is the cheap half of this over five slides.
 */
const readSlides = async (): Promise<LandingSlides> => {
  const { default: text } = await import('./slides.json?raw');
  return landingSlidesSchema.parse(JSON.parse(text));
};

/** What went wrong, in one clause the quiet line can carry. Never an object or a stack. */
const problemOf = (cause: unknown): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : 'the slide set is unreadable';

/**
 * The committed slide set, as the carousel reads it.
 *
 * `cancelled` is the usual guard: the read outlives a component that unmounted while it was
 * in flight, and setting state on it then is a leak React warns about.
 */
export function useLandingSlides(): LandingSlidesState {
  const [state, setState] = useState<LandingSlidesState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    readSlides().then(
      (set) => {
        if (!cancelled) setState({ status: 'ready', set });
      },
      (cause: unknown) => {
        if (!cancelled) setState({ status: 'unreadable', problem: problemOf(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
