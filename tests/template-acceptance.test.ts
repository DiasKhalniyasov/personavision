import { describe, expect, it } from 'vitest';
import { GENERATOR_VERSION, generatePersonas } from '@personavision/personas';
import { createOfflineWonderProvider } from '@personavision/provider';
import { EXAMPLE_TESTS } from '../apps/viewer/src/screens/newtest/templates.js';
import {
  audienceFrom,
  countOutcomes,
  DEFAULT_RUNS_ROOT,
  criterionKindOf,
  observedCount,
  PEOPLE_PER_TEMPLATE,
  producedAResult,
  REPEATS,
  renderReport,
  requestFor,
  parseArguments,
  TEMPLATE_ACCEPTANCE_SEED,
  templatesNamed,
  verdictExitCode,
} from '../scripts/template-acceptance.js';
import type { TemplateOutcome } from '../scripts/template-acceptance.js';

/**
 * The acceptance check's **reading of a finished run**, which is the half of
 * `scripts/template-acceptance.ts` that does not need a model key, a browser or a live site.
 *
 * The script itself cannot be tested: it drives five public websites on the owner's
 * credential, which is the whole reason it is a script run by hand rather than a CI job
 * (#423's auto-decision of 2026-11-04). What *can* be held still is everything either side of
 * those runs — what each template asks for, what the four outcome counts are read off, what
 * "observed the criterion" means in a session file, which templates the table calls a pass,
 * and the exit code. Those are the parts a reader of the posted table is trusting, so they are
 * the parts that are pinned here.
 *
 * Nothing here opens a browser or reads a credential.
 */

/** A finished session, in the two fields the table reads off one. */
const session = (
  status: 'success' | 'failed' | 'abandoned' | 'automation_failure',
  reason = 'because',
  width = 390,
): TemplateOutcome['sessions'][number] => ({
  outcome: { status, reason },
  persona: { device: { viewport: { width } } },
});

/** One row of the table, with everything a caller did not care about at zero. */
const outcome = (over: Partial<TemplateOutcome> = {}): TemplateOutcome => ({
  id: 'stripe-testing-payments',
  siteUrl: 'https://docs.stripe.com',
  runId: '2026-11-05-1200-find-out-how-to-check-a-payment',
  runDir: '/tmp/acceptance/2026-11-05-1200-find-out-how-to-check-a-payment',
  criterion: 'A heading with the words “Test card numbers” is visible.',
  criterionKind: 'element',
  sessions: [],
  wallClockMs: 1_000,
  costUsd: 0,
  trouble: null,
  ...over,
});

describe('what each template asks for', () => {
  it('is six people, one repeat, a model run, and the one fixed seed', () => {
    const request = requestFor(EXAMPLE_TESTS[0], 'aud-stripe');

    expect(request.repeats).toBe(REPEATS);
    expect(request.repeats).toBe(1);
    expect(request.seed).toBe(TEMPLATE_ACCEPTANCE_SEED);
    expect(request.engineMode).toBe('model');
    // Six people come from the audience's own `size`, which is what `generatePersonas`
    // counts; the request carries the repeats beside it.
    expect(PEOPLE_PER_TEMPLATE).toBe(6);
  });

  it('is the template’s own goal, the template’s own feature and one variant for its site', () => {
    const template = EXAMPLE_TESTS[2];
    const request = requestFor(template, 'aud-ikea');

    expect(request.feature).toBe(template.feature);
    expect(request.goal).toEqual({
      task: template.task,
      successCriterion: template.successCriterion,
      // A person wrote this goal — the owner, in the template — so no model is credited with
      // it, exactly as `personavision run --site` records a typed one.
      lastWrittenBy: 'user',
    });
    expect(request.task.prompt).toBe(template.task);
    expect(request.variants).toHaveLength(1);
    expect(request.variants[0].url).toBe(template.siteUrl);
    expect(request.audienceId).toBe('aud-ikea');
  });

  it('asks the same thing twice: the same template gives the same request', () => {
    expect(requestFor(EXAMPLE_TESTS[1], 'aud-vercel')).toEqual(
      requestFor(EXAMPLE_TESTS[1], 'aud-vercel'),
    );
  });
});

