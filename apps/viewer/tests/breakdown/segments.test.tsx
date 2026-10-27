// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPaths } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from '../app';
import { axePass, describeViolations } from '../axe';
import { paths } from '../../src/shell/paths';
import { sessionRow } from '../../src/session';
import { SegmentsSection, segmentBars } from '../../src/screens/breakdown/SegmentsSection';
import { SEED_RUN_ID, seedRun } from '../verdict/fixture';

/**
 * *Which part of your audience this came from* — the section at the foot of the Score
 * breakdown screen, over the committed seed example run.
 *
 * What it is here to hold is the one reading the section exists for: **whether one part of
 * the audience carried the whole result.** So every count asserted below is computed in
 * this file from the run's own session files rather than typed out, and compared with what
 * the screen prints — a screen that counted from the run's rolled-up `outcomeCounts`, or
 * that folded our automation's failures into "failed", would disagree with the artifact and
 * be caught here rather than read as a result.
 *
 * Everything else is asserted through the words on screen. The class names of the bands are
 * the prototype's and are not what the section promises a reader.
 */

const LAYOUT = runPaths('');
const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = join(here, '../../src/screens/breakdown/SegmentsSection.css');

const HEADING = 'Which part of your audience this came from';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

/** One session of the seed run, as it is stored. */
const sessionFile = (sessionId: string): Session =>
  readRunFile(SEED_RUN_ID, LAYOUT.session(sessionId)) as unknown as Session;

interface Expected {
  readonly success: number;
  readonly abandoned: number;
  readonly failed: number;
  readonly automationFailure: number;
  readonly total: number;
}

type Band = keyof Omit<Expected, 'total'>;

const EMPTY: Expected = { success: 0, abandoned: 0, failed: 0, automationFailure: 0, total: 0 };

const BAND: Record<Session['outcome']['status'], Band> = {
  success: 'success',
  abandoned: 'abandoned',
  failed: 'failed',
  automation_failure: 'automationFailure',
};

/**
 * The counts the artifact itself carries, per person and version, read straight off the
 * session files. This is the table the screen has to agree with.
 */
const fromTheArtifact = (run: Run): Map<string, Expected> => {
  const counted = new Map<string, Expected>();
  for (const sessionId of run.sessionIds) {
    const session = sessionFile(sessionId);
    const key = `${session.persona?.id ?? '?'}|${session.variant}`;
    const before = counted.get(key) ?? EMPTY;
    const band = BAND[session.outcome.status];
    counted.set(key, { ...before, [band]: before[band] + 1, total: before.total + 1 });
  }
  return counted;
};

/** The section, by its heading: `data-section` is how every screen test here scopes one. */
const section = async (): Promise<HTMLElement> => {
  const heading = await screen.findByRole('heading', { level: 2, name: HEADING });
  const found = heading.closest('[data-section="segments"]');
  if (found === null) throw new Error('the heading is not inside the segments section');
  return found as HTMLElement;
};

/** Its rows, once every session file has arrived and the bars are drawn. */
const rows = async (expectedCount: number): Promise<HTMLElement[]> => {
  const sec = await section();
  const settled = (): void => {
    expect(within(sec).getAllByRole('listitem')).toHaveLength(expectedCount);
  };
  await waitFor(settled, { timeout: 10_000 });
  return within(sec).getAllByRole('listitem');
};

/** One row, as a reader reads it: JSX wraps the markup, a reader sees one line. */
const line = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * The row naming this person on this version, found by the words on it. The version is
 * located by its **name** and not by its id: `A` is a letter that turns up in a device
 * name, and a locator that matched it would pick two rows.
 */
const rowFor = (
  found: readonly HTMLElement[],
  person: string,
  variantName: string,
): HTMLElement => {
  const matching = found.filter((row) => {
    const text = line(row);
    return text.includes(person) && text.includes(variantName);
  });
  if (matching.length !== 1) {
    throw new Error(
      `${matching.length} rows name both ${person} and ${variantName}: ${found
        .map(line)
        .join(' / ')}`,
    );
  }
  return matching[0] as HTMLElement;
};

