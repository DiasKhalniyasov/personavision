import { describe, expect, it } from 'vitest';
import {
  HURRIED_SCANNER,
  MIDDLING,
  PATIENT_READER,
  SEEDS,
  metricOf,
  metricsOf,
  primaryActionId,
  runSessions,
} from './harness.js';

/**
 * The statistical half of the engine's credibility harness (#70).
 *
 * Where `behaviour.test.ts` asserts the shape of a scanpath, this suite asserts the
 * numbers a *run* produces: the share of sessions that fixated an area, and the median
 * time to first fixation — the two figures the Attention screen prints beside an area of
 * interest. Every one of them comes out of `aggregate`, the one place in the project that
 * computes a per-area number, so a band here is a band on what a designer will read.
 *
 * **These tests cannot flake.** They run over `SEEDS`, the same fixed set of twenty-four
 * the behavioural suite uses — one run's worth of sessions — through a sampler whose only
 * randomness is the seed. A share below is therefore an exact, reproducible number on
 * every machine; the band around it is a tolerance on *the engine*, not on the test.
 *
 * **Why a band and not an equality.** Pinning each number to the digit would make the
 * suite a snapshot: every calibration of the weights (#11) would fail it, and nobody would
 * learn anything from the failure. So each band is as wide as the mechanism that produces
 * it allows and no wider, and each one records why its edges are where they are. Narrowing
 * a band is then a decision somebody takes, in a diff that says so.
 *
 * **Time budget.** Eight runs of twenty-four sessions over four of the five committed
 * captures, each capture's screenshot decoded once: 60 ms of the two suites' 5-second
 * budget, which `packages/engine/README.md` restates. No API key, no network, no run
 * directory.
 */

describe('the share of sessions that fixated an area falls in its band', () => {
  it('puts the least-favoured row of the price page in 0.45 to 0.85 of the sessions', async () => {
    const fixture = 'price-and-fees' as const;
    const runs = await runSessions(
      { fixture, personaId: 'middling', persona: MIDDLING, goal: { text: 'pay for the boots' } },
      SEEDS,
    );
    const leastFavoured = metricsOf(runs)
      .map((metric) => metric.lookedAtShare)
      .sort((left, right) => left - right)[0];

    /**
     * 0.667 on the defaults — 16 of 24 sessions — for whichever row of the order summary
     * the terms favour least, on an eight-area page with nine looks to spend.
     *
     * This is the band with two live edges, and it is the one that says the engine
     * *discriminates*. Below **0.45**, a row of a short order summary would be
     * effectively invisible, which is a claim about this page the fixture does not
     * support. Above **0.85**, every area is seen by almost every session, which would
     * mean the softmax had flattened and a heatmap would have nothing to say. The measured
     * value sits near the middle, with room on both sides for the weights to be refitted.
     * It is deliberately the *least*-favoured row rather than a named one: which row that
     * is may change with a refit, and the claim is about the spread, not about the row.
     */
    expect(leastFavoured).toBeGreaterThanOrEqual(0.45);
    expect(leastFavoured).toBeLessThanOrEqual(0.85);
  });

  it('puts every paragraph of the plain-text control above 0.95 of the sessions', async () => {
    const fixture = 'plain-text-control' as const;
    const runs = await runSessions(
      {
        fixture,
        personaId: 'middling',
        persona: MIDDLING,
        goal: { text: 'learn how the boots are made' },
      },
      SEEDS,
    );

    /**
     * 1.00 for all three on the defaults, against a floor of 0.95.
     *
     * The null case, and the band is high *because* it is the null case: three areas of
     * even contrast, evenly spread, with nine to eleven looks to spend between them, so
     * everybody sees everything and no area is favoured. A paragraph on a page like this
     * dropping below 0.95 would mean the engine had invented a preference the pixels do
     * not support — which is exactly the failure this fixture exists to catch.
     */
    const shares = metricsOf(runs).map((metric) => metric.lookedAtShare);
    expect(shares.length).toBe(3);
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.95);
  });

  it('puts every region the segmenter found in 0.50 to 1.00 of the sessions', async () => {
    const fixture = 'card-grid-unexplained' as const;
    const runs = await runSessions(
      { fixture, personaId: 'middling', persona: MIDDLING, goal: { text: 'pick a pair of boots' } },
      SEEDS,
    );

    /**
     * 0.583 to 0.875 over the six cards on the defaults.
     *
     * The claim is that an area the DOM never reported is attended to like an element is:
     * the cards are this page's content, and an engine that could only see what the
     * accessibility tree named would be blind to most real pages. The **floor of 0.50**
     * says every card is seen by at least half the sessions — a card below it would be a
     * region the segmenter found and the sampler then ignored. The floor is not higher
     * because eight areas share nine looks: the six cards sit beside a heading and a
     * filter link, so no card can be in every session.
     */
    const cards = metricsOf(runs).filter((metric) => metric.aoiId.includes('-region-'));
    expect(cards.length).toBe(6);
    expect(Math.min(...cards.map((metric) => metric.lookedAtShare))).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...cards.map((metric) => metric.lookedAtShare))).toBeLessThanOrEqual(1);
  });

  it('puts the below-fold primary action in all of the sessions that scroll and none that do not', async () => {
    const fixture = 'below-fold-primary-action' as const;
    const goal = { text: 'place the order' };
    const primary = await primaryActionId(fixture);
    const [patient, hurried] = await Promise.all([
      runSessions({ fixture, personaId: 'patient-reader', persona: PATIENT_READER, goal }, SEEDS),
      runSessions({ fixture, personaId: 'hurried-scanner', persona: HURRIED_SCANNER, goal }, SEEDS),
    ]);

    /**
     * The same area, the same page, the same seeds, two personas: **1.00 and 0.00**, and
     * the band is the pair.
     *
     * No tolerance to state, because neither number is a probability. A patient reader's
     * `screenPersistenceScale` is above 1, so the session scrolls the page through and
     * reaches a control it spends a whole screen's looks beside; a hurried scanner's is
     * below 1, so the session never leaves the first screen and the control is 380 px
     * below the bottom of it. This is the pair the Attention screen has to be able to show
     * — "every one of them saw it" and "not one of them did" — and the share is the field
     * that carries it.
     */
    expect(metricOf(patient, primary).lookedAtShare).toBe(1);
    expect(metricOf(hurried, primary).lookedAtShare).toBe(0);
  });
});

