// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../setup';
import { mountApp } from '../app';
import { axeViolations, describeViolations } from '../axe';
import { rulesOf } from '../cssom';
import { stubVideoPlayback } from '../replay/harness';
import { forget, laterFiles, prose, RUN_ID, SCREENS, serveHundred } from './fixture';

/**
 * **A hundred sessions at 390 px, by keyboard, and still.**
 *
 * The quiet half of the step's contract, over all six screens at once: each one clean under
 * axe, operable by keyboard with a focus ring the tokens declare, honouring a 390 px
 * viewport without scrolling sideways, and — walked a second time under
 * `prefers-reduced-motion: reduce` — **complete and still**, every figure at its settled
 * value and nothing moving.
 *
 * Two of these cannot be decided by a rendered tree, because jsdom lays nothing out: how
 * wide a column is, and whether a page scrolls sideways. They are decided the way the rest
 * of this app's suites decide a screen contract that is CSS — by reading the stylesheet back
 * through the CSSOM (`tests/cssom.ts`) — and the rule asserted is the one that actually cuts
 * a phone off: **nothing demands a width in pixels**, and the only thing allowed to scroll
 * horizontally is a wide table inside its own card.
 *
 * No visual value is restated here. The focus ring is read out of
 * `docs/design/tokens.css` through the document the setup loads it into, as the token tests
 * do.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The six screens' own directories, which is where their stylesheets live. */
const SCREEN_DIRS = ['summary', 'sessions', 'replay', 'attention', 'funnel', 'analysis'] as const;

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

/** Every file of the six screens' own directories whose extension is one of these. */
const screenFiles = (...kinds: string[]): string[] =>
  SCREEN_DIRS.flatMap((screenDir) =>
    filesUnder(join(here, '../../src/screens', screenDir)).filter((path) =>
      kinds.includes(extname(path)),
    ),
  );

/** Every stylesheet of the six screens, by path. */
const screenStylesheets = (): string[] => screenFiles('.css');

/** Every component of the six screens, where a Tailwind utility class would be written. */
const screenComponents = (): string[] => screenFiles('.tsx', '.ts');

/** What a `rem` is, so a length written in them can be compared with the phone's width. */
const ROOT_FONT_PX = 16;

/**
 * The width the product calls a phone, **read out of `docs/design/tokens.css`** rather than
 * written here: `--frame-ratio-mobile` is the mobile frame's own aspect ratio, `390 / 844`,
 * and its first term is that width. The setup loads the committed tokens file into the
 * document, so this is the same value the product renders with.
 */
const phoneWidth = (): number => {
  const ratio = getComputedStyle(document.documentElement)
    .getPropertyValue('--frame-ratio-mobile')
    .trim();
  const width = Number(/^(\d+(?:\.\d+)?)\s*\/\s*\d/u.exec(ratio)?.[1]);
  if (!Number.isFinite(width)) {
    throw new Error(`--frame-ratio-mobile does not name a width: ${JSON.stringify(ratio)}`);
  }
  return width;
};

/** A stylesheet with its comments taken out: a word in a comment is not a declaration. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

/** jsdom answers every media query `false`; this makes one of them answer `true`. */
const prefersReducedMotion = (matches: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
};

/** The controls of one screen, in page order. */
const controlsIn = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [role="slider"]',
  ),
];

/**
 * A control a reader cannot reach with the keyboard.
 *
 * `tabindex="-1"` is how a roving group — a toolbar, a tab list, a radio group — keeps one
 * stop in the tab order and moves between its own members with the arrow keys, which is
 * Radix's behaviour and is operable. Outside such a group it is a control the keyboard
 * cannot get to at all.
 */
const unreachable = (container: HTMLElement): string[] =>
  controlsIn(container)
    .filter((control) => control.getAttribute('tabindex') === '-1')
    .filter(
      (control) =>
        control.closest('[role="toolbar"], [role="tablist"], [role="radiogroup"]') === null,
    )
    .map((control) => control.outerHTML.slice(0, 120));

beforeEach(() => {
  loadDesignTokens();
  stubVideoPlayback();
});
afterEach(forget);

