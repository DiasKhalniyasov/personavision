import { useEffect, useState } from 'react';
import { landingSlidesSchema } from '@personavision/contract';
import { chosenSlideSet } from './slideSets';
import type { LandingSlides } from '@personavision/contract';
import type { SlideScreenshots } from './slideSets';

/**
 * The read behind the front page's carousel: the slide set `/` shows, parsed by the contract
 * (#428).
 *
 * **Which set that is, is not decided here.** It is `chosenSlideSet()`, and the rule behind it
 * lives in `slideSets.ts` and nowhere else (#429): this module reads whatever that names and
 * carries the set's `screenshots` out beside it, so the carousel can resolve a capture without
 * knowing whether the run it came from is committed under `runs/` or was copied into this
 * app's assets.
 *
 * **It is not a network read, and that is deliberate.** A slide set is baked from a run
 * directory (#427) and the file lives in this app's own source, so it is the same file for
 * every visitor and there is nothing about it to ask a server. It is imported `?raw` and
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
  | {
      readonly status: 'ready';
      readonly set: LandingSlides;
      /** Where this set's captures are loaded from; `slideSets.ts` decides, not the page. */
      readonly screenshots: SlideScreenshots;
    }
  /** The file could not be read or does not match the contract, with the reason. */
  | { readonly status: 'unreadable'; readonly problem: string };

/** The read's answer once it has one: the set, and where its captures come from. */
type ReadSlides = Extract<LandingSlidesState, { status: 'ready' }>;

/**
 * The chosen slide set, read and parsed.
 *
 * The chunk itself is loaded once — that is the module registry's doing, not ours — and the
 * parse is the cheap half of this over five slides.
 */
const readSlides = async (): Promise<ReadSlides> => {
  const { screenshots, read } = chosenSlideSet();
  return { status: 'ready', set: landingSlidesSchema.parse(JSON.parse(await read())), screenshots };
};

/** What went wrong, in one clause the quiet line can carry. Never an object or a stack. */
const problemOf = (cause: unknown): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : 'the slide set is unreadable';

/**
 * The slide set `/` shows, as the carousel reads it.
 *
 * `cancelled` is the usual guard: the read outlives a component that unmounted while it was
 * in flight, and setting state on it then is a leak React warns about.
 */
export function useLandingSlides(): LandingSlidesState {
  const [state, setState] = useState<LandingSlidesState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    readSlides().then(
      (ready) => {
        if (!cancelled) setState(ready);
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
