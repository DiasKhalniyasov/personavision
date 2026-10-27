// @vitest-environment jsdom
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { runPaths, sessionSchema } from '@personavision/contract';
import type { Session } from '@personavision/contract';
import { paths } from '@/shell/paths';
import { forgetRuns, readRunFile, serveRunData } from '../../../tests/app';
import {
  fixationsOnStep,
  reachedStep,
  saccadesOnStep,
  useAttentionStepSessions,
} from './useAttentionStepSessions';
import '../../../tests/setup';

/**
 * The people one step's aggregate is made of, over the repository's own committed example
 * run: 24 sessions, two versions, two of them lost to our own automation.
 *
 * The figures asserted here are the ones the screen prints beside a heatmap, so what they
 * are worth is exactly whether they come from the right population — this version, scored
 * only, this step — and whether the screen is told when a file could not be read instead of
 * being handed a shorter aggregate.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');

/** One person's session file of the committed run, parsed by the contract that declares it. */
const oneSession = (sessionId: string): Session =>
  sessionSchema.parse(readRunFile(RUN_ID, layout.session(sessionId)));

describe('what one session did on one step', () => {
  it('counts a step as reached when the session stood on one of its screens', () => {
    // S-15 is the rushed buyer on the redesign: cart, payment, review, and no further.
    const session = oneSession('S-15');

    expect(reachedStep(session, 'review')).toBe(true);
    expect(reachedStep(session, 'confirm')).toBe(false);
  });

  it('takes the fixations recorded on that step, and no others', () => {
    const session = oneSession('S-15');

    const here = fixationsOnStep(session, 'review');

    expect(here.map((fixation) => fixation.index)).toEqual([19, 20, 21, 22]);
    // Fixation indexes run continuously across the whole session, so the ones on this step
    // are a window into it rather than a list starting at zero.
    expect(here.length).toBeLessThan(session.fixations.length);
  });

  it('takes only the moves whose both ends are fixations of that step', () => {
    const session = oneSession('S-15');

    const moves = saccadesOnStep(session, 'review');

    // Four fixations are joined by three moves; the move into the first of them starts on
    // the step before, where this view draws nothing.
    expect(moves).toHaveLength(3);
    const here = new Set(fixationsOnStep(session, 'review').map((fixation) => fixation.index));
    for (const move of moves) {
      expect(here.has(move.fromFixation) && here.has(move.toFixation)).toBe(true);
    }
  });
});

describe('the aggregate of one version’s step', () => {
  afterEach(forgetRuns);

  const at = (path: string, variant: string, step: string) =>
    renderHook(() => useAttentionStepSessions(variant, step), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(MemoryRouter, { initialEntries: [path] }, children),
    });

  const review = () => at(paths.attention(RUN_ID, 'B', 'review'), 'B', 'review');

  it('is loading until every session has settled, then ready', async () => {
    await serveRunData();
    const view = review();

    expect(view.result.current.status).toBe('loading');
    await waitFor(() => {
      expect(view.result.current.status).toBe('ready');
    });
  });

  it('covers this version’s scored people only, and says how many the run scored', async () => {
    await serveRunData();
    const view = review();

    await waitFor(() => {
      expect(view.result.current.status).toBe('ready');
    });
    const { sessions, scoredSessionCount, reachedCount } = view.result.current;

    // 12 sessions ran on the redesign; our own automation broke one of them, and the run
    // scored the other 11. Nine of those got as far as the review step.
    expect(sessions).toHaveLength(11);
    expect(sessions.map((session) => session.sessionId)).not.toContain('S-23');
    expect(sessions.every((session) => session.variant === 'B')).toBe(true);
    expect(scoredSessionCount).toBe(11);
    expect(reachedCount).toBe(9);
  });

  it('carries the fixations and saccades of those people on that step, and no others', async () => {
    await serveRunData();
    const view = review();

    await waitFor(() => {
      expect(view.result.current.status).toBe('ready');
    });
    const { fixations, saccades } = view.result.current;

    expect(fixations).toHaveLength(116);
    expect(saccades).toHaveLength(107);
    // A fixation on the review step is one of the review screens', which is what keeps the
    // heatmap over the page the aggregate is about.
    const onReview = view.result.current.sessions.flatMap((session) =>
      session.screens.filter((screen) => screen.step === 'review').map((screen) => screen.index),
    );
    expect(fixations.every((fixation) => onReview.includes(fixation.screenIndex))).toBe(true);
  });

  it('re-projects for another step without reading a file again', async () => {
    const served = await serveRunData();
    const view = at(paths.attention(RUN_ID, 'B', 'cart'), 'B', 'cart');
    await waitFor(() => {
      expect(view.result.current.status).toBe('ready');
    });
    const read = served.requests.filter((path) => path.includes(layout.sessionsDir)).length;

    view.rerender();

    expect(view.result.current.reachedCount).toBe(11);
    expect(served.requests.filter((path) => path.includes(layout.sessionsDir))).toHaveLength(read);
  });

  it('says which file could not be read rather than averaging a shorter audience', async () => {
    const broken = `/runs/${RUN_ID}/${layout.session('S-13')}`;
    await serveRunData({ files: { [broken]: 'this is not an artifact' } });
    const view = review();

    await waitFor(() => {
      expect(view.result.current.status).toBe('error');
    });
    expect(view.result.current.error).toContain(layout.session('S-13'));
    expect(view.result.current.sessions).toEqual([]);
  });
});