describe('all six are clean under axe', () => {
  for (const one of SCREENS) {
    it(`reports no violation on ${one.name}`, async () => {
      await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      await one.settled();

      const violations = await axeViolations(container);
      expect(violations, `${one.name}: ${describeViolations(violations)}`).toEqual([]);
    }, 60_000);
  }
});

describe('all six are operable by keyboard', () => {
  for (const one of SCREENS) {
    it(`leaves no control out of reach on ${one.name}`, async () => {
      await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      await one.settled();

      expect(controlsIn(container).length).toBeGreaterThan(0);
      expect(unreachable(container), one.name).toEqual([]);
    }, 60_000);
  }

  /** How many stops of one screen's tab order are walked. */
  const STOPS = 12;

  for (const one of SCREENS) {
    it(`walks forward from one control to the next on ${one.name}, and never sticks`, async () => {
      const user = userEvent.setup();
      await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      await one.settled();

      const controls = controlsIn(container);
      const first = controls[0];
      if (first === undefined) throw new Error(`${one.name} drew no control`);
      first.focus();
      expect(document.activeElement).toBe(first);

      const stops: Element[] = [first];
      for (let step = 0; step < Math.min(controls.length - 1, STOPS); step += 1) {
        await user.tab();
        const landed = document.activeElement as Element;
        // Forward, and somewhere new: a tab that lands where it started is a trap.
        expect(stops.includes(landed), landed.outerHTML.slice(0, 120)).toBe(false);
        stops.push(landed);
      }
      // More than one, and as many as the screen had to give: a walk that stopped early
      // because the screen ran out of controls is not a walk this test has judged.
      expect(stops.length, one.name).toBe(Math.min(controls.length, STOPS + 1));
    }, 60_000);
  }

  it('never takes a focus ring away without putting one back', async () => {
    await serveHundred();
    let judged = 0;

    for (const one of SCREENS) {
      const mounted = mountApp(one.path(RUN_ID));
      await one.settled();
      for (const control of controlsIn(mounted.container)) {
        const classes = control.getAttribute('class') ?? '';
        if (!classes.includes('outline-none')) continue;
        expect(classes, `${one.name}: ${control.outerHTML.slice(0, 120)}`).toMatch(
          /focus-visible:ring-/u,
        );
        judged += 1;
      }
      mounted.unmount();
    }

    // The registry's primitives do take the browser ring away and put their own back, so
    // the six do have controls of this shape. A run that found none would mean the class
    // the check looks for had been renamed, not that every control keeps its ring.
    expect(judged, 'no control on any of the six takes its outline away').toBeGreaterThan(0);
  }, 90_000);

  it('reads the ring itself out of the tokens', () => {
    // The focus ring is `--border-width-strong` in `--color-focus` (`docs/FLOW.md` section
    // 10); both are read from the committed tokens file rather than written out here.
    const tokens = getComputedStyle(document.documentElement);
    expect(tokens.getPropertyValue('--color-focus').trim()).not.toBe('');
    expect(tokens.getPropertyValue('--border-width-strong').trim()).not.toBe('');
  });
});

