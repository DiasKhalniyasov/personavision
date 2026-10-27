// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSchema } from '@personavision/contract';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from './app';
import { paths } from '../src/shell/paths';
import { runStatus } from '../src/shell/runStatus';

/**
 * Which screen a test is. The run artifact records where the run got to, so the three
 * screens of `/runs/:runId` are chosen by the run and never by what is on disk beside it.
 */

const SEED = '2026-10-24-1402-northwind-demo';

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the screen a test is', () => {
  const seed = () => runSchema.parse(readRunFile(SEED));

  it('is the Verdict for a finished test, and for one written before the status existed', () => {
    const run = seed();

    expect(run.status, 'the committed example run predates the status').toBeUndefined();
    expect(runStatus(run)).toBe('complete');
    expect(runStatus({ ...run, status: 'finished' })).toBe('complete');
  });

  it('is the Running screen while a test is open, and the Test failed screen when it failed', () => {
    const run = seed();

    expect(runStatus({ ...run, status: 'open' })).toBe('running');
    expect(runStatus({ ...run, status: 'failed' })).toBe('failed');
  });

  it('renders the Running screen for an open test, inside the same chrome', async () => {
    const run = readRunFile(SEED);
    await serveRunData({
      files: { [`/runs/${SEED}/run.json`]: JSON.stringify({ ...run, status: 'open' }) },
    });
    mountApp(paths.run(SEED));

    await waitFor(() => {
      // `#screen-running`'s heading names the test beside the state, the way the chrome
      // names it (#18); what this suite is about is which screen the status chose.
      expect(screen.getByRole('heading', { level: 1, name: /^Running · / })).toBeTruthy();
    });
    // The chrome above it is the chrome of any other test: a run being read is named
    // whatever state it is in.
    expect(screen.getByText('Northwind Outdoors')).toBeTruthy();
  });
});