/** The version tag a row opens with: the chip the two versions keep everywhere. */
const tagOf = (row: HTMLElement): string =>
  line(row.querySelector('[data-slot="badge"]') as HTMLElement);

/** The four band widths of one row's stack, as percentages of the row's sessions. */
const widths = (row: HTMLElement): number[] =>
  [...row.querySelectorAll('.stack i')].map((band) =>
    Number.parseFloat((band as HTMLElement).style.width),
  );

/** One of the run's generated people, by id, for a test that holds a count against them. */
const personaNamed = (run: Run, personaId: string): string => {
  const found = run.personas.find((candidate) => candidate.id === personaId);
  if (found === undefined) throw new Error(`${personaId} is not one of this run's people`);
  return found.name;
};

/** One of the run's versions, by id. */
const variantNamed = (run: Run, variantId: string): string => {
  const found = run.variants.find((candidate) => candidate.id === variantId);
  if (found === undefined) throw new Error(`${variantId} is not one of this run's versions`);
  return found.name;
};

describe('one row per generated person, per version', () => {
  it('names the person, the part of the audience they came from, their device and the version', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const found = await rows(run.personas.length * run.variants.length);

    for (const persona of run.personas) {
      for (const variant of run.variants) {
        const where = `${persona.name} on ${variant.id}`;
        const row = rowFor(found, persona.name, variant.name);
        const text = line(row);
        expect(text, where).toContain(persona.name);
        expect(text, where).toContain(persona.segment);
        expect(text, where).toContain(persona.device.name);
        expect(text, where).toContain(variant.name);
        // And the version tag itself, which is the chip the two versions keep everywhere.
        expect(tagOf(row), where).toBe(variant.id);
      }
    }
  });

  it('groups the people of one segment together, so the list reads as parts of an audience', () => {
    // The seed audience gives every person their own segment, so the rule is only visible
    // on an audience whose people share one. Two of these three do, and they are *not*
    // adjacent in the run's own persona list.
    const run = seedRun();
    const [first, second, third] = run.personas as [
      Run['personas'][number],
      Run['personas'][number],
      Run['personas'][number],
    ];
    const shared = 'mobile · price-sensitive';
    const alone = 'desktop · compares carefully';
    const audience: Run = {
      ...run,
      personas: [
        { ...first, segment: shared },
        { ...second, segment: alone },
        { ...third, segment: shared },
      ],
    };

    const segments = segmentBars(audience, []).map((bar) => bar.segment);

    // Each segment occupies one unbroken block of the list.
    const blocks = segments.filter((segment, index) => segment !== segments[index - 1]);
    expect(blocks).toEqual([shared, alone]);
  });

  it('keeps a row for a session on a version the run never listed, rather than losing its count', () => {
    // The contract does not forbid it, and this section's whole premise is that no
    // session is dropped: the count would otherwise fall out of every bar in silence.
    const run = seedRun();
    const persona = run.personas[0] as Run['personas'][number];
    const session = sessionFile('S-01');
    const row = sessionRow(run, { ...session, variant: 'C', persona: session.persona });

    const bars = segmentBars(run, [row]);

    expect(bars).toHaveLength(run.personas.length * run.variants.length + 1);
    const stray = bars[bars.length - 1] as (typeof bars)[number];
    expect(stray.variant).toBe('C');
    expect(stray.personaName).toBe(persona.name);
    expect(stray.total).toBe(1);
    // It says what put it at the foot, rather than looking like any other row.
    expect(stray.unplaced).toBe('on a version this test does not list');
    // And it borrows no segment label, so a segment's own block stays the only place that
    // label appears — the grouping below could not otherwise hold.
    expect(stray.segment).toBeNull();
  });

  it('keeps one unbroken block per segment even when a row sits at the foot', () => {
    const run = seedRun();
    const session = sessionFile('S-01');
    const stray = sessionRow(run, { ...session, variant: 'C', persona: session.persona });

    const segments = segmentBars(run, [stray]).map((bar) => bar.segment);
    const blocks = segments.filter((segment, index) => segment !== segments[index - 1]);

    // Four segments, then the one foot row, which carries no segment at all.
    expect(blocks).toEqual([...run.personas.map((persona) => persona.segment), null]);
  });

  it('keeps a row for a person who ran on neither version, rather than dropping them', () => {
    const run = seedRun();
    const bars = segmentBars(run, []);

    expect(bars).toHaveLength(run.personas.length * run.variants.length);
    for (const bar of bars) expect(bar.total).toBe(0);
  });
});

