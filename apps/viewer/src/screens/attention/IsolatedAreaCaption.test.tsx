// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPaths, runSchema, sessionSchema } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { paths, sessionsWithArea } from '@/shell/paths';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../../../tests/app';
import { axeViolations, describeViolations } from '../../../tests/axe';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';
import { IsolatedAreaCaption } from './IsolatedAreaCaption';
import { attentionAreas } from './useAttentionAreas';
import type { AttentionArea } from './useAttentionAreas';
import { fixationsOnStep, reachedStep, saccadesOnStep } from './useAttentionStepSessions';
import type { AttentionStepSessions } from './useAttentionStepSessions';

/**
 * Isolating one area of interest, over the repository's own committed example run.
 *
 * The reading this file exists for is on variant B's review step, where the button that
 * completes the order was never looked at. The sentence that says so is asserted **word for
 * word**: it is the moment `docs/FLOW.md` section 7 turns on, and a word of it rewritten
 * somewhere else in the application is the one regression a shape-matching test would let
 * through.
 *
 * Nothing here reads a canvas. What is asserted is the words, the selected row, the URL and
 * the link out of the caption.
 */

const RUN_ID = '2026-10-24-1402-northwind-demo';
const HEADING = 'Where your audience looked';
const layout = runPaths('');

/** The area nobody on the redesign ever fixated, and the one a third of the looks went to. */
const NEVER_FIXATED = 'B-review-complete';
const FIXATED = 'B-review-fee-row';

const seedRun = (): Run => runSchema.parse(readRunFile(RUN_ID));

const areaOf = (run: Run, aoiId: string): AttentionArea => {
  const aoi = run.aois.find((candidate) => candidate.id === aoiId) as Run['aois'][number];
  const { areas } = attentionAreas(run, aoi.variant, aoi.step);
  return areas.find((candidate) => candidate.aoi.id === aoiId) as AttentionArea;
};

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
    scoredSessionCount: 0,
  };
}

/** The caption alone, over people the test has already read. */
const caption = (options: {
  run: Run;
  isolated: AttentionArea | null;
  variant?: string;
  sessions?: AttentionStepSessions;
}) => {
  const { run, isolated } = options;
  const variant = options.variant ?? 'B';
  const step = isolated?.aoi.step ?? 'review';
  return render(
    <MemoryRouter>
      <IsolatedAreaCaption
        runId={run.runId}
        variant={variant}
        isolated={isolated}
        sessions={options.sessions ?? stepSessions(run, variant, step)}
      />
    </MemoryRouter>,
  );
};

const captionIn = (container: HTMLElement): HTMLElement =>
  container.querySelector('#att-caption') as HTMLElement;

const said = (container: HTMLElement): string => captionIn(container).textContent ?? '';

const attention = (variant: string, step: string, query = '') =>
  mountApp(`${paths.attention(RUN_ID, variant, step)}${query}`);

/** The committed run with something changed in it, served in its place. */
const serveChangedRun = async (change: (run: Run) => Run) => {
  await serveRunData({
    files: { [`/runs/${RUN_ID}/run.json`]: JSON.stringify(change(seedRun())) },
  });
};

/** The outlines, which are off until a reader asks for them. */
const showOutlines = async (container: HTMLElement) => {
  decoded(container);
  await userEvent.click(screen.getByRole('button', { name: /Areas of interest/ }));
};

const boxFor = (container: HTMLElement, aoiId: string): SVGRectElement =>
  container.querySelector(`[data-aoi="${aoiId}"]`) as SVGRectElement;

/** The screen, once the run and its people have been read. */
const settled = async () => {
  await screen.findByRole('heading', { level: 1, name: HEADING });
  await waitFor(() => {
    expect(screen.getByText('Reached this step').nextElementSibling?.textContent).not.toContain(
      'reading',
    );
  });
};

const rowFor = (container: HTMLElement, aoiId: string): HTMLElement =>
  container.querySelector(`tr[data-aoi-row="${aoiId}"]`) as HTMLElement;

/** The page as it is once its screenshot has arrived, which jsdom never does on its own. */
const decoded = (container: HTMLElement) => {
  fireEvent.load(container.querySelector('#att-page img') as HTMLImageElement);
};

/** The step the filmstrip moves to, by the id the artifact gives it. */
const stepFrame = (step: string): HTMLElement =>
  screen.getByRole('group', { name: 'Step' }).querySelector(`[data-step="${step}"]`) as HTMLElement;

