// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../../setup';
import { axeViolations, describeViolations } from '../../axe';
import { forgetRuns, mountApp } from '../../app';
import { newTestStep, paths } from '../../../src/shell/paths';
import {
  canLaunch,
  forgetWizardDraft,
  readWizardDraft,
  writeWizardDraft,
} from '../../../src/screens/newtest/wizard/draft';
import {
  A_TESTED_SITE,
  AN_UNTESTED_SITE,
  CREATORS_RECORD_ID,
  creatorsRecord,
  FIRST_TIME_CREATORS,
  refusal,
  savedAudienceRecord,
  serveStep,
  THE_SENTENCE,
} from './fixture';

/**
 * `/new?step=audience` — *who should try it, and what should they try?*
 *
 * `#screen-newtest-feature` of `docs/design/prototype.html`: the site, the feature and the
 * audience sentence, and under them **what that sentence became** as six fields the reader
 * can disagree with. The wizard around this step — the step in the query, the breadcrumb and
 * the draft — is `../shell.test.tsx`'s; what is asserted here is the step's own content and
 * the one rule it owns: nothing launches until the structured audience has been seen.
 *
 * The six lines' conversion is `fields.test.ts`'s; this suite reads the screen.
 */

/**
 * The registry's select is Radix's, which measures and captures the pointer. jsdom
 * implements neither, so the pointer-events check is turned off rather than the control
 * being replaced by one the product does not ship.
 */
const act = () => userEvent.setup({ pointerEventsCheck: 0 });

beforeEach(() => {
  loadDesignTokens();
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
});

const open = async (): Promise<ReturnType<typeof mountApp>> => {
  const mounted = mountApp(newTestStep('audience'));
  await screen.findByRole('heading', {
    level: 1,
    name: 'Who should try it, and what should they try?',
  });
  return mounted;
};

const field = (name: string | RegExp): HTMLInputElement =>
  screen.getByRole('textbox', { name }) as HTMLInputElement;

const picker = (name: string | RegExp): HTMLElement => screen.getByRole('combobox', { name });

/** The second card, once what the sentence became is on the screen. */
const readCard = (): HTMLElement =>
  screen.getByRole('region', { name: /First-time creators|Reading your sentence/ });

/** Turn the sentence in the box into an audience, the way a reader does. */
const turnIntoAudience = async (sentence: string = THE_SENTENCE): Promise<void> => {
  const user = act();
  await user.clear(field(/Describe your audience in a sentence/));
  await user.type(field(/Describe your audience in a sentence/), sentence);
  await user.click(screen.getByRole('button', { name: 'Turn this into an audience' }));
};

/** The six lines as the screen has them, by the labels the prototype gives them. */
const sixFields = (): Record<string, string> => ({
  Participants: (screen.getByRole('spinbutton', { name: 'Participants' }) as HTMLInputElement)
    .value,
  'Age groups': field('Age groups').value,
  'Gender split': field('Gender split').value,
  'Region and language': field('Region and language').value,
  'Device mix': field('Device mix').value,
  'How tech-confident': picker('How tech-confident').textContent ?? '',
});

