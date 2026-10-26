// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import axe from 'axe-core';
import type { Run } from '@personavision/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { forgetRuns, mountApp, readFindingsFile, readRunFile, serveRunData } from '../app';
import { Finding } from '../../src/screens/verdict/Finding';
import { HeadlineFindings } from '../../src/screens/verdict/HeadlineFindings';
import { evidenceUrl } from '../../src/screens/verdict/evidenceLink';
import type { FindingItem } from '../../src/screens/verdict/evidenceLink';
import { paths } from '../../src/shell/paths';

/**
 * *What to fix first*: the findings the verdict named, and the one click to the evidence
 * behind each of them.
 *
 * Which three they are is the pipeline's choice, so most of these tests serve the
 * committed run's own `findings.json` and `run.json`, replaced with a file of their own
 * only where the point is a shape the committed run does not have. They assert what a
 * reader sees and where a click lands, never which component rendered it.
 */

const SEED = '2026-10-24-1402-northwind-demo';

/** The committed run's own findings. The file does not change while the suite runs. */
const SEED_FINDINGS = (readFindingsFile(SEED) as { findings: FindingItem[] }).findings;
const seedFindings = (): FindingItem[] => SEED_FINDINGS;

const seedRun = (): Run => readRunFile(SEED) as unknown as Run;

/** The run's own run file, with the ids the verdict leads with replaced. */
const runNaming = (headlineFindingIds: string[]): Record<string, string> => {
  const run = readRunFile(SEED);
  const verdict = { ...(run.verdict as Record<string, unknown>), headlineFindingIds };
  return { [`/runs/${SEED}/run.json`]: JSON.stringify({ ...run, verdict }) };
};

/** The run's own findings file, with the findings replaced. */
const findingsOf = (findings: unknown[]): Record<string, string> => ({
  [`/runs/${SEED}/findings.json`]: JSON.stringify({
    schemaVersion: 2,
    runId: SEED,
    findings,
  }),
});