/** The area's own name, which is the control that isolates its row. */
const rowButton = (container: HTMLElement, aoiId: string): HTMLElement =>
  rowFor(container, aoiId).querySelector('button') as HTMLElement;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the sentence when nobody looked', () => {
  it('is the finding in words, and not a figure of any kind', () => {
    const run = seedRun();
    const { container } = caption({ run, isolated: areaOf(run, NEVER_FIXATED) });

    expect(said(container)).toBe(
      'No fixation ever landed in “Completing action — A: "Place order", B: "Confirm purchase"” ' +
        'on variant B. 0 of 9 people in your audience who reached this step looked at it. ' +
        'Nothing is missing from the data: the area was simply never seen.',
    );
  });

  it('marks the whole sentence, and takes the mark’s colour from the tokens', () => {
    const run = seedRun();
    const { container } = caption({ run, isolated: areaOf(run, NEVER_FIXATED) });
    const marked = captionIn(container).querySelector('span') as HTMLElement;
    const stylesheet = join(dirname(fileURLToPath(import.meta.url)), 'isolatedArea.module.css');
    const rule = ruleIn(rulesOf(readFileSync(stylesheet, 'utf8')));

    expect(marked.textContent).toBe(said(container));
    // The prototype's `.nofix`: the same critical colour the table's `never` cell carries.
    expect(rule('.nofix')['color']).toBe('var(--sev-critical)');
    expect(rule('.nofix')['font-weight']).toBe('var(--weight-semibold)');
  });

  it('offers no list of the people who fixated it, because there are none', () => {
    const run = seedRun();
    const { container } = caption({ run, isolated: areaOf(run, NEVER_FIXATED) });

    expect(captionIn(container).querySelector('a')).toBeNull();
  });
});

describe('the caption for an area the audience did look at', () => {
  it('counts its fixations against the step’s, in the prototype’s words', () => {
    const run = seedRun();
    const { container } = caption({ run, isolated: areaOf(run, FIXATED) });

    expect(said(container)).toContain(
      'Isolated to “Service fee row — planted defect”: 33 fixations of the 116 on this step.',
    );
  });

  it('opens the sessions that fixated it, on this version and this area', () => {
    const run = seedRun();
    const { container } = caption({ run, isolated: areaOf(run, FIXATED) });
    const link = captionIn(container).querySelector('a') as HTMLAnchorElement;

    expect(link.textContent).toBe('Open the sessions that fixated it');
    expect(link.getAttribute('href')).toBe(sessionsWithArea(RUN_ID, 'B', FIXATED));
  });
});

describe('what the caption will not say', () => {
  it('says nothing at all while nothing is isolated', () => {
    const { container } = caption({ run: seedRun(), isolated: null });

    expect(said(container)).toBe('');
  });

  it('withholds the sentence while the people are still arriving, rather than half of it', () => {
    const run = seedRun();
    const { container } = caption({
      run,
      isolated: areaOf(run, NEVER_FIXATED),
      sessions: {
        status: 'loading',
        error: null,
        sessions: [],
        fixations: [],
        saccades: [],
        reachedCount: 0,
        scoredSessionCount: 0,
      },
    });

    expect(said(container)).toBe('');
  });

  it('says nothing on a step nobody reached, which is a different finding', () => {
    const run = seedRun();
    const { container } = caption({
      run,
      isolated: areaOf(run, NEVER_FIXATED),
      sessions: {
        status: 'ready',
        error: null,
        sessions: [],
        fixations: [],
        saccades: [],
        reachedCount: 0,
        scoredSessionCount: 9,
      },
    });

    // The stage above says "nobody in your audience reached this step". "0 of 0 people who
    // reached this step looked at it" under it would report that as a never-seen area.
    expect(said(container)).toBe('');
  });

  it('is announced when it changes, so isolating is not a result only sight reports', () => {
    const { container } = caption({ run: seedRun(), isolated: null });

    expect(captionIn(container).getAttribute('role')).toBe('status');
  });
});

describe('isolating from the areas table', () => {
  it('puts the area in the URL, marks its row, and says what is isolated', async () => {
    await serveRunData();
    const { container, router } = attention('B', 'review');
    await settled();

    await userEvent.click(rowButton(container, NEVER_FIXATED));

    expect(router.state.location.search).toBe(`?aoi=${NEVER_FIXATED}`);
    expect(rowFor(container, NEVER_FIXATED).getAttribute('aria-selected')).toBe('true');
    expect(rowFor(container, FIXATED).getAttribute('aria-selected')).toBe('false');
    expect(said(container)).toContain('No fixation ever landed in');
  });

  it('clears the isolation when the same row is clicked again', async () => {
    await serveRunData();
    const { container, router } = attention('B', 'review', `?aoi=${FIXATED}`);
    await settled();

    await userEvent.click(rowButton(container, FIXATED));

    expect(router.state.location.search).toBe('');
    expect(rowFor(container, FIXATED).getAttribute('aria-selected')).toBe('false');
    expect(said(container)).toBe('');
  });

  it('leaves the row by its link rather than isolating, when the link is what was clicked', async () => {
    await serveRunData();
    const { container, router } = attention('B', 'review');
    await settled();

    await userEvent.click(rowFor(container, FIXATED).querySelector('a') as HTMLAnchorElement);

    expect(router.state.location.pathname).toBe(paths.sessions(RUN_ID));
  });
});