describe('the form', () => {
  it('asks for the site, the feature and the audience, in the prototype’s words', async () => {
    await serveStep();
    await open();

    expect(picker('Site')).toBeTruthy();
    expect(field('The feature whose experience you want tested')).toBeTruthy();
    expect(field(/^Describe your audience in a sentence — or pick a saved one$/)).toBeTruthy();
    expect(document.body.textContent).toContain('Your sentence, kept as you wrote it.');
    expect(screen.getByRole('button', { name: 'Turn this into an audience' })).toBeTruthy();
  });

  it('offers the workspace’s sites, and states the chosen one’s URL and what it allows', async () => {
    await serveStep({ sites: [A_TESTED_SITE, AN_UNTESTED_SITE] });
    await open();
    const user = act();

    await waitFor(() => {
      expect(picker('Site').textContent).toContain('app.clipforge.example');
    });
    // The figures are the fixture's and the words are the Sites screen's: what this asserts
    // is that the field prints the platform's answer rather than a number of its own. The
    // whole URL is stated, because that is the address a hundred browsers are pointed at.
    expect(document.body.textContent).toContain(
      `${A_TESTED_SITE.url} · 100 agents per run allowed · 4 runs an hour · 10 browsers at a time.`,
    );

    await user.click(picker('Site'));
    await user.click(await screen.findByRole('option', { name: 'beta.clipforge.example/create' }));

    expect(document.body.textContent).toContain(
      `${AN_UNTESTED_SITE.url} · 100 agents per run allowed`,
    );
    // Nothing in the step is about who controls the site (`docs/FLOW.md` section 13).
    expect(screen.getByRole('main').textContent ?? '').not.toMatch(/verif|unverified|prove/i);
    expect(readWizardDraft().site).toEqual({
      id: 'site-beta',
      url: 'https://beta.clipforge.example/create',
    });
  });

  it('points a workspace with no site at the screen that adds one', async () => {
    await serveStep({ sites: [] });
    const { container } = await open();

    const notice = container.querySelector('.notice') as HTMLElement;
    expect(notice.textContent).toContain('This workspace has no site yet');
    expect(within(notice).getByRole('link', { name: 'Add the site' }).getAttribute('href')).toBe(
      paths.newSite,
    );
  });

  it('carries the feature sentence on exactly as it was typed', async () => {
    await serveStep();
    await open();
    const user = act();
    const typed = 'Generating a VIDEO from a prompt — the “one-click” path.  ';

    await user.type(field('The feature whose experience you want tested'), typed);

    await waitFor(() => {
      expect(readWizardDraft().feature).toBe(typed);
    });
  });
});

describe('what the sentence became', () => {
  it('is not drawn at all before a sentence has been described', async () => {
    await serveStep();
    const { container } = await open();

    expect(container.textContent).not.toContain('What we read from that sentence');
    expect(screen.queryByRole('button', { name: 'Write the goal' })).toBeNull();
  });

  it('renders the audience as six editable fields, as `#screen-newtest-feature` prints them', async () => {
    await serveStep();
    await open();
    await turnIntoAudience();

    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    expect(readCard().textContent).toContain('What we read from that sentence — edit anything');
    expect(sixFields()).toEqual({
      Participants: '100',
      'Age groups': '18–24 30% · 25–34 45% · 35–44 25%',
      'Gender split': '54% female · 46% male',
      'Region and language': 'Kazakhstan, Uzbekistan · Russian, Kazakh, English',
      'Device mix': '72% mobile · 28% desktop',
      'How tech-confident': 'not very tech-confident',
    });
    // Why the same audience and the same seed matter, which is the point of the footnote.
    expect(readCard().textContent).toContain('always produce the same hundred people');
  });

  it('says the sentence is being read, keeps the form usable, and does not move the layout', async () => {
    const served = await serveStep({ hold: true });
    await open();
    await turnIntoAudience();

    // The frame is drawn while the sentence is being read: the label, the six fields and the
    // footnote are all there, so nothing below shifts when the audience arrives.
    await waitFor(() => {
      expect(readCard().getAttribute('aria-busy')).toBe('true');
    });
    expect(readCard().textContent).toContain('Reading your sentence…');
    const whileReading = Object.keys(sixFields());
    // The first card stays usable: the sentence and the feature can still be typed.
    expect(field('The feature whose experience you want tested').disabled).toBe(false);
    expect(field(/Describe your audience in a sentence/).disabled).toBe(false);

    served.release();

    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    expect(Object.keys(sixFields())).toEqual(whileReading);
    expect(readCard().getAttribute('aria-busy')).toBe('false');
  });

  it('is the one thing a launch waits for: nothing is reviewed until it is on the screen', async () => {
    await serveStep();
    await open();

    expect(canLaunch(readWizardDraft())).toBe(false);

    await turnIntoAudience();

    await waitFor(() => {
      expect(readWizardDraft().audience).toEqual({
        sentence: THE_SENTENCE,
        audienceId: CREATORS_RECORD_ID,
        reviewed: true,
      });
    });
    expect(canLaunch(readWizardDraft())).toBe(true);
  });

  it('is read again, not remembered, when a reader comes back to the step', async () => {
    await serveStep({ records: [creatorsRecord()] });
    writeWizardDraft({
      site: null,
      feature: 'generating a video from a prompt',
      audience: { sentence: THE_SENTENCE, audienceId: CREATORS_RECORD_ID, reviewed: true },
      goal: null,
    });
    await open();

    await waitFor(() => {
      expect(sixFields()['Age groups']).toBe('18–24 30% · 25–34 45% · 35–44 25%');
    });
    expect(field(/Describe your audience in a sentence/).value).toBe(THE_SENTENCE);
  });
});

