// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/dom';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from './setup';
import { forgetRuns, serveRunData } from './app';
import { mount } from '../src/mount';

describe('mounting the app', () => {
  let container: HTMLElement;

  beforeEach(async () => {
    await serveRunData();
    container = document.createElement('div');
    container.id = 'root';
    container.textContent = 'The app did not start.';
    document.body.append(container);
  });

  afterEach(forgetRuns);

  it('replaces the boot fallback with the product chrome once the tokens are there', async () => {
    loadDesignTokens();

    await act(async () => {
      mount(container);
    });

    expect(container.textContent).not.toContain('did not start');
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'PersonaVision' })).toBeTruthy();
    });
    expect(screen.getByRole('navigation', { name: 'This test' })).toBeTruthy();
  });

  it('says so in words when there is no #root at all, rather than rendering blank', async () => {
    loadDesignTokens();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      mount(null);
    });

    expect(document.body.textContent).toContain('The app could not start');
    expect(document.body.textContent).toContain('no #root element');
    logged.mockRestore();
  });

  it('says why in words when the tokens never arrived, rather than rendering blank', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      mount(container);
    });

    expect(container.textContent).toContain('The app could not start');
    expect(container.textContent).toContain('--score-threshold-good');
    expect(container.textContent).toContain('docs/design/tokens.css');
    // The reason reaches the console with its stack, not only the page.
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    logged.mockRestore();
  });
});
