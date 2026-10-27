// @vitest-environment jsdom
import { createElement } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, readRunFile, serveRunData } from '../../../tests/app';
import { attentionAreas, useAttentionAreas } from './useAttentionAreas';
import '../../../tests/setup';

/**
 * The areas of one version's step, joined to their numbers, over the repository's own
 * committed example run. What is asserted is the join and the three gaps it refuses to
 * hide — never a count of rows for its own sake.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const labels = (areas: { aoi: { label: string } }[]): string[] =>
  areas.map((area) => area.aoi.label);

describe('the areas of one version’s step', () => {
  it('takes only this version’s areas, in the artifact’s order', () => {
    const run = seedRun();

    const { areas } = attentionAreas(run, 'A', 'review');

    expect(labels(areas)).toEqual([
      'Cart badge',
      'Shipping address row',
      'Payment method row',
      'Completing action — A: "Place order", B: "Confirm purchase"',
      'Order summary',
      'Trust badges',
      '"Need help?" link',
    ]);
  });

  it('joins each area to the numbers the pipeline stored for it', () => {
    const run = seedRun();

    const { areas } = attentionAreas(run, 'B', 'review');
    const complete = areas.find((area) => area.aoi.id === 'B-review-complete');

    // The area at the centre of the whole demo: the completing action nobody ever looked
    // at. A never-fixated area is a `null` time and a zero share, and both come from the
    // artifact rather than from anything worked out here.
    expect(complete?.metric).toMatchObject({
      timeToFirstFixationMs: null,
      lookedAtShare: 0,
    });
  });

  it('leaves an area the run recorded no numbers for on the screen, with a stated gap', () => {
    const run = seedRun();
    const without: Run = {
      ...run,
      aoiMetrics: run.aoiMetrics.filter((metric) => metric.aoiId !== 'B-review-complete'),
    };

    const { areas } = attentionAreas(without, 'B', 'review');

    expect(areas.find((area) => area.aoi.id === 'B-review-complete')?.metric).toBeNull();
    expect(labels(areas)).toContain('Completing action — A: "Place order", B: "Confirm purchase"');
  });
});

describe('what only the other version has', () => {
  it('names the areas of this step the redesign added, by the name both versions use', () => {
    const run = seedRun();

    const { presentOnOtherVariantOnly } = attentionAreas(run, 'A', 'review');

    expect(presentOnOtherVariantOnly.map((aoi) => aoi.label)).toEqual([
      'Promo banner',
      'Service fee row — planted defect',
    ]);
  });

  it('names nothing when this version has every area of the step', () => {
    const run = seedRun();

    expect(attentionAreas(run, 'B', 'review').presentOnOtherVariantOnly).toEqual([]);
  });
});

describe('a metrics row that names no area', () => {
  it('is surfaced rather than dropped, so a figure attached to nothing is visible', () => {
    const run = seedRun();
    const orphaned: Run = {
      ...run,
      aoiMetrics: [
        ...run.aoiMetrics,
        {
          aoiId: 'B-review-a-box-that-is-not-there',
          timeToFirstFixationMs: 120,
          firstFixationDurationMs: 90,
          totalDwellMs: 400,
          fixationCount: 2,
          revisits: 0,
          lookedAtShare: 0.5,
          sessionCount: 11,
        },
      ],
    };

    expect(attentionAreas(orphaned, 'B', 'review').unknownMetricAoiIds).toEqual([
      'B-review-a-box-that-is-not-there',
    ]);
  });

  it('is empty for the committed run, whose every metrics row names an area', () => {
    expect(attentionAreas(seedRun(), 'B', 'review').unknownMetricAoiIds).toEqual([]);
  });
});

describe('the hook over the run the route is about', () => {
  afterEach(forgetRuns);

  const at = (path: string) =>
    renderHook(
      ({ variant, step }: { variant: string; step: string }) => useAttentionAreas(variant, step),
      {
        initialProps: { variant: 'B', step: 'review' },
        wrapper: ({ children }) =>
          createElement(MemoryRouter, { initialEntries: [path] }, children),
      },
    );

  it('reads the areas of the run the URL names, and follows a change of step', async () => {
    await serveRunData();
    const view = at(paths.attention(RUN_ID, 'B', 'review'));

    await waitFor(() => {
      expect(labels([...view.result.current.areas])).toContain('Service fee row — planted defect');
    });

    view.rerender({ variant: 'B', step: 'cart' });
    expect(labels([...view.result.current.areas])).toContain('Promo banner');
    expect(labels([...view.result.current.areas])).not.toContain(
      'Service fee row — planted defect',
    );
  });

  it('has no areas before the run has been read', () => {
    const view = at(paths.attention(RUN_ID, 'B', 'review'));

    expect(view.result.current.areas).toEqual([]);
  });
});
