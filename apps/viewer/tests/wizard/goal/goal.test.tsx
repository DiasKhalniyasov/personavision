// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDesignTokens } from '../../setup';
import { axeViolations, describeViolations } from '../../axe';
import { forgetRuns, mountApp, serveRunData } from '../../app';
import { newTestStep } from '../../../src/shell/paths';
import {
  forgetWizardDraft,
  readWizardDraft,
  writeWizardDraft,
} from '../../../src/screens/newtest/wizard/draft';
import type { WizardDraft } from '../../../src/screens/newtest/wizard/draft';
import { GOAL_PATH } from '../../../src/screens/newtest/wizard/goal/goal';

/**
 * `/new?step=goal` — the goal, read and edited before it runs (#276).
 *
 * What is asserted here is `#screen-newtest-goal`: the two editable fields and their
 * footnote, the goal arriving from the platform's own call, the line that says who last wrote
 * it and when, the authorship moving to the user the moment they type, the re-ask, and the
 * refusal that leaves the step finishable by hand. The frame around it — the step in the
 * query, the breadcrumb, the draft that survives a reload — is `tests/wizard/shell.test.tsx`'s.
 *
 * The platform is faked **at the network boundary**: `POST /runs/goal` is answered by the
 * stubbed `fetch`, as every other screen suite fakes the platform, so what is exercised is
 * the request this screen really makes and the answers it really has to read.
 */

const SITE = 'https://app.clipforge.example/create';
const FEATURE = 'generating a video from a text prompt';

/** A draft standing on the goal step: a site and the user's own sentence, and no goal yet. */
const draftWithNoGoal = (patch: Partial<WizardDraft> = {}): WizardDraft => ({
  site: { id: 'site-clipforge', url: SITE },
  feature: FEATURE,
  audience: { sentence: 'first-time creators', audienceId: 'aud-ftc', reviewed: true },
  goal: null,
  ...patch,
});

/** The goal Muse Wonder answers with, in the shape `goalSchema` holds it. */
const WRITTEN = {
  task: 'Generate a video from a text prompt on this page, and wait until it is ready to watch.',
  successCriterion: 'A video preview is visible on the page.',
  lastWrittenBy: 'model' as const,
};

/** A second wording, for the re-ask. */
const REWORDED = {
  task: 'Ask for a video from a written prompt and wait for it to finish.',
  successCriterion: 'The page shows the text “Your video is ready”.',
  lastWrittenBy: 'model' as const,
};

/** The refusal `GoalCriterionError` writes, as the platform answers it (decision 117). */
const REFUSAL =
  'The success criterion was sent back once and came back unobservable again — “The page feels trustworthy.”, then “The person understands what the video will cost.” — so this goal is refused rather than run against a criterion no session can evaluate.';

interface GoalCall {
  readonly body: unknown;
}

/**
 * Serve the run data every screen reads, with `POST /runs/goal` answered by this test.
 *
 * `answers` is read one per call, so a re-ask can be given a different wording; the last
 * answer stands for every call after it.
 */
const servePlatformGoal = async (
  answers: readonly { status: number; body: unknown }[],
): Promise<GoalCall[]> => {
  await serveRunData();
  const served = globalThis.fetch;
  const calls: GoalCall[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input instanceof Request ? input.url : input));
    if (pathname !== GOAL_PATH) return served(input as RequestInfo, init);
    calls.push({ body: JSON.parse(String(init?.body ?? 'null')) as unknown });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] as {
      status: number;
      body: unknown;
    };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });

  return calls;
};

/** The written goal, answered for every ask. */
const serveGoal = async (goal: unknown = WRITTEN): Promise<GoalCall[]> =>
  servePlatformGoal([{ status: 200, body: goal }]);

const taskField = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('The task each person attempts')) as HTMLTextAreaElement;

const successField = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('What counts as success')) as HTMLTextAreaElement;

/** The authorship line, which is the screen's one live region. */
const authorship = (): HTMLElement => screen.getByRole('status');

beforeEach(loadDesignTokens);
afterEach(() => {
  forgetRuns();
  forgetWizardDraft();
});