describe('arriving with an area already isolated', () => {
  it('isolates on load, with no click, and shows the row selected', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', `?aoi=${NEVER_FIXATED}`);
    await settled();

    expect(rowFor(container, NEVER_FIXATED).getAttribute('aria-selected')).toBe('true');
    expect(said(container)).toContain('0 of 9 people in your audience who reached this step');
  });

  it('draws that area’s outline in the critical style, and leaves the others dashed', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', `?aoi=${NEVER_FIXATED}`);
    await settled();
    await showOutlines(container);

    const marked = [...container.querySelectorAll('[data-aoi]')]
      .filter((box) => box.hasAttribute('data-never-fixated'))
      .map((box) => box.getAttribute('data-aoi'));

    expect(marked).toEqual([NEVER_FIXATED]);
  });

  it('draws an area the audience looked at as active rather than critical', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', `?aoi=${FIXATED}`);
    await settled();
    await showOutlines(container);

    const box = boxFor(container, FIXATED);

    expect(box.hasAttribute('data-isolated')).toBe(true);
    expect(box.hasAttribute('data-never-fixated')).toBe(false);
  });
});

describe('an area the run itself is wrong about', () => {
  it('states the fault instead of a figure, and is not outlined as never seen', async () => {
    // A `null` time to first fixation beside a share above zero: the contradiction the
    // table refuses to print a figure for. The box must not print it either.
    await serveChangedRun((run) => ({
      ...run,
      aoiMetrics: run.aoiMetrics.map((metric) =>
        metric.aoiId === NEVER_FIXATED ? { ...metric, lookedAtShare: 0.5 } : metric,
      ),
    }));
    const { container } = attention('B', 'review', `?aoi=${NEVER_FIXATED}`);
    await settled();
    await showOutlines(container);

    expect(said(container)).toContain(`These figures disagree about ${NEVER_FIXATED}`);
    expect(boxFor(container, NEVER_FIXATED).hasAttribute('data-isolated')).toBe(true);
    expect(boxFor(container, NEVER_FIXATED).hasAttribute('data-never-fixated')).toBe(false);
  });

  it('is not outlined as looked at either, when the run recorded no figures for it', async () => {
    await serveChangedRun((run) => ({
      ...run,
      aoiMetrics: run.aoiMetrics.filter((metric) => metric.aoiId !== NEVER_FIXATED),
    }));
    const { container } = attention('B', 'review', `?aoi=${NEVER_FIXATED}`);
    await settled();
    await showOutlines(container);

    expect(said(container)).toContain(`This test recorded no figures for ${NEVER_FIXATED}`);
    expect(boxFor(container, NEVER_FIXATED).hasAttribute('data-never-fixated')).toBe(false);
  });
});

describe('the isolation follows the selection', () => {
  it('is kept when the version changes, and the caption follows it', async () => {
    // The demo's own move: the completing action is read on the current checkout, where
    // the audience did look at it, and then on the redesign, where nobody ever did.
    await serveRunData();
    const { container, router } = attention('A', 'review', '?aoi=A-review-complete');
    await settled();
    expect(said(container)).toContain('Isolated to “Completing action');

    await userEvent.click(screen.getByRole('button', { name: /^B/ }));
    await settled();

    expect(router.state.location.search).toBe('?aoi=A-review-complete');
    expect(said(container)).toContain('No fixation ever landed in');
    expect(said(container)).toContain('on variant B');
    expect(rowFor(container, NEVER_FIXATED).getAttribute('aria-selected')).toBe('true');
  });

  it('is cleared when the step changes, because an area belongs to a step', async () => {
    await serveRunData();
    const { container, router } = attention('B', 'review', `?aoi=${FIXATED}`);
    await settled();

    await userEvent.click(stepFrame('payment'));
    await settled();

    expect(router.state.location.search).toBe('');
    expect(said(container)).toBe('');
  });
});

describe('accessibility', () => {
  it('passes axe with one area isolated and its row selected', async () => {
    await serveRunData();
    const { container } = attention('B', 'review', `?aoi=${NEVER_FIXATED}`);
    await settled();

    const violations = await axeViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
