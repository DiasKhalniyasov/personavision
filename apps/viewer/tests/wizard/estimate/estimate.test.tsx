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
import { ruleIn, rulesOf } from '../../cssom';
import { newTestStep, paths, STEP_PARAM } from '../../../src/shell/paths';
import {
  forgetWizardDraft,
  readWizardDraft,
  writeWizardDraft,
} from '../../../src/screens/newtest/wizard/draft';
import type { WizardDraft } from '../../../src/screens/newtest/wizard/draft';
import {
  filledDraft,
  knownEstimate,
  offlineEstimate,
  refusal,
  serveLaunch,
  STARTED_RUN_ID,
} from './fixture';
import type { LaunchBehaviour } from './fixture';

/**
 * `/new?step=estimate` — the estimate, the launch, and the cap that can refuse it.
 *
 * `#screen-newtest-estimate` of `docs/design/prototype.html`, as the product: the heading
 * naming the run, the three figures with the arithmetic under them, the one button that
 * starts anything, and what the screen does with a refusal.
 *
 * The platform is faked at the network boundary (`fixture.tsx`) and **every figure served is
 * the fixture's own**, so what is asserted throughout is that the screen prints what it was
 * handed: a figure this screen computed itself would be a figure that one day disagrees with
 * the run it describes.
 */

const openStep = async (
  behaviour: LaunchBehaviour = {},
  draft: WizardDraft = filledDraft(),
): Promise<Awaited<ReturnType<typeof serveLaunch>> & { mounted: ReturnType<typeof mountApp> }> => {
  const served = await serveLaunch(behaviour);
  writeWizardDraft(draft);
  const mounted = mountApp(newTestStep('estimate'));
  return { ...served, mounted };
};

/** One of the three figures, by the cell it is in. */
const cell = (name: string): HTMLElement =>
  document.querySelector(`[data-figure="${name}"]`) as HTMLElement;

const figureIn = (name: string): string => cell(name).querySelector('b')?.textContent ?? '';
const lineIn = (name: string): string => cell(name).querySelector('span.faint')?.textContent ?? '';

/** The `dl.kv` under the figures, row by row. */
const madeOf = (): Record<string, string> => {
  const rows: Record<string, string> = {};
  const list = document.querySelector('dl') as HTMLElement;
  const keys = [...list.querySelectorAll('dt')];
  const values = [...list.querySelectorAll('dd')];
  keys.forEach((key, index) => {
    rows[key.textContent ?? ''] = values[index]?.textContent ?? '';
  });
  return rows;
};

const launchButton = async (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /^Launch/ });

const heading = async (): Promise<HTMLElement> => screen.findByRole('heading', { level: 1 });

const mainText = (): string => (document.querySelector('main') as HTMLElement).textContent ?? '';

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
  vi.restoreAllMocks();
});

describe('the heading', () => {
  it('names the agents, the site, the feature and the audience the launch is about', async () => {
    await openStep();

    // The prototype's own heading and lede, from the audience the draft names and the
    // sentence the user wrote.
    expect((await heading()).textContent).toBe('100 agents on app.clipforge.example');
    expect((document.querySelector('.lede') as HTMLElement).textContent).toBe(
      'Generating a video from a prompt, for First-time creators. Here is what it will take.',
    );
  });
});