describe('the two fields the platform fills in', () => {
  it('renders the prototype’s heading, lede, labels and footnote', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'This is what the hundred of them will try to do',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Written by Muse Wonder from your URL and your sentence\./),
    ).toBeTruthy();
    expect(await taskField()).toBeTruthy();
    expect(await successField()).toBeTruthy();
    expect(screen.getByText(/It has to be something we can see in the page/)).toBeTruthy();
    expect(screen.getByText(/is not a success criterion, and Wonder is asked again/)).toBeTruthy();
  });

  it('asks the platform for the draft’s own site and feature sentence, once', async () => {
    const calls = await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toEqual({ siteUrl: SITE, feature: FEATURE });
  });

  it('fills both fields with what came back, and they are editable', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });
    expect((await successField()).value).toBe(WRITTEN.successCriterion);
    expect((await taskField()).readOnly).toBe(false);
    expect((await successField()).readOnly).toBe(false);
  });

  it('describes the success field by its footnote, so the rule is read out with it', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    const field = await successField();
    const footnote = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(footnote?.textContent).toMatch(/an element, a URL or a piece of text/);
  });
});

describe('the authorship line', () => {
  it('names Muse Wonder and the time the goal was written', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    await waitFor(() => {
      expect(authorship().textContent).toMatch(/^Written by Muse Wonder, /);
    });
    // The clock the rest of the app prints: day first, 24 hours, in the reader's own zone —
    // `3 Nov 09:08`, read off the instant the draft recorded rather than off a second clock.
    const written = readWizardDraft().goal?.writtenAt as string;
    const at = new Date(written);
    const when = [
      new Intl.DateTimeFormat('en-US', { day: 'numeric' }).format(at),
      new Intl.DateTimeFormat('en-US', { month: 'short' }).format(at),
      new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(at),
    ].join(' ');
    expect(when).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/);
    expect(authorship().textContent).toContain(`Written by Muse Wonder, ${when}.`);
    expect(authorship().textContent).toMatch(
      /a completion rate is only as meaningful as the criterion behind it/,
    );
  });

  it('is a live region, so a change to it is announced and not only seen', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    // Present from the first paint: an announcement is a change to a region that was already
    // there, never the insertion of one.
    expect(authorship()).toBeTruthy();
    await waitFor(() => {
      expect(authorship().textContent).toMatch(/Muse Wonder/);
    });
  });

  it('names the user the moment they edit either field, before they move on', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    await userEvent.setup().type(await successField(), ' and playable');

    expect(authorship().textContent).toMatch(/^Written by you, /);
    expect(authorship().textContent).toMatch(/The test records you as the author of the goal/);
    // And that is what the draft carries on, which is what the run records.
    expect(readWizardDraft().goal?.author).toBe('user');
    expect(readWizardDraft().goal?.success).toBe(`${WRITTEN.successCriterion} and playable`);
  });

  it('records the user as the author when the task is the field they changed', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    await userEvent.setup().type(await taskField(), '!');

    expect(readWizardDraft().goal?.author).toBe('user');
    expect(readWizardDraft().goal?.task).toBe(`${WRITTEN.task}!`);
    // The criterion is untouched: editing one field does not blank the other.
    expect(readWizardDraft().goal?.success).toBe(WRITTEN.successCriterion);
  });
});

describe('asking for another wording', () => {
  it('replaces both fields and leaves the author as the model', async () => {
    const calls = await servePlatformGoal([
      { status: 200, body: WRITTEN },
      { status: 200, body: REWORDED },
    ]);
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask for another wording' }));

    await waitFor(async () => {
      expect((await taskField()).value).toBe(REWORDED.task);
    });
    expect((await successField()).value).toBe(REWORDED.successCriterion);
    expect(authorship().textContent).toMatch(/^Written by Muse Wonder, /);
    expect(readWizardDraft().goal?.author).toBe('model');
    // The same site and the same sentence, asked again.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ siteUrl: SITE, feature: FEATURE });
  });

  it('takes the user’s own wording back off the model’s hands when it is asked again', async () => {
    await servePlatformGoal([
      { status: 200, body: WRITTEN },
      { status: 200, body: REWORDED },
    ]);
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });
    const user = userEvent.setup();
    await user.type(await taskField(), ' now');
    expect(readWizardDraft().goal?.author).toBe('user');

    await user.click(screen.getByRole('button', { name: 'Ask for another wording' }));

    await waitFor(() => {
      expect(readWizardDraft().goal?.author).toBe('model');
    });
    expect((await taskField()).value).toBe(REWORDED.task);
  });
});

