// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { readRunFile } from '../../../tests/app';
import { attentionAreas } from './useAttentionAreas';
import type { AttentionArea } from './useAttentionAreas';
import { fixationsOnStep, reachedStep, saccadesOnStep } from './useAttentionStepSessions';
import type { AttentionStepSessions } from './useAttentionStepSessions';
import { ThisStepPanel } from './ThisStepPanel';
import '../../../tests/setup';

/**
 * The "This step" readings, over the repository's own committed example run.
 *
 * Every figure asserted here was worked out from the session files on disk, so the test
 * says what a designer reads — "15 median per session", "9 of 11" — rather than restating
 * the arithmetic the component does.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const layout = runPaths('');

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

/** The hook's answer for one version and one step, read straight off the run directory. */
function stepSessions(run: Run, variant: string, step: string): AttentionStepSessions {
  const sessions = run.sessionIds
    .map((sessionId) => sessionSchema.parse(readRunFile(RUN_ID, layout.session(sessionId))))
    .filter(
      (session: Session) => session.variant === variant && !session.outcome.excludedFromScores,
    );
  return {
    status: 'ready',
    error: null,
    sessions,
    fixations: sessions.flatMap((session) => fixationsOnStep(session, step)),
    saccades: sessions.flatMap((session) => saccadesOnStep(session, step)),
    reachedCount: sessions.filter((session) => reachedStep(session, step)).length,
    scoredSessionCount:
      run.scores.find((score) => score.variant === variant && score.taskId === run.task.id)
        ?.scoredSessionCount ?? 0,
  };
}

const stepOf = (run: Run, step: string) =>
  run.steps.find((candidate) => candidate.id === step) as Run['steps'][number];

/** What the panel reads for one heading, so a test asserts a reading and not a layout. */
const reading = (term: string): string =>
  screen.getByText(term, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

const panel = (options: {
  run: Run;
  step: string;
  variant: string;
  isolated?: AttentionArea | null;
  sessions?: AttentionStepSessions;
}) => {
  const { run, step, variant } = options;
  const { areas } = attentionAreas(run, variant, step);
  return render(
    <ThisStepPanel
      step={stepOf(run, step)}
      sessions={options.sessions ?? stepSessions(run, variant, step)}
      areas={areas}
      isolated={options.isolated ?? null}
    />,
  );
};

describe('the readings of one step', () => {
  it('states the medians, the earliest area, the reach and that nothing is isolated', () => {
    panel({ run: seedRun(), variant: 'B', step: 'review' });

    expect(reading('Fixations')).toBe('15 median per session');
    expect(reading('Total dwell')).toBe('6.9 s');
    expect(reading('Earliest area')).toBe('Order summary');
    expect(reading('Reached this step')).toBe('9 of 11');
    expect(reading('Isolated')).toBe('all areas');
  });

  it('takes the median over the people who reached the step, not over everybody scored', () => {
    // Eleven people were scored on the redesign and nine reached the review step. Counting
    // the other two as zeros would halve every reading on this panel and read as an
    // audience that barely looked, rather than one that never arrived.
    panel({ run: seedRun(), variant: 'B', step: 'review' });

    expect(reading('Reached this step')).toBe('9 of 11');
    expect(reading('Fixations')).toBe('15 median per session');
  });

  it('never calls a never-fixated area the earliest one', () => {
    // Half the areas of this step carry a null time to first fixation: nobody ever looked
    // at them. A null is not a zero, and the earliest area is one somebody did look at.
    panel({ run: seedRun(), variant: 'B', step: 'review' });

    expect(reading('Earliest area')).toBe('Order summary');
  });
});

describe('with one area isolated', () => {
  it('narrows the two medians to that area and names it', () => {
    const run = seedRun();
    const { areas } = attentionAreas(run, 'B', 'review');
    const fee = areas.find((area) => area.aoi.id === 'B-review-fee-row') as AttentionArea;

    panel({ run, variant: 'B', step: 'review', isolated: fee });

    expect(reading('Fixations')).toBe('4 median per session');
    expect(reading('Total dwell')).toBe('2.3 s');
    expect(reading('Isolated')).toBe('Service fee row — planted defect');
  });
});

describe('before the sessions are there', () => {
  const nothing: AttentionStepSessions = {
    status: 'loading',
    error: null,
    sessions: [],
    fixations: [],
    saccades: [],
    reachedCount: 0,
    scoredSessionCount: 11,
  };

  it('says it is reading rather than printing a zero that will change', () => {
    panel({ run: seedRun(), variant: 'B', step: 'review', sessions: nothing });

    expect(reading('Fixations')).toBe('reading the sessions…');
    expect(reading('Reached this step')).toBe('reading the sessions…');
  });

  it('reads none once they are there and nobody reached the step', () => {
    panel({
      run: seedRun(),
      variant: 'B',
      step: 'review',
      sessions: { ...nothing, status: 'ready' },
    });

    expect(reading('Fixations')).toBe('none');
    expect(reading('Reached this step')).toBe('0 of 11');
  });
});
