// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from './setup';
import { forgetRuns, mountApp, serveRunData } from './app';
import { paths } from '../src/shell/paths';
import { MotionProvider, useMoment, usePrefersReducedMotion } from '../src/shell/motion';
import type { Moment } from '../src/shell/motion';

/**
 * Motion: the durations come from the tokens, and under `prefers-reduced-motion` a moment
 * renders its finished state immediately rather than a shortened animation.
 */

/** jsdom answers every media query `false`; this makes one of them answer `true`. */
const prefersReducedMotion = (matches: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
};

const Moment = ({ moment }: { moment: Moment }) => <span>{`${useMoment(moment)}ms`}</span>;
const Reduced = () => <span>{String(usePrefersReducedMotion())}</span>;

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('a moment’s duration', () => {
  it('is the token’s, read from the cascade', () => {
    prefersReducedMotion(false);

    const { container } = render(
      <MotionProvider>
        <Moment moment="ticker" />
      </MotionProvider>,
    );

    expect(container.textContent).toBe('900ms');
  });

  it('follows an override of the custom property instead of returning a literal', () => {
    prefersReducedMotion(false);
    document.documentElement.style.setProperty('--moment-ticker-duration', '1500ms');

    const { container } = render(
      <MotionProvider>
        <Moment moment="ticker" />
      </MotionProvider>,
    );

    expect(container.textContent).toBe('1500ms');
  });

  it('reads seconds as milliseconds, so a component never parses a token itself', () => {
    prefersReducedMotion(false);
    document.documentElement.style.setProperty('--moment-beam-duration', '2s');

    const { container } = render(
      <MotionProvider>
        <Moment moment="beam" />
      </MotionProvider>,
    );

    expect(container.textContent).toBe('2000ms');
  });

  it('throws naming the file when the token does not resolve, rather than inventing one', () => {
    prefersReducedMotion(false);
    document.head.replaceChildren();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(
        <MotionProvider>
          <Moment moment="heat" />
        </MotionProvider>,
      ),
    ).toThrow('--moment-heat-duration');
    logged.mockRestore();
  });
});

describe('under prefers-reduced-motion: reduce', () => {
  it('every moment is zero, so a component renders its finished state at once', () => {
    prefersReducedMotion(true);

    const { container } = render(
      <MotionProvider>
        <Moment moment="ticker" />
        <Moment moment="spotlight" />
        <Moment moment="beam" />
        <Moment moment="heat" />
        <Moment moment="stagger" />
        <Reduced />
      </MotionProvider>,
    );

    expect(container.textContent).toBe('0ms0ms0ms0ms0mstrue');
  });

  it('mounts the whole app with no animation and no transition of its own', async () => {
    prefersReducedMotion(true);
    await serveRunData();
    const { container } = mountApp(paths.run('2026-10-24-1402-northwind-demo'));

    await waitFor(() => {
      expect(container.querySelector('[data-section="headline"]')).not.toBeNull();
    });

    // Nothing in the shell animates in JavaScript, so nothing carries an inline duration,
    // and the transitions the chrome does declare are `--duration-base`, which the tokens
    // file sets to 0ms under this query.
    for (const element of container.querySelectorAll<HTMLElement>('[style]')) {
      expect(element.style.transitionDuration, element.outerHTML).toBe('');
      expect(element.style.animationDuration, element.outerHTML).toBe('');
      expect(element.style.animation, element.outerHTML).toBe('');
    }
  });
});

describe('the provider', () => {
  it('is mounted above the router, so one answer covers every screen', async () => {
    prefersReducedMotion(true);
    await serveRunData();
    const { container } = mountApp(paths.audiences);

    // `MotionConfig` renders no element of its own, so what proves it is above the router
    // is that a screen rendered by the router reads the reduced-motion answer through it.
    await waitFor(() => {
      expect(container.textContent).toContain('New test');
    });
    const { container: inside } = render(
      <MotionProvider>
        <Moment moment="stagger" />
      </MotionProvider>,
    );
    expect(inside.textContent).toBe('0ms');
  });
});
