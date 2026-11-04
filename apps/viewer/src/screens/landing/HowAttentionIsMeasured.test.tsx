// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../../tests/setup';
import { axeViolations, describeViolations } from '../../../tests/axe';
import {
  CAN_BE_USED_TO_FIT,
  EYETRACKER_URL,
  HowAttentionIsMeasured,
  MEASURED_HEADING,
} from './HowAttentionIsMeasured';

/**
 * *Where the heatmaps come from*, and above all: what it may not say.
 *
 * The owner's constraint on this section (#431) is that its claims stay true to what the
 * repository contains. Two of them are a standing temptation to inflate — that the engine
 * is fitted on human gaze, and a human-likeness figure to go with it — so they are pinned
 * here. **A later change that quietly upgrades the claim fails these tests**, which is the
 * whole point of them: the words are the acceptance, not a comment.
 *
 * The facts behind the pins, both checked against the repository rather than remembered:
 * `docs/calibration/report.md` says in its own heading that today's figures are measured
 * over a committed synthetic stand-in corpus, and
 * `packages/calibration/src/dataset/manifest.json` still records
 * `verifiedAgainstArchive: false`.
 */

const mount = () => render(<HowAttentionIsMeasured />);

/** Everything a reader of the section reads, as one string. */
const sectionText = (container: HTMLElement): string => {
  const section = container.querySelector('[data-section="landing-measured"]');
  if (section === null) throw new Error('the section is not on the page');
  return section.textContent ?? '';
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** A file of this repository, by its path from the root. */
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

describe('the four stages', () => {
  it('names them in order, each numbered', () => {
    const { container } = mount();

    expect(screen.getByRole('heading', { level: 2, name: MEASURED_HEADING })).toBeTruthy();
    const stages = [...container.querySelectorAll('[data-section="landing-measured"] li')];
    expect(stages.map((stage) => stage.querySelector('h3')?.textContent)).toEqual([
      'Real people, recorded locally',
      'Their gaze teaches the agents',
      'Generated people test the site',
      'What you get',
    ]);
    expect(stages.map((stage) => stage.querySelector('p')?.textContent)).toEqual([
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'Stage 4',
    ]);
  });

  it('names Muse Spark on stage 3 and Muse Wonder on stage 4', () => {
    const { container } = mount();
    const text = sectionText(container);

    expect(text).toContain('Muse Spark');
    expect(text).toContain('Muse Wonder');
  });
});

describe('the claims, which are the acceptance', () => {
  it('says the recordings “can be used to fit” small models, in those words', () => {
    const { container } = mount();

    expect(sectionText(container)).toContain(CAN_BE_USED_TO_FIT);
  });

  it('says no model fitted on human gaze ships today', () => {
    const { container } = mount();

    expect(sectionText(container)).toContain('No model fitted on human gaze ships today.');
  });

  it('claims no fitted model, however the sentence is phrased', () => {
    const { container } = mount();
    // Each of these is a sentence that would say a model fitted on human gaze is what runs
    // today. None of them may appear while `verifiedAgainstArchive` is false.
    for (const claim of [
      /\bis fitted on (?:real )?human gaze\b/i,
      /\bare fitted on (?:real )?human gaze\b/i,
      /\bfitted on (?:real )?human gaze\b(?![^.]*\bships\b)/i,
      /\btrained on (?:real )?human (?:gaze|eye)\b/i,
      /\blearn(?:ed|s|t)? from (?:real )?human gaze\b/i,
      /\bmatches human gaze\b/i,
      /\bas accurate as (?:a )?human\b/i,
    ]) {
      expect(sectionText(container), String(claim)).not.toMatch(claim);
    }
  });

  it('prints no gaze-similarity figure, and no figure at all', () => {
    const { container } = mount();
    const text = sectionText(container);

    // The header badge is where a number belongs, with the run's own calibration block
    // behind it. Here there is nothing to be a figure: no metric is named, and nothing in
    // the section reads as a decimal, a percentage or a score.
    for (const figure of [
      /\b\d+(?:\.\d+)?\s*%/,
      /\b\d+\.\d+\b/,
      /\bsimilarity\b/i,
      /\bcorrelation\b/i,
      /\b(?:AUC|NSS|KLD|CC|SIM|ScanMatch|MultiMatch)\b/,
    ]) {
      expect(text, String(figure)).not.toMatch(figure);
    }
    // The only digits a reader sees are the stage numbers.
    expect(text.match(/\d+/g)).toEqual(['1', '2', '3', '4']);
  });

  it('names packages/calibration as where the comparison lives, over a stand-in corpus', () => {
    const { container } = mount();
    const text = sectionText(container);

    expect(text).toContain('packages/calibration');
    expect(text).toContain('comparison against human eye tracking');
    expect(text).toContain('synthetic stand-in corpus');
  });

  it('is pinned to a repository where nothing is yet verified against the archive', () => {
    // If this ever becomes true, the two pins above are the ones to revisit — the claim may
    // then be allowed to grow, and the test should be the thing that says so.
    const manifest = JSON.parse(read('packages/calibration/src/dataset/manifest.json')) as {
      readonly datasets?: readonly { readonly verifiedAgainstArchive?: boolean }[];
    };
    const flags = JSON.stringify(manifest);

    expect(flags).toContain('"verifiedAgainstArchive":false');
    expect(read('docs/calibration/report.md')).toContain('synthetic');
  });
});

describe('the eye tracker stage 1 links', () => {
  it('points at tools/eyetrack on main', () => {
    mount();

    const link = screen.getByRole('link', { name: 'Try the eye tracker' });
    expect(link.getAttribute('href')).toBe(EYETRACKER_URL);
    expect(EYETRACKER_URL).toBe(
      'https://github.com/DiasKhalniyasov/personavision/tree/main/tools/eyetrack',
    );
  });

  it('points at a path this repository has', () => {
    expect(read('tools/eyetrack/calibrate/index.html').length).toBeGreaterThan(0);
  });
});

describe('the drawings', () => {
  it('draws four of them inline, each with a text alternative that says what it shows', () => {
    const { container } = mount();

    const drawings = [...container.querySelectorAll('svg')];
    expect(drawings).toHaveLength(4);
    const alternatives = screen.getAllByRole('img').map((img) => img.getAttribute('aria-label'));
    expect(alternatives).toHaveLength(4);
    for (const alternative of alternatives) {
      expect(alternative, 'a drawing with no text alternative').toBeTruthy();
      // Not "diagram" or "image": what it shows.
      expect((alternative as string).length).toBeGreaterThan(30);
    }
    expect(alternatives[0]).toContain('gaze');
    expect(alternatives[1]).toContain('model');
    expect(alternatives[2]).toContain('people');
    expect(alternatives[3]).toContain('path');
  });

  it('fetches nothing: no image file, no third-party host', () => {
    const { container } = mount();

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('image')).toHaveLength(0);
    const source = read('apps/viewer/src/screens/landing/HowAttentionIsMeasured.tsx');
    // The one URL in the component is the eye tracker's, and it is an href a reader clicks.
    expect([...source.matchAll(/https?:\/\/[^'"\s)]+/g)].map((match) => match[0])).toEqual([
      EYETRACKER_URL,
    ]);
    expect(source).not.toMatch(/\burl\(/);
    expect(source).not.toMatch(/<(?:img|image|iframe|script)\b/);
  });

  it('carries no colour of its own: every one is a token', () => {
    const source = read('apps/viewer/src/screens/landing/HowAttentionIsMeasured.tsx');
    // Colour lives in `landing.module.css`, which `tests/skeleton.test.ts` holds to tokens
    // app-wide; what this asserts is that the markup does not route around it.
    // Without the comments, where `#431` and its siblings are ticket numbers rather than
    // colours and the only `#` on the file.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:fill|stroke)=["'](?!none)/);
    expect(source).not.toMatch(/\bstyle=\{\{/);

    const css = read('apps/viewer/src/screens/landing/landing.module.css');
    const drawing = /\.draw[A-Za-z]+\s*\{[^}]*\}/g;
    const blocks = [...css.matchAll(drawing)].map((match) => match[0]);
    expect(blocks.length).toBeGreaterThanOrEqual(9);
    for (const block of blocks) {
      for (const declaration of block.split(';').slice(0, -1)) {
        const [property, value] = declaration.split(':').map((part) => part.trim());
        if (property === undefined || value === undefined) continue;
        // The colour-carrying properties only: a line cap is geometry, not a colour.
        if (!['fill', 'stroke', 'color', 'background', 'background-color'].includes(property))
          continue;
        expect(value, `${property}: ${value}`).toMatch(/^(?:var\(--|none$)/);
      }
    }
  });
});

describe('accessibility', () => {
  it('passes axe, and adds no h1', async () => {
    const { container } = mount();

    expect(container.querySelectorAll('h1')).toHaveLength(0);
    const violations = await axeViolations(container);
    expect(describeViolations(violations)).toBe('');
  });

  it('renders complete and still on first paint under prefers-reduced-motion', () => {
    // The setup's stub matches nothing, which is a reader who has set no preference; this
    // test is about the reader who has asked for reduced motion.
    const reduced = (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    const original = globalThis.matchMedia;
    globalThis.matchMedia = reduced as typeof globalThis.matchMedia;
    try {
      const { container } = mount();

      // Everything, synchronously, with no waiting: the section has no entrance at all.
      expect(sectionText(container)).toContain('No model fitted on human gaze ships today.');
      expect(sectionText(container)).toContain(CAN_BE_USED_TO_FIT);
      expect(container.querySelectorAll('svg')).toHaveLength(4);
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it('declares no animation and no transition of its own', () => {
    const css = read('apps/viewer/src/screens/landing/landing.module.css');
    // This section's own rules, not the file's: a sibling's band is not this test's business.
    const own = [...css.matchAll(/\.(?:measured|stage|drawing|draw[A-Z])[A-Za-z]*[^{]*\{[^}]*\}/g)]
      .map((match) => match[0])
      .join('\n');
    expect(own.length).toBeGreaterThan(0);
    expect(own).not.toMatch(/animation|transition|@keyframes/);

    const source = read('apps/viewer/src/screens/landing/HowAttentionIsMeasured.tsx');
    expect(source).not.toMatch(
      /from '(?:motion|framer-motion)'|useReducedMotion|requestAnimationFrame/,
    );
  });
});
