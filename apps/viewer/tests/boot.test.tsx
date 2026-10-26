// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    document.head.replaceChildren();
    document.documentElement.removeAttribute('style');
    container = document.createElement('div');
    container.id = 'root';
    container.textContent = 'The app did not start.';
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
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

    await act(async () => {
      mount(null);
    });

    expect(document.body.textContent).toContain('The app could not start');
    expect(document.body.textContent).toContain('no #root element');
  });

  it('says why in words when the tokens never arrived, rather than rendering blank', async () => {
    await act(async () => {
      mount(container);
    });

    expect(container.textContent).toContain('The app could not start');
    expect(container.textContent).toContain('--score-threshold-good');
    expect(container.textContent).toContain('docs/design/tokens.css');
  });
});