describe('the audience each template is run for', () => {
  /**
   * The **offline** Wonder implementation, which is the one this suite may have: the live
   * check refuses to run on it (an invented audience standing in for the owner's sentence is
   * worse than a refusal), and what is under test here is not the answer but the shaping of
   * it — the stamped id, the generator version, and the six people this check runs whatever
   * the sentence implies.
   */
  const offline = createOfflineWonderProvider();

  it('is six people, from the template’s own sentence, for every template', async () => {
    for (const template of EXAMPLE_TESTS) {
      const { audience } = await audienceFrom(offline, template);

      expect(audience.size, template.id).toBe(PEOPLE_PER_TEMPLATE);
      // The caller's id, never the model's: a template's audience is addressable by the
      // template it belongs to, which is how a reader of the runs root tells them apart.
      expect(audience.id, template.id).toBe(template.id);
      expect(audience.generatedFrom?.generatorVersion, template.id).toBe(GENERATOR_VERSION);
      expect(audience.generatedFrom?.seed, template.id).toBe(TEMPLATE_ACCEPTANCE_SEED);
    }
  });

  it('generates the six people it says it will, device quota and all', async () => {
    for (const template of EXAMPLE_TESTS) {
      const { audience } = await audienceFrom(offline, template);

      // The check this is really making: `size` is not a free field. The device shares have
      // to account for all six people, and an audience nobody can be generated from has to
      // fail at the template rather than inside the swarm, with a live site half driven.
      expect(
        generatePersonas(audience, { seed: TEMPLATE_ACCEPTANCE_SEED }),
        template.id,
      ).toHaveLength(PEOPLE_PER_TEMPLATE);
    }
  });

  it('asks for the same audience every time: same sentence, same seed', async () => {
    const template = EXAMPLE_TESTS[3];

    expect((await audienceFrom(offline, template)).audience).toEqual(
      (await audienceFrom(offline, template)).audience,
    );
  });
});

describe('which kind of criterion each template is decided by', () => {
  it('reads each one the way the run loop reads it', () => {
    // The amendment of 2026-11-04: a template decided by an **address** has to be visible as
    // such in the table, because a URL criterion is answered by the address and an element
    // or a piece of text by what the page drew (#441).
    expect(
      EXAMPLE_TESTS.map((template) => [template.id, criterionKindOf(template.successCriterion)]),
    ).toEqual([
      ['stripe-testing-payments', 'element'],
      ['vercel-start-from-a-template', 'element'],
      ['ikea-furniture-take-back', 'element'],
      ['canva-short-social-video', 'element'],
      ['apple-trade-in', 'element'],
      ['meta-cheapest-vision-model', 'url'],
    ]);
  });

  it('says nothing rather than guessing, for a criterion no session could evaluate', () => {
    expect(criterionKindOf('The page feels welcoming.')).toBeNull();
  });
});

describe('the four outcome counts', () => {
  it('counts each status, including the automation failures the bar excludes', () => {
    expect(
      countOutcomes([
        session('success'),
        session('success'),
        session('failed'),
        session('abandoned'),
        session('automation_failure'),
      ]),
    ).toEqual({ success: 2, failed: 1, abandoned: 1, automationFailure: 1 });
  });
});

describe('how many sessions observed the criterion', () => {
  it('counts a success, which under the goal rule is an observed criterion', () => {
    expect(observedCount([session('success'), session('success'), session('abandoned')])).toBe(2);
  });

  it('counts a session the criterion was already true for, which is not a success', () => {
    // `decideOutcome`'s own case: a criterion that was already true when the agent arrived
    // is `failed` — nothing was tested — and the agent did see the thing. A table that
    // counted only successes would report that nobody ever reached it.
    expect(
      observedCount([
        session(
          'failed',
          'Gave up on the "page" step: the criterion “A heading with the words “Test card numbers” is visible.” was already true when the agent arrived, and nothing was acted on.',
        ),
      ]),
    ).toBe(1);
  });

  it('counts no session that never saw it, whatever it gave up over', () => {
    expect(
      observedCount([
        session('failed', 'the criterion “…” was never observed — the "page" step was missing…'),
        session('abandoned', 'Gave up on the "page" step after 8 actions.'),
        session('automation_failure', 'Execution context was destroyed'),
      ]),
    ).toBe(0);
  });
});