describe('a goal the platform refuses', () => {
  it('renders the reason it gave, unchanged', async () => {
    await servePlatformGoal([{ status: 422, body: { error: REFUSAL } }]);
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', REFUSAL);
  });

  it('leaves both fields editable and the step finishable by hand', async () => {
    await servePlatformGoal([{ status: 422, body: { error: REFUSAL } }]);
    writeWizardDraft(draftWithNoGoal());
    const { router } = mountApp(newTestStep('goal'));
    await screen.findByRole('alert');

    expect((await taskField()).readOnly).toBe(false);
    expect((await successField()).readOnly).toBe(false);

    const user = userEvent.setup();
    await user.type(await taskField(), 'Generate a video from a prompt.');
    await user.type(await successField(), 'A video preview is visible on the page.');
    await user.click(screen.getByRole('button', { name: /^Looks right/ }));

    await waitFor(() => {
      expect(router.state.location.search).toBe(
        `?${newTestStep('estimate').split('?')[1] as string}`,
      );
    });
    expect(readWizardDraft().goal?.author).toBe('user');
    expect(readWizardDraft().goal?.task).toBe('Generate a video from a prompt.');
  });

  it('reads a platform that cannot be reached the same way: a reason, and two fields', async () => {
    await serveRunData();
    const served = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input instanceof Request ? input.url : input));
      if (pathname !== GOAL_PATH) return served(input as RequestInfo, init);
      return Promise.reject(new Error('the platform is not listening'));
    });
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/the platform could not be reached/);
    expect(alert.textContent).toMatch(/the platform is not listening/);
    expect((await taskField()).readOnly).toBe(false);
  });

  it('does not take away the wording that was already there when a re-ask refuses', async () => {
    await servePlatformGoal([
      { status: 200, body: WRITTEN },
      { status: 422, body: { error: REFUSAL } },
    ]);
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask for another wording' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', REFUSAL);
    expect((await taskField()).value).toBe(WRITTEN.task);
    expect((await successField()).value).toBe(WRITTEN.successCriterion);
  });

  it('says so plainly when the answer is not a goal this build can read', async () => {
    await servePlatformGoal([{ status: 200, body: { task: 'Do the thing' } }]);
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/a goal this build cannot read/);
    expect(alert.textContent).toMatch(/successCriterion/);
  });
});

describe('a feature sentence that changed under the goal', () => {
  it('asks again rather than keeping a goal about something else', async () => {
    const calls = await serveGoal(REWORDED);
    writeWizardDraft({
      ...draftWithNoGoal({ feature: 'cancelling a subscription' }),
      goal: {
        task: WRITTEN.task,
        success: WRITTEN.successCriterion,
        author: 'model',
        writtenAt: '2026-11-03T09:08:00.000Z',
        // Written for the sentence the user has since changed.
        askedFor: { siteUrl: SITE, feature: FEATURE },
      },
    });
    mountApp(newTestStep('goal'));

    await waitFor(async () => {
      expect((await taskField()).value).toBe(REWORDED.task);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ siteUrl: SITE, feature: 'cancelling a subscription' });
  });

  it('keeps a goal that was written for the draft as it stands, and asks for nothing', async () => {
    const calls = await serveGoal(REWORDED);
    writeWizardDraft({
      ...draftWithNoGoal(),
      goal: {
        task: WRITTEN.task,
        success: WRITTEN.successCriterion,
        author: 'user',
        writtenAt: '2026-11-03T09:08:00.000Z',
        askedFor: { siteUrl: SITE, feature: FEATURE },
      },
    });
    mountApp(newTestStep('goal'));

    expect((await taskField()).value).toBe(WRITTEN.task);
    expect(authorship().textContent).toMatch(/^Written by you, /);
    expect(calls).toHaveLength(0);
  });
});

describe('moving on', () => {
  it('carries the goal and its author into the draft the launch step reads', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    const { router } = mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    await userEvent.setup().click(screen.getByRole('button', { name: /^Looks right/ }));

    await waitFor(() => {
      expect(router.state.location.search).toBe(
        `?${newTestStep('estimate').split('?')[1] as string}`,
      );
    });
    const carried = readWizardDraft().goal;
    expect(carried?.task).toBe(WRITTEN.task);
    expect(carried?.success).toBe(WRITTEN.successCriterion);
    expect(carried?.author).toBe('model');
  });
});

