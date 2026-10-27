// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDesignTokens } from '../setup';
import { axeViolations, describeViolations } from '../axe';
import { demoAudienceRecord, forgetRuns, mountApp } from '../app';
import { otherAudienceRecord, refusal, servePlatform, STARTED_RUN_ID } from './fixture';
import { paths } from '../../src/shell/paths';

/**
 * `/new` — the three decisions a test is started from, and the two settings that change
 * what its result can claim.
 *
 * The form is asserted the way a reader uses it: the label on a field, the value in it, the
 * people named under the picker, what the screen says when a field is refused, and where
 * pressing Start lands. Nothing here asserts a class name, and nothing asserts that the
 * test ran — this screen hands the request to the platform and goes to `/runs/:runId`,
 * where #18's Running state takes over.
 */

/**
 * The registry's select is Radix's, which measures and captures the pointer. jsdom
 * implements neither, and Radix covers the body while a list is open, so the pointer-events
 * check is turned off for these tests rather than the control being replaced by one the
 * product does not ship.
 */
const act = () => userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  loadDesignTokens();
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(forgetRuns);

const START = /^Start test/;

/** The form, once it is on the screen. */
const openForm = async (options: Parameters<typeof mountApp>[1] = {}) => {
  const mounted = mountApp(paths.newTest, options);
  await screen.findByRole('button', { name: START });
  return mounted;
};

const field = (name: string | RegExp): HTMLInputElement =>
  screen.getByRole('textbox', { name }) as HTMLInputElement;

const picker = (name: string | RegExp): HTMLElement => screen.getByRole('combobox', { name });

/** Choose from one of the two selects, the way a pointer does. */
const choose = async (name: string | RegExp, option: string | RegExp): Promise<void> => {
  const user = act();
  await user.click(picker(name));
  await user.click(await screen.findByRole('option', { name: option }));
};

/** Fill the form with a test that would start. */
const fillValidTest = async (): Promise<void> => {
  const user = act();
  await user.type(field('Variant A URL'), 'http://localhost:4173/checkout-a');
  await user.type(field('Variant B URL'), 'http://localhost:4173/checkout-b');
  await user.type(field('Task'), 'Buy the hiking boots and pay with the saved card.');
};

const start = async (): Promise<void> => {
  await act().click(screen.getByRole('button', { name: START }));
};

