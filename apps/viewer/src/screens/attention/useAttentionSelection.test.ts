// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { patterns, paths } from '@/shell/paths';
import { forgetRuns, readRunFile, serveRunData } from '../../../tests/app';
import { resolveSelection, useAttentionSelection } from './useAttentionSelection';
import '../../../tests/setup';

/**
 * The Attention screen's selection: the URL, checked against the run.
 *
 * Two halves. The first is the resolver on its own — what a link that asks for something
 * this test never ran is answered with, and the sentence the reader is given. The second is
 * the hook writing the URL back: what survives a version switch, what a step change drops,
 * and where isolating an area puts it.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const asked = (variant: string, step: string, aoi: string | null = null) => ({
  variant,
  step,
  aoi,
});

describe('a link that names a version, a step and an area this test has', () => {
  it('is used exactly as it was asked for, and states nothing', () => {
    expect(resolveSelection(seedRun(), asked('B', 'review', 'B-review-complete'))).toEqual({
      variant: 'B',
      step: 'review',
      aoi: 'B-review-complete',
      fallback: null,
    });
  });

  it('is passed through untouched while the run is still being read', () => {
    expect(resolveSelection(null, asked('Z', 'nowhere', 'nothing'))).toEqual({
      variant: 'Z',
      step: 'nowhere',
      aoi: 'nothing',
      fallback: null,
    });
  });
});

describe('a link that names a version this test never ran', () => {
  it('shows the first version and says which was asked for', () => {
    const { variant, fallback } = resolveSelection(seedRun(), asked('C', 'review'));

    expect(variant).toBe('A');
    expect(fallback).toEqual({
      what: 'variant',
      given: 'C',
      used: 'A',
      sentence: 'This test has no version “C”. Showing Current checkout, the first version it ran.',
    });
  });
});

describe('a link that names a step this test has no screen for', () => {
  it('shows the earliest step and says which was asked for', () => {
    const { step, fallback } = resolveSelection(seedRun(), asked('B', 'delivery'));

    expect(step).toBe('cart');
    expect(fallback).toEqual({
      what: 'step',
      given: 'delivery',
      used: 'cart',
      sentence:
        'This test has no step “delivery”. Showing Cart, the earliest step your audience reached.',
    });
  });
});

describe('an ?aoi= that names no area of this version’s step', () => {
  it('is dropped, and the screen says what was asked for and what is shown', () => {
    const { aoi, fallback } = resolveSelection(seedRun(), asked('B', 'review', 'a-box-elsewhere'));

    expect(aoi).toBeNull();
    expect(fallback).toEqual({
      what: 'aoi',
      given: 'a-box-elsewhere',
      used: null,
      sentence:
        'There is no area “a-box-elsewhere” on Redesign candidate at the Review step. Showing every area.',
    });
  });

  it('is dropped when it names an area of another step, even on this version', () => {
    const { aoi, fallback } = resolveSelection(seedRun(), asked('B', 'review', 'B-cart-promo'));

    expect(aoi).toBeNull();
    expect(fallback?.used).toBeNull();
  });
});

describe('an ?aoi= that names the same area on the other version', () => {
  it('isolates this version’s own, so the moment can be read on A and on B', () => {
    // Arriving on the redesign with the current checkout's completing action isolated:
    // the two are one area to a reader and two rows in the artifact.
    const { aoi, fallback } = resolveSelection(
      seedRun(),
      asked('B', 'review', 'A-review-complete'),
    );

    expect(aoi).toBe('B-review-complete');
    expect(fallback).toEqual({
      what: 'aoi',
      given: 'A-review-complete',
      used: 'B-review-complete',
      sentence:
        '“Completing action — A: "Place order", B: "Confirm purchase"” is a different area on each version. Showing the one on Redesign candidate.',
    });
  });

  it('is dropped when this version has no area of that name at all', () => {
    // The promo banner the redesign added: the current checkout has nothing to isolate.
    const { aoi, fallback } = resolveSelection(seedRun(), asked('A', 'review', 'B-review-promo'));

    expect(aoi).toBeNull();
    expect(fallback?.sentence).toContain('Showing every area.');
  });
});

describe('the hook writing the URL back', () => {
  let seen = '';

  function Probe() {
    const location = useLocation();
    seen = `${location.pathname}${location.search}`;
    return null;
  }

  const at = (path: string) => {
    seen = path;
    return renderHook(useAttentionSelection, {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: patterns.attention,
              element: createElement(Fragment, null, createElement(Probe), children),
            }),
          ),
        ),
    });
  };

  beforeEach(async () => {
    await serveRunData();
  });
  afterEach(forgetRuns);

  it('reads the version, the step and the isolated area out of the URL', async () => {
    const view = at(`${paths.attention(RUN_ID, 'B', 'review')}?aoi=B-review-complete`);

    await waitFor(() => {
      expect(view.result.current.fallback).toBeNull();
    });
    expect(view.result.current).toMatchObject({
      runId: RUN_ID,
      variant: 'B',
      step: 'review',
      aoi: 'B-review-complete',
    });
  });

  it('keeps the step and the isolated area when the version changes', async () => {
    const view = at(`${paths.attention(RUN_ID, 'B', 'review')}?aoi=B-review-complete`);
    await waitFor(() => {
      expect(view.result.current.aoi).toBe('B-review-complete');
    });

    act(() => {
      view.result.current.setVariant('A');
    });

    expect(seen).toBe(`${paths.attention(RUN_ID, 'A', 'review')}?aoi=B-review-complete`);
    // And the area it carried in is read as the current checkout's own.
    await waitFor(() => {
      expect(view.result.current.aoi).toBe('A-review-complete');
    });
  });

  it('goes nowhere when the version already shown is pressed again', async () => {
    const view = at(paths.attention(RUN_ID, 'B', 'review'));
    await waitFor(() => {
      expect(view.result.current.variant).toBe('B');
    });

    act(() => {
      view.result.current.setVariant('B');
    });

    expect(seen).toBe(paths.attention(RUN_ID, 'B', 'review'));
  });

  it('drops the isolated area when the step changes, because an area belongs to a step', async () => {
    const view = at(`${paths.attention(RUN_ID, 'B', 'review')}?aoi=B-review-complete`);
    await waitFor(() => {
      expect(view.result.current.aoi).toBe('B-review-complete');
    });

    act(() => {
      view.result.current.setStep('cart');
    });

    expect(seen).toBe(paths.attention(RUN_ID, 'B', 'cart'));
    expect(view.result.current.aoi).toBeNull();
  });

  it('puts an isolated area in the query string, and takes it out again', async () => {
    const view = at(paths.attention(RUN_ID, 'B', 'review'));
    await waitFor(() => {
      expect(view.result.current.variant).toBe('B');
    });

    act(() => {
      view.result.current.setAoi('B-review-fee-row');
    });
    expect(seen).toBe(`${paths.attention(RUN_ID, 'B', 'review')}?aoi=B-review-fee-row`);

    act(() => {
      view.result.current.setAoi(null);
    });
    expect(seen).toBe(paths.attention(RUN_ID, 'B', 'review'));
  });
});