describe('while the goal is being written', () => {
  /** A goal whose answer is held until the test lets it go. */
  const holdTheGoal = async (): Promise<() => void> => {
    await serveRunData();
    const served = globalThis.fetch;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input instanceof Request ? input.url : input));
      if (pathname !== GOAL_PATH) return served(input as RequestInfo, init);
      await held;
      return new Response(JSON.stringify(WRITTEN), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return release;
  };

  it('renders the frame with both fields pending and says the goal is being written', async () => {
    const release = await holdTheGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    await screen.findByRole('heading', { level: 1 });
    const task = await taskField();
    const success = await successField();
    // The fields are there, so nothing is inserted under the reader when the goal arrives.
    expect(task.value).toBe('');
    expect(task.getAttribute('aria-busy')).toBe('true');
    expect(success.getAttribute('aria-busy')).toBe('true');
    expect(authorship().textContent).toMatch(/Muse Wonder is writing the goal/);

    release();

    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });
    // The same two fields, in the same order: the layout did not move.
    expect(await taskField()).toBe(task);
    expect(await successField()).toBe(success);
    expect((await taskField()).getAttribute('aria-busy')).toBe('false');
  });

  it('refuses a submission and a re-ask until there is something to read', async () => {
    const release = await holdTheGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByRole('button', { name: /^Looks right/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Ask for another wording' })).toHaveProperty(
      'disabled',
      true,
    );

    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Looks right/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
  });
});

describe('a draft with nothing to write a goal from', () => {
  it('sends the user back to the step that collects the site and the sentence', async () => {
    const calls = await serveGoal();
    writeWizardDraft(draftWithNoGoal({ site: null, feature: '' }));
    mountApp(newTestStep('goal'));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'This is what the hundred of them will try to do',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/this test has neither yet/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Describe the audience and the feature' })
        .getAttribute('href'),
    ).toBe(newTestStep('audience'));
    // And the model is asked for nothing.
    expect(calls).toHaveLength(0);
  });

  it('names which of the two is missing', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal({ feature: '   ' }));
    const first = mountApp(newTestStep('goal'));
    expect(await screen.findByText(/this test has no sentence yet/)).toBeTruthy();
    first.unmount();

    writeWizardDraft(draftWithNoGoal({ site: null }));
    mountApp(newTestStep('goal'));
    expect(await screen.findByText(/this test has no site yet/)).toBeTruthy();
  });
});

describe('the step at 390px, by keyboard, and under reduce', () => {
  it('passes axe cleanly, written and refused', async () => {
    for (const answers of [
      [{ status: 200, body: WRITTEN }],
      [{ status: 422, body: { error: REFUSAL } }],
    ]) {
      await servePlatformGoal(answers);
      writeWizardDraft(draftWithNoGoal());
      const { container, unmount } = mountApp(newTestStep('goal'));
      await screen.findByRole('heading', { level: 1 });
      await waitFor(() => {
        expect(authorship().textContent).not.toMatch(/is writing the goal/);
      });

      const violations = await axeViolations(container.querySelector('main') as HTMLElement);
      expect(violations, describeViolations(violations)).toHaveLength(0);
      unmount();
      forgetRuns();
    }
  });

  it('is operable and submittable by keyboard alone', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    const { router } = mountApp(newTestStep('goal'));
    await waitFor(async () => {
      expect((await taskField()).value).toBe(WRITTEN.task);
    });

    const user = userEvent.setup();
    (await taskField()).focus();
    expect(document.activeElement).toBe(await taskField());
    // Tab from the task to the criterion to the two buttons: four stops, in reading order.
    await user.tab();
    expect(document.activeElement).toBe(await successField());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Looks right/ }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Ask for another wording' }),
    );

    screen.getByRole('button', { name: /^Looks right/ }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(router.state.location.search).toBe(
        `?${newTestStep('estimate').split('?')[1] as string}`,
      );
    });
  });

  it('writes no value of its own: the column and the card come from the tokens', async () => {
    await serveGoal();
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));
    await screen.findByRole('heading', { level: 1 });

    const main = document.querySelector('main') as HTMLElement;
    expect(main.querySelector('.wrap-narrow')).not.toBeNull();
    expect([...main.querySelectorAll('[style]')]).toHaveLength(0);
  });

  it('is complete and still on first paint under prefers-reduced-motion: reduce', async () => {
    await serveGoal();
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
    writeWizardDraft(draftWithNoGoal());
    mountApp(newTestStep('goal'));

    // The whole frame is there on the first render, fields and all; nothing animates in.
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'This is what the hundred of them will try to do',
    );
    expect(await taskField()).toBeTruthy();
    expect(await successField()).toBeTruthy();
  });
});