describe('the counts, as the sessions store them', () => {
  it('prints the completed count against the segment’s total', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const expected = fromTheArtifact(run);
    const found = await rows(run.personas.length * run.variants.length);

    for (const persona of run.personas) {
      for (const variant of run.variants) {
        const counts = expected.get(`${persona.id}|${variant.id}`) as Expected;
        const row = line(rowFor(found, persona.name, variant.name));
        expect(row, `${persona.name} on ${variant.id}`).toContain(
          `${counts.success} / ${counts.total} completed`,
        );
      }
    }
  });

  it('puts the other three counts in text beside the bar, so no colour carries a reading alone', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const expected = fromTheArtifact(run);
    const found = await rows(run.personas.length * run.variants.length);

    for (const persona of run.personas) {
      for (const variant of run.variants) {
        const counts = expected.get(`${persona.id}|${variant.id}`) as Expected;
        const row = line(rowFor(found, persona.name, variant.name));
        expect(row, `${persona.name} on ${variant.id}`).toContain(
          `${counts.abandoned} gave up · ${counts.failed} failed · ${counts.automationFailure} excluded`,
        );
      }
    }
  });

  it('never folds our own automation’s failures into failed or gave-up', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const expected = fromTheArtifact(run);
    const found = await rows(run.personas.length * run.variants.length);

    // The segments this run excluded somebody from. Each keeps its own band: the completed
    // figure is short by one, and neither "failed" nor "gave up" absorbed it.
    const excluded = [...expected].filter(([, counts]) => counts.automationFailure > 0);
    expect(excluded.length).toBeGreaterThan(0);

    for (const [key, counts] of excluded) {
      const [personaId = '', variantId = ''] = key.split('|');
      const row = line(rowFor(found, personaNamed(run, personaId), variantNamed(run, variantId)));
      expect(row, key).toContain(`${counts.automationFailure} excluded`);
      expect(row, key).toContain(`${counts.failed} failed`);
      expect(row, key).toContain(`${counts.abandoned} gave up`);
      // And the denominator still counts the excluded person: they were in this segment.
      expect(row, key).toContain(`${counts.success} / ${counts.total} completed`);
    }
  });

  it('stacks the four widths in proportion to that segment’s sessions', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const expected = fromTheArtifact(run);
    const found = await rows(run.personas.length * run.variants.length);

    for (const persona of run.personas) {
      for (const variant of run.variants) {
        const counts = expected.get(`${persona.id}|${variant.id}`) as Expected;
        const row = rowFor(found, persona.name, variant.name);
        const share = (count: number): number => (count / counts.total) * 100;

        expect(widths(row), `${persona.name} on ${variant.id}`).toEqual([
          share(counts.success),
          share(counts.abandoned),
          share(counts.failed),
          share(counts.automationFailure),
        ]);
      }
    }
  });
});

describe('the two completion figures on this page', () => {
  it('says what a row’s figure is out of, since it is not what the completion rate is out of', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const found = await rows(run.personas.length * run.variants.length);

    // The bar has to account for everyone who ran in its segment or its four widths would
    // not fill it, so an excluded person is in the denominator here. The stored
    // `completionRate` on the cards above divides by the scored sessions, which leave them
    // out — 2 / 3 here against 2 / 2 there, on the same people.
    const excluded = rowFor(found, personaNamed(run, 'firsttime'), variantNamed(run, 'A'));
    expect(line(excluded)).toContain('2 / 3 completed');
    expect(line(excluded)).toContain('1 excluded');

    const sec = await section();
    const note = sec.querySelector('[data-section="segments-denominator"]') as HTMLElement;
    expect(note).not.toBeNull();
    expect(line(note)).toContain('the people our automation broke on included');
    expect(line(note)).toContain('the completion rate above');
  });
});

