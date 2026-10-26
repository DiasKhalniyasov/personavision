// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@personavision/contract';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, readRunFile, serveRunData } from './app';
import { paths } from '../src/shell/paths';

/**
 * Reading a run: one place, through `packages/contract`, and honest about what it cannot
 * read. Everything here goes through the app, because the hook's whole job is what the
 * screen above it ends up showing.
 */

const SEED = '2026-10-24-1402-northwind-demo';

const served = (requests: string[], path: string): number =>
  requests.filter((request) => request === path).length;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the run the chrome names and the run the screen renders', () => {
  it('are one read, not two', async () => {
    const { requests } = await serveRunData();
    mountApp(paths.run(SEED));

    await waitFor(() => {
      expect(document.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    expect(served(requests, `/runs/${SEED}/run.json`)).toBe(1);
  });

  it('is read again on another screen of the same test without another request', async () => {
    const { requests } = await serveRunData();
    const { unmount } = mountApp(paths.run(SEED));
    await waitFor(() => {
      expect(document.querySelector('[data-section="headline"]')).not.toBeNull();
    });
    unmount();

    mountApp(paths.sessions(SEED));
    await screen.findByRole('heading', { name: 'Sessions' });

    expect(served(requests, `/runs/${SEED}/run.json`)).toBe(1);
  });
});

describe('a run the viewer cannot read', () => {
  it('names the file and what is wrong with it, rather than throwing', async () => {
    await serveRunData({ files: { [`/runs/${SEED}/run.json`]: '{ not json' } });
    mountApp(paths.run(SEED));

    expect(
      await screen.findByRole('heading', { name: 'That test could not be read' }),
    ).toBeTruthy();
    expect(screen.getByText(`/runs/${SEED}/run.json`)).toBeTruthy();
    expect(screen.getByText(/not valid JSON/)).toBeTruthy();
  });

  it('names the field when a run breaks the contract, at the path it breaks it', async () => {
    const run = readRunFile(SEED);
    await serveRunData({
      files: {
        [`/runs/${SEED}/run.json`]: JSON.stringify({ ...run, schemaVersion: SCHEMA_VERSION + 1 }),
      },
    });
    mountApp(paths.run(SEED));

    await screen.findByRole('heading', { name: 'That test could not be read' });
    expect(screen.getByText(/schemaVersion/)).toBeTruthy();
    expect(screen.getByText(/regenerate the run directory/)).toBeTruthy();
  });

  it('is read again rather than remembered as broken', async () => {
    const { requests } = await serveRunData({ files: { [`/runs/${SEED}/run.json`]: '{' } });
    const { unmount } = mountApp(paths.run(SEED));
    await screen.findByRole('heading', { name: 'That test could not be read' });
    unmount();

    mountApp(paths.run(SEED));
    await screen.findByRole('heading', { name: 'That test could not be read' });

    expect(served(requests, `/runs/${SEED}/run.json`)).toBe(2);
  });
});

describe('every field the viewer shows comes from the contract', () => {
  it('parses the run with runSchema, so an unexpected field is a violation and not a value', async () => {
    const run = readRunFile(SEED);
    await serveRunData({
      files: {
        [`/runs/${SEED}/run.json`]: JSON.stringify({ ...run, workspaceId: 'northwind-demo' }),
      },
    });
    mountApp(paths.run(SEED));

    // The artifact is closed: a field the contract does not declare — an account id, a
    // workspace id — is refused where it sits rather than quietly rendered.
    await screen.findByRole('heading', { name: 'That test could not be read' });
    expect(screen.getByText(/workspaceId/)).toBeTruthy();
  });
});
