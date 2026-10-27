/**
 * The behaviour suite's fixtures: the pages, the task they are written for, the people who
 * walk them, and the replay that drives them with nothing running.
 *
 * `../fixtures/site/` is four committed pages and `../fixtures/captures/` is the capture set
 * recorded from them by `record-fixtures.ts` — so every session in this suite replays bytes
 * that were really recorded from a real page, with no browser, no socket and no API key.
 * `../fixtures/README.md` is the record of what is on each page and why.
 *
 * Three scenarios, one per recorded variant, each a page shaped to produce one behaviour:
 *
 * | variant       | the page is                                               | what it is for          |
 * | ------------- | --------------------------------------------------------- | ----------------------- |
 * | `tedious`     | long, with the control that finishes it small and low     | giving up in character  |
 * | `mislabelled` | loud about the goal on a control that does nothing        | a defect that is theirs |
 * | `vanishing`   | a control that leaves the document under the pointer      | breakage that is ours   |
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureSource } from '@personavision/browser';
import type { ActResult, CaptureSource, Device, TaskDefinition } from '@personavision/browser';
import type { Persona } from '@personavision/contract';

/**
 * This package's own directory: the nearest ancestor of this file holding a `package.json`.
 *
 * The pages and the capture set are the package's, not this file's neighbours, because
 * `record:fixtures` compiles this module and runs the JavaScript — so at run time it sits in
 * `dist/record/test/` as often as in `test/`, and both layouts have to find them.
 */
const packageRoot = (): string => {
  let at = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(at, 'package.json'))) return at;
    const up = dirname(at);
    if (up === at) throw new Error(`no package.json above ${fileURLToPath(import.meta.url)}`);
    at = up;
  }
};

export const BEHAVIOUR_SITE = join(packageRoot(), 'fixtures', 'site');
export const BEHAVIOUR_CAPTURES = join(packageRoot(), 'fixtures', 'captures');

/**
 * The one device every page was recorded under. One device, because the same people walk
 * every variant and a person has one device: a set recorded at two viewports cannot be
 * walked end to end by one swarm.
 */
export const BEHAVIOUR_DEVICE: Device = {
  name: 'mobile',
  viewport: { width: 390, height: 844 },
  // One device pixel per CSS pixel. A phone's three would make the recorded image of a
  // 2400-pixel page nine times the bytes, and committed test material is read far more
  // often than it is recorded: the salience the engine reads off these images is a
  // statistic over the page, which one pixel per pixel states as well as three.
  deviceScaleFactor: 1,
  touch: true,
};

/**
 * The task the fixture pages are written for: two steps, and the second one is done.
 *
 * The first step's URL pattern names all three scenario pages, so one task walks every
 * variant and the step ids a session reports are the same whichever page it was given.
 */
export const BEHAVIOUR_TASK: TaskDefinition = {
  id: 'order',
  prompt: 'Place the order for the canvas tote bag.',
  steps: [
    {
      id: 'list',
      label: 'Items',
      match: {
        urlPattern: '/(tedious|mislabelled|vanishing)\\.html',
        requiredSelector: '#order-panel',
      },
      primaryAction: { selector: '#order-submit' },
    },
    {
      id: 'done',
      label: 'Placed',
      match: { urlPattern: '/done\\.html', requiredSelector: '#done-receipt' },
      primaryAction: { selector: '#done-home' },
    },
  ],
};

/** The selector the fixture pages give the control that finishes the task. */
export const PRIMARY_ACTION_SELECTOR = '#order-submit';

/** One recorded scenario: the variant it is recorded under, where it starts, and its walk. */
export interface Scenario {
  readonly variant: string;
  readonly entry: string;
  /** The steps recorded for it, in order. */
  readonly steps: readonly string[];
}

/**
 * The three scenarios, as the capture set records them.
 *
 * `vanishing` records one step and not two: its control takes itself out of the document
 * when a pointer goes down on it, so a recorder that tried to walk through it would be
 * recording the defect away.
 */
export const SCENARIOS: readonly Scenario[] = [
  { variant: 'tedious', entry: '/tedious.html', steps: ['list', 'done'] },
  { variant: 'mislabelled', entry: '/mislabelled.html', steps: ['list', 'done'] },
  { variant: 'vanishing', entry: '/vanishing.html', steps: ['list'] },
];

/** The variant a scenario is recorded under, as a run and a session address it. */
export const scenarioVariant = (variant: string) => ({
  id: variant,
  url: `https://behaviour.fixture.test${
    SCENARIOS.find((scenario) => scenario.variant === variant)?.entry ?? '/'
  }`,
});