/** A rendered finding, whatever element it turned out to be. */
const findings = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-sev]'),
];

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the three headline findings', () => {
  it('renders exactly the findings the verdict names, in its order', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(3));

    const all = seedFindings();
    // F-1, F-2, F-3, which is what `headlineFindingIds` names, in that order.
    const rendered = findings(container).map((finding) => finding.textContent ?? '');
    expect(rendered[0]).toContain(all[0]!.claim);
    expect(rendered[1]).toContain(all[1]!.claim);
    expect(rendered[2]).toContain(all[2]!.claim);
    // The rest of the run's findings are one click deeper, not here.
    expect(screen.queryByText(all[3]!.claim)).toBeNull();
  });

  it('renders two when the verdict names two', async () => {
    await serveRunData({ files: runNaming(['F-2', 'F-3']) });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(2));
    expect(screen.getByText(seedFindings()[1]!.claim)).toBeTruthy();
    expect(screen.queryByText(seedFindings()[0]!.claim)).toBeNull();
  });

  it('renders the first three when the verdict names four: the cap holds', async () => {
    // A `run.json` naming four would not pass the contract, so the four arrive as the
    // component's own argument. The cap is the screen's, not only the schema's.
    await serveRunData();
    const run = seedRun();
    const named = {
      ...run,
      verdict: { ...run.verdict, headlineFindingIds: ['F-1', 'F-2', 'F-3', 'F-4'] },
    };
    const { container } = render(
      <MemoryRouter>
        <HeadlineFindings run={named} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(findings(container)).toHaveLength(3));
    expect(screen.queryByText(seedFindings()[3]!.claim)).toBeNull();
  });

  it('spends no headline place on an id its findings file does not hold', async () => {
    await serveRunData();
    const run = seedRun();
    const named = {
      ...run,
      verdict: { ...run.verdict, headlineFindingIds: ['F-99', 'F-1', 'F-2', 'F-3'] },
    };
    const { container } = render(
      <MemoryRouter>
        <HeadlineFindings run={named} />
      </MemoryRouter>,
    );

    // The dangling id is dropped before the cap, so three real findings still reach the
    // reader rather than two.
    await waitFor(() => expect(findings(container)).toHaveLength(3));
    expect(container.textContent).toContain(seedFindings()[2]!.claim);
  });

  it('says the two files disagree when every named finding is missing', async () => {
    await serveRunData({ files: runNaming(['F-99']) });
    mountApp(paths.run(SEED));

    expect(
      await screen.findByText(/names a finding to lead with that its findings file does not hold/),
    ).toBeTruthy();
  });

  it('does not rank or filter: reversing findings[].rank changes nothing it shows', async () => {
    const reversed = seedFindings().map((finding, index) => ({ ...finding, rank: 6 - index }));
    await serveRunData({ files: findingsOf(reversed) });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(3));
    const rendered = findings(container).map((finding) => finding.textContent ?? '');
    expect(rendered[0]).toContain(seedFindings()[0]!.claim);
    expect(rendered[2]).toContain(seedFindings()[2]!.claim);
  });

  it('renders a claim, its evidence, and every tag a reader needs to place it', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(3));
    const first = seedFindings()[0]!;
    const text = findings(container)[0]!.textContent ?? '';

    expect(text).toContain(first.claim);
    expect(text).toContain(first.evidence);
    // Severity in words beside its colour, the version by the name the run gave it, who is
    // at fault, where it happened, and how many people are behind it.
    expect(text).toContain('critical');
    expect(text).toContain('Redesign candidate');
    expect(text).toContain('your checkout');
    expect(text).toContain(`${first.step} / ${first.aoiId!}`);
    expect(text).toContain(`${first.sessionCount} people`);
    // Its position, which the screen counts and the finding does not carry.
    expect(text).toContain('1');
  });

  it('names an automation failure as our own, and says it is excluded', async () => {
    const automation = seedFindings()[5]!;
    await serveRunData({
      files: { ...findingsOf([automation]), ...runNaming([automation.id]) },
    });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(1));
    const text = findings(container)[0]!.textContent ?? '';
    expect(text).toContain('our simulation · excluded');
    // The evidence sentence mentions the reader's checkout; the attribution tag does not
    // blame it, which is the thing this asserts.
    expect(container.querySelector('.tag-product')).toBeNull();
    // A finding about the run rather than one version says so too.
    expect(text).toContain('both versions');
  });

  it('links to the full list by the number of findings the run holds', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(3));
    const link = screen.getByRole('link', { name: /See all 6 findings/ });
    expect(link.getAttribute('href')).toBe(paths.breakdown(SEED));
  });

  it('says so in one sentence when the verdict names none, and still opens the doors', async () => {
    await serveRunData({ files: runNaming([]) });
    const { container } = mountApp(paths.run(SEED));

    // The findings are fetched after the run resolves, so the sentence is awaited rather
    // than asserted off the back of the doors appearing.
    expect(await screen.findByText(/No finding was serious enough/)).toBeTruthy();
    expect(findings(container)).toHaveLength(0);
    // The detail is still worth reaching, so the doors are there whatever the findings did.
    const doors = container.querySelector('[data-section="detail-doors"]')!;
    expect(doors.querySelector(`a[href="${paths.breakdown(SEED)}"]`)).not.toBeNull();
  });

  it('says so when the run has no findings at all', async () => {
    await serveRunData({ files: { ...findingsOf([]), ...runNaming([]) } });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(container.textContent).toContain('turned up nothing to fix');
    });
    expect(
      screen.queryByRole('link', { name: /findings and the full score breakdown/ }),
    ).toBeNull();
  });

  it('reserves the list while the findings are still being read', async () => {
    await serveRunData();
    const { container } = render(
      <MemoryRouter>
        <HeadlineFindings run={seedRun()} />
      </MemoryRouter>,
    );

    // The first paint, before the findings have arrived: three places held open, so the
    // doors below do not move up and then back down.
    const busy = container.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy!.children).toHaveLength(3);
    // The state a reader meets first is audited too: the finished list is not the only
    // thing axe sees.
    const loading = await axe.run(container, { resultTypes: ['violations'] });
    expect(loading.violations.map((violation) => violation.id)).toEqual([]);

    await waitFor(() => expect(findings(container)).toHaveLength(3));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('says a findings file it cannot read could not be read', async () => {
    await serveRunData({ files: { [`/runs/${SEED}/findings.json`]: 'not json at all' } });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(container.textContent).toContain('could not be read'));
    expect(findings(container)).toHaveLength(0);
  });

  it('is clean under axe', async () => {
    await serveRunData();
    const { container } = mountApp(paths.run(SEED));
    await waitFor(() => expect(findings(container)).toHaveLength(3));

    const results = await axe.run(
      container.querySelector<HTMLElement>('[data-section="headline-findings"]')!,
      {
        resultTypes: ['violations'],
      },
    );
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('a finding as a control', () => {
  it('navigates to the URL its evidence_link names', async () => {
    await serveRunData();
    const { container, router } = mountApp(paths.run(SEED));
    await waitFor(() => expect(findings(container)).toHaveLength(3));

    const first = seedFindings()[0]!;
    const expected = `${paths.attention(SEED, 'B', 'review')}?aoi=${first.aoiId!}`;
    const control = findings(container)[0]!;
    expect(control.getAttribute('href')).toBe(expected);

    await userEvent.click(control);
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(expected);
  });

  it('is reachable by keyboard and activated by Enter', async () => {
    await serveRunData();
    const { container, router } = mountApp(paths.run(SEED));
    await waitFor(() => expect(findings(container)).toHaveLength(3));

    const control = findings(container)[0]!;
    control.focus();
    expect(document.activeElement).toBe(control);
    await userEvent.keyboard('{Enter}');
    expect(router.state.location.pathname).toContain('/attention/');
  });

  it('opens the Sessions screen, with its filters, for a finding that names it', async () => {
    const sessionsFinding = seedFindings()[3]!;
    await serveRunData({
      files: { ...findingsOf([sessionsFinding]), ...runNaming([sessionsFinding.id]) },
    });
    const { container } = mountApp(paths.run(SEED));

    await waitFor(() => expect(findings(container)).toHaveLength(1));
    expect(findings(container)[0]!.getAttribute('href')).toBe(
      `${paths.sessions(SEED)}?variant=B&outcome=failed`,
    );
  });
});

describe('the Finding component, as #107 reuses it', () => {
  const base = (): FindingItem => seedFindings()[3]!;

  const renderFinding = (finding: FindingItem, href: string | null = null) =>
    render(
      <MemoryRouter>
        <Finding finding={finding} href={href} rank={1} variantName="Redesign candidate" />
      </MemoryRouter>,
    );

  it('builds a Sessions URL from a sessions evidence link, with its filters', () => {
    expect(evidenceUrl('r-1', base().evidence_link)).toBe(
      `${paths.sessions('r-1')}?variant=B&outcome=failed`,
    );
  });

  it('forwards every parameter the destination screen takes', () => {
    // `step` is one of the four the contract allows on a sessions link, and the Sessions
    // screen filters on it: dropping it would land the reader on the wrong rows.
    expect(
      evidenceUrl('r-1', {
        screen: 'sessions',
        params: { variant: 'B', step: 'payment', aoi: 'B-payment-promo', outcome: 'failed' },
      }),
    ).toBe(`${paths.sessions('r-1')}?variant=B&step=payment&aoi=B-payment-promo&outcome=failed`);
    expect(
      evidenceUrl('r-1', {
        screen: 'attention',
        params: { variant: 'B', step: 'review', aoi: 'B-review-fee-row', outcome: 'abandoned' },
      }),
    ).toBe(`${paths.attention('r-1', 'B', 'review')}?aoi=B-review-fee-row&outcome=abandoned`);
  });

  it('accepts no Attention link that names no version or step', () => {
    expect(evidenceUrl('r-1', { screen: 'attention', params: { aoi: 'x' } })).toBeNull();
    expect(
      evidenceUrl('r-1', { screen: 'attention', params: { variant: 'B', step: 'review' } }),
    ).toBe(paths.attention('r-1', 'B', 'review'));
  });

  it('renders a finding with no acceptable destination without its action, and says so', () => {
    const { container } = renderFinding(base(), null);

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('no page to open for this one');
    expect(container.textContent).toContain(base().claim);
  });

  it('renders a finding missing its claim with what it has, marked incomplete', () => {
    const finding = { ...base(), claim: '' };
    const { container } = renderFinding(finding, '/runs/r-1/sessions');

    expect(container.textContent).toContain(finding.evidence);
    expect(container.textContent).toContain('incomplete');
    expect(container.querySelector('a')).not.toBeNull();
  });

  it('renders a finding missing its evidence with what it has, marked incomplete', () => {
    const finding = { ...base(), evidence: '' };
    const { container } = renderFinding(finding, '/runs/r-1/sessions');

    expect(container.textContent).toContain(finding.claim);
    expect(container.textContent).toContain('incomplete');
  });

  it('takes its position from the caller rather than from the finding', () => {
    render(
      <MemoryRouter>
        <Finding finding={{ ...base(), rank: 4 }} href={null} rank={2} />
      </MemoryRouter>,
    );

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('4')).toBeNull();
  });

  it('needs no run, no route and no session of its own', () => {
    // #124 mounts it on the public demo page: a finding is handed its position, the
    // version's name and a URL, and reads nothing else.
    const { container } = renderFinding(base(), '/runs/r-1/sessions');
    expect(container.textContent).toContain('Redesign candidate');
  });
});
