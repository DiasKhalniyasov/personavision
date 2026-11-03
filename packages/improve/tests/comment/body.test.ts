import { runSchema } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, commentBody } from '../../src/index.js';
import type { CommentDraft } from '../../src/index.js';
import {
  BASELINE_FIGURES,
  CHANGE_FIGURES,
  HOLDOUT_FIGURES,
  RUN_URL,
  runWithChange,
} from './fixture.js';

/**
 * The words of the comment, which are the product talking to a reader who has never seen a
 * screen of it (`docs/FLOW.md` section 15, point 6).
 *
 * What is asserted here is the **text**: that each figure in it is the run's own stored
 * figure, that every line stating a number says `simulated`, that a holdout that did not
 * confirm reads that way in the opening lines, and that nothing about how the product is
 * built is in it. Asserting an intention — that the writer meant to label its numbers —
 * would pass on a body a reader could not trust.
 */

const text = (draft: CommentDraft): string => {
  expect(draft.kind, draft.kind === 'refused' ? draft.reason : '').toBe('comment');
  return draft.kind === 'comment' ? draft.text : '';
};

const body = (run: Run, runUrl = RUN_URL): string => text(commentBody({ run, runUrl }));

const refusal = (run: Run, runUrl = RUN_URL): string => {
  const draft = commentBody({ run, runUrl });
  expect(draft.kind).toBe('refused');
  return draft.kind === 'refused' ? draft.reason : '';
};

/** The lines that state a number: a percentage, an *N of M*, or a count of people. */
const numeric = (written: string): readonly string[] =>
  written
    .split('\n')
    .filter((row) =>
      /\d[\d,.]*\s*%|\b\d+\s+(?:of|in)\s+(?:the\s+)?\d+\b|\b\d+\s+people\b/.test(row),
    );

describe('the fixture run is a run the contract accepts', () => {
  it('parses with its change, its holdout and the figures under each rate', () => {
    expect(() => runSchema.parse(runWithChange())).not.toThrow();
    expect(() => runSchema.parse(runWithChange({ holdout: 'not_confirmed' }))).not.toThrow();
    expect(() => runSchema.parse(runWithChange({ holdout: 'none' }))).not.toThrow();
  });
});

describe('the figures are the run’s own, field by field', () => {
  it('states each stored completion rate as a percentage, with the population under it', () => {
    const run = runWithChange();
    const written = body(run);

    expect(run.scores[0].completionRate).toBe(BASELINE_FIGURES.completionRate);
    expect(written).toContain('**Baseline** — 41% completed the task (simulated), 38 of 93 people');
    expect(run.scores[1].completionRate).toBe(CHANGE_FIGURES.completionRate);
    expect(written).toContain(
      '**With the change** — 58% completed the task (simulated), 55 of 95 people',
    );
    expect(run.scores[1].holdout).toEqual(HOLDOUT_FIGURES);
    expect(written).toContain(
      '**Holdout** — 55% completed the task (simulated), 22 of 40 people, on seeds this change was never chosen against',
    );
  });

  it('cannot state a figure the run does not hold: moving one moves the body', () => {
    const run = runWithChange();
    run.scores[1].completionRate = 0.62;
    run.scores[1].outcomeCounts = { success: 59, abandoned: 21, failed: 15, automationFailure: 1 };

    expect(body(run)).toContain(
      '**With the change** — 62% completed the task (simulated), 59 of 95 people',
    );
  });

  it('reads the two sides by the variants the run names, not by their order', () => {
    const run = runWithChange();
    run.improve = { ...run.improve!, baselineVariant: 'B', changeVariant: 'A' };

    expect(body(run)).toContain(
      '**Baseline** — 58% completed the task (simulated), 55 of 95 people',
    );
  });

  it('carries the verdict’s own reasons as the Why, in the run’s words', () => {
    const run = runWithChange();

    expect(body(run)).toContain(
      '**Why**\n\n- The button that completes the order was never seen on the redesign.',
    );
  });
});