describe('all six hold at 390 px', () => {
  it('gives nothing on any of the six a width in pixels', () => {
    // The four properties that make a box demand room. `0px` is not one of them — it
    // demands nothing, which is what a flex child is given so that it may shrink — so a
    // length is read as a number rather than matched as a string.
    const fixed = ['width', 'min-width', 'min-inline-size', 'inline-size'];

    for (const path of screenStylesheets()) {
      for (const rule of rulesOf(readFileSync(path, 'utf8'))) {
        for (const [property, value] of Object.entries(rule.declarations)) {
          if (!fixed.includes(property)) continue;
          const where = `${path}: ${rule.selector} ${property}: ${value}`;
          const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
          if (pixels === null) expect(value, where).not.toMatch(/\d\s*px/u);
          else expect(Number(pixels[1]), where).toBe(0);
        }
      }
    }
  });

  it('lets only a wide table scroll sideways, inside its own card', () => {
    // The page itself never scrolls horizontally at 390 px. Where a table has more columns
    // than a phone has room for, the card around it scrolls — which is the `.tablewrap` the
    // three table screens share — and the page under it does not move.
    const scrollers: string[] = [];

    for (const path of screenStylesheets()) {
      for (const rule of rulesOf(readFileSync(path, 'utf8'))) {
        const overflow = rule.declarations['overflow-x'];
        if (overflow === undefined || overflow === 'hidden' || overflow === 'visible') continue;
        scrollers.push(`${path}: ${rule.selector}`);
        expect(rule.selector, `${path}: ${rule.selector} scrolls sideways`).toBe('.tablewrap');
      }
    }
    // And the convention is in use rather than vacuously true.
    expect(scrollers.length).toBeGreaterThan(0);
  });

  it('asks for no width in a utility class either', () => {
    // A stylesheet is not the only way to demand room: Tailwind's arbitrary values put the
    // same declaration in a class name, where the CSSOM above cannot see it. So the six
    // screens' own components are read for one too, by the shape the utility takes —
    // `w-[600px]`, `min-w-[48rem]` — with `0px`, and the sub-`phone` lengths an icon or a
    // control needs, allowed exactly as the stylesheet rule allows them.
    const phone = phoneWidth();
    const arbitrary = /\b(?:min-)?(?:w|inline-size)-\[(\d+(?:\.\d+)?)(px|rem)\]/gu;

    // The six use none today, so unlike the two rules above this one has nothing of its own
    // to count. What it can state is that it read the screens at all: a scan whose file
    // list had gone empty — a directory renamed, a screen moved — would otherwise pass
    // over any width at all.
    const components = screenComponents();
    expect(components.length, 'the six screens have no components to read').toBeGreaterThan(5);

    for (const path of components) {
      const body = withoutComments(readFileSync(path, 'utf8'));
      for (const found of body.matchAll(arbitrary)) {
        const [whole, length, unit] = found;
        const pixels = unit === 'rem' ? Number(length) * ROOT_FONT_PX : Number(length);
        expect(pixels, `${path}: ${whole}`).toBeLessThanOrEqual(phone);
      }
    }
  });

  it('hard-sizes nothing it renders, either', async () => {
    const phone = phoneWidth();
    await serveHundred();
    let styled = 0;

    for (const one of SCREENS) {
      const mounted = mountApp(one.path(RUN_ID));
      await one.settled();
      styled += mounted.container.querySelectorAll('[style]').length;
      for (const element of mounted.container.querySelectorAll<HTMLElement>('[style]')) {
        for (const property of ['width', 'minWidth'] as const) {
          const value = element.style[property];
          const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value);
          if (pixels === null) continue;
          expect(
            Number(pixels[1]),
            `${one.name}: ${element.outerHTML.slice(0, 120)}`,
          ).toBeLessThanOrEqual(phone);
        }
      }
      mounted.unmount();
    }

    // Not every one of the six styles anything inline — the Summary styles nothing at all —
    // but the heatmap stage's boxes and the funnel's bars do, so the walk has elements to
    // judge. A run that found none would mean the screens had stopped drawing them, and
    // this check had quietly become a check of nothing.
    expect(styled, 'none of the six drew an inline style').toBeGreaterThan(0);
  }, 90_000);
});