describe('the bar: each template produces an outcome that is not an automation failure', () => {
  it('passes a template with one success, one failure or one abandonment', () => {
    expect(producedAResult(outcome({ sessions: [session('success')] }))).toBe(true);
    expect(producedAResult(outcome({ sessions: [session('failed')] }))).toBe(true);
    expect(producedAResult(outcome({ sessions: [session('abandoned')] }))).toBe(true);
  });

  it('fails a template whose every session was an automation failure', () => {
    expect(
      producedAResult(
        outcome({ sessions: [session('automation_failure'), session('automation_failure')] }),
      ),
    ).toBe(false);
  });

  it('fails a template whose run never started, and one that ran nobody', () => {
    expect(
      producedAResult(outcome({ sessions: [], trouble: { kind: 'no-run', reason: 'no key' } })),
    ).toBe(false);
    expect(producedAResult(outcome({ sessions: [] }))).toBe(false);
  });

  it('exits non-zero when any one template produced nothing', () => {
    const produced = outcome({ sessions: [session('success')] });
    const nothing = outcome({ id: 'canva-short-social-video', sessions: [] });

    expect(verdictExitCode([produced, produced])).toBe(0);
    expect(verdictExitCode([produced, nothing])).toBe(1);
    expect(verdictExitCode([])).toBe(1);
  });
});

describe('the command line', () => {
  it('reads a path as the runs root and a bare word as a template id', () => {
    expect(parseArguments(['/tmp/acceptance'])).toEqual({
      runsRoot: '/tmp/acceptance',
      ids: [],
    });
    expect(parseArguments(['/tmp/acceptance', 'apple-trade-in'])).toEqual({
      runsRoot: '/tmp/acceptance',
      ids: ['apple-trade-in'],
    });
    expect(parseArguments([])).toEqual({ runsRoot: DEFAULT_RUNS_ROOT, ids: [] });
  });

  it('never makes a directory out of a template id', () => {
    // The foot-gun this exists for: taking the first argument as a root unconditionally made
    // `pnpm acceptance:templates ikea-furniture-take-back` create `./ikea-furniture-take-back`
    // inside the checkout and then run all six templates at full cost.
    expect(parseArguments(['ikea-furniture-take-back'])).toEqual({
      runsRoot: DEFAULT_RUNS_ROOT,
      ids: ['ikea-furniture-take-back'],
    });
  });

  it('refuses a name no template carries, with the names there are', () => {
    expect(() => templatesNamed(['ikea'])).toThrow(/there is no template "ikea"/);
    expect(() => templatesNamed(['ikea'])).toThrow(/ikea-furniture-take-back/);
    expect(templatesNamed([])).toEqual(EXAMPLE_TESTS);
  });
});