describe('the median time to first fixation on a primary action falls either side of the fold', () => {
  it('is below 1,500 ms for a primary action above the fold', async () => {
    const fixture = 'price-and-fees' as const;
    const primary = await primaryActionId(fixture);
    const runs = await runSessions(
      { fixture, personaId: 'middling', persona: MIDDLING, goal: { text: 'pay for the boots' } },
      SEEDS,
    );

    /**
     * 720 ms on the defaults, against a bound of 1,500 ms.
     *
     * "Pay now" is on the first screen, so the only thing between the start of the session
     * and the first look at it is a couple of fixations elsewhere: the bound is a little
     * over two median fixations plus their gaps (around 280 ms and 190 ms on the
     * defaults), which is the honest statement of "seen almost immediately" on an
     * eight-area page. A primary action above the fold taking longer than that would be a
     * finding about the page — and this page has no finding to make.
     */
    const row = metricOf(runs, primary);
    expect(row.timeToFirstFixationMs).not.toBeNull();
    expect(row.timeToFirstFixationMs).toBeLessThan(1_500);
  });

  it('is above 4,000 ms for a primary action below the fold', async () => {
    const fixture = 'below-fold-primary-action' as const;
    const primary = await primaryActionId(fixture);
    const runs = await runSessions(
      {
        fixture,
        personaId: 'patient-reader',
        persona: PATIENT_READER,
        goal: { text: 'place the order' },
      },
      SEEDS,
    );

    /**
     * 9,561 ms on the defaults, against a bound of 4,000 ms.
     *
     * The mechanism is the page, not the persona: "Place order" sits 380 px below the
     * bottom of a 240 px viewport, so it takes three scrolls to reach, and the agent
     * spends a screen's worth of looks on each one before it gets there. The bound is set
     * at roughly one screen of looking — ten fixations of around 350 ms with their gaps,
     * near 4,000 ms — which is the least a page like this can cost: anything under it
     * would mean the engine had looked at a control before scrolling to it. The gap
     * between the bound and the measured 9,561 ms is deliberate slack for a refit of the
     * duration and count rows.
     */
    const row = metricOf(runs, primary);
    expect(row.timeToFirstFixationMs).not.toBeNull();
    expect(row.timeToFirstFixationMs).toBeGreaterThan(4_000);
  });

  it('is null, not a near-zero, for a primary action no session scrolled to', async () => {
    const fixture = 'below-fold-primary-action' as const;
    const primary = await primaryActionId(fixture);
    const runs = await runSessions(
      {
        fixture,
        personaId: 'hurried-scanner',
        persona: HURRIED_SCANNER,
        goal: { text: 'place the order' },
      },
      SEEDS,
    );

    /**
     * The other end of the same claim, as the numbers a screen prints: no band, no
     * near-zero, no "under a millisecond". A hurried scanner never leaves the first
     * screen, so the median time to first fixation of a control below the fold is `null`
     * and so is its first-fixation duration — and those two nulls are what make "nobody
     * looked at it" survive to the Attention screen (#7, user story 11). `sessionCount` is
     * the whole seed set, so a screen reading this row knows the nulls are a result over
     * twenty-four sessions and not the absence of any.
     */
    expect(metricOf(runs, primary)).toMatchObject({
      timeToFirstFixationMs: null,
      firstFixationDurationMs: null,
      sessionCount: SEEDS.length,
    });
  });
});
