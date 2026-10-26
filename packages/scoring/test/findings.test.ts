import { findingsSchema, SCHEMA_VERSION, type Session } from '@personavision/contract';
import { describe, expect, it } from 'vitest';
import {
  FINDING_RULE_IDS,
  findingRuleIdOf,
  findings,
  score,
  scoringConfig,
  type Aoi,
  type Finding,
} from '../src/index.js';
import { JARGON } from '../src/findings/wording.js';
import { buildAoiMetrics, buildSession } from './fixtures/build.js';
import {
  cleanVariantSessions,
  defectiveVariantSessions,
  fixtureAoiMetrics,
  fixtureAois,
  fixtureSessions,
  fixtureTask,
  plantedDefects,
} from './fixtures/index.js';
import {
  rulesAoiMetrics,
  rulesAois,
  rulesSessions,
  rulesTask,
  RULES_VARIANT,
} from './fixtures/rules.js';

/**
 * The findings generator, through its public function and never through a rule.
 *
 * Every assertion below goes through `findings()` on a fixture set, as #9's testing
 * decisions require: a rule is only interesting if the sentence a designer would read comes
 * out of it, and a test that reached inside one would pass while the list stayed empty.
 *
 * Three fixture sets are used. The clean and defective checkouts of `./fixtures/index.ts`
 * are the ones the friction score's acceptance table is measured on, and they carry the
 * three planted defects. `./fixtures/rules.ts` adds the three situations those two have no
 * instance of. Between them every rule in `FINDING_RULE_IDS` fires, which a test here
 * holds them to.
 */

/** What `findings()` is handed for one of the two checkout fixture sets. */
const forCheckouts = (sessions: readonly Session[]): Finding[] =>
  findings(
    sessions,
    fixtureAois,
    fixtureAoiMetrics,
    score(sessions, fixtureAois, fixtureAoiMetrics, fixtureTask),
  );

const bothCheckouts = forCheckouts(fixtureSessions);
const cleanOnly = forCheckouts(cleanVariantSessions);
const defectiveOnly = forCheckouts(defectiveVariantSessions);

const extraRules = findings(
  rulesSessions,
  rulesAois,
  rulesAoiMetrics,
  score(rulesSessions, rulesAois, rulesAoiMetrics, rulesTask),
);

/**
 * A run with nothing wrong: one step, the control found in a second, nobody giving up and
 * nothing excluded.
 *
 * `docs/FLOW.md` section 6 and the Screen contract on #28 both say an empty list is a
 * legitimate result, so there has to be a run that produces one — otherwise "no findings"
 * could only ever mean the generator was broken.
 */
const QUIET_AOIS: Aoi[] = [
  { name: 'heading', label: 'Two-person tent', role: 'heading', y: 80, primary: false },
  { name: 'blurb', label: 'Specification', role: 'text', y: 200, primary: false },
  { name: 'go', label: 'Buy it', role: 'button', y: 360, primary: true },
].map((spec) => ({
  id: `q-shelf-${spec.name}`,
  variant: 'Q',
  step: 'shelf',
  label: spec.label,
  source: 'dom' as const,
  role: spec.role,
  bbox: { x: 24, y: spec.y, width: 300, height: 56 },
  isPrimaryAction: spec.primary,
  belowFold: false,
}));

const quietSessions: Session[] = [1, 2, 3, 4].map((person) =>
  buildSession(
    {
      sessionId: `S-0${person}`,
      variant: 'Q',
      seed: 1,
      personaId: `P-${person}`,
      status: 'success',
      steps: [{ step: 'shelf', primaryAfterSeconds: 1, deadEndReturns: 0 }],
    },
    QUIET_AOIS,
  ),
);
const quietAoiMetrics = buildAoiMetrics(quietSessions, QUIET_AOIS);
const quiet = findings(
  quietSessions,
  QUIET_AOIS,
  quietAoiMetrics,
  score(quietSessions, QUIET_AOIS, quietAoiMetrics, fixtureTask),
);