describe('the table that is posted on the ticket', () => {
  const report = (): string =>
    renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [
        outcome({
          sessions: [
            session('success'),
            session('success', 'because', 1280),
            session('failed'),
            session('abandoned'),
            session('automation_failure', 'Timeout 30000ms exceeded.'),
            session('automation_failure', 'a second one nobody prints'),
          ],
          wallClockMs: 92_000,
          costUsd: 0.1234,
        }),
        outcome({
          id: 'canva-short-social-video',
          siteUrl: 'https://www.canva.com',
          criterion: 'A heading with the words “Video editor” is visible.',
          runId: '2026-11-05-1210-find-out-what-you-d-need-to-make',
          runDir: '/tmp/acceptance/2026-11-05-1210-find-out-what-you-d-need-to-make',
          sessions: [session('automation_failure', 'Execution context was destroyed.')],
          wallClockMs: 8_000,
          costUsd: 0.01,
        }),
        outcome({
          id: 'meta-cheapest-vision-model',
          siteUrl: 'https://dev.meta.ai',
          criterion: 'The address bar reads /docs/pricing-rate-limits.',
          criterionKind: 'url',
          runId: null,
          runDir: null,
          sessions: [],
          trouble: { kind: 'no-run', reason: 'the site could not be opened' },
          wallClockMs: 2_000,
          costUsd: 0,
        }),
      ],
    });

  it('gives one row per template, with its site and the four counts', () => {
    const table = report();

    expect(table).toContain('https://docs.stripe.com');
    expect(table).toContain('https://www.canva.com');
    expect(table).toContain('https://dev.meta.ai');
    // The stripe row: 6 sessions, 2 success, 1 failed, 1 abandoned, 2 automation failures.
    expect(table).toMatch(/docs\.stripe\.com.*\| 6 \| 2 \| 1 \| 1 \| 2 \|/);
  });

  it('says which kind of criterion decided each template, and how many saw it', () => {
    const table = report();

    expect(table).toMatch(/dev\.meta\.ai.*\| url \|/);
    expect(table).toMatch(/docs\.stripe\.com.*\| element \|/);
    // Two successes observed it; the "observed" column is its own, because a criterion that
    // was already true is observed and is not a success.
    expect(table).toMatch(/docs\.stripe\.com.*\| 2 \| 1 \| 1 \| 2 \| 2 \|/);
  });

  it('never prints a minute with sixty seconds in it', () => {
    // 119.6 s: rounding the remainder of the division gives 60, which is not a time.
    const table = renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [outcome({ sessions: [session('success')], wallClockMs: 119_600 })],
    });

    expect(table).toContain('2m 0s');
    expect(table).not.toContain('1m 60s');
  });

  it('gives the wall clock and the cost, per template and in total', () => {
    const table = report();

    expect(table).toContain('1m 32s');
    expect(table).toContain('$0.1234');
    // 92s + 8s + 2s, and 0.1234 + 0.01.
    expect(table).toContain('1m 42s');
    expect(table).toContain('$0.1334');
  });

  it('names the first automation failure’s reason, and only the first', () => {
    const table = report();

    expect(table).toContain('Timeout 30000ms exceeded.');
    expect(table).not.toContain('a second one nobody prints');
    expect(table).toContain('Execution context was destroyed.');
  });

  it('says a run that never started never started, with why', () => {
    const table = report();

    expect(table).toContain('**Runs that never started**');
    expect(table).toContain('the site could not be opened');
  });

  it('does not call a run that started and was stopped a run that never started', () => {
    // `RunStoppedError` means the run started and landed real sessions: its sessions are in
    // the counts, and "nothing was simulated" would be a lie with a run sitting next to it.
    const table = renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [
        outcome({
          sessions: [session('success'), session('abandoned')],
          trouble: { kind: 'stopped', reason: 'run.json could not be written' },
        }),
      ],
    });

    expect(table).not.toContain('**Runs that never started**');
    expect(table).toContain('were then stopped');
    expect(table).toContain('run.json could not be written');
    // It produced results, so no verdict sentence accuses it of anything.
    expect(table).toContain('Every template produced results: 1 of 1.');
  });

  it('keeps the directory of a run whose sessions could not all be read', () => {
    // The run is on disk and #429 may still want it, so it is not reported as "no run
    // directory was written" — and the sessions that did parse are still counted.
    const table = renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [
        outcome({
          sessions: [session('success')],
          trouble: { kind: 'unread-sessions', reason: '1 of 2 session files could not be read' },
        }),
      ],
    });

    expect(table).toContain('could not be read back in full');
    expect(table).toContain('2026-11-05-1200-find-out-how-to-check-a-payment');
    expect(table).not.toContain('no run directory was written');
  });

  it('blames the check, not the site, when nothing could be measured', () => {
    const table = renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [
        outcome({ sessions: [], trouble: { kind: 'no-run', reason: 'the API answered 401' } }),
      ],
    });

    expect(table).toContain('**1 of 1 templates were not measured: https://docs.stripe.com.**');
    expect(table).toContain('a finding about this check and not about the site');
    expect(table).not.toContain('sibling ticket on #222');
  });

  it('says where the runs are, so #429 does not pay for them again', () => {
    const table = report();

    expect(table).toContain('/tmp/acceptance');
    expect(table).toContain('2026-11-05-1200-find-out-how-to-check-a-payment');
  });

  it('says which templates produced a contrast and which did not, for #429', () => {
    const table = report();

    // Stripe: a session that reached the thing and sessions that did not, on two viewports.
    expect(table).toMatch(/docs\.stripe\.com — both outcomes.*390.*1280/);
    // Canva produced no outcome at all, so it is not offered as a slide set.
    expect(table).toMatch(/www\.canva\.com — no outcome/);
  });

  it('states the verdict in a sentence a reader can act on', () => {
    const table = report();

    // Canva ran and produced only an automation failure: a finding about the site.
    expect(table).toContain(
      '**1 of 3 templates ran and produced no outcome that is not an automation failure: https://www.canva.com.**',
    );
    expect(table).toContain('sibling ticket on #222');
  });

  it('does not blame a site for a run that never started', () => {
    const table = report();

    // dev.meta.ai never started a run at all. Counting that as a site that cannot be driven
    // would send a reader — and a sibling ticket — to the wrong place.
    expect(table).toContain('**1 of 3 templates were not measured: https://dev.meta.ai.**');
    expect(table).toContain('a finding about this check and not about the site');
    expect(table).not.toMatch(
      /ran and produced no outcome that is not an automation failure[^\n]*dev\.meta\.ai/,
    );
  });

  it('says so plainly when every template produced results', () => {
    const table = renderReport({
      runsRoot: '/tmp/acceptance',
      outcomes: [outcome({ sessions: [session('success')] })],
    });

    expect(table).toContain('Every template produced results: 1 of 1.');
  });
});