describe('editing what we read', () => {
  it('changes what would be saved, and never asks the model to read the sentence again', async () => {
    const served = await serveStep();
    await open();
    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    const user = act();

    await user.clear(field('Region and language'));
    await user.type(field('Region and language'), 'Kazakhstan · Kazakh');
    await user.click(screen.getByRole('button', { name: 'Write the goal' }));

    await waitFor(() => {
      expect(served.saved()).toHaveLength(1);
    });
    expect(served.saved()[0]).toEqual({
      ...FIRST_TIME_CREATORS,
      regions: ['Kazakhstan'],
      languages: ['Kazakh'],
    });
    // One call to read the sentence, and one only: an edit is an edit, not a re-reading.
    expect(served.sentences()).toEqual([THE_SENTENCE]);
  });

  it('goes on to the goal once the edit is stored', async () => {
    await serveStep();
    const { router } = await open();
    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });

    await act().click(screen.getByRole('button', { name: 'Write the goal' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?step=goal');
    });
  });

  it('refuses shares that do not sum to one against their own field, in the platform’s words', async () => {
    // The contract's own message, at the contract's own path, which is decision 22.
    const PLATFORM =
      'the age groups are a distribution: the shares must sum to 1 (±0.000001), and these sum to 0.6';
    const served = await serveStep({
      patches: () => refusal([{ path: 'ageGroups', message: PLATFORM }]),
    });
    await open();
    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    const user = act();

    await user.clear(field('Age groups'));
    await user.type(field('Age groups'), '18–24 30% · 25–34 30%');
    await user.click(screen.getByRole('button', { name: 'Write the goal' }));

    await waitFor(() => {
      expect(readCard().textContent).toContain(PLATFORM);
    });
    // Against its own field, and nowhere else; the reader is still on this step.
    expect(field('Age groups').getAttribute('aria-invalid')).toBe('true');
    expect(field('Device mix').getAttribute('aria-invalid')).toBe('false');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Who should try it, and what should they try?',
    );
    expect(served.saved()).toHaveLength(1);
  });

  it('refuses a line it cannot read at all without asking the platform to store it', async () => {
    const served = await serveStep();
    await open();
    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    const user = act();

    await user.clear(field('Gender split'));
    await user.type(field('Gender split'), 'mostly women');
    await user.click(screen.getByRole('button', { name: 'Write the goal' }));

    await waitFor(() => {
      expect(field('Gender split').getAttribute('aria-invalid')).toBe('true');
    });
    expect(served.saved()).toEqual([]);
  });
});

describe('a sentence the platform could not read', () => {
  it('is one sentence the reader can act on, and never an audience nobody wrote', async () => {
    await serveStep({
      reads: () =>
        refusal(
          [{ path: 'sentence', message: 'the reply named a device nobody offers.' }],
          'That sentence could not be read.',
        ),
    });
    const { container } = await open();
    await turnIntoAudience();

    const message = await waitFor(() => {
      const found = container.querySelector('[role="alert"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(message.textContent).toContain('We could not read your audience from that sentence.');
    // The form is the way on, which is the whole of what this state offers.
    expect(
      within(message)
        .getByRole('link', { name: /Describe them on the form/ })
        .getAttribute('href'),
    ).toBe(paths.newAudience);
    expect(container.textContent).not.toContain('What we read from that sentence');
    expect(canLaunch(readWizardDraft())).toBe(false);
  });

  it('says so for a platform that could not be reached either, rather than an empty audience', async () => {
    await serveStep({ reads: () => new Response('no', { status: 502 }) });
    const { container } = await open();
    await turnIntoAudience();

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'We could not read your audience from that sentence.',
      );
    });
    expect(container.textContent).not.toContain('What we read from that sentence');
  });
});

