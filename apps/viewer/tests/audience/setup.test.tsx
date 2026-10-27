// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { demoAudienceRecord, forgetRuns, mountApp } from '../app';
import { refusal, serveStore } from './fixture';
import { paths } from '../../src/shell/paths';
import type { AudienceRecord } from '../../src/screens/audience/store';

/**
 * `/audiences/:audienceId` and `/audiences/new` — describing the customers, and the people
 * the description generates.
 *
 * The form is asserted the way a reader uses it: by the label on a field, the value in it,
 * the words under the two sliders, and what the screen says when a save is refused. The
 * people underneath are never a control — they are the store's answer, and this suite
 * proves they change when the audience does.
 */

const DEMO_RECORD_ID = 'aud-outdoor-gear-shoppers';

const field = (name: string | RegExp): HTMLInputElement =>
  screen.getByRole(name instanceof RegExp ? 'textbox' : 'textbox', { name }) as HTMLInputElement;

const number = (name: string | RegExp): HTMLInputElement =>
  screen.getByRole('spinbutton', { name }) as HTMLInputElement;

const openForm = async (path: string) => {
  const mounted = mountApp(path);
  await screen.findByRole('button', { name: 'Save audience' });
  return mounted;
};

beforeEach(loadDesignTokens);
afterEach(forgetRuns);

