// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '@personavision/contract';
import { CompletionFigures } from '@/screens/verdict/CompletionFigures';
import { inTen, percent } from '@/screens/verdict/completionBand';
import { paths } from '@/shell/paths';
import { forgetRuns, mountApp, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';
import { seedRun, show, withVerdict } from '../../../tests/verdict/fixture';
import { NumberTicker } from './NumberTicker';

/**
 * The two Aceternity moments of the Verdict screen — the reveal and the heatmap warming up —
 * and the rule that is the other half of the direction: **nowhere else moves**.
 *
 * What these tests hold is that the moments are decoration on a page that is already
 * complete. The figures are the run's own figures at first paint, whatever frame the digits
 * on top of them are on; the spotlight follows a stored field; the beams can be deleted
 * without taking a word with them; the heat is #71's layer with its opacity animated and no
 * second accumulation; every duration is the token's, through `useMoment`; a moment runs once
 * and never again; and under `prefers-reduced-motion` every one of them is simply finished.
 *
 * The count is driven a frame at a time rather than waited for: `requestAnimationFrame` is
 * stubbed, so a test says what the clock said and reads what was drawn, and the two forms of
 * one share can be compared at the same frame.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = join(here, 'moments.module.css');
const componentFiles = ['NumberTicker.tsx', 'Spotlight.tsx', 'Beam.tsx'];

/** The committed example run, which every screen suite of this app reads. */
const SEED = '2026-10-24-1402-northwind-demo';

/** The two forms the Verdict screen says one share in. */
const tenths = (rate: number): string => String(inTen(rate));
const percentage = (rate: number): string => `${String(percent(rate))}%`;

/** The frames the moments asked for, so a count is driven a timestamp at a time. */
let frames: FrameRequestCallback[] = [];

const stubFrames = (): void => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
};

/** Every frame asked for so far, run at this timestamp — one timestamp for all of them. */
const frame = (at: number): void => {
  const due = frames;
  frames = [];
  for (const callback of due) callback(at);
};

/** Whatever the clock happened to say when the screen mounted. */
const START = 1_000;

/** jsdom answers no media query; this makes one of them answer `true`. */
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

/** The moments mounted under an element, by name, so a screen can be counted in one go. */
const momentsIn = (root: ParentNode): Record<string, number> => {
  const counted: Record<string, number> = {};
  for (const element of root.querySelectorAll('[data-moment]')) {
    const name = element.getAttribute('data-moment') ?? '';
    counted[name] = (counted[name] ?? 0) + 1;
  }
  return counted;
};

/** One figure's two counting layers: the *N in 10* form, then the percentage. */
const drawn = (figure: Element): (string | null)[] =>
  [...figure.querySelectorAll('[data-count]')].map((layer) => layer.getAttribute('data-count'));

/** This version's stored score for the run's one task, as the figures read it. */
const scoreOf = (run: Run, variant: string): Run['scores'][number] => {
  const score = run.scores.find(
    (candidate) => candidate.variant === variant && candidate.taskId === run.task.id,
  );
  if (score === undefined) throw new Error(`the run carries no score for ${variant}`);
  return score;
};

/** The assembled Verdict screen, with the heat — the last beat — on the page. */
async function openVerdict() {
  await serveRunData();
  const mounted = mountApp(paths.run(SEED));
  await waitFor(() => {
    expect(mounted.container.querySelector('[data-overlay-layer="heat"]')).not.toBeNull();
  });
  return mounted;
}

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the number ticker on a completion figure', () => {
  it('has the final figure in the DOM at first paint and counts up to it over the token', () => {
    stubFrames();
    const { container } = render(<NumberTicker value={0.82} format={tenths} />);
    const ticker = container.querySelector('[data-moment="ticker"]') as HTMLElement;

    // The answer, before a single frame has run: this is what a screen reader announces.
    expect(ticker.textContent).toBe('8');
    expect(ticker.dataset.durationMs).toBe('900');

    frame(START);
    expect(drawn(ticker)).toEqual(['0']);
    frame(START + 450);
    expect(drawn(ticker)).toEqual(['4']);
    // And the document still says the answer, at every frame: the count is not a text node.
    expect(ticker.textContent).toBe('8');

    frame(START + 900);
    expect(drawn(ticker)).toEqual(['8']);
    // One pass: the ticker asks for no frame after the one it arrived on, and uncovers the
    // figure React rendered rather than leaving a value of its own on the page.
    expect(frames).toHaveLength(0);
    expect(ticker.hasAttribute('data-ticking')).toBe(false);
    expect(ticker.textContent).toBe('8');
  });

  it('says one share in two forms that agree at every frame', () => {
    stubFrames();
    const run = seedRun();
    const { container } = show(<CompletionFigures run={run} />);
    const figures = [...container.querySelectorAll('.figure')];

    for (const elapsed of [0, 225, 450, 900]) {
      frame(START + elapsed);
      const progress = Math.min(1, elapsed / 900);

      for (const [index, variant] of run.variants.entries()) {
        const share = scoreOf(run, variant.id).completionRate * progress;
        // Both forms are this frame's one share, written the two ways the product writes it.
        expect(drawn(figures[index] as Element), variant.id).toEqual([
          tenths(share),
          percentage(share),
        ]);
      }
    }
  });

  it('reserves the final figure’s width, so nothing on the page moves while it runs', () => {
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    // The answer keeps its box for the whole count — it is faded, never taken out of flow —
    // and the digits are drawn over it from out of flow, so neither can move the line.
    expect(rule('.ticker[data-ticking] .answer')).toEqual({ opacity: '0' });
    expect(rule('.counting').position).toBe('absolute');
    expect(rule('.ticker').position).toBe('relative');
  });

  it('reads the duration the production build writes, not only the one the file does', () => {
    // The built stylesheet is minified, and `700ms` comes out of it as `.7s`: a duration
    // with no digit before the dot. `src/shell/motion.tsx` parses the token, and this is the
    // form it meets in the app a reader actually loads.
    document.documentElement.style.setProperty('--moment-ticker-duration', '.7s');
    const { container } = render(<NumberTicker value={0.82} format={tenths} />);

    expect(
      (container.querySelector('[data-moment="ticker"]') as HTMLElement).dataset.durationMs,
    ).toBe('700');
  });

  it('does not replay when the screen re-renders', () => {
    stubFrames();
    const run = seedRun();
    const { container, rerender } = show(<CompletionFigures run={run} />);
    frame(START);
    frame(START + 900);
    expect(frames).toHaveLength(0);

    // A filter resolving, a query settling: the screen renders again with the same answer.
    rerender(<CompletionFigures run={{ ...run }} />);

    expect(frames).toHaveLength(0);
    expect(container.querySelector('[data-ticking]')).toBeNull();
  });
});

