// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, serveRunData } from '../app';
import { paths } from '../../src/shell/paths';
import { AudienceLine, audienceSummary } from '../../src/screens/verdict/AudienceLine';
import { Headline } from '../../src/screens/verdict/Headline';
import { Reasons } from '../../src/screens/verdict/Reasons';
import { SEED_RUN_ID, seedRun, show, withVerdict } from './fixture';

/**
 * The answer, and the three things around it: who it is true of, what was tested, and why.
 *
 * The figures are `figures.test.tsx`; this file is the rest of the first strip of
 * `#screen-verdict` — the audience line, the headline sentence, the task sentence and the
 * reasons — plus the assertion that the screen stayed quiet: the friction score and its
 * workings are the Score breakdown screen's, and a test says so.
 */

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the headline sentence', () => {
  it('renders verdict.audienceSentence verbatim, as the screen’s one h1', () => {
    const run = seedRun();
    show(<Headline run={run} />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect((headings[0] as HTMLElement).textContent).toBe(run.verdict.audienceSentence);
  });

  it('follows the stored sentence rather than wording one of its own', () => {
    const sentence =
      'Your audience completes the purchase on the redesign, not on the current checkout.';
    show(<Headline run={withVerdict(seedRun(), { audienceSentence: sentence })} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(sentence);
  });

  it('names the task that was tested, so the figures have a verb attached', () => {
    const run = seedRun();
    const { container } = show(<Headline run={run} />);

    expect(container.textContent).toContain(`Task tested: “${run.task.prompt}”`);
    expect(container.textContent).toContain('Same audience, same people, both versions.');
  });

  it('says a run carries no verdict instead of inventing a sentence', () => {
    const run = withVerdict(seedRun(), { audienceSentence: '' });
    const { container } = show(<Headline run={run} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('missing its verdict sentence');
    // Nothing that reads as an answer: neither version is named, so no claim is made about
    // which one the audience completes.
    for (const variant of run.variants) {
      expect(heading.textContent, variant.name).not.toContain(variant.name);
    }
    // And the task is still on screen, so the figures beside it still mean something.
    expect(container.textContent).toContain(`Task tested: “${run.task.prompt}”`);
  });
});

describe('the audience line', () => {
  it('names the audience, its summary, the people it generated and the seed', () => {
    const { container } = show(<AudienceLine run={seedRun()} />);

    expect(container.textContent).toContain('Outdoor-gear shoppers');
    expect(container.textContent).toContain(
      '25–45 · mostly mobile · price-aware · United Kingdom & Ireland',
    );
    expect(container.textContent).toContain(
      '4 simulated people, generated from this audience with seed 20261024',
    );
  });

  it('links to the audience the test ran with', () => {
    const run = seedRun();
    show(<AudienceLine run={run} />);

    const audiencePath = paths.audience(run.audience.id);
    expect(screen.getByRole('link', { name: /Outdoor-gear shoppers/ }).getAttribute('href')).toBe(
      audiencePath,
    );
    expect(screen.getByRole('link', { name: 'Change audience' }).getAttribute('href')).toBe(
      audiencePath,
    );
  });

  it('reads the summary off the audience rather than off the example run', () => {
    const base = seedRun().audience;
    const desktop = base.devices[1] as (typeof base.devices)[number];

    expect(
      audienceSummary({
        ...base,
        ageRange: { min: 30, max: 60 },
        devices: [{ ...desktop, share: 1 }],
        priceSensitivity: 0.2,
        regions: ['Spain'],
      }),
    ).toBe('30–60 · desktop · price-insensitive · Spain');

    // A level mix leans no way, and a dial in the middle says so.
    expect(
      audienceSummary({
        ...base,
        devices: base.devices.map((device) => ({ ...device, share: 0.5 })),
        priceSensitivity: 0.5,
        regions: ['Spain', 'France', 'Italy'],
      }),
    ).toBe('25–45 · mobile and desktop · moderately price-aware · Spain, France & Italy');
  });
});

describe('the reasons', () => {
  it('renders the stored reasons under one quiet Why label', () => {
    const run = seedRun();
    const { container } = show(<Reasons run={run} />);

    expect(container.textContent).toContain('Why');
    for (const reason of run.verdict.reasons) {
      expect(container.textContent, reason).toContain(reason);
    }
    expect(container.querySelectorAll('.reason')).toHaveLength(run.verdict.reasons.length);
  });

  it('renders two and nothing else when an artifact carries three', () => {
    const third = 'A third reason the screen must not grow room for.';
    const run = withVerdict(seedRun(), {
      reasons: ['The first reason.', 'The second reason.', third],
    });
    const { container } = show(<Reasons run={run} />);

    expect(container.querySelectorAll('.reason')).toHaveLength(2);
    // Two reasons, and not a word about the one it left out: no count, no "and more".
    expect(container.textContent).toBe('WhyThe first reason.The second reason.');
  });

  it('renders no block at all when there is no reason, rather than an empty label', () => {
    const { container } = show(<Reasons run={withVerdict(seedRun(), { reasons: [] })} />);

    expect(container.querySelector('[data-section="reasons"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('what this screen does not show', () => {
  it('carries no friction score, no components and no spread: that is #107’s screen', async () => {
    const run = seedRun();
    await serveRunData();
    const { container } = mountApp(paths.run(SEED_RUN_ID));

    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).not.toBeNull();
    });

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/friction/i);
    // The score's own verdict line, its gap and its spread are all absent.
    expect(text).not.toContain(run.verdict.sentence);
    expect(text).not.toContain(`${run.verdict.gapPoints} points`);
    expect(text).not.toMatch(/bands (do not )?overlap/i);
    for (const component of [
      'Task failure rate',
      'Abandonment',
      'Time to first fixation',
      'Dead-end revisits',
    ]) {
      expect(text, component).not.toContain(component);
    }
    for (const score of run.scores) {
      expect(text, score.variant).not.toContain(String(score.frictionScore.median));
    }
  });
});