/** The message a field is marked with, read through the field's own description. */
const messageFor = (control: HTMLElement): string =>
  (control.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('the three decisions', () => {
  it('asks for the audience, the two versions and the task, and nothing else', async () => {
    await servePlatform();
    await openForm();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New test');
    expect(picker('Audience')).toBeTruthy();
    expect(field('Variant A URL')).toBeTruthy();
    expect(field('Variant B URL')).toBeTruthy();
    expect(field('Task')).toBeTruthy();
    expect(picker('Repeats per persona')).toBeTruthy();
    expect(field('Base seed')).toBeTruthy();
  });

  it('names each version the name it will carry in the result', async () => {
    await servePlatform();
    const { container } = await openForm();

    expect(messageFor(field('Variant A URL'))).toContain('Named Current checkout in results.');
    expect(messageFor(field('Variant B URL'))).toContain('Named Redesign candidate in results.');
    expect(container.textContent).toContain('It must say what counts as finishing');
  });

  it('says what the repeats and the seed each do to the result', async () => {
    await servePlatform();
    await openForm();

    expect(messageFor(picker('Repeats per persona'))).toContain(
      'This is what produces the spread the verdict is stated with.',
    );
    expect(messageFor(field('Base seed'))).toContain(
      'Same seed and same persona reproduce the run exactly.',
    );
  });

  it('opens on the contract’s own defaults', async () => {
    await servePlatform();
    await openForm();

    expect(picker('Repeats per persona').textContent).toContain('3');
    expect(field('Base seed').value).toBe('20261024');
  });
});

describe('the audience', () => {
  it('opens on the audience the most recent test ran with', async () => {
    // The newest audience in the list is not the one the latest test used, so a form that
    // simply took the first entry would open on the wrong people.
    await servePlatform({ records: [otherAudienceRecord(), demoAudienceRecord()] });
    await openForm();

    // The run the default comes from is read just after the form renders, so the picker
    // settles on it rather than opening on whichever audience the list happened to list first.
    await waitFor(() => {
      expect(picker('Audience').textContent).toContain('Outdoor-gear shoppers');
    });
  });

  it('lists this workspace’s audiences and no others', async () => {
    await servePlatform({ records: [demoAudienceRecord(), otherAudienceRecord()] });
    await openForm();

    const user = act();
    await user.click(picker('Audience'));
    const listed = (await screen.findAllByRole('option')).map((option) => option.textContent);

    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('Outdoor-gear shoppers');
    expect(listed[1]).toContain('Trade & wholesale buyers');

    // Closed before the test ends: the list is a portal on the document body, which this
    // app's DOM teardown clears before React unmounts it.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('option')).toBeNull();
    });
  });

  it('names an audience by its people, its ages and how price-aware it is', async () => {
    await servePlatform();
    await openForm();

    expect(picker('Audience').textContent).toBe(
      'Outdoor-gear shoppers — 25–45, mostly mobile, price-aware (4 people)',
    );
  });

  it('offers the way to edit the audience it is on', async () => {
    await servePlatform();
    await openForm();

    expect(screen.getByRole('link', { name: 'Edit the audience' }).getAttribute('href')).toBe(
      paths.audience('aud-outdoor-gear-shoppers'),
    );
  });

  it('names the people it generates, and changes them with the picker', async () => {
    await servePlatform({ records: [demoAudienceRecord(), otherAudienceRecord()] });
    const { container } = await openForm();
    const people = (): HTMLElement =>
      container.querySelector('[data-section="test-people"]') as HTMLElement;

    expect(within(people()).getByText('Rushed buyer')).toBeTruthy();
    expect(people().textContent).toContain('4 personas · 3 seeds each · 12 per version');

    await choose('Audience', /Trade & wholesale buyers/);

    await waitFor(() => {
      expect(within(people()).getByText('Trade rushed buyer')).toBeTruthy();
    });
    expect(within(people()).queryByText('Rushed buyer')).toBeNull();
    expect(people().textContent).toContain('2 personas · 3 seeds each · 6 per version');
  });

  it('sends a workspace with no audience to the screen that asks for one', async () => {
    await servePlatform({ records: [] });
    const { router } = mountApp(paths.newTest);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.audiences);
    });
    expect(screen.queryByRole('button', { name: START })).toBeNull();
  });

  it('waits for the audiences with a disabled picker, and the rest of the form is usable', async () => {
    await servePlatform();
    await openForm({ audiences: { status: 'loading' } });

    expect(picker('Audience').getAttribute('data-disabled')).not.toBeNull();
    expect(picker('Audience').textContent).toContain('Reading your audiences…');
    await act().type(field('Task'), 'Buy the boots');
    expect(field('Task').value).toBe('Buy the boots');
  });
});