describe('every number carries the simulated label', () => {
  it('says simulated on every line that states one', () => {
    const written = body(runWithChange());

    expect(numeric(written).length).toBeGreaterThan(0);
    for (const row of numeric(written)) expect(row, row).toMatch(/simulated/i);
  });

  it('labels a reason that states a count of people, which the product did not write', () => {
    const run = runWithChange();
    run.verdict.reasons = [
      '17 of the 33 people who used to leave on the waiting screen now stay to the preview.',
    ];

    expect(body(run)).toContain(
      '- 17 of the 33 people who used to leave on the waiting screen now stay to the preview. (simulated)',
    );
  });

  it('labels a headline sentence that states a figure', () => {
    const run = runWithChange();
    run.verdict.audienceSentence = '58% of your audience finishes on the change.';

    expect(body(run)).toContain('58% of your audience finishes on the change. (simulated)');
  });

  it('refuses a body whose number it cannot label, and posts nothing', () => {
    const run = runWithChange();
    // A sentence that spans lines carries its number on one line and the label on another,
    // so the line a reader sees would not say simulated.
    run.verdict.reasons = ['17 of 33 people stayed to the preview.\nThat is what the change did.'];

    expect(refusal(run)).toContain('17 of 33 people stayed to the preview.');
    expect(refusal(run)).toContain('nothing is posted');
  });
});

describe('the holdout line is in the opening lines, in words', () => {
  /** The marker renders as nothing, so the reader's first two lines are the next two. */
  const opening = (written: string): string =>
    written
      .split('\n')
      .filter((row) => row.trim() !== '' && row !== COMMENT_MARKER)
      .slice(0, 2)
      .join('\n');

  it('reads “not confirmed” before anything else when the holdout did not confirm', () => {
    const written = body(runWithChange({ holdout: 'not_confirmed' }));

    expect(opening(written)).toContain('**Not confirmed on the holdout.**');
    expect(opening(written)).toContain('never chosen against');
  });

  it('reads “confirmed” in the same place when it did', () => {
    expect(opening(body(runWithChange()))).toContain('**Confirmed on the holdout.**');
  });

  it('says no holdout ran rather than printing a holdout figure nobody is behind', () => {
    const written = body(runWithChange({ holdout: 'none' }));

    expect(opening(written)).toContain('**No holdout ran.**');
    expect(written).not.toContain('**Holdout**');
    expect(written).toContain('**Baseline** — 41%');
  });
});

describe('the comment carries the link and nothing about how the product is built', () => {
  it('links the run on the platform', () => {
    expect(body(runWithChange())).toContain(`[See this run on PersonaVision](${RUN_URL})`);
  });

  it('carries no identifier of ours, no path on our disk and nothing token-shaped', () => {
    const run = runWithChange();
    const written = body(run);

    const beyondTheLink = written
      .split('\n')
      .filter((row) => !row.includes(RUN_URL))
      .join('\n');

    // The run id is in the link and nowhere else: a link to the run is the one thing this
    // comment must carry, and an id quoted beside it would be an identifier of ours.
    expect(written).toContain(run.runId);
    expect(beyondTheLink).not.toContain(run.runId);

    for (const internal of [
      run.personas[0].id,
      run.improve!.recommendationId,
      run.improve!.changedFile,
      run.improve!.baselineVariant === 'A' ? 'variant A' : 'variant B',
      'ghs_',
      'Authorization',
      'Bearer ',
    ]) {
      expect(written, internal).not.toContain(internal);
    }
    expect(written).not.toMatch(/(^|\s)(\/[A-Za-z0-9._-]+){2,}/);
  });

  it('carries the footnote’s claim in full, in the prototype’s words', () => {
    expect(body(runWithChange())).toContain(
      'It says this change helps these people; it does not estimate what it will do to your conversion rate. Merging is yours.',
    );
  });

  it('names the audience the figures are a simulation of', () => {
    expect(body(runWithChange())).toContain('Simulated for Outdoor-gear shoppers.');
  });

  it('opens with the hidden marker, which renders as nothing', () => {
    expect(body(runWithChange()).split('\n')[0]).toBe(COMMENT_MARKER);
    expect(COMMENT_MARKER.startsWith('<!--')).toBe(true);
  });
});

describe('there are runs with no comment to write', () => {
  it('refuses a run that tested no change', () => {
    const run = runWithChange();
    delete run.improve;

    expect(refusal(run)).toContain('tested no change');
  });

  it('refuses a run whose change was never served anywhere', () => {
    const run = runWithChange();
    run.improve = {
      ...run.improve!,
      preview: { url: null, reason: 'this repository publishes no preview deployment' },
    };

    expect(refusal(run)).toContain('no comparison to report');
    expect(refusal(run)).toContain('publishes no preview deployment');
  });

  it('refuses a run missing one side’s score on the task it tested', () => {
    const run = runWithChange();
    run.scores = [run.scores[0]];

    expect(refusal(run)).toContain('only one of the two versions');
  });

  it('refuses a link that is not an http address, so no scheme of ours is clickable', () => {
    for (const url of ['javascript:alert(1)', 'file:///Users/someone/runs/run.json', 'not a url']) {
      expect(refusal(runWithChange(), url)).toContain('http:// or https://');
    }
  });
});
