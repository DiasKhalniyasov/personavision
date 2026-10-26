// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from './setup';
import { Boot } from '../src/boot';
import { mount } from '../src/mount';

describe('the boot placeholder', () => {
  it('shows the product name and one line saying no run is loaded', () => {
    render(<Boot />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PersonaVision');
    expect(screen.getByText('No run has been loaded yet.')).toBeTruthy();
  });

  it('is the whole of the app: no chrome, no tab bar, no screen', () => {
    const { container } = render(<Boot />);

    expect(container.querySelectorAll('nav, header, [role="tablist"]')).toHaveLength(0);
    expect(container.querySelectorAll('h1, p')).toHaveLength(2);
  });
});

describe('mounting the app', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'root';
    container.textContent = 'The app did not start.';
    document.body.append(container);
  });

  it('replaces the boot fallback with the placeholder once the tokens are there', async () => {
    loadDesignTokens();

    await act(async () => {
      mount(container);
    });

    expect(container.textContent).toContain('PersonaVision');
    expect(container.textContent).toContain('No run has been loaded yet.');
    expect(container.textContent).not.toContain('did not start');
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
