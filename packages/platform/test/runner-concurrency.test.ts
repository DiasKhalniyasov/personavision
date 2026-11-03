/**
 * `PV_RUNNER_CONCURRENCY` moves the estimate, and moves no cap (#317).
 *
 * The variable is **our own ceiling** on how many sessions we are willing to run at once —
 * which is a fact about managed job executions and about what we can afford, and not about any
 * site. The three caps `docs/FLOW.md` section 13 fixes are about the site being driven: a
 * hundred agents a run, ten browsers at a time per site, four runs an hour per site.
 *
 * So this suite does two things and the second is the one that matters: it shows the estimate's
 * arithmetic really does divide by what `sessionsInFlight` produces, and it shows that every
 * cap answers the same whatever this variable says — **asserted at a thousand**, which is the
 * value that would be visible on every one of them if any of them read it.
 *
 * Every assertion about a figure hands `sessionsInFlight` its own environment, so the suite
 * passes on a machine configured the way `docs/deployment.md` instructs. The two tests that do
 * read `process.env` set it themselves and put it back.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPS,
  CapRefusedError,
  concurrencyForSite,
  refuseTooManyAgents,
  refuseTooManyRunsThisHour,
  RUNNER_CONCURRENCY_ENV,
  sessionsInFlight,
} from '../src/index.js';
import { estimateRun } from '../src/run/estimate.js';
import type { EstimateRequest, MeasuredHistory, MeasuredRun } from '../src/run/estimate.js';

const THE_SITE = 'https://example.test/a/cart';

/** Three finished sessions, so the time figures are a range the batches multiply up. */
const HISTORY: MeasuredHistory = {
  onSite: [
    {
      runId: 'r1',
      engineMode: 'offline',
      sessionDurationsMs: [60_000, 90_000, 120_000],
      tokensPerSession: null,
      videoBytesPerSession: 10_000_000,
      browserStartupMs: null,
    } satisfies MeasuredRun,
  ],
  elsewhere: [],
};

const asked = (concurrency: number): EstimateRequest => ({
  participants: 100,
  siteUrl: THE_SITE,
  engineMode: 'offline',
  modelMode: 'standard',
  concurrency,
});

/** The batches the estimate quotes for a hundred agents at the ceiling the environment names. */
const batchesAt = (env: Record<string, string>): number => {
  const estimate = estimateRun(
    { ...asked(CAPS.concurrentSessionsPerSite), concurrency: sessionsInFlight(undefined, env) },
    HISTORY,
  );
  if (estimate.time.state !== 'known') throw new Error(`the time is ${estimate.time.state}`);
  return estimate.time.batches;
};

const A_THOUSAND = { [RUNNER_CONCURRENCY_ENV]: '1000' };

describe('our own concurrency ceiling', () => {
  it('is the per-site cap when nothing names one', () => {
    expect(sessionsInFlight(undefined, {})).toBe(CAPS.concurrentSessionsPerSite);
  });

  it('reads the process environment when no environment is handed to it', () => {
    const saved = process.env[RUNNER_CONCURRENCY_ENV];
    process.env[RUNNER_CONCURRENCY_ENV] = '3';
    try {
      expect(sessionsInFlight()).toBe(3);
    } finally {
      if (saved === undefined) delete process.env[RUNNER_CONCURRENCY_ENV];
      else process.env[RUNNER_CONCURRENCY_ENV] = saved;
    }
  });

  it('holds a run below the cap when the environment names a smaller ceiling', () => {
    expect(sessionsInFlight(undefined, { [RUNNER_CONCURRENCY_ENV]: '2' })).toBe(2);
    expect(sessionsInFlight(undefined, { [RUNNER_CONCURRENCY_ENV]: '1' })).toBe(1);
  });

  it('is still the per-site cap when the environment names a larger one', () => {
    expect(sessionsInFlight(undefined, A_THOUSAND)).toBe(CAPS.concurrentSessionsPerSite);
  });

  it('reads an unreadable or impossible value as nobody naming a ceiling', () => {
    for (const named of ['', '   ', 'ten', 'NaN', '0', '-4', 'Infinity']) {
      expect(sessionsInFlight(undefined, { [RUNNER_CONCURRENCY_ENV]: named })).toBe(
        CAPS.concurrentSessionsPerSite,
      );
    }
  });

  it('still honours a caller that asked for less than both', () => {
    expect(sessionsInFlight(3, { [RUNNER_CONCURRENCY_ENV]: '8' })).toBe(3);
    expect(sessionsInFlight(3, {})).toBe(3);
  });
});