describe('the legend', () => {
  it('names all four bands, and the excluded one as our automation’s failure', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const sec = await section();
    const legend = await waitFor(() => {
      const found = sec.querySelector('[data-section="segments-legend"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect([...legend.querySelectorAll('span')].map(line)).toEqual([
      'Completed',
      'Gave up',
      'Failed',
      'Our automation broke (excluded)',
    ]);
  });
});

describe('a session with no person in this test’s audience', () => {
  /** The same run with one session re-pointed at a persona the run never generated. */
  const withAStray = async () => {
    const original = sessionFile('S-01');
    const stray = { ...original, persona: { ...original.persona, id: 'ghost' } };
    return serveRunData({
      files: { [`/runs/${SEED_RUN_ID}/${LAYOUT.session('S-01')}`]: JSON.stringify(stray) },
    });
  };

  it('is grouped under an unknown-person row that says so, rather than dropped', async () => {
    await withAStray();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    // The grid, plus one row for the version the stray session landed on.
    const found = await rows(run.personas.length * run.variants.length + 1);

    const unknown = found.filter((row) => line(row).includes('Unknown person'));
    expect(unknown).toHaveLength(1);
    const text = line(unknown[0] as HTMLElement);
    expect(text).toContain('not one of this test’s people');
    expect(text).toContain('1 / 1 completed');

    // And the person it used to be counted under is short by exactly that one session.
    expect(line(rowFor(found, personaNamed(run, 'rushed'), variantNamed(run, 'A')))).toContain(
      '2 / 2 completed',
    );
  });
});

describe('the section’s own states', () => {
  it('reserves its height while the sessions are read', () => {
    // No run data served: every session file is still outstanding, which is the state a
    // reader sees first. The rows are held back until all of them have settled, because a
    // stacked bar drawn from half a segment is a different reading and not a smaller one.
    const run = seedRun();
    const { container } = render(<SegmentsSection run={run} />);

    const reserved = container.querySelector('[data-section="segments-loading"]') as HTMLElement;
    expect(reserved).not.toBeNull();
    expect(reserved.getAttribute('aria-busy')).toBe('true');
    // As many placeholders as there will be rows — `personas × variants`, which the run
    // names before a session file is read — and not one per session file.
    expect(reserved.children).toHaveLength(run.personas.length * run.variants.length);
    expect(container.querySelectorAll('.segbar')).toHaveLength(0);
  });

  it('renders the section with a line when the test recorded no people', () => {
    const { container } = render(<SegmentsSection run={{ ...seedRun(), sessionIds: [] }} />);

    expect(screen.getByRole('heading', { level: 2, name: HEADING })).toBeTruthy();
    expect(line(container.querySelector('[data-section="segments-empty"]') as HTMLElement)).toBe(
      'This test recorded no people, so there is no audience to break the result down by.',
    );
    expect(container.querySelectorAll('.segbar')).toHaveLength(0);
  });

  it('says so when a session could not be read, rather than quietly counting short', async () => {
    await serveRunData({
      files: { [`/runs/${SEED_RUN_ID}/${LAYOUT.session('S-01')}`]: 'not a session file' },
    });
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const found = await rows(run.personas.length * run.variants.length);

    const sec = await section();
    const note = sec.querySelector('[data-section="segments-unreadable"]') as HTMLElement;
    expect(note).not.toBeNull();
    expect(line(note)).toBe(
      '1 session of this test could not be read, and is counted in no bar above.',
    );
    // The bar it would have been in is short, and the screen has said why.
    expect(line(rowFor(found, personaNamed(run, 'rushed'), variantNamed(run, 'A')))).toContain(
      '2 / 2 completed',
    );
  });
});