describe('the three figures', () => {
  it('renders each one as the platform quoted it', async () => {
    await openStep();
    await waitFor(() => {
      expect(figureIn('agents')).not.toBe('');
    });

    // 100 agents, 10 at a time; 900_000–1_500_000 ms; $0.81–$1.2025 — the fixture's figures,
    // in the units the card prints them in and in no arithmetic of the browser's.
    expect(figureIn('agents')).toBe('100');
    expect(lineIn('agents')).toBe('10 at a time, the per-site cap');
    expect(figureIn('time')).toBe('15–25 min');
    expect(figureIn('cost')).toBe('$0.81–$1.20');
    expect([...document.querySelectorAll('[data-figure]')]).toHaveLength(3);
  });

  it('prints the platform’s own totals, whatever they are', async () => {
    // The proof that nothing here is computed in the browser: an answer whose totals are not
    // a product of anything on this screen is printed exactly as it arrived.
    await openStep({
      estimate: (quoted) =>
        new Response(
          JSON.stringify({
            ...knownEstimate(quoted),
            agents: { participants: 7, sessions: 7, concurrency: 3 },
            time: {
              ...(knownEstimate(quoted).time as Record<string, unknown>),
              ms: { low: 120_000, high: 180_000 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    await waitFor(() => {
      expect(figureIn('agents')).toBe('7');
    });

    expect(figureIn('time')).toBe('2–3 min');
    expect(lineIn('agents')).toBe('3 at a time, under the per-site cap of 10');
  });

  it('labels a range as a range', async () => {
    await openStep();
    await waitFor(() => {
      expect(figureIn('time')).toBe('15–25 min');
    });
    expect(lineIn('time')).toContain('A range · ');
    expect(lineIn('cost')).toContain('A range · ');
  });

  it('prints a figure with no spread as one figure, not a range of a number to itself', async () => {
    // The shape the first test on a site produces (decision 102, as #283 refined it).
    await openStep({
      estimate: (quoted) => {
        const known = knownEstimate(quoted);
        return jsonOf({
          ...known,
          time: {
            ...(known.time as Record<string, unknown>),
            ms: { low: 1_080_000, high: 1_080_000 },
          },
        });
      },
    });
    await waitFor(() => {
      expect(figureIn('time')).toBe('18 min');
    });

    expect(lineIn('time')).not.toContain('A range');
  });

  it('asks for the estimate once, with the draft’s own figures and the site’s cap', async () => {
    const served = await openStep();
    await waitFor(() => {
      expect(served.quoted()).toHaveLength(1);
    });

    expect(served.quoted()[0]).toEqual({
      participants: 100,
      siteUrl: 'https://app.clipforge.example/create',
      // The site's own cap, as `GET /sites` states it. This screen defines no concurrency.
      concurrency: 10,
      // The engine the button will really use, so the cost is a price for the test that is
      // about to run rather than for another one.
      engineMode: 'model',
    });
  });
});

describe('what the estimate is made of', () => {
  it('states the arithmetic, and the figures it names are the figures above it', async () => {
    await openStep();
    await waitFor(() => {
      expect(figureIn('time')).not.toBe('');
    });
    const rows = madeOf();

    expect(Object.keys(rows)).toEqual(['Time', 'Cost', 'Storage']);
    expect(rows.Time).toContain('100 sessions ÷ 10 concurrent');
    expect(rows.Time).toContain('the 1:50 median session on this site');
    expect(rows.Cost).toContain('around 6.8k input and 500 output tokens a session');
    expect(rows.Cost).toContain('docs/meta-model-api.md');
    // `browserStartupMs` is `null` on every estimate today, so the prototype's start-up line
    // is absent rather than invented (#246).
    expect(rows.Time).not.toContain('start the browsers');
  });

  it('cites the price document in the mono family, as the prototype draws it', async () => {
    await openStep();
    await waitFor(() => {
      expect(figureIn('cost')).not.toBe('');
    });

    const cited = [...document.querySelectorAll('dd .mono')].map((node) => node.textContent);
    expect(cited).toEqual(['docs/meta-model-api.md']);
  });

  it('sits in a card under the prototype’s own label', async () => {
    await openStep();
    await waitFor(() => {
      expect(figureIn('cost')).not.toBe('');
    });

    const card = (document.querySelector('dl') as HTMLElement).closest('.card') as HTMLElement;
    expect(card.querySelector('.microlabel')?.textContent).toBe('What the estimate is made of');
  });

  it('says a storage figure nobody has measured is not measured yet, and quotes none', async () => {
    await openStep({ estimate: (quoted) => jsonOf(offlineEstimate(quoted)) });
    await waitFor(() => {
      expect(figureIn('cost')).not.toBe('');
    });

    // Owner decision 101.
    expect(madeOf().Storage).toContain('Not measured yet');
    expect(madeOf().Storage).toContain('kept inside the run directory');
    expect(madeOf().Storage).not.toMatch(/\d\s?(?:GB|MB)/);
  });
});

describe('an offline run', () => {
  it('renders no price, says it costs nothing, and never prints a price of zero', async () => {
    await openStep({ estimate: (quoted) => jsonOf(offlineEstimate(quoted)) });
    await waitFor(() => {
      expect(figureIn('cost')).not.toBe('');
    });

    expect(figureIn('cost')).toBe('Nothing to pay');
    expect(figureIn('cost')).not.toContain('$');
    expect(mainText()).not.toContain('$0.00');
    expect(madeOf().Cost).toContain('calls no model');
    // A borrowed median is labelled as one on the same screen (decision 79).
    expect(lineIn('time')).toContain('not yet measured here');
  });
});

describe('the loading state', () => {
  it('renders the three figures as skeletons under their labels, with the button disabled', async () => {
    const served = await openStep({ holdEstimate: true });
    await launchButton();

    expect([...document.querySelectorAll('[data-figure]')]).toHaveLength(3);
    expect([...document.querySelectorAll('[data-waiting]')].length).toBeGreaterThan(0);
    expect(labelsOnScreen()).toEqual(['Agents', 'Time', 'Model cost']);
    expect((await launchButton()).hasAttribute('disabled')).toBe(true);

    served.release();
    await waitFor(() => {
      expect(figureIn('agents')).toBe('100');
    });
    // And the figures arrived in the cells the skeletons were standing in.
    expect(labelsOnScreen()).toEqual(['Agents', 'Time', 'Model cost']);
    expect(document.querySelectorAll('[data-waiting]')).toHaveLength(0);
    expect((await launchButton()).hasAttribute('disabled')).toBe(false);
  });

  it('does not move the layout when the estimate arrives', async () => {
    const served = await openStep({ holdEstimate: true });
    await launchButton();

    const before = [...document.querySelectorAll('[data-figure]')].map(
      (node) => node.previousElementSibling === null,
    );
    served.release();
    await waitFor(() => {
      expect(figureIn('time')).not.toBe('');
    });

    // The same three cells, in the same order, in the same row: nothing was added or
    // reordered around them.
    expect(
      [...document.querySelectorAll('[data-figure]')].map(
        (node) => node.previousElementSibling === null,
      ),
    ).toEqual(before);
    expect(cell('agents').parentElement).toBe(cell('cost').parentElement);
  });
});

describe('an estimate that cannot be read', () => {
  it('says so in one sentence and still offers the launch', async () => {
    await openStep({ estimate: () => refusal({ error: 'The estimate is not available.' }, 500) });
    const button = await launchButton();

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('The estimate is not available.');
    });
    expect(screen.getByRole('status').textContent).toContain('The test can still be launched.');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(document.querySelectorAll('[data-figure]')).toHaveLength(0);
  });

  it('says which read did not land when the site’s own cap cannot be read', async () => {
    await openStep({ sitesAnswer: 500 });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('limits could not be read');
    });
    expect((await launchButton()).hasAttribute('disabled')).toBe(false);
  });
});

describe('the launch button', () => {
  it('is disabled with its reason stated while the audience has not been reviewed', async () => {
    const draft = filledDraft();
    await openStep(
      {},
      {
        ...draft,
        audience: { ...(draft.audience as NonNullable<WizardDraft['audience']>), reviewed: false },
      },
    );
    const button = await launchButton();

    expect(button.hasAttribute('disabled')).toBe(true);
    const reason = document.getElementById(
      button.getAttribute('aria-describedby') ?? '',
    ) as HTMLElement;
    expect(reason.textContent).toContain('have not seen the audience');
    expect(within(reason).getByRole('link', { name: 'Review it' }).getAttribute('href')).toBe(
      newTestStep('audience'),
    );
  });

  it('starts the test and goes to the run it opened', async () => {
    const served = await openStep();
    const button = await launchButton();
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    await userEvent.setup().click(button);

    await waitFor(() => {
      expect(served.mounted.router.state.location.pathname).toBe(paths.run(STARTED_RUN_ID));
    });
  });

  it('submits the one-URL form, with the goal in the platform’s own spelling', async () => {
    const served = await openStep();
    const button = await launchButton();
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(served.started()).toHaveLength(1);
    });

    expect(served.started()[0]).toEqual({
      site: 'https://app.clipforge.example/create',
      siteId: 'site-clipforge',
      feature: 'generating a video from a prompt',
      goal: {
        task: 'Generate a video from a text prompt, and wait until it is ready to watch.',
        successCriterion: 'A video preview is visible on the page.',
        lastWrittenBy: 'model',
      },
      audienceId: 'aud-first-time-creators',
    });
  });

  it('starts nothing else: one estimate, one launch, and no other request', async () => {
    const served = await openStep();
    const button = await launchButton();
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(served.started()).toHaveLength(1);
    });

    expect(served.posted()).toEqual(['/runs/estimate', '/runs']);
  });

  it('keeps the product’s standing disclaimer beside it, unchanged', async () => {
    await openStep();
    await launchButton();

    expect(mainText()).toContain(
      'Every number this test produces is simulated, and none of it is a conversion-lift estimate.',
    );
  });
});