describe('raising it moves the estimate', () => {
  it('quotes more batches at a lower ceiling and fewer at a higher one', () => {
    // A hundred agents: fifty batches of two, twenty of five, ten at the cap.
    expect(batchesAt({ [RUNNER_CONCURRENCY_ENV]: '2' })).toBe(50);
    expect(batchesAt({ [RUNNER_CONCURRENCY_ENV]: '5' })).toBe(20);
    expect(batchesAt({})).toBe(10);
    // And raising it past the cap quotes what the cap allows, not what we could afford.
    expect(batchesAt(A_THOUSAND)).toBe(10);
  });

  it('quotes a longer run at a lower ceiling, from the same measured sessions', () => {
    const slower = estimateRun(
      { ...asked(10), concurrency: sessionsInFlight(undefined, { [RUNNER_CONCURRENCY_ENV]: '2' }) },
      HISTORY,
    );
    const atTheCap = estimateRun(
      { ...asked(10), concurrency: sessionsInFlight(undefined, {}) },
      HISTORY,
    );
    if (slower.time.state !== 'known' || atTheCap.time.state !== 'known') {
      throw new Error('both estimates are quoted from the same measured history');
    }
    expect(slower.time.ms.high).toBeGreaterThan(atTheCap.time.ms.high);
    // From the same sessions: only the batches moved.
    expect(slower.time.medianSessionMs).toBe(atTheCap.time.medianSessionMs);
    expect(slower.time.sessionsMeasured).toBe(atTheCap.time.sessionsMeasured);
  });
});

describe('and moves no cap', () => {
  /**
   * The assertion that would fail if a cap read the variable: every cap is exercised with a
   * ceiling of a thousand in the environment, and every one of them answers what it answers
   * with nothing set.
   */
  it('leaves the three numbers, and every refusal built on them, exactly as they were', () => {
    const before = { ...CAPS };
    const saved = process.env[RUNNER_CONCURRENCY_ENV];
    process.env[RUNNER_CONCURRENCY_ENV] = '1000';
    try {
      expect({ ...CAPS }).toEqual(before);
      expect(CAPS.concurrentSessionsPerSite).toBe(before.concurrentSessionsPerSite);

      // The per-site concurrency: still the cap, and still a sentence for a caller above it.
      expect(concurrencyForSite()).toEqual({
        concurrency: before.concurrentSessionsPerSite,
        lowered: null,
      });
      const tooMany = concurrencyForSite(before.concurrentSessionsPerSite + 1);
      expect(tooMany.concurrency).toBe(before.concurrentSessionsPerSite);
      expect(tooMany.lowered).toContain(String(before.concurrentSessionsPerSite));

      // The agents-per-run cap: still refuses one person more than it allows.
      expect(refuseTooManyAgents(before.agentsPerRun)).toBeNull();
      expect(refuseTooManyAgents(before.agentsPerRun + 1)).toBeInstanceOf(CapRefusedError);

      // The runs-per-hour cap: still refuses the fifth launch of the hour.
      const noon = new Date('2026-11-04T12:00:00.000Z');
      const launches = Array.from({ length: before.runsPerSitePerHour }, (_unused, at) => ({
        id: `launch-${String(at)}`,
        runId: `r${String(at)}`,
        at: new Date(noon.getTime() - (at + 1) * 60_000).toISOString(),
      }));
      expect(refuseTooManyRunsThisHour(launches, noon)).toBeInstanceOf(CapRefusedError);
      expect(refuseTooManyRunsThisHour(launches.slice(1), noon)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env[RUNNER_CONCURRENCY_ENV];
      else process.env[RUNNER_CONCURRENCY_ENV] = saved;
    }
  });
});
