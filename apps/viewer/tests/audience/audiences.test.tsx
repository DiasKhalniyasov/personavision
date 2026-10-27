// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { demoAudienceRecord, forgetRuns, mountApp } from '../app';
import { serveStore } from './fixture';
import { paths } from '../../src/shell/paths';
import type { AudienceRecord } from '../../src/screens/audience/store';

/**
 * `/audiences` — the workspace's audiences, and the screen that asks for one when there
 * is none.
 *
 * What is asserted is what a reader sees and where a click lands: the facts on a card, the
 * audience the latest test used, and the two ways out of an empty workspace. The store is
 * #102's, answered over the same `fetch` the run data goes through.
 */

const DEMO_RECORD_ID = 'aud-outdoor-gear-shoppers';

const second = (): AudienceRecord => {
  const demo = demoAudienceRecord();
  return {
    ...demo,
    id: 'aud-trade',
    audience: {
      ...demo.audience,
      id: 'trade-wholesale-buyers',
      name: 'Trade & wholesale buyers',
      ageRange: { min: 30, max: 60 },
      roles: ['Procurement'],
      regions: ['United Kingdom'],
      devices: [
        { ...(demo.audience.devices[1] as (typeof demo.audience.devices)[number]), share: 0.85 },
        { ...(demo.audience.devices[0] as (typeof demo.audience.devices)[number]), share: 0.15 },
      ],
      priceSensitivity: 0.1,
      techSavviness: 0.9,
    },
    people: demo.people.slice(0, 2),
  };
};

const cards = (): HTMLElement[] =>
  screen.getAllByRole('link').filter((link) => link.querySelector('h2') !== null);

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('the workspace’s audiences', () => {
  it('lists each one with its facts', async () => {
    await serveStore();
    mountApp(paths.audiences);

    const card = (await screen.findByRole('heading', { name: 'Outdoor-gear shoppers' }))
      .parentElement as HTMLElement;

    expect(card.textContent).toContain('25–45 · United Kingdom & Ireland');
    expect(card.textContent).toContain('60% mobile · 40% desktop');
    expect(card.textContent).toContain('First-time buyer and Returning customer');
    expect(card.textContent).toContain('Price-aware · moderately tech-confident');
    expect(card.textContent).toContain('4 people generated · seed 20261024');
  });

  it('marks the one the latest test used, and says the other is not used yet', async () => {
    await serveStore({ records: [demoAudienceRecord(), second()] });
    mountApp(paths.audiences);

    await screen.findByRole('heading', { name: 'Outdoor-gear shoppers' });
    // The audience the latest test used is read from that test, which arrives on its own.
    await waitFor(() => {
      expect((cards()[0] as HTMLElement).getAttribute('aria-current')).toBe('true');
    });
    const [used, unused] = cards();

    expect((used as HTMLElement).getAttribute('aria-current')).toBe('true');
    expect((used as HTMLElement).textContent).toContain('Used by the latest test');
    expect((unused as HTMLElement).getAttribute('aria-current')).toBeNull();
    expect((unused as HTMLElement).textContent).toContain('Not used yet');
  });

  it('opens an audience, and offers a card for describing a new one', async () => {
    await serveStore();
    const { router } = mountApp(paths.audiences);

    const open = await screen.findByRole('link', { name: /Outdoor-gear shoppers/ });
    expect(open.getAttribute('href')).toBe(paths.audience(DEMO_RECORD_ID));
    expect(screen.getByRole('link', { name: /Describe a new audience/ }).getAttribute('href')).toBe(
      paths.newAudience,
    );

    await userEvent.click(open);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audience(DEMO_RECORD_ID));
    });
  });

  it('reserves the cards’ space while the store is being read', async () => {
    await serveStore();
    const { container } = mountApp(paths.audiences);

    expect(container.querySelector('[data-loading="audience"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Reading your audiences…');
    await screen.findByRole('heading', { name: 'Outdoor-gear shoppers' });
    expect(container.querySelector('[data-loading="audience"]')).toBeNull();
  });

  it('says so, and keeps the screen, when the store cannot be reached', async () => {
    await serveStore({ records: [] });
    // The list route answers, and what it answers with is not an audience list.
    const reads = globalThis.fetch;
    Object.assign(globalThis, {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith('/audiences')
          ? Promise.resolve(new Response('nope', { status: 503 }))
          : reads(input, init),
    });
    mountApp(paths.audiences);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be reached');
    expect(screen.getByRole('heading', { name: 'Who does your business serve?' })).toBeTruthy();
  });

  it('is clean under axe', async () => {
    await serveStore({ records: [demoAudienceRecord(), second()] });
    const { container } = mountApp(paths.audiences);

    await screen.findByRole('heading', { name: 'Outdoor-gear shoppers' });
    const results = await axe.run(container.querySelector('main') as HTMLElement, {
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('a workspace with no audience', () => {
  it('asks who the customers are, and offers the example test', async () => {
    await serveStore({ records: [] });
    mountApp(paths.audiences);

    expect(
      await screen.findByRole('heading', { name: 'First, who are your customers?' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Describe my audience' }).getAttribute('href')).toBe(
      paths.newAudience,
    );
    expect(
      screen.getByRole('link', { name: 'Look at the example test first' }).getAttribute('href'),
    ).toBe(paths.demo);
  });

  it('refuses to start a test, and sends the reader here', async () => {
    await serveStore({ records: [] });
    const { router } = mountApp(paths.newTest);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
    expect(
      await screen.findByRole('heading', { name: 'First, who are your customers?' }),
    ).toBeTruthy();
  });

  it('lets a test be started once there is one', async () => {
    await serveStore();
    const { router } = mountApp(paths.newTest);

    expect(await screen.findByRole('heading', { name: 'New test' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(paths.newTest);
  });

  it('is clean under axe', async () => {
    await serveStore({ records: [] });
    const { container } = mountApp(paths.audiences);

    await screen.findByRole('heading', { name: 'First, who are your customers?' });
    const results = await axe.run(container.querySelector('main') as HTMLElement, {
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('an audience the generator refuses', () => {
  it('says so on its own card rather than taking the list down', async () => {
    const broken: AudienceRecord = {
      ...second(),
      people: [],
      issues: [
        {
          path: 'generatedFrom.generatorVersion',
          message: 'this audience was generated from by "persona-gen-0"',
        },
      ],
    };
    await serveStore({ records: [demoAudienceRecord(), broken] });
    mountApp(paths.audiences);

    await screen.findByRole('heading', { name: 'Outdoor-gear shoppers' });
    const card = screen.getByRole('heading', { name: 'Trade & wholesale buyers' })
      .parentElement as HTMLElement;
    expect(card.textContent).toContain('No people: this audience was generated from by');
    expect(within(screen.getByRole('main')).getAllByRole('heading', { level: 2 })).toHaveLength(3);
  });
});