describe('a cap that refuses the launch', () => {
  /** The refusal `POST /runs` answers with: the platform's sentence, and its figures. */
  const hourly = (): Response =>
    refusal(
      {
        error:
          'This site has had its 4 runs this hour; the next may start at 10:12. Nothing was started.',
        cap: 'runsPerSitePerHour',
        limit: 4,
        observed: 4,
        retryAt: '2026-11-04T10:12:00.000Z',
      },
      429,
    );

  const tooManyAgents = (): Response =>
    refusal(
      {
        error:
          'A test may run 100 agents; this audience asks for 140. Lower the participant count, or split it across two tests.',
        cap: 'agentsPerRun',
        limit: 100,
        observed: 140,
        retryAt: null,
      },
      429,
    );

  const press = async (behaviour: LaunchBehaviour) => {
    const served = await openStep(behaviour);
    const button = await launchButton();
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });
    await userEvent.setup().click(button);
    await screen.findByRole('alert');
    return served;
  };

  it('renders the cap, the limit and when it can be tried again, in the platform’s words', async () => {
    await press({ run: hourly });

    expect(screen.getByRole('alert').textContent).toBe(
      'This site has had its 4 runs this hour; the next may start at 10:12. Nothing was started.',
    );
    const text = mainText();
    expect(text).toContain('runs an hour on this site');
    expect(text).toContain('Limit · 4');
    // The reader's own clock, drawn from the instant beside the sentence (decision 111).
    expect(text).toContain(
      new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date('2026-11-04T10:12:00.000Z')),
    );
  });

  it('keeps everything the user chose, and stays on the step', async () => {
    const draft = filledDraft();
    const served = await press({ run: hourly });

    expect(readWizardDraft()).toEqual(draft);
    expect(served.mounted.router.state.location.pathname).toBe(paths.newTest);
    expect(new URLSearchParams(served.mounted.router.state.location.search).get(STEP_PARAM)).toBe(
      'estimate',
    );
    // And the figures are still on the screen: a refusal is not a reason to redraw the step.
    expect(figureIn('agents')).toBe('100');
  });

  it('offers what can be done instead: waiting until the time the refusal names', async () => {
    await press({ run: hourly });

    expect(mainText()).toContain('and launch then');
    expect(mainText()).toContain('Nothing you chose has been lost.');
  });

  it('offers a launch within the cap where waiting does not help', async () => {
    await press({ run: tooManyAgents });

    const instead = screen.getByRole('link', { name: 'lower the participant count' });
    expect(instead.getAttribute('href')).toBe(newTestStep('audience'));
    expect(mainText()).not.toContain('Next allowed');
  });

  it('is never about the site being unverified', async () => {
    // Decision 71, settled as no gate on testing: the caps protect the site being driven,
    // and this screen has no sentence about verification to print.
    await press({ run: hourly });

    expect(mainText().toLowerCase()).not.toContain('verif');
  });

  it('renders a field the platform refused against the step that holds it', async () => {
    await press({
      run: () =>
        refusal(
          {
            error: 'That test could not be started.',
            issues: [
              { path: 'goal.successCriterion', message: 'nothing was written here' },
              { path: 'audienceId', message: 'a test names the audience it is for' },
            ],
          },
          400,
        ),
    });

    const refusedList = document.querySelector('ul') as HTMLElement;
    expect(refusedList.textContent).toContain('nothing was written here');
    expect([...refusedList.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(
      [newTestStep('goal'), newTestStep('audience')],
    );
  });

  it('says the platform’s own sentence when the model it would run on cannot be used', async () => {
    await press({
      run: () =>
        refusal(
          {
            error: 'The test was not started: the standard model could not be used.',
            modelMode: 'standard',
          },
          503,
        ),
    });

    expect(screen.getByRole('alert').textContent).toContain('could not be used');
  });
});

