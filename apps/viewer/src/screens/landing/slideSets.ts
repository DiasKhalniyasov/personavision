import { runDataBase } from '@/shell/useRun';

/**
 * The slide sets the front page can show, and the one rule for which of them `/` reads (#429).
 *
 * #427 bakes one set out of the committed example run and #428 renders a set. This file is the
 * third thing the owner's input asks for: **the front page shows one set at a time**, and once
 * there is a set per example template beside the example run's, something has to decide which.
 * That decision lives here and nowhere else — not in `LandingPage`, not in `RunCarousel`, not
 * in the read — so that changing which test the front page leads with is reordering one list
 * rather than finding every place a file name is spelled (decision 182).
 *
 * **The rule, and the whole of it: `/` reads the first entry of `SLIDE_SETS`.** The entries are
 * in the order the page prefers them and the committed example run's set is **last**, which is
 * what makes it the fallback: with no template set registered the front page shows it, exactly
 * as it did before this file existed. A visitor therefore sees the same people on every visit
 * and on every machine, which is what lets a shared link, a screenshot of the page and a
 * per-set test all mean the same thing.
 *
 * ## Why a set carries where its screenshots live
 *
 * A slide's `screenshot.path` is run-directory-relative, exactly as `runPaths('').screenshot()`
 * spells it, and it is resolved against a base. For the example run that base is the run-data
 * mount, because that run is committed under `runs/` and the app already serves it. **The
 * template runs are not committed**: they are made against live third-party sites into a runs
 * root outside the repository (`docs/template-acceptance.md`), and the front page may not reach
 * outside the app. So a template set's captures are copied into this app's own assets by the
 * bake (`pnpm bake:landing-slides … --assets`) and its base is that directory. Either way the
 * only host `/` asks is its own.
 */

/** Where one set's screenshots are resolved against. */
export type SlideScreenshots =
  /**
   * The run is committed under `runs/`, so the app's own run-data mount serves its captures —
   * the identical URL every other screen in the product loads a screenshot from.
   */
  | { readonly kind: 'run-data' }
  /**
   * The run is not committed, and the bake copied its captures into this app's assets under
   * `base`. `base` is origin-relative and ends in a slash; the run id is a directory inside
   * it, so two sets baked from two runs cannot collide on a capture's path.
   */
  | { readonly kind: 'assets'; readonly base: string };

/** One slide set the front page could show. */
export interface SlideSet {
  /**
   * The set's id: the template's own id from `screens/newtest/templates.ts` for a template
   * set, so a reader can see which example test a set came from without opening it.
   */
  readonly id: string;
  /** The site the run was against, for an owner reading this list. Never drawn on the page. */
  readonly site: string;
  readonly screenshots: SlideScreenshots;
  /**
   * The set's own bytes. A function, and a dynamic import inside it, for the two reasons
   * `useLandingSlides` documents: a set is a few hundred kB behind the fold of the one page
   * every visitor lands on, and a read that resolves after the first paint is what gives the
   * section its loading state. `?raw` because the viewer has no `resolveJsonModule`, and
   * because the parse then belongs to the contract rather than to the bundler.
   */
  readonly read: () => Promise<string>;
}

/**
 * The committed example run's set: #427's file, baked from `runs/2026-10-24-1402-northwind-demo`.
 *
 * It is the fallback and so it is always last in `SLIDE_SETS`. Its captures come off the
 * run-data mount, which is why nothing of it is copied into `public/`: the run is in the
 * repository and the app already serves it.
 */
const EXAMPLE_SET: SlideSet = {
  id: 'northwind-demo',
  site: 'the Northwind demo shop',
  screenshots: { kind: 'run-data' },
  read: async () => (await import('./slides.json?raw')).default,
};

/**
 * Every set, in the order `/` prefers them, with the fallback last.
 *
 * **A template set is added here**, above `EXAMPLE_SET`, once it has been baked: one entry
 * naming the template's id, its site, the assets directory the bake copied its captures into,
 * and its file under `./slides/`. Nothing else on the page changes — not the carousel, not the
 * read, not a test — which is the point of this file.
 *
 * It is a non-empty tuple so that the rule below needs no "what if there are none" branch: the
 * example set is committed, so there is always at least one.
 */
export const SLIDE_SETS: readonly [SlideSet, ...SlideSet[]] = [
  // Template sets go here, in the order the front page should prefer them — #429 owes the five
  // of them, and they are blocked on the live runs of #423 (a model key this machine refuses).
  EXAMPLE_SET,
];

/** The set `/` shows. The first of the declared order; see this file's header. */
export const chosenSlideSet = (): SlideSet => SLIDE_SETS[0];

/**
 * One run's captures as the page loads them, ending in a slash: what a slide's stored
 * `screenshot.path` resolves against.
 *
 * The run id is encoded the same way `runDataBase` encodes it, so a set whose captures were
 * copied into the assets and a set read off the run-data mount spell a run's directory
 * identically and a slide needs to know nothing about which kind of set it is on.
 */
export const screenshotBase = (screenshots: SlideScreenshots, runId: string): string =>
  screenshots.kind === 'run-data'
    ? runDataBase(runId)
    : `${screenshots.base}${encodeURIComponent(runId)}/`;