describe('nothing shifts as the run is read', () => {
  /**
   * Every slot a screen has drawn, by the name it declares: `data-section` for a screen's
   * own block and `data-shell` for one of the chrome's.
   */
  const slotsIn = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('[data-section], [data-shell]')]
      .map((block) => block.getAttribute('data-section') ?? block.getAttribute('data-shell') ?? '')
      .filter((name) => name !== '');

  /** Whatever is holding a space: a placeholder block, by either convention. */
  const stillReading = (container: HTMLElement): Element[] => [
    ...container.querySelectorAll('[data-state="loading"], [aria-busy="true"]'),
  ];

  /** The next macrotask, which is before a deliberately late file answers. */
  const tick = async (): Promise<void> => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  for (const one of SCREENS) {
    it(`draws ${one.name} and then fills it, without moving what is already there`, async () => {
      // Every file but `run.json` answers late, so the state the screen is in while it
      // reads them is a state a test can see at all.
      await serveHundred({ slow: laterFiles(), slowMs: 300 });
      const { container } = mountApp(one.path(RUN_ID));

      // The run has arrived and the rest has not: the screen is drawn, with its heading.
      let reading = '';
      for (let step = 0; step < 50 && reading === ''; step += 1) {
        await tick();
        reading = prose(container.querySelector('h1')?.textContent);
      }
      expect(reading, `${one.name} drew no heading while it read`).not.toBe('');
      // The blocks it drew off `run.json` alone. A slot named `no-…` is a **stated
      // absence** and is left out of the comparison below, because two of the six do
      // briefly state one while their own copy of the run read resolves — the Heatmaps
      // screen's areas table and the Funnel's simulated line. Both are a tick wide, both
      // are the shared `useOptionalRun` hook starting at `null` in a second component
      // rather than anything these screens do, and this ticket **reports** a departure
      // rather than editing the screen it is on (reported on #280).
      const held = slotsIn(container).filter((slot) => !slot.startsWith('no-'));
      expect(held.length, `${one.name} drew no block while it read`).toBeGreaterThan(0);

      await one.settled();

      // Every slot the screen had while it was reading is still there now: the arriving
      // figures filled their own blocks rather than appearing where there was nothing and
      // pushing the page down. The screen's own structure comes from `run.json`, which is
      // the one file that had landed.
      const settled = new Set(slotsIn(container));
      for (const slot of held) expect(settled.has(slot), `${one.name} lost ${slot}`).toBe(true);
      expect(prose(container.querySelector('h1')?.textContent), one.name).not.toBe('');
      // And nothing is left holding a space, which would be a block that never arrived.
      expect(stillReading(container), one.name).toHaveLength(0);
      // Nor is any absence still stated over a run that recorded all of it: the figures
      // have landed, so a screen saying it has none would be contradicting its own files.
      expect(
        [...container.querySelectorAll('[data-section]')]
          .map((block) => block.getAttribute('data-section') ?? '')
          .filter((slot) => slot.startsWith('no-')),
        one.name,
      ).toEqual([]);
    }, 90_000);
  }
});

describe('under prefers-reduced-motion: reduce, all six are complete and still', () => {
  for (const one of SCREENS) {
    it(`renders ${one.name} finished, and moves nothing`, async () => {
      prefersReducedMotion(true);
      await serveHundred();
      const { container } = mountApp(one.path(RUN_ID));
      // Complete: the screen's own settled state is reached under the query, so every
      // figure, overlay and bar is readable at the value it ends on.
      await one.settled();
      expect(prose(container.textContent).length).toBeGreaterThan(200);

      // Still: nothing on these six is one of the animated moments of section 10 — those
      // are on the Verdict and the two public pages and nowhere else — and nothing is being
      // animated in JavaScript, which would show as an inline duration.
      expect(container.querySelectorAll('[data-moment]'), one.name).toHaveLength(0);
      for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
        const where = `${one.name}: ${element.outerHTML.slice(0, 120)}`;
        expect(element.style.animation, where).toBe('');
        expect(element.style.animationDuration, where).toBe('');
        expect(element.style.transitionDuration, where).toBe('');
      }

      // And no recording plays itself: a video that autoplayed would be the one thing on
      // this page that moves whatever the reader has asked for.
      for (const video of container.querySelectorAll('video')) {
        expect(video.hasAttribute('autoplay'), one.name).toBe(false);
        expect(video.hasAttribute('loop'), one.name).toBe(false);
      }
    }, 60_000);
  }

  it('declares no animation of its own in any of the six stylesheets', () => {
    for (const path of screenStylesheets()) {
      const body = withoutComments(readFileSync(path, 'utf8'));
      expect(body, path).not.toMatch(/@keyframes/u);
      expect(body, path).not.toMatch(/\banimation(-[a-z]+)?\s*:/u);
    }
  });

  it('leaves the two animated moments where #125 put them', async () => {
    // The same walk without the query: the moments are absent because they are not on these
    // screens at all, rather than because the reader asked for stillness.
    prefersReducedMotion(false);
    await serveHundred();

    for (const one of SCREENS) {
      const mounted = mountApp(one.path(RUN_ID));
      await one.settled();
      expect(mounted.container.querySelectorAll('[data-moment]'), one.name).toHaveLength(0);
      mounted.unmount();
    }
  }, 90_000);
});
