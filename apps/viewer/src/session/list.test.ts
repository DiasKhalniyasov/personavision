import { describe, expect, it } from 'vitest';
import { findingsForSession, matchesSessionFilter, openRun, sessionRow } from './index.js';
import type { RunSessions, SessionFilter } from './index.js';
import { EXAMPLE_RUN_BASE, exampleRunFetch } from './fixtures.js';

/**
 * The list projection and the three filters, over the committed example run: 24 people, two
 * versions, three seeds, two of them lost to our own automation.
 */
const exampleRun = async (): Promise<RunSessions> => {
  const { fetch } = exampleRunFetch();
  return openRun({ baseUrl: EXAMPLE_RUN_BASE, fetch });
};

/** The session ids a filter leaves, in the run's own order. */
const narrowedTo = async (run: RunSessions, filter: SessionFilter): Promise<string[]> => {
  const sessions = await Promise.all(run.sessionIds.map((sessionId) => run.session(sessionId)));
  return sessions
    .filter((session) => matchesSessionFilter(session, filter))
    .map((session) => session.sessionId);
};

describe('one row of the sessions list', () => {
  it('carries the person, the version, the seed, the device and how it ended', async () => {
    const run = await exampleRun();

    const row = sessionRow(run.run, await run.session('S-15'));

    expect(row).toMatchObject({
      sessionId: 'S-15',
      variant: 'B',
      seed: 3,
      personaId: 'rushed',
      personaName: 'Rushed buyer',
      segment: 'mobile · in a hurry',
      participantId: null,
      deviceName: 'iPhone 15',
      excludedFromScores: false,
      durationMs: 38_000,
      fixationCount: 23,
      endedOn: { step: 'review', label: 'Review' },
      reason: 'Review — service fee revealed, left without ordering',
    });
    expect(row.outcome.label).toBe('Abandoned');
    expect(row.attribution.label).toBe('product');
  });

  it('lists an automation failure, worded as ours and marked excluded', async () => {
    const run = await exampleRun();

    const row = sessionRow(run.run, await run.session('S-09'));

    expect(run.sessionIds, 'it is in the list, not dropped from it').toContain('S-09');
    expect(row.outcome.label).toBe('Automation failure');
    expect(row.outcome.token).toBe('--attr-automation');
    expect(row.attribution.label).toBe('automation');
    expect(row.excludedFromScores, 'as stored, not re-derived').toBe(true);
  });
});

describe('the three filters', () => {
  it('narrows to one version', async () => {
    const run = await exampleRun();

    expect(await narrowedTo(run, { variant: 'B' })).toEqual([
      'S-13',
      'S-14',
      'S-15',
      'S-16',
      'S-17',
      'S-18',
      'S-19',
      'S-20',
      'S-21',
      'S-22',
      'S-23',
      'S-24',
    ]);
  });

  it('narrows to one outcome, keeping the three non-success outcomes apart', async () => {
    const run = await exampleRun();

    expect(await narrowedTo(run, { outcome: 'abandoned' })).toEqual([
      'S-11',
      'S-12',
      'S-15',
      'S-17',
      'S-18',
      'S-20',
      'S-22',
      'S-24',
    ]);
    expect(await narrowedTo(run, { outcome: 'failed' })).toEqual(['S-13', 'S-14', 'S-19']);
    expect(await narrowedTo(run, { outcome: 'automation_failure' })).toEqual(['S-09', 'S-23']);
  });

  it('narrows to the people who fixated an area of interest', async () => {
    const run = await exampleRun();

    expect(await narrowedTo(run, { aoiId: 'B-review-fee-row' })).toEqual([
      'S-13',
      'S-14',
      'S-15',
      'S-16',
      'S-17',
      'S-18',
      'S-19',
      'S-21',
      'S-24',
    ]);
  });

  it('narrows further as filters are combined', async () => {
    const run = await exampleRun();

    expect(await narrowedTo(run, { variant: 'B', outcome: 'abandoned' })).toEqual([
      'S-15',
      'S-17',
      'S-18',
      'S-20',
      'S-22',
      'S-24',
    ]);
  });

  it('leaves nobody when the combination is impossible', async () => {
    const run = await exampleRun();

    expect(
      await narrowedTo(run, { variant: 'B', outcome: 'success', aoiId: 'B-review-complete' }),
      'on the redesign nobody both finished and ever looked at the button that completes the order',
    ).toEqual([]);
  });

  it('constrains nothing for a filter the URL does not carry', async () => {
    const run = await exampleRun();

    expect(await narrowedTo(run, {})).toHaveLength(24);
    expect(await narrowedTo(run, { variant: null, outcome: null, aoiId: null })).toHaveLength(24);
    expect(
      await narrowedTo(run, { variant: '', aoiId: '' }),
      'a cleared control leaves ?variant= behind, which is no filter at all',
    ).toHaveLength(24);
  });
});

describe('the findings a session is evidence for', () => {
  it('resolves a session id through findings[].sessionIds, best-ranked first', async () => {
    const run = await exampleRun();
    const findings = await run.findings();

    expect(findingsForSession(findings, 'S-15').map((finding) => finding.id)).toEqual([
      'F-1',
      'F-2',
      'F-3',
    ]);
    expect(findingsForSession(findings, 'S-11').map((finding) => finding.id)).toEqual(['F-5']);
  });

  it('resolves a session in no finding to nothing, without throwing', async () => {
    const run = await exampleRun();
    const findings = await run.findings();

    expect(findingsForSession(findings, 'S-01')).toEqual([]);
    expect(findingsForSession(findings, 'S-99')).toEqual([]);
  });
});