describe('where the section is, and is not', () => {
  it('is on the Score breakdown screen', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    expect(await screen.findByRole('heading', { level: 2, name: HEADING })).toBeTruthy();
  });

  it('is not on the Verdict screen, which carries one verdict and no segment stack', async () => {
    await serveRunData();
    mountApp(paths.run(SEED_RUN_ID));

    // The screen has fully arrived: its headline is the run's own verdict sentence, and the
    // score cards that moved off it are not there either.
    await screen.findByRole('heading', { level: 1, name: seedRun().verdict.audienceSentence });
    expect(document.querySelector('[data-section="score-cards"]')).toBeNull();

    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
    expect(document.querySelector('[data-section="segments"]')).toBeNull();
    expect(document.querySelectorAll('.segbar')).toHaveLength(0);
  });
});

describe('reading it without colour, and without a pointer', () => {
  it('passes an axe pass over the section', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    await rows(run.personas.length * run.variants.length);
    const sec = await section();

    const results = await axePass(sec);
    expect(describeViolations(results.violations)).toBe('');
    // And the pass was not vacuous: jsdom decided the rules this section is made of.
    expect(results.passes.map((pass) => pass.id)).toContain('list');
  });

  it('hides the bar itself from the accessibility tree, since the counts are text beside it', async () => {
    await serveRunData();
    mountApp(paths.breakdown(SEED_RUN_ID));

    const run = seedRun();
    const found = await rows(run.personas.length * run.variants.length);

    for (const row of found) {
      const stack = row.querySelector('.stack') as HTMLElement;
      expect(stack.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

/**
 * The parts of the contract that are CSS and nothing else. jsdom applies no stylesheet, so
 * the rules are read back through the CSSOM, as `tests/verdict/stylesheet.test.ts` reads the
 * Verdict screen's.
 */
describe('the stylesheet', () => {
  interface Rule {
    selector: string;
    condition: string;
    declarations: Record<string, string>;
  }

  const declarationsOf = (styleRule: CSSStyleRule): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: styleRule.style.length }, (_unused, index) =>
        styleRule.style.item(index),
      ).map((property) => [property, styleRule.style.getPropertyValue(property)]),
    );

  const rulesOf = (css: string): Rule[] => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const sheet = style.sheet as CSSStyleSheet;

    return [...sheet.cssRules].flatMap((item) => {
      if (item instanceof CSSMediaRule) {
        return [...item.cssRules].map((inner) => ({
          selector: (inner as CSSStyleRule).selectorText,
          condition: item.conditionText,
          declarations: declarationsOf(inner as CSSStyleRule),
        }));
      }
      if (item instanceof CSSStyleRule) {
        return [{ selector: item.selectorText, condition: '', declarations: declarationsOf(item) }];
      }
      return [];
    });
  };

  /** jsdom keeps a selector list's own line breaks; a reader writes it on one line. */
  const oneLine = (selector: string): string => selector.replace(/\s+/g, ' ').trim();

  const rule = (selector: string, condition = ''): Record<string, string> => {
    const all = rulesOf(readFileSync(stylesheet, 'utf8'));
    const found = all.filter(
      (item) => oneLine(item.selector) === selector && item.condition === condition,
    );
    expect(found, `${selector} ${condition}`).toHaveLength(1);
    return (found[0] as Rule).declarations;
  };

  it('takes the three outcome bands from the --outcome-* ramp', () => {
    expect(rule('.stack .s, .legend .s').background).toBe('var(--outcome-success)');
    expect(rule('.stack .ab, .legend .ab').background).toBe('var(--outcome-abandoned)');
    expect(rule('.stack .f, .legend .f').background).toBe('var(--outcome-failed)');
  });

  it('takes the excluded band from --attr-automation, an attribution and not an outcome', () => {
    expect(rule('.stack .au, .legend .au').background).toBe('var(--attr-automation)');
  });

  it('reserves a whole row’s height while the sessions are read, not a bar’s', () => {
    // 40px: two lines of label against two lines of counts. A reservation the height of
    // the bar alone would let the legend travel up the page as the counts land.
    expect(rule('.segbar-reserve')['min-block-size']).toBe('var(--space-10)');
  });

  it('stacks each row’s label above its bar below the prototype’s breakpoint', () => {
    expect(rule('.segbar')['grid-template-columns']).toBe('calc(var(--space-24) * 3) 1fr auto');
    expect(rule('.segbar', '(max-width: 640px)')['grid-template-columns']).toBe('1fr');
  });
});