describe('a draft that cannot be launched', () => {
  it('sends the user back to the step that is missing rather than estimating nothing', async () => {
    const draft = filledDraft();
    const served = await openStep({}, { ...draft, site: null });

    await waitFor(() => {
      expect(new URLSearchParams(served.mounted.router.state.location.search).get(STEP_PARAM)).toBe(
        'audience',
      );
    });
    expect(served.quoted()).toHaveLength(0);
  });

  it('sends a draft with no goal to the goal step', async () => {
    const draft = filledDraft();
    const served = await openStep({}, { ...draft, goal: null });

    await waitFor(() => {
      expect(new URLSearchParams(served.mounted.router.state.location.search).get(STEP_PARAM)).toBe(
        'goal',
      );
    });
  });
});

describe('the step itself', () => {
  it('passes axe cleanly, waiting and quoted and refused', async () => {
    const served = await openStep({ holdEstimate: true, run: () => refusal({ error: 'no' }, 500) });
    const { container } = served.mounted;
    const main = container.querySelector('main') as HTMLElement;

    const waiting = await axeViolations(main);
    expect(waiting, describeViolations(waiting)).toHaveLength(0);

    served.release();
    await waitFor(() => {
      expect(figureIn('cost')).not.toBe('');
    });
    const quotedPass = await axeViolations(main);
    expect(quotedPass, describeViolations(quotedPass)).toHaveLength(0);

    await userEvent.setup().click(await launchButton());
    await screen.findByRole('alert');
    const refusedPass = await axeViolations(main);
    expect(refusedPass, describeViolations(refusedPass)).toHaveLength(0);
  });

  it('lays itself out in the wizard’s own column and restates no value by hand', async () => {
    await openStep();
    await heading();

    const main = document.querySelector('main') as HTMLElement;
    expect(main.querySelector('.wrap-narrow')).not.toBeNull();
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);
  });

  it('is operable by keyboard, with the app’s own focus ring', async () => {
    await openStep();
    const button = await launchButton();
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    button.focus();
    expect(document.activeElement).toBe(button);
    // A real button, at the prototype's large size, and not a div that listens for a click.
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('data-size')).toBe('lg');

    // The ring itself is the app's one `:focus-visible` rule, in the tokens' own values —
    // jsdom paints nothing, so it is read off the stylesheet the app ships.
    const appCss = join(dirname(fileURLToPath(import.meta.url)), '../../../src/app.css');
    const ring = ruleIn(rulesOf(readFileSync(appCss, 'utf8')))(':focus-visible');
    expect(ring.outline).toBe('var(--border-width-strong) solid var(--color-focus)');
  });

  it('is complete and still under prefers-reduced-motion: reduce', async () => {
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
    await openStep();
    await waitFor(() => {
      expect(figureIn('time')).not.toBe('');
    });

    // The whole step is there on the first render: nothing here animates in, so there is no
    // finished state to wait for and nothing to shorten.
    expect((await heading()).textContent).toBe('100 agents on app.clipforge.example');
    expect(figureIn('cost')).not.toBe('');
  });
});

/** The three `.microlabel`s of the figure row, in the order they are drawn. */
const labelsOnScreen = (): string[] =>
  [...document.querySelectorAll('[data-figure] .microlabel')].map((node) => node.textContent ?? '');

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