describe('a field that was refused', () => {
  it('rejects a URL with no scheme against its own field, and starts nothing', async () => {
    const platform = await servePlatform();
    await openForm();

    const user = act();
    await user.type(field('Variant A URL'), 'http://localhost:4173/checkout-a');
    await user.type(field('Variant B URL'), 'localhost:4173/checkout-b');
    await user.type(field('Task'), 'Buy the hiking boots and pay with the saved card.');
    await start();

    const urlB = field('Variant B URL');
    expect(urlB.getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(urlB)).toContain('Needs a scheme: http:// or https://');
    expect(field('Variant A URL').getAttribute('aria-invalid')).toBe('false');
    expect(platform.started).toEqual([]);
  });

  it('rejects a task that says nothing about finishing, and offers the example', async () => {
    const platform = await servePlatform();
    await openForm();

    const user = act();
    await user.type(field('Variant A URL'), 'http://localhost:4173/checkout-a');
    await user.type(field('Variant B URL'), 'http://localhost:4173/checkout-b');
    await user.type(field('Task'), 'Have a look around');
    await start();

    const task = field('Task');
    expect(task.getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(task)).toContain(
      'The task has to say what finishing means, or nobody can be counted as having completed it.',
    );
    expect(messageFor(task)).toContain(
      'Example: “Buy the hiking boots and pay with the saved card.”',
    );
    expect(platform.started).toEqual([]);
  });

  it('rejects two identical URLs: there is nothing to compare', async () => {
    const platform = await servePlatform();
    await openForm();

    const user = act();
    await user.type(field('Variant A URL'), 'http://localhost:4173/checkout-a');
    await user.type(field('Variant B URL'), 'http://localhost:4173/checkout-a');
    await user.type(field('Task'), 'Buy the hiking boots and pay with the saved card.');
    await start();

    expect(messageFor(field('Variant B URL'))).toContain(
      'The same URL as variant A: there would be nothing to compare.',
    );
    expect(platform.started).toEqual([]);
  });

  it('rejects a seed that is not a whole number', async () => {
    await servePlatform();
    await openForm();

    const user = act();
    await user.clear(field('Base seed'));
    await user.type(field('Base seed'), 'yesterday');
    await fillValidTest();
    await start();

    expect(messageFor(field('Base seed'))).toContain('Needs a whole number.');
  });

  it('says how many fields need attention, and keeps every value typed', async () => {
    await servePlatform();
    await openForm();

    const user = act();
    await user.type(field('Variant A URL'), 'localhost:4173/checkout-a');
    await user.type(field('Variant B URL'), 'http://localhost:4173/checkout-b');
    await user.type(field('Task'), 'Have a look around');
    await start();

    expect(screen.getByText('The test was not started. Two fields need attention.')).toBeTruthy();
    expect(field('Variant A URL').value).toBe('localhost:4173/checkout-a');
    expect(field('Variant B URL').value).toBe('http://localhost:4173/checkout-b');
    expect(field('Task').value).toBe('Have a look around');
  });
});

describe('starting the test', () => {
  it('hands the platform the request the contract declares, and goes to the test', async () => {
    const platform = await servePlatform();
    const { router } = await openForm();

    await fillValidTest();
    await start();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.run(STARTED_RUN_ID));
    });
    expect(platform.started).toEqual([
      {
        task: { prompt: 'Buy the hiking boots and pay with the saved card.' },
        variants: [
          { id: 'A', name: 'Current checkout', url: 'http://localhost:4173/checkout-a' },
          { id: 'B', name: 'Redesign candidate', url: 'http://localhost:4173/checkout-b' },
        ],
        audienceId: 'aud-outdoor-gear-shoppers',
        repeats: 3,
        seed: 20261024,
        engineMode: 'offline',
      },
    ]);
  });

  it('lands on the Running state, which this screen does not render itself', async () => {
    await servePlatform();
    await openForm();

    await fillValidTest();
    await start();

    expect(await screen.findByRole('heading', { name: /^Running · / })).toBeTruthy();
  });

  it('submits the repeats the reader chose', async () => {
    const platform = await servePlatform();
    await openForm();

    await choose('Repeats per persona', '1 — fastest, no spread');
    await fillValidTest();
    await start();

    await waitFor(() => {
      expect(platform.started[0]?.repeats).toBe(1);
    });
  });

  it('says why the platform refused it, above the form, and keeps what was typed', async () => {
    await servePlatform({
      answer: () => refusal('That audience has no people to test with.'),
    });
    const { router } = await openForm();

    await fillValidTest();
    await start();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'That audience has no people to test with.',
      );
    });
    expect(router.state.location.pathname).toBe(paths.newTest);
    expect(field('Task').value).toBe('Buy the hiking boots and pay with the saved card.');
  });
});

describe('without a pointer', () => {
  it('is filled in and submitted by keyboard alone', async () => {
    const platform = await servePlatform();
    const { router } = await openForm();
    const user = act();

    field('Variant A URL').focus();
    await user.keyboard('http://localhost:4173/checkout-a');
    await user.tab();
    await user.keyboard('http://localhost:4173/checkout-b');
    await user.tab();
    await user.keyboard('Buy the hiking boots and pay with the saved card.');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.run(STARTED_RUN_ID));
    });
    expect(platform.started).toHaveLength(1);
  });

  it('is clean under axe, refused fields and all', async () => {
    await servePlatform();
    const { container } = await openForm();

    const user = act();
    await user.type(field('Variant A URL'), 'localhost:4173/checkout-a');
    await user.type(field('Task'), 'Have a look around');
    await start();

    const violations = await axeViolations(container.querySelector('main') as HTMLElement);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