describe('the spotlight on the winning version', () => {
  it('lands on the card verdict.preferredVariant names, and on no other', () => {
    const { container } = show(<CompletionFigures run={seedRun()} />);
    const lit = [...container.querySelectorAll('[data-moment="spotlight"]')];

    expect(lit).toHaveLength(1);
    expect((lit[0] as HTMLElement).textContent).toContain('Current checkout');
    expect((lit[0] as HTMLElement).dataset.durationMs).toBe('700');
  });

  it('follows the field when the artifact prefers the other version', () => {
    const { container } = show(
      <CompletionFigures run={withVerdict(seedRun(), { preferredVariant: 'B' })} />,
    );
    const lit = container.querySelector('[data-moment="spotlight"]') as HTMLElement;

    expect(lit.textContent).toContain('Redesign candidate');
    expect(lit.textContent).not.toContain('Current checkout');
  });

  it('does not mount at all when the run names no version to ship', () => {
    const { container } = show(
      <CompletionFigures run={withVerdict(seedRun(), { preferredVariant: '' })} />,
    );

    expect(container.querySelectorAll('[data-moment="spotlight"]')).toHaveLength(0);
  });
});

describe('the beams from the audience line to the two versions', () => {
  it('draws one to each version, staggered by the token', () => {
    const run = seedRun();
    const { container } = show(<CompletionFigures run={run} />);
    const beams = [...container.querySelectorAll('[data-moment="beam"]')];

    expect(beams).toHaveLength(run.variants.length);
    expect(beams.map((beam) => beam.getAttribute('data-duration-ms'))).toEqual(['1200', '1200']);
    expect(beams.map((beam) => beam.getAttribute('data-delay-ms'))).toEqual(['0', '80']);
    // Each line starts at the top of the field — the whitespace the audience line is on the
    // other side of — and lands on the middle of its own version's share of the row.
    expect(beams.map((beam) => beam.querySelector('path')?.getAttribute('d'))).toEqual([
      'M 0 0 C 0 50 25 50 25 100',
      'M 0 0 C 0 50 75 50 75 100',
    ]);
    // The lime and the grass accents, which is the whole of what a beam carries.
    expect(
      [...container.querySelectorAll('[data-moment="beam"] path')].map((path) =>
        path.getAttribute('data-accent'),
      ),
    ).toEqual(['lime', 'grass']);
  });

  it('is decoration: removing it leaves the block exactly as readable', () => {
    const { container } = show(<CompletionFigures run={seedRun()} />);
    const words = container.textContent;

    for (const beam of container.querySelectorAll('[data-moment="beam"]')) beam.remove();

    expect(container.textContent).toBe(words);
  });

  it('takes no pointer and no focus, so the screen is operable while they run', () => {
    const { container } = show(<CompletionFigures run={seedRun()} />);
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    for (const decoration of container.querySelectorAll('[data-moment="beam"]')) {
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
    }
    // Nothing a reader can reach is inside a moment but the figures the spotlight lights.
    expect(container.querySelectorAll('[data-moment] a, [data-moment] button')).toHaveLength(0);
    expect(rule('.beams')['pointer-events']).toBe('none');
    expect(rule('.glow')['pointer-events']).toBe('none');
  });
});