describe('a saved audience instead', () => {
  it('renders in the same six fields, so a reader can disagree with it here too', async () => {
    await serveStep({ records: [creatorsRecord(), savedAudienceRecord()] });
    await open();
    const user = act();

    // The workspace's audiences are read once the app is open; until they are there is
    // nothing to pick from, and the form is what the control offers.
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Use a saved audience instead' })).toBeTruthy();
    });
    await user.click(picker('Use a saved audience instead'));
    await user.click(await screen.findByRole('option', { name: 'First-time creators' }));

    await waitFor(() => {
      expect(sixFields()['Gender split']).toBe('54% female · 46% male');
    });
    expect(readWizardDraft().audience?.audienceId).toBe(CREATORS_RECORD_ID);
    expect(canLaunch(readWizardDraft())).toBe(true);
  });

  it('replaces an audience a sentence became, rather than leaving the first one standing', async () => {
    await serveStep({ records: [creatorsRecord(), savedAudienceRecord()] });
    await open();
    const user = act();
    await turnIntoAudience();
    await waitFor(() => {
      expect(sixFields()['Age groups']).toBe('18–24 30% · 25–34 45% · 35–44 25%');
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Use a saved audience instead' })).toBeTruthy();
    });
    await user.click(picker('Use a saved audience instead'));
    await user.click(await screen.findByRole('option', { name: 'Outdoor-gear shoppers' }));

    await waitFor(() => {
      expect(sixFields()['Age groups']).toBe('25–45');
    });
    expect(readWizardDraft().audience?.audienceId).toBe('aud-outdoor-gear');
  });

  it('offers the form instead when the workspace has saved none', async () => {
    await serveStep({ records: [] });
    await open();

    expect(
      screen.getByRole('link', { name: 'Use a saved audience instead' }).getAttribute('href'),
    ).toBe(paths.audiences);
  });
});

describe('the step itself', () => {
  it('passes axe cleanly, with the audience on the screen and with a refusal on it', async () => {
    await serveStep();
    const { container } = await open();
    const main = () => container.querySelector('main') as HTMLElement;

    const empty = await axeViolations(main());
    expect(empty, describeViolations(empty)).toHaveLength(0);

    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });

    const read = await axeViolations(main());
    expect(read, describeViolations(read)).toHaveLength(0);
  });

  it('is operable and submittable by keyboard alone', async () => {
    await serveStep();
    await open();
    const user = act();

    await user.click(field(/Describe your audience in a sentence/));
    await user.keyboard(THE_SENTENCE.slice(0, 20));
    // Tab to the one control that reads the sentence, and press it with the keyboard.
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Turn this into an audience' }),
    );
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    // And every one of the six is reachable and editable from there.
    field('Age groups').focus();
    await user.keyboard('{End} 45+ 0%');
    expect(field('Age groups').value).toContain('45+ 0%');
  });

  it('restates no value by hand, and sits in the column the wizard draws', async () => {
    await serveStep();
    const { container } = await open();
    await turnIntoAudience();
    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });

    const main = container.querySelector('main') as HTMLElement;
    expect(main.querySelector('.wrap-narrow')).not.toBeNull();
    // The prototype positions these two cards with an inline `style`; this screen takes the
    // same spacing from its own stylesheet, so the component writes no `style` at all. The
    // registry's `select` writes one of its own on the hidden control it bubbles through,
    // which is the primitive's and not this screen's — so the source is what is read.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../src/screens/newtest/wizard/audience/AudienceStep.tsx',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/\bstyle=/);
  });

  it('is complete and still on first paint under prefers-reduced-motion: reduce', async () => {
    await serveStep();
    vi.stubGlobal(
      'matchMedia',
      (query: string): MediaQueryList =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    await open();
    await turnIntoAudience();

    await waitFor(() => {
      expect(readCard().textContent).toContain('First-time creators');
    });
    // Nothing animates in: the audience is complete on the render it arrives on.
    expect(sixFields()['Participants']).toBe('100');
  });
});