const TRAITS = {
  /**
   * No patience and little persistence: eight seconds of dwell and five fruitless actions
   * is what this person spends before leaving, whatever is left to try.
   */
  rushed: {
    persistence: 0.25,
    scanningVsReading: 0.9,
    detailOrientation: 0.2,
    interfaceFamiliarity: 0.75,
    patience: 0.15,
    riskTolerance: 0.7,
  },
  /** Patience and persistence at the top of the scale: this person reads the whole page. */
  dogged: {
    persistence: 1,
    scanningVsReading: 0.2,
    detailOrientation: 0.5,
    interfaceFamiliarity: 0.5,
    patience: 1,
    riskTolerance: 0.2,
  },
} as const satisfies Record<string, Persona['traits']>;

export type Who = keyof typeof TRAITS;

/** One of the suite's two people, as a generator would hand them over. */
export const personaWho = (who: Who): Persona => ({
  id: who,
  name: who === 'rushed' ? 'Rushed buyer' : 'Dogged completer',
  audienceId: 'behaviour-fixtures',
  segment: who === 'rushed' ? 'Rushed' : 'Dogged',
  traits: TRAITS[who],
  device: BEHAVIOUR_DEVICE,
});

export const RUSHED = personaWho('rushed');
export const DOGGED = personaWho('dogged');

/**
 * The band of seeds every claim in this suite is made over, and the one seed the paired
 * claim names.
 *
 * A band rather than one seed because a swarm is a spread: the same person on two seeds
 * looks at a page in two orders, and whether a small grey control is found at all is part
 * of what this fixture is for. Fixed, so the suite measures the same eight sessions on
 * every machine and a tolerance below is a fact rather than a hope.
 */
export const SEED_BAND: readonly number[] = [11, 17, 23, 29, 37, 41, 43, 47];

/** One seed of the band on which the rushed person gives up and the dogged one finishes. */
export const PAIRED_SEED = 23;

/**
 * How many screens a session on the mislabelled page may capture.
 *
 * Ten, where the default is eight per step of the task, because that page cannot be
 * finished and a session has to end somewhere: at ten screens the dogged person still has
 * patience and persistence left, so the outcome is read off a task that was not done rather
 * than off a budget that ran out. Left at the default, the same session ends `abandoned`
 * some thirty screens later, which is a true answer to a different question.
 */
export const MISLABELLED_SCREEN_CAP = 10;

/**
 * The ids the vanishing page's control is recorded under, read out of the committed
 * capture. Both candidates for one control — the DOM's and the accessibility tree's — carry
 * its selector, and either of them is the control the agent chose.
 */
const vanishingControlIds = async (): Promise<ReadonlySet<string>> => {
  const file = `${BEHAVIOUR_CAPTURES}/captures/vanishing/list.json`;
  const capture = JSON.parse(await readFile(file, 'utf8')) as {
    elements: { id: string; selector: string }[];
  };
  const ids = capture.elements
    .filter((element) => element.selector === PRIMARY_ACTION_SELECTOR)
    .map((element) => element.id);
  if (ids.length === 0) {
    throw new Error(`${file} records no element whose selector is ${PRIMARY_ACTION_SELECTOR}`);
  }
  return new Set(ids);
};

/**
 * The committed capture set, replayed, with the vanishing page's defect replayed too.
 *
 * A capture is a reading of a page taken **before** the session acted on it, so a replay
 * resolves every id it holds: that is right for a page that stays put, and the vanishing
 * page does not. Its control removes itself from the document the moment a pointer goes
 * down on it (`../fixtures/site/vanishing.html`), so a live driver's locator never resolves
 * and `act` reports `selector_not_found`. That is what this answers for the one control the
 * page takes away, and nothing else: the position it reports is the replay's own, asked for
 * with a scroll of nothing, so the session is told where it is and that the control is not
 * there.
 */
export const behaviourSource = async (): Promise<CaptureSource> => {
  const inner = createFixtureSource(BEHAVIOUR_CAPTURES);
  const vanishes = await vanishingControlIds();

  return {
    ...inner,
    act: async (page, action, ctx, options): Promise<ActResult> => {
      const gone =
        ctx.variant === 'vanishing' &&
        action.type === 'click' &&
        action.elementId !== undefined &&
        vanishes.has(action.elementId);
      if (!gone) return inner.act(page, action, ctx, options);

      const where = await inner.act(page, { type: 'scroll', deltaY: 0 }, ctx);
      return {
        ok: false,
        action,
        url: where.url,
        scrollY: where.scrollY,
        step: where.step,
        failure: 'selector_not_found',
      };
    },
  };
};