describe('an audience that already exists', () => {
  it('renders its values, field by field', async () => {
    await serveStore();
    await openForm(paths.audience(DEMO_RECORD_ID));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Outdoor-gear shoppers');
    expect(field('Audience name').value).toBe('Outdoor-gear shoppers');
    expect(number('Age from').value).toBe('25');
    expect(number('Age to').value).toBe('45');
    expect(number('Mobile share (%)').value).toBe('60');
    expect(number('Desktop share (%)').value).toBe('40');
    expect(
      screen.getByRole('button', { name: 'First-time buyer' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Gift buyer' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(
      screen.getByRole('button', { name: 'United Kingdom' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('says that editing it does not change a finished test', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));

    expect(container.textContent).toContain(
      'Changing an audience does not change a finished test: a test records the audience it ran with.',
    );
  });

  it('says so when the path names no audience of this workspace', async () => {
    await serveStore();
    mountApp(paths.audience('aud-nobody'));

    expect(await screen.findByRole('heading', { name: 'No audience with that id' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to your audiences' })).toBeTruthy();
  });

  it('reserves the form’s space while it is read', async () => {
    await serveStore();
    const { container } = mountApp(paths.audience(DEMO_RECORD_ID));

    expect(container.querySelector('[data-loading="audience"]')).not.toBeNull();
    await screen.findByRole('button', { name: 'Save audience' });
    expect(container.querySelector('[data-loading="audience"]')).toBeNull();
  });
});

describe('a new audience', () => {
  it('renders an empty form', async () => {
    await serveStore();
    await openForm(paths.newAudience);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Describe your audience');
    expect(field('Audience name').value).toBe('');
    expect(number('Age from').value).toBe('');
    expect(number('Age to').value).toBe('');
    expect(
      screen.getByRole('button', { name: 'First-time buyer' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('has nobody until it is saved, and says where the people will come from', async () => {
    await serveStore();
    const { container } = await openForm(paths.newAudience);
    const people = container.querySelector('[data-section="generated-people"]') as HTMLElement;

    expect(people.textContent).toContain(
      'Save the audience and PersonaVision generates its people here.',
    );
  });
});

describe('saving', () => {
  it('posts the audience the form describes, and lists it on the way back', async () => {
    const store = await serveStore({ records: [] });
    const { router } = await openForm(paths.newAudience);

    await userEvent.type(field('Audience name'), 'Weekend hikers');
    await userEvent.type(number('Age from'), '30');
    await userEvent.type(number('Age to'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Gift buyer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.method).toBe('POST');
    expect(store.writes[0]?.url).toBe('/audiences');
    expect(store.writes[0]?.body).toMatchObject({
      id: 'weekend-hikers',
      name: 'Weekend hikers',
      ageRange: { min: 30, max: 50 },
      roles: ['Gift buyer'],
      size: 4,
    });
    expect(await screen.findByRole('heading', { name: 'Weekend hikers' })).toBeTruthy();
  });

  it('patches an audience that already exists, at its own record', async () => {
    const store = await serveStore();
    const { router } = await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.clear(field('Audience name'));
    await userEvent.type(field('Audience name'), 'Outdoor-gear regulars');
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
    expect(store.writes[0]?.method).toBe('PATCH');
    expect(store.writes[0]?.url).toBe(`/audiences/${DEMO_RECORD_ID}`);
    // The id a finished test recorded is kept: only the name the reader reads changes.
    expect(store.writes[0]?.body).toMatchObject({
      id: 'outdoor-gear-shoppers',
      name: 'Outdoor-gear regulars',
    });
  });

  it('keeps what was typed, and says what was wrong, when the store refuses it', async () => {
    await serveStore({
      records: [],
      answer: () =>
        refusal([{ path: 'id', message: 'this workspace already has an audience with that id' }]),
    });
    const { router } = await openForm(paths.newAudience);

    await userEvent.type(field('Audience name'), 'Weekend hikers');
    await userEvent.type(number('Age from'), '30');
    await userEvent.type(number('Age to'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toContain(
      'That audience could not be saved: one thing needs changing.',
    );
    expect(alerts.map((alert) => alert.textContent)).toContain(
      'this workspace already has an audience with that id',
    );
    expect(field('Audience name').value).toBe('Weekend hikers');
    expect(number('Age from').value).toBe('30');
    expect(router.state.location.pathname).toBe(paths.newAudience);
  });

  it('keeps the form standing when the store cannot be reached at all', async () => {
    await serveStore({
      records: [],
      answer: () => new Response('', { status: 502 }),
    });
    await openForm(paths.newAudience);

    await userEvent.type(field('Audience name'), 'Weekend hikers');
    await userEvent.type(number('Age from'), '30');
    await userEvent.type(number('Age to'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be reached');
    expect(alert.textContent).toContain('Nothing you typed has been lost');
    expect(field('Audience name').value).toBe('Weekend hikers');
  });

  it('is refused at the field, before the store is asked, when the age range runs backwards', async () => {
    const store = await serveStore();
    await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.clear(number('Age from'));
    await userEvent.type(number('Age from'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toContain(
      'an age range runs from min to max: found 60–45',
    );
    expect(store.writes).toEqual([]);
  });

  it('saves and goes on to the test when asked to', async () => {
    await serveStore();
    const { router } = await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.click(screen.getByRole('button', { name: 'Save and start a test' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.newTest);
    });
  });
});

describe('the device mix', () => {
  it('says the shares have to add up, and refuses them rather than normalising', async () => {
    const store = await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.clear(number('Desktop share (%)'));
    await userEvent.type(number('Desktop share (%)'), '35');

    expect(container.textContent).toContain('must add up to 100% — they add up to 95%');

    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toContain(
      'the device shares are a mix of one audience: they must add up to 100%, and these add up to 95%',
    );
    expect(store.writes).toEqual([]);
    // Nothing was rewritten behind the reader: what was typed is still what is there.
    expect(number('Desktop share (%)').value).toBe('35');
    expect(number('Mobile share (%)').value).toBe('60');
  });

  it('sends the shares as a distribution once they do add up', async () => {
    const store = await serveStore();
    await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.clear(number('Mobile share (%)'));
    await userEvent.type(number('Mobile share (%)'), '70');
    await userEvent.clear(number('Desktop share (%)'));
    await userEvent.type(number('Desktop share (%)'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    await waitFor(() => {
      expect(store.writes).toHaveLength(1);
    });
    expect(store.writes[0]?.body.devices.map((device) => [device.name, device.share])).toEqual([
      ['mobile', 0.7],
      ['desktop', 0.3],
    ]);
  });
});

describe('the two behaviour sliders', () => {
  it('show their value and say what each one moves', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));

    const tech = screen.getByRole('slider', { name: 'How tech-confident they are' });
    const price = screen.getByRole('slider', { name: 'How much price matters to them' });

    expect(tech.getAttribute('aria-valuetext')).toBe('0.55');
    expect(price.getAttribute('aria-valuetext')).toBe('0.75');
    expect(container.textContent).toContain('0.55');
    expect(container.textContent).toContain('0.75');
    expect(container.textContent).toContain(
      'These two move the generated people’s traits: how familiar an interface feels, how closely a total is read, and how quickly somebody gives up when a price changes.',
    );
  });

  it('moves with the keyboard alone, and sends what it was moved to', async () => {
    const store = await serveStore();
    await openForm(paths.audience(DEMO_RECORD_ID));

    const price = screen.getByRole('slider', { name: 'How much price matters to them' });
    price.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');

    expect(price.getAttribute('aria-valuetext')).toBe('0.77');

    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));
    await waitFor(() => {
      expect(store.writes).toHaveLength(1);
    });
    expect(store.writes[0]?.body.priceSensitivity).toBeCloseTo(0.77, 5);
  });
});

describe('the people this generates', () => {
  it('renders the generator’s output for this audience and its seed', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));
    const people = container.querySelector('[data-section="generated-people"]') as HTMLElement;

    expect(people.textContent).toContain('seed 20261024 · same audience and seed, same people');
    for (const person of demoAudienceRecord().people) {
      expect(people.textContent).toContain(person.name);
      expect(people.textContent).toContain(person.segment);
    }
  });

  it('is shown and never edited, and says it is generated from the audience', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));
    const people = container.querySelector('[data-section="generated-people"]') as HTMLElement;

    expect(within(people).queryAllByRole('textbox')).toEqual([]);
    expect(within(people).queryAllByRole('button')).toEqual([]);
    expect(within(people).queryAllByRole('slider')).toEqual([]);
    expect(people.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(people.textContent).toContain('Generated, not chosen.');
  });

  it('changes when the audience does', async () => {
    const demo = demoAudienceRecord();
    const regenerated: AudienceRecord = {
      ...demo,
      people: [
        {
          ...(demo.people[0] as (typeof demo.people)[number]),
          id: 'trade-1',
          name: 'Bulk buyer',
          segment: 'desktop · buys in bulk',
        },
      ],
    };
    await serveStore({
      answer: () =>
        new Response(JSON.stringify(regenerated), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));
    const people = () =>
      container.querySelector('[data-section="generated-people"]') as HTMLElement;

    expect(people().textContent).toContain('Rushed buyer');

    // Describe different customers, save, and come back to the audience: the people are
    // the generator's answer for what is now stored, not the ones the form opened with.
    await userEvent.click(screen.getByRole('button', { name: 'Trade buyer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));
    await userEvent.click(await screen.findByRole('link', { name: /Outdoor-gear shoppers/ }));
    await screen.findByRole('button', { name: 'Save audience' });

    await waitFor(() => {
      expect(people().textContent).toContain('Bulk buyer');
    });
    expect(people().textContent).not.toContain('Rushed buyer');
  });
});

describe('the form without a pointer or a screen', () => {
  it('gives every field a real label', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));
    const form = container.querySelector('form') as HTMLElement;

    // A primitive's own hidden input — the one Radix's select keeps a form value in — is
    // not a field anybody meets, and is already out of the accessibility tree.
    const fields = [...form.querySelectorAll<HTMLInputElement>('input, select, textarea')].filter(
      (control) =>
        control.closest('[aria-hidden="true"]') === null &&
        control.style.display !== 'none' &&
        control.type !== 'hidden',
    );
    expect(fields.length).toBeGreaterThan(0);

    for (const control of fields) {
      const described = control.id === '' ? null : form.querySelector(`label[for="${control.id}"]`);
      expect(
        described ?? control.getAttribute('aria-label') ?? control.getAttribute('aria-labelledby'),
        control.outerHTML,
      ).toBeTruthy();
    }
  });

  it('is filled in and submitted with the keyboard alone', async () => {
    const store = await serveStore({ records: [] });
    const { router } = await openForm(paths.newAudience);

    field('Audience name').focus();
    await userEvent.keyboard('Weekend hikers');
    await userEvent.tab();
    await userEvent.keyboard('30');
    await userEvent.tab();
    await userEvent.keyboard('50');
    // Enter in a text field submits the form, as it does in every other form on the web.
    field('Audience name').focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(store.writes).toHaveLength(1);
    });
    expect(store.writes[0]?.body).toMatchObject({
      name: 'Weekend hikers',
      ageRange: { min: 30, max: 50 },
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
  });

  it('is clean under axe', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));

    const results = await axe.run(container.querySelector('main') as HTMLElement, {
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('is clean under axe with every error on it', async () => {
    await serveStore();
    const { container } = await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.clear(field('Audience name'));
    await userEvent.clear(number('Age from'));
    await userEvent.clear(number('Desktop share (%)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));
    await screen.findAllByRole('alert');

    const results = await axe.run(container.querySelector('main') as HTMLElement, {
      resultTypes: ['violations'],
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('a refusal at a path no field on this form owns', () => {
  it('is said above the form rather than only counted', async () => {
    await serveStore({
      answer: () =>
        refusal([
          { path: 'generatedFrom.generatorVersion', message: 'this build is "persona-gen-1"' },
        ]),
    });
    await openForm(paths.audience(DEMO_RECORD_ID));

    await userEvent.click(screen.getByRole('button', { name: 'Save audience' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'That audience could not be saved: one thing needs changing. generatedFrom.generatorVersion: this build is "persona-gen-1"',
    );
  });
});