const byId = (list: readonly Finding[], id: string): Finding => {
  const found = list.find((finding) => finding.id === id);
  if (found === undefined)
    throw new Error(`no finding ${id} in ${list.map((f) => f.id).join(', ')}`);
  return found;
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

describe('the list a run states in words', () => {
  it('is the contract’s findings.json, and parses as it', () => {
    const parsed = findingsSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      runId: 'fixture-run',
      findings: bothCheckouts,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it('gives every finding a claim and a separate evidence sentence, both readable aloud', () => {
    expect(bothCheckouts.length).toBeGreaterThan(0);
    for (const finding of [...bothCheckouts, ...extraRules]) {
      expect(finding.claim, finding.id).toMatch(/^\S.*\.$/);
      expect(finding.evidence, finding.id).toMatch(/^\S.*\.$/);
      expect(finding.claim).not.toEqual(finding.evidence);
      // No placeholder ever reaches a reader: the two things a half-written formatter
      // leaves behind are an unfilled template and the word "undefined".
      for (const text of [finding.claim, finding.evidence]) {
        expect(text, finding.id).not.toMatch(/undefined|null|NaN|\$\{|TODO|TBD|\[/);
      }
    }
  });

  it('writes the claim as one sentence, and keeps the numbers in the evidence', () => {
    for (const finding of [...bothCheckouts, ...extraRules]) {
      // One sentence: the full stop at the end is the only sentence break. A decimal point
      // ("2.4 s") is not one, and neither is a run of digits.
      const breaks = finding.claim.replace(/\d\.\d/g, '00').match(/[.!?](\s|$)/g) ?? [];
      expect(breaks, `${finding.id}: ${finding.claim}`).toHaveLength(1);
    }
  });

  it('returns every finding: the cap of three is the verdict’s business, not this function’s', () => {
    // `docs/FLOW.md` section 6: the artifact carries every finding and
    // `verdict.headlineFindingIds` (#27) names the three the Verdict screen shows.
    expect(bothCheckouts.length).toBeGreaterThan(3);
  });

  it('returns an empty list for a run with nothing wrong, not an informational placeholder', () => {
    expect(quiet).toEqual([]);
  });
});

describe('the ranking', () => {
  it('is severity first, then the number of sessions behind it', () => {
    const keys = bothCheckouts.map((finding) => [
      SEVERITY_ORDER.indexOf(finding.severity),
      -finding.sessionCount,
    ]);
    expect(keys).toEqual([...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  });

  it('writes rank on each finding, counting from one with no gaps', () => {
    expect(bothCheckouts.map((finding) => finding.rank)).toEqual(
      bothCheckouts.map((_, position) => position + 1),
    );
  });

  it('breaks a tie on the finding’s own id, so the order is total and repeatable', () => {
    // Both versions' competing-area findings are `high` with eleven sessions behind them,
    // which is the tie: without a third key their order would be the order the rules
    // happen to be written in, and a rank a screen links by would move under an edit that
    // changed no reading.
    const tied = bothCheckouts.filter(
      (finding) => finding.severity === 'high' && finding.sessionCount === 11,
    );
    expect(tied.map((finding) => finding.id)).toEqual([
      'competing-first-fixation@A',
      'competing-first-fixation@B',
    ]);
    expect(forCheckouts([...fixtureSessions].reverse())).toEqual(bothCheckouts);
  });
});

describe('the control nobody ever looked at', () => {
  const finding = byId(bothCheckouts, 'never-fixated-primary-action@B');

  it('is critical, and worded as an absence', () => {
    expect(finding.severity).toBe('critical');
    expect(finding.rank).toBe(1);
    // The sentence the Screen contract on #28 settles on, after the departure it records:
    // the Attention screen keeps its own isolate sentence and neither restates the other.
    // A version is named by its id because nothing `findings()` is given carries a
    // version's display name (decision 16).
    expect(finding.claim).toBe(
      'Nobody ever looked at the button that completes the order on variant B.',
    );
  });

  it('puts the counts in its evidence sentence, against the other version’s control', () => {
    expect(finding.evidence).toBe(
      'On the review step, “Place order” sits below the fold. Of the 11 people who got that far, 0 looked at it. On variant A the same control was seen by 11 of 11, after 2.4 s.',
    );
  });

  it('names the area and the step, and the sessions that got that far', () => {
    expect(finding.variant).toBe('B');
    expect(finding.step).toBe('review');
    expect(finding.aoiId).toBe('b-review-place-order');
    expect(finding.sessionCount).toBe(11);
    expect(finding.sessionIds).toHaveLength(11);
  });

  it('does not also report the same control as merely hard to find', () => {
    // `primary-action-below-fold` is the same situation one step less bad, and reporting
    // both would say one thing twice at two severities.
    expect(bothCheckouts.map((f) => f.id)).not.toContain('primary-action-below-fold@B');
  });
});

describe('the sessions our own automation lost', () => {
  const note = byId(bothCheckouts, 'informational-note@run');
  const excluded = fixtureSessions.filter((session) => session.outcome.excludedFromScores);

  it('is marked as ours, attributed to the automation and about no single version', () => {
    expect(note.attribution).toBe('automation');
    expect(note.variant).toBeNull();
    expect(note.severity).toBe('info');
    expect(note.claim).toBe(
      '2 of 24 people could not be simulated to the end, and are excluded from both figures.',
    );
    expect(note.evidence).toContain('a weakness of the simulation, never evidence against');
  });

  it('is the only finding that names an excluded session', () => {
    expect(note.sessionIds).toEqual(excluded.map((session) => session.sessionId).sort());
    for (const finding of bothCheckouts.filter((f) => f.id !== note.id)) {
      for (const session of excluded) {
        expect(finding.sessionIds, `${finding.id}`).not.toContain(session.sessionId);
      }
    }
  });

  it('lets no rule read an excluded session, so none of them can reach a score', () => {
    // Taking the excluded sessions away must change nothing but the note itself: that is
    // what "excluded from every score" means for the findings, and it is checked by
    // comparing the two lists rather than by reading the rules.
    const withoutThem = forCheckouts(
      fixtureSessions.filter((session) => !session.outcome.excludedFromScores),
    );
    expect(withoutThem.map((f) => f.id)).toEqual(
      bothCheckouts.filter((f) => f.id !== note.id).map((f) => f.id),
    );
    for (const finding of withoutThem) {
      const before = byId(bothCheckouts, finding.id);
      expect([finding.claim, finding.evidence], finding.id).toEqual([
        before.claim,
        before.evidence,
      ]);
    }
  });
});

describe('the evidence link', () => {
  /**
   * The two routes `docs/FLOW.md` section 3 gives the evidence screens:
   *
   * - Attention — `/runs/:runId/attention/:variant/:step?aoi=`
   * - Sessions  — `/runs/:runId/sessions?variant=&outcome=&aoi=`
   *
   * `variant` and `step` are path segments of the Attention route, so a link to that
   * screen cannot leave either out; everything on the Sessions route is a query parameter
   * and all of them are optional, and `step` is not among them.
   */
  const REQUIRED = { attention: ['variant', 'step'], sessions: [] } as const;
  const ALLOWED = {
    attention: ['variant', 'step', 'aoi'],
    sessions: ['variant', 'outcome', 'aoi'],
  } as const;
  const OUTCOMES = ['success', 'abandoned', 'failed', 'automation_failure'];

  const everyLink = [...bothCheckouts, ...extraRules, ...cleanOnly, ...defectiveOnly];

  it('names attention or sessions, with parameters those routes take', () => {
    expect(everyLink.length).toBeGreaterThan(0);
    for (const finding of everyLink) {
      const { screen, params } = finding.evidence_link;
      expect(['attention', 'sessions']).toContain(screen);
      for (const key of REQUIRED[screen]) expect(Object.keys(params), finding.id).toContain(key);
      for (const key of Object.keys(params)) {
        expect(ALLOWED[screen] as readonly string[], `${finding.id} → ${screen}?${key}`).toContain(
          key,
        );
        expect(params[key], `${finding.id} → ${key}`).toMatch(/\S/);
      }
      if (params.outcome !== undefined) expect(OUTCOMES).toContain(params.outcome);
    }
  });

  it('points at the version, step and area the finding itself names', () => {
    for (const finding of everyLink) {
      const { params } = finding.evidence_link;
      if (params.variant !== undefined) expect(params.variant, finding.id).toBe(finding.variant);
      if (params.step !== undefined) expect(params.step, finding.id).toBe(finding.step);
      if (params.aoi !== undefined) expect(params.aoi, finding.id).toBe(finding.aoiId);
    }
  });

  it('lands on an area the run declares, and never on one it does not', () => {
    const declared = new Set([...fixtureAois, ...rulesAois].map((aoi) => aoi.id));
    for (const finding of everyLink) {
      if (finding.aoiId !== null) expect(declared, finding.id).toContain(finding.aoiId);
    }
  });
});

describe('every rule, exercised through findings()', () => {
  const fired = new Set(
    [...bothCheckouts, ...extraRules].map((finding) => findingRuleIdOf(finding)),
  );

  it('fires each of the rule ids the package exports, on these fixtures', () => {
    expect([...FINDING_RULE_IDS].filter((ruleId) => !fired.has(ruleId))).toEqual([]);
  });

  it('carries its rule in the finding’s id, so the rule is readable back off the artifact', () => {
    for (const finding of [...bothCheckouts, ...extraRules]) {
      const ruleId = findingRuleIdOf(finding);
      expect(ruleId, finding.id).not.toBeNull();
      expect(finding.id).toBe(`${ruleId}@${finding.variant ?? 'run'}`);
      expect(finding.severity).toBe(scoringConfig.severityByRule[ruleId as never]);
    }
    expect(findingRuleIdOf({ ...bothCheckouts[0], id: 'F-1' })).toBeNull();
  });

  it('gives every finding a different id, so a rank is addressable', () => {
    const ids = [...bothCheckouts, ...extraRules].map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes its severity from the configuration object and never from the rule', () => {
    expect(Object.keys(scoringConfig.severityByRule).sort()).toEqual([...FINDING_RULE_IDS].sort());
    for (const severity of Object.values(scoringConfig.severityByRule)) {
      expect(SEVERITY_ORDER).toContain(severity);
    }
  });

  it('states the three situations the checkout fixtures have no instance of', () => {
    expect(extraRules.map((finding) => finding.id)).toEqual([
      `competing-first-fixation@${RULES_VARIANT}`,
      `primary-action-below-fold@${RULES_VARIANT}`,
      `low-looked-at-share@${RULES_VARIANT}`,
      `slow-primary-action-fixation@${RULES_VARIANT}`,
    ]);
    expect(byId(extraRules, `primary-action-below-fold@${RULES_VARIANT}`).claim).toBe(
      'The button that completes the order on variant S starts below the fold, and only 2 of 10 people who got that far ever looked at it.',
    );
    expect(byId(extraRules, `slow-primary-action-fixation@${RULES_VARIANT}`).claim).toBe(
      '10 of 10 people on variant S took 4.0 s to find the button that moves on from the shelf step, time they spent on everything around it instead.',
    );
    expect(byId(extraRules, `low-looked-at-share@${RULES_VARIANT}`).claim).toBe(
      'Not one of the 10 people who reached the basket step on variant S ever looked at “Change delivery date”, so it did no work at all.',
    );
  });
});

describe('the planted defects', () => {
  it('are the top findings of the defective checkout', () => {
    const top = defectiveOnly
      .filter((finding) => finding.variant !== null)
      .slice(0, plantedDefects.length);
    expect(
      top.map((finding) => [
        findingRuleIdOf(finding),
        finding.variant,
        finding.step,
        finding.aoiId,
      ]),
    ).toEqual(
      [...plantedDefects]
        .sort(
          (a, b) =>
            top.findIndex((f) => findingRuleIdOf(f) === a.ruleId) -
            top.findIndex((f) => findingRuleIdOf(f) === b.ruleId),
        )
        .map((defect) => [defect.ruleId, defect.variant, defect.step, defect.aoiId]),
    );
  });

  it('are each found by the rule the demo shop declares them with', () => {
    for (const defect of plantedDefects) {
      const finding = defectiveOnly.find((f) => findingRuleIdOf(f) === defect.ruleId);
      expect(finding, defect.id).toBeDefined();
      expect([finding?.variant, finding?.step, finding?.aoiId], defect.id).toEqual([
        defect.variant,
        defect.step,
        defect.aoiId,
      ]);
    }
  });

  it('leave the clean checkout with no critical finding', () => {
    expect(cleanOnly.map((finding) => finding.severity)).not.toContain('critical');
    expect(
      cleanOnly.filter((finding) => findingRuleIdOf(finding) === 'never-fixated-primary-action'),
    ).toEqual([]);
  });
});

describe('a claim is written for a business reader', () => {
  const everyClaim = [...bothCheckouts, ...extraRules, ...cleanOnly, ...defectiveOnly];

  it('says none of the product’s own words, for every rule and every fixture', () => {
    // `docs/FLOW.md` section 6: no jargon in a claim sentence. Asserted over the generated
    // claims rather than left to review, which is what the re-plan on #28 asks for. The
    // evidence sentence is allowed a number, a unit and a technical quantity.
    expect(everyClaim.length).toBeGreaterThan(0);
    for (const finding of everyClaim) {
      const claim = finding.claim.toLowerCase();
      for (const word of JARGON) {
        expect(claim, `${finding.id} says "${word}" in its claim`).not.toContain(word);
      }
    }
  });

  it('names what the audience did, with the population behind it', () => {
    // A claim with no population behind it is an opinion, so every one of them says how
    // many people, or says nobody.
    for (const finding of everyClaim) {
      expect(finding.claim, finding.id).toMatch(/\bpeople\b|\bperson\b|\bnobody\b/i);
    }
  });

  it('names the thing on the page it is about', () => {
    // Quoted by its own label, or named as the control that advances the task, or located
    // by its step. A finding about the run itself names no element, because there is none:
    // those are the ones that carry no version.
    for (const finding of everyClaim.filter((f) => f.variant !== null)) {
      expect(finding.claim, finding.id).toMatch(/\u201c|the button that|\bstep\b/i);
    }
  });

  it('ends on the consequence, in words one of the formatters wrote', () => {
    // There is one formatter per rule, so the clauses that state a consequence are a
    // closed set and can be listed. This is the guard on the next rule somebody adds: a
    // claim that reports a reading and stops short of what it cost the reader fails here
    // until its formatter says so. Keep this list in step with the formatters.
    const CONSEQUENCES = [
      'Nobody ever looked at',
      'before they look at anything that moves the task on',
      'ever looked at it',
      'left without ordering',
      'had to read it again',
      'instead of going on',
      'leaving was not their choice',
      'time they spent on everything around it instead',
      'did no work',
      'excluded from both figures',
    ];
    for (const finding of everyClaim) {
      expect(
        CONSEQUENCES.some((clause) => finding.claim.includes(clause)),
        `${finding.id} states no consequence: ${finding.claim}`,
      ).toBe(true);
    }
  });
});

/**
 * The wording, pinned.
 *
 * `docs/design/prototype.html`'s `FINDINGS` constant is the reference for the voice, the
 * length and the level of numeric detail of these sentences, and the table below is what
 * the generator produces for the fixture that mirrors the demo. Pinning it is what stops
 * the wording drifting between runs: one formatter per rule writes these, and an edit to a
 * formatter fails here until this table is updated with it.
 *
 * Five of the six prototype sentences are **not** reproduced character for character, and
 * decision 16 records why: they state a $9.95 fee, a total changing from $129.00 to
 * $147.95, 180 px below the fold, that nobody used the promo code, that three people
 * believed they had bought the boots and that two were price-led shoppers, and they name
 * the versions "the redesign" and "your current checkout". `findings(sessions, aois,
 * aoiMetrics, scores)` is handed no money, no page copy, no fold position, no persona
 * segment and not even a version's name, so those are the demo's authored prose and not a
 * reading any run carries. The situation each one names is found, by the rule named beside
 * it below.
 */
describe('the wording the demo’s findings carry', () => {
  it('reads as the prototype’s FINDINGS constant reads, from one formatter per rule', () => {
    expect(bothCheckouts.map((finding) => [finding.id, finding.claim, finding.evidence])).toEqual([
      [
        'never-fixated-primary-action@B',
        'Nobody ever looked at the button that completes the order on variant B.',
        'On the review step, “Place order” sits below the fold. Of the 11 people who got that far, 0 looked at it. On variant A the same control was seen by 11 of 11, after 2.4 s.',
      ],
      [
        'competing-first-fixation@A',
        '“Order total” takes the first look in 11 of 11 people on variant A, about 2.4 s before they look at anything that moves the task on.',
        'It holds 0.5 s of attention against 0.3 s on the control beneath it. That is 50% of everything looked at on the review step — attention it costs without earning anything.',
      ],
      [
        'competing-first-fixation@B',
        '“Save 15% today” takes the first look in 11 of 11 people on variant B, about 2.0 s before they look at anything that moves the task on.',
        'It holds 1.0 s of attention against 0.3 s on the control beneath it. That is 67% of everything looked at on the cart step — attention it costs without earning anything.',
      ],
      [
        'value-changed-between-steps@B',
        '“Service fee $9.95” appears for the first time on the review step, once people have already committed, and 9 of 11 people who got that far left without ordering.',
        'It holds the eye for 250 ms the first time and people come back to it 2 times each — the most re-read thing on the step. Nothing with its name is on any of the steps before it.',
      ],
      [
        'high-abandonment-at-step@B',
        '6 of 11 people who reached the review step on variant B gave up there instead of going on.',
        'That is 55% of the people who got that far, and 6 of the 6 who gave up anywhere on variant B gave up here. Each of them recorded the same reason: gave up at the order total.',
      ],
      [
        'task-failure-at-step@B',
        '3 of 11 people who reached the review step on variant B ended there with no order placed, and leaving was not their choice.',
        'All 3 stopped on that step with the task unfinished and the product at fault — a failure, not someone choosing to leave. Each of them recorded the same reason: the order could not be placed.',
      ],
      [
        'informational-note@run',
        '2 of 24 people could not be simulated to the end, and are excluded from both figures.',
        'Our own browser automation gave up on the payment step (one person on each version). This is a weakness of the simulation, never evidence against your checkout.',
      ],
    ]);
  });

  it('finds the situation each of the prototype’s six findings names', () => {
    // prototype FINDINGS entry → the rule that states it here. The sentences differ, the
    // situations do not; the fifth fires on the defective checkout rather than the clean
    // one, whose worst step loses 2 of 11 — under `thresholds.highAbandonmentShare`, and
    // so not a step the run leads with.
    const SITUATIONS = [
      ['the control that completes the order, never looked at', 'never-fixated-primary-action'],
      ['a charge that appears only after the card is entered', 'value-changed-between-steps'],
      ['a banner that takes the first look and holds the step', 'competing-first-fixation'],
      ['a step where the task fails with nothing ordered', 'task-failure-at-step'],
      ['a step where people give up rather than go on', 'high-abandonment-at-step'],
      ['the sessions our own automation could not finish', 'informational-note'],
    ] as const;

    for (const [situation, ruleId] of SITUATIONS) {
      expect(
        bothCheckouts.map((finding) => findingRuleIdOf(finding)),
        situation,
      ).toContain(ruleId);
    }
    expect(SITUATIONS).toHaveLength(6);
  });
});