describe('the heatmap warming up', () => {
  it('warms #71’s layer once, over the token, with no second accumulation', async () => {
    const { container } = await openVerdict();
    const warming = [...container.querySelectorAll('[data-moment="heat"]')];

    expect(warming).toHaveLength(1);
    expect((warming[0] as HTMLElement).dataset.durationMs).toBe('900');
    // One layer, inside the box whose opacity is what moves: the heat itself is #71's
    // renderer, mounted as it is, and there is one of it on the page.
    expect((warming[0] as Element).querySelectorAll('[data-overlay-layer="heat"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-overlay-layer="heat"] svg')).toHaveLength(1);
    // No loop and no pulse: `pv-pulse` is for a live or a loading state, and this is neither.
    expect((warming[0] as HTMLElement).style.animation).toBe('');
  });

  it('accumulates no heat of its own anywhere this ticket touched', () => {
    const hero = readFileSync(join(here, '../../screens/verdict/HeroEvidence.tsx'), 'utf8');

    expect(hero).toContain("from '@/screens/attention/stage/HeatmapLayer'");
    for (const source of [
      hero,
      ...componentFiles.map((file) => readFileSync(join(here, file), 'utf8')),
    ]) {
      expect(source).not.toMatch(/accumulateHeat|heatAccumulation/);
    }
  });
});

describe('nowhere else moves', () => {
  it('mounts each moment of the Verdict screen once, and the tickers only on the figures', async () => {
    const run = seedRun();
    const { container } = await openVerdict();

    expect(momentsIn(container)).toEqual({
      // One form of the share each, on each of the two figures.
      ticker: run.variants.length * 2,
      spotlight: 1,
      beam: run.variants.length,
      heat: 1,
    });
    for (const ticker of container.querySelectorAll('[data-moment="ticker"]')) {
      expect(ticker.closest('[data-section="completion-figures"]')).not.toBeNull();
    }
  });

  it('mounts no moment on any of the four screens one click deeper', async () => {
    const run = seedRun();
    const { heroEvidence } = run.verdict;
    await serveRunData();

    const deeper = [
      [paths.breakdown(SEED), '[data-section="score-cards"]'],
      [
        paths.attention(SEED, heroEvidence.variant, heroEvidence.step),
        '[data-section="attention"]',
      ],
      [paths.sessions(SEED), '[aria-label="The people in this test"]'],
      [paths.session(SEED, 'S-01'), '#rp-clock'],
    ] as const;

    for (const [path, settled] of deeper) {
      const { container, unmount } = mountApp(path);
      await waitFor(() => {
        expect(container.querySelector(settled), path).not.toBeNull();
      });
      expect(momentsIn(container), path).toEqual({});
      unmount();
    }
  });

  it('writes no duration, no easing curve and no colour in a component', () => {
    for (const file of componentFiles) {
      const source = readFileSync(join(here, file), 'utf8');
      // A file's own header explains what it animates and names the token it reads: prose is
      // not a value, so what is scanned is the code with the comments taken out of it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Every duration a moment has is the token's, read through the shell's one hook.
      expect(code, file).toContain('useMoment(');
      expect(code, file).not.toMatch(/\d(?:\.\d+)?(?:ms|s)\b/);
      expect(code, file).not.toMatch(/cubic-bezier|ease-in|ease-out|linear/);
      expect(code, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    }

    // And the stylesheet states no duration either: a CSS transition would have to be told
    // about reduced motion a second time, and the components are told once.
    const css = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/transition|animation|pv-pulse|--moment-/);
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('renders every moment finished, with no duration above zero and nothing running', () => {
    prefersReducedMotion(true);
    stubFrames();
    const run = seedRun();
    const { container } = show(<CompletionFigures run={run} />);

    // The figures are the run's own, at once, and no frame was ever asked for.
    for (const variant of run.variants) {
      const rate = scoreOf(run, variant.id).completionRate;
      expect(container.textContent, variant.id).toContain(`${tenths(rate)} in 10`);
      expect(container.textContent, variant.id).toContain(percentage(rate));
    }
    expect(frames).toHaveLength(0);
    expect(container.querySelector('[data-ticking]')).toBeNull();

    // The beam is a line that is only ever drawn, so its finished state is the page without
    // it — which is the state `docs/design/prototype.html` draws.
    expect(container.querySelectorAll('[data-moment="beam"]')).toHaveLength(0);
    // The spotlight is a static ring: mounted, settled, and animated by nothing.
    const lit = container.querySelector('[data-moment="spotlight"]') as HTMLElement;
    expect(lit.dataset.durationMs).toBe('0');
    for (const element of container.querySelectorAll('[data-moment] *')) {
      expect(element.getAttribute('style'), element.outerHTML).toBeNull();
    }
    for (const moment of container.querySelectorAll('[data-moment]')) {
      expect(moment.getAttribute('data-duration-ms'), moment.outerHTML).toBe('0');
    }
  });

  it('mounts the heat bare, so the heatmap is simply there', async () => {
    prefersReducedMotion(true);
    const { container } = await openVerdict();

    expect(container.querySelectorAll('[data-overlay-layer="heat"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-moment="heat"]')).toHaveLength(0);
  });
});

describe('the assembled screen, with the moments mounted', () => {
  it('reports no axe violation', async () => {
    const { container } = await openVerdict();
    const violations = await axeViolations(container);

    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
