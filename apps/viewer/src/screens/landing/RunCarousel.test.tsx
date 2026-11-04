// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LandingSlides } from '@personavision/contract';
import { NEXT_PARAM, paths } from '@/shell/paths';
import { forgetRuns, mountApp, serveRunData } from '../../../tests/app';
import { ruleIn, rulesOf } from '../../../tests/cssom';
import type { Rule } from '../../../tests/cssom';
import { loadDesignTokens } from '../../../tests/setup';

/**
 * The carousel of agent runs on the front page (#428), over the repository's own committed
 * slide set.
 *
 * What is asserted is what a reader sees, where a click lands and what a key does. The point
 * of most of it is that **nothing on a slide is written into the page**: every name, age,
 * trait value, sentence, outcome and number is read from `slides.json`, so the tests that
 * matter most here change a value in that file and expect the page to follow.
 *
 * The slide set is this app's own source rather than a file a server hands over, so it is
 * mocked at the module that reads it: `served` holds the text, every test is handed the
 * committed bytes, and a test about a changed value edits that text before mounting. The
 * read caches nothing, which is what makes one mount per test enough.
 *
 * The one thing jsdom cannot answer is whether a 390px window scrolls sideways, so the
 * narrow-window contract is read off the stylesheet with the rest of this app's layout
 * suites (`tests/cssom.ts`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const SLIDES_FILE = join(here, 'slides.json');
const COMMITTED = readFileSync(SLIDES_FILE, 'utf8');

/** The text the read is handed. Reset to the committed bytes before every test. */
let served = COMMITTED;

vi.mock('./slides.json?raw', () => ({
  get default() {
    return served;
  },
}));

const SIGNED_OUT = { status: 'signed-out' } as const;

/** The committed set, parsed the way the page parses it, for a test to read values off. */
const committedSet = (): LandingSlides => JSON.parse(COMMITTED) as LandingSlides;

/** The committed set with something changed in it, served in its place. */
const serveChangedSlides = (change: (set: LandingSlides) => void): LandingSlides => {
  const set = committedSet();
  change(set);
  served = JSON.stringify(set);
  return set;
};

/** The landing page, mounted at `/` for somebody with no session. */
const landing = () => mountApp(paths.home, { session: SIGNED_OUT });

/** The carousel, once the slide set has been read into it. */
const carousel = async (container: HTMLElement): Promise<HTMLElement> =>
  waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-slide]');
    if (found === null) throw new Error('no slide yet');
    return found.closest('[data-section="landing-carousel"]') as HTMLElement;
  });

/** The slide on screen. Only one is ever mounted. */
const slideOn = async (container: HTMLElement): Promise<HTMLElement> => {
  await carousel(container);
  return container.querySelector<HTMLElement>('[data-slide]') as HTMLElement;
};

/** The view switch's item for one of the three views. */
const viewButton = (container: HTMLElement, view: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-view="${view}"]`) as HTMLElement;

const showView = async (container: HTMLElement, view: string): Promise<HTMLElement> => {
  await userEvent.click(viewButton(container, view));
  return slideOn(container);
};

beforeEach(async () => {
  served = COMMITTED;
  loadDesignTokens();
  await serveRunData();
});

afterEach(forgetRuns);

describe('the slide set is the page', () => {
  it('states the task once above the slides, because every person was asked the same thing', async () => {
    const set = committedSet();
    const { container } = landing();
    const section = await carousel(container);

    expect(section.textContent).toContain(set.task);
    // Once, not per slide: five copies of one prompt is the thing the set exists to avoid.
    expect(screen.getAllByText(new RegExp(set.task.slice(0, 20)))).toHaveLength(1);
  });

  it('puts price sensitivity on the audience’s line and never in a person’s traits', async () => {
    const set = committedSet();
    const { container } = landing();
    const section = await carousel(container);

    const line = section.querySelector('[data-carousel-audience]') as HTMLElement;
    expect(line.textContent).toContain(set.audience.name);
    expect(line.textContent).toContain(set.audience.priceSensitivity.toFixed(2));
    expect(line.textContent).toContain('the audience’s, not one person’s');

    // Decision 178: `personaTraitsSchema` has no such field, so no trait row can be one.
    const slide = await slideOn(container);
    const traits = [...slide.querySelectorAll('[data-trait]')].map((row) =>
      row.getAttribute('data-trait'),
    );
    expect(traits).not.toContain('priceSensitivity');
    expect(traits.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the first person’s own name, role and trait values', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('the committed set has no slides');
    const { container } = landing();
    const slide = await slideOn(container);

    expect(slide.textContent).toContain(first.person.name);
    expect((slide.querySelector('[data-person-segment]') as HTMLElement).textContent).toBe(
      first.person.segment,
    );
    for (const trait of first.person.traits) {
      const row = slide.querySelector(`[data-trait="${trait.key}"]`) as HTMLElement;
      expect(row.textContent).toContain(trait.value.toFixed(2));
    }
    // The owner's own word for `interfaceFamiliarity`, which is what a reader knows it by.
    expect(
      (slide.querySelector('[data-trait="interfaceFamiliarity"] dt') as HTMLElement).textContent,
    ).toBe('tech confidence');
  });

  it('follows a changed name and a changed trait value in the slide set', async () => {
    const changed = serveChangedSlides((set) => {
      const first = set.slides[0];
      if (first === undefined) throw new Error('the committed set has no slides');
      first.person.name = 'Somebody the fixture renamed';
      const trait = first.person.traits[0];
      if (trait === undefined) throw new Error('the first slide carries no trait');
      trait.value = 0.11;
    });
    const first = changed.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    const slide = await slideOn(container);

    expect(slide.textContent).toContain('Somebody the fixture renamed');
    expect(slide.textContent).not.toContain(committedSet().slides[0]?.person.name ?? '');
    expect(
      (slide.querySelector(`[data-trait="${first.person.traits[0]?.key ?? ''}"]`) as HTMLElement)
        .textContent,
    ).toContain('0.11');
  });

  it('renders no age and no placeholder for a person the run recorded none for', async () => {
    // Every person in the committed set is one: a generated persona carries only traits.
    const { container } = landing();
    const slide = await slideOn(container);

    expect(slide.querySelector('[data-person-age]')).toBeNull();
    expect(slide.textContent).not.toContain('age');
    expect(slide.textContent).not.toContain('—,');
  });

  it('renders the age of a person who carries one', async () => {
    serveChangedSlides((set) => {
      const first = set.slides[0];
      if (first === undefined) throw new Error('no slide');
      first.person.ageYears = 34;
    });
    const { container } = landing();
    const slide = await slideOn(container);

    expect((slide.querySelector('[data-person-age]') as HTMLElement).textContent).toContain('34');
  });
});

describe('the device is the frame', () => {
  it('draws a touch device as a phone at that persona’s viewport, and a desktop one on a mat', async () => {
    const set = committedSet();
    const { container } = landing();
    await carousel(container);

    const touchAt = set.slides.findIndex((slide) => slide.person.device.touch);
    const deskAt = set.slides.findIndex((slide) => !slide.person.device.touch);
    expect(touchAt, 'the set holds a touch slide').toBeGreaterThanOrEqual(0);
    expect(deskAt, 'the set holds a desktop slide').toBeGreaterThanOrEqual(0);

    for (const [at, frame] of [
      [touchAt, 'phone'],
      [deskAt, 'mat'],
    ] as const) {
      await userEvent.click(container.querySelector(`[data-dot="${at}"]`) as HTMLElement);
      const slide = await slideOn(container);
      const person = set.slides[at]?.person;
      if (person === undefined) throw new Error('no person');

      expect(slide.querySelector('[data-frame]')?.getAttribute('data-frame')).toBe(frame);
      // Labelled with the device's name and its viewport, as every other screenshot is.
      expect((slide.querySelector('[data-device]') as HTMLElement).textContent).toContain(
        `${person.device.name} · ${person.device.viewport.width} × ${person.device.viewport.height}`,
      );
      // `min(100%, …)`: the frame is capped at the persona's own viewport **and** at the
      // column it sits in, so it cannot reach off the side of a window narrower than the
      // device — which is what keeps a 390px capture inside a 390px window.
      const box = slide.querySelector('[data-frame] > div') as HTMLElement;
      expect(box.style.maxWidth).toBe(
        frame === 'phone'
          ? `min(100%, ${person.device.viewport.width}px)`
          : `min(100%, ${set.slides[at]?.screenshot.viewport.width ?? 0}px)`,
      );
    }
  });

  it('loads the screenshot from the committed run directory and from no other host', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    const slide = await slideOn(container);

    const image = slide.querySelector('img') as HTMLImageElement;
    const src = new URL(image.getAttribute('src') as string, window.location.href);
    expect(src.pathname).toBe(`/runs/${first.runId}/${first.screenshot.path}`);
    // Same origin as the app: the run directory the viewer serves, never a third party.
    expect(src.origin).toBe(window.location.origin);
    expect(image.getAttribute('alt')).toContain(first.person.name);
  });
});

describe('the three views', () => {
  it('draws the dwell-weighted heatmap of this person’s own fixations', async () => {
    const { container } = landing();
    const slide = await slideOn(container);

    // The heat is the view a slide opens on, and #71's layer, mounted as it is.
    const heat = slide.querySelector('[data-overlay-layer="heat"]') as HTMLElement;
    const blobs = [...heat.querySelectorAll('[data-heat-step]')];
    expect(blobs.length).toBeGreaterThan(0);
    // Weighted by dwell: every blob carries the milliseconds it was drawn from.
    for (const blob of blobs) expect(Number(blob.getAttribute('data-dwell-ms'))).toBeGreaterThan(0);
  });

  it('outlines the named areas with the dwell and share each already carries', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    await slideOn(container);
    const slide = await showView(container, 'aoi');

    const outlines = [...slide.querySelectorAll('[data-overlay-layer="aoi"] [data-aoi]')];
    expect(outlines.length).toBeGreaterThan(0);

    // An area nobody ever fixated reads `never` and `0%` — never `0 ms`, never blank.
    const unseen = first.areas.find((area) => area.metrics.timeToFirstFixationMs === null);
    if (unseen === undefined) throw new Error('the first slide has no never-fixated area');
    const row = slide.querySelector(`[data-area="${unseen.id}"]`) as HTMLElement;
    expect((row.querySelector('[data-area-dwell]') as HTMLElement).textContent).toBe('never');
    expect((row.querySelector('[data-area-share]') as HTMLElement).textContent).toBe('0%');

    // And an area the audience held on reads the stored dwell, in seconds as the areas
    // table compares them.
    const held = first.areas.find((area) => area.metrics.totalDwellMs > 0);
    if (held === undefined) throw new Error('the first slide has no area with dwell');
    const heldRow = slide.querySelector(`[data-area="${held.id}"]`) as HTMLElement;
    expect((heldRow.querySelector('[data-area-dwell]') as HTMLElement).textContent).toMatch(/s$/);
  });

  it('numbers this person’s fixations in the order they happened, and draws the clicks', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    await slideOn(container);
    const slide = await showView(container, 'path');

    // The replay's own per-session trace (decision 180): the session's numbering, which is
    // a fixation's `index` plus one, in the order the session recorded them.
    const numbers = [...slide.querySelectorAll('[data-fixation]')].map((mark) =>
      Number(mark.getAttribute('data-fixation')),
    );
    expect(numbers).toEqual(first.fixations.map((fixation) => fixation.index + 1));
    // The saccades between them.
    expect(slide.querySelectorAll('#rp-vec line')).toHaveLength(first.saccades.length);
    // And a ring where they pressed, over the area the click named.
    const drawable = first.clicks.filter((click) =>
      first.areas.some((area) => area.id === click.aoiId),
    );
    expect(slide.querySelectorAll('#rp-clicks [data-click]')).toHaveLength(drawable.length);
  });

  it('leaves the capped areas list reachable without a pointer', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    await slideOn(container);
    const slide = await showView(container, 'aoi');

    // The list is taller than its box and holds nothing focusable of its own, so it is a
    // named group with a tab stop — the same treatment the Attention screen's scrolling
    // frame has, and the only thing that makes the rows past the eighth reachable (WCAG
    // 2.1.1).
    const list = slide.querySelector('[data-areas]') as HTMLElement;
    expect(list.getAttribute('tabindex')).toBe('0');
    expect(list.getAttribute('role')).toBe('group');
    const named = first.areas.filter((area) => area.label !== area.role);
    expect(list.getAttribute('aria-label')).toContain('scrollable');
    expect(list.querySelectorAll('[data-area]')).toHaveLength(named.length);
    // Every named area is in the list: capping its height hides none of them.
    expect(named.length).toBeGreaterThan(8);
  });

  it('gives each view a text alternative saying what is drawn and on whose screen', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const where = first.areas[0];
    if (where === undefined) throw new Error('the first slide names no area');
    const { container } = landing();

    const expected: Readonly<Record<string, string>> = {
      heat: 'their fixations, weighted by how long each one held',
      aoi: 'the areas this test named on the page, each outlined',
      path: 'their fixations numbered in the order they happened, with the moves between them',
    };

    await slideOn(container);
    for (const [view, says] of Object.entries(expected)) {
      const slide = await showView(container, view);
      const alt = slide.querySelector(`[data-stage-alt="${view}"]`) as HTMLElement;
      expect(alt.textContent).toContain(says);
      expect(alt.textContent).toContain(`the ${where.step} step of ${where.variant}`);
      // The heat is the one overlay the Attention screen gives a legend, and it is that
      // legend — the ramp the colours on the page are read against — mounted only while
      // the heat is drawn.
      expect(alt.querySelector('[data-heat-key="ramp"]') === null).toBe(view !== 'heat');
    }
  });
});

describe('what they thought', () => {
  it('prints the agent’s own sentences verbatim', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    const slide = await slideOn(container);

    for (const which of ['intent', 'decidedAction'] as const) {
      const thought = first.thoughts[which];
      if (thought === undefined) continue;
      const row = slide.querySelector(`[data-thought="${which}"]`) as HTMLElement;
      expect((row.querySelector('q') as HTMLElement).textContent).toBe(thought.text);
    }
  });

  it('follows a changed sentence in the slide set', async () => {
    serveChangedSlides((set) => {
      const thought = set.slides[0]?.thoughts.intent;
      if (thought === undefined) throw new Error('the first slide has no intent');
      thought.text = 'A sentence the fixture put there.';
    });
    const { container } = landing();
    const slide = await slideOn(container);

    expect((slide.querySelector('[data-thought="intent"] q') as HTMLElement).textContent).toBe(
      'A sentence the fixture put there.',
    );
  });

  it('ties each thought to the numbered marker it names on the Path view', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    await slideOn(container);
    const slide = await showView(container, 'path');

    const drawn = new Set(
      [...slide.querySelectorAll('[data-fixation]')].map((mark) =>
        mark.getAttribute('data-fixation'),
      ),
    );
    const rows = [...slide.querySelectorAll('[data-thought]')];
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const which = row.getAttribute('data-thought') as 'intent' | 'decidedAction';
      const thought = first.thoughts[which];
      if (thought === undefined) throw new Error(`no ${which} on the first slide`);
      const number = String(thought.fixationIndex + 1);
      // The number the row carries is the number on the marker, which is what ties them.
      expect(row.getAttribute('data-fixation-number')).toBe(number);
      expect(row.textContent).toContain(number);
      expect(drawn.has(number)).toBe(true);
    }
  });
});

describe('how it ended', () => {
  it('names the status in the product’s words, with the stored reason', async () => {
    const set = committedSet();
    const words: Readonly<Record<string, string>> = {
      success: 'Success',
      abandoned: 'Gave up',
      failed: 'Failed',
    };
    const { container } = landing();
    await carousel(container);

    // Every slide, because the three statuses are never merged and the set holds more than
    // one of them.
    for (const [at, one] of set.slides.entries()) {
      await userEvent.click(container.querySelector(`[data-dot="${at}"]`) as HTMLElement);
      const slide = await slideOn(container);
      const ended = slide.querySelector('[data-outcome]') as HTMLElement;

      expect(ended.getAttribute('data-outcome')).toBe(one.outcome.status);
      expect(ended.textContent).toContain(words[one.outcome.status] as string);
      expect(ended.textContent).toContain(one.outcome.reason);
      expect(ended.textContent).toContain(one.outcome.step);
    }

    // The three the carousel is about, and no slide that is our own breakage.
    expect(set.slides.map((one) => one.outcome.status)).not.toContain('automation_failure');
    expect(new Set(set.slides.map((one) => one.outcome.status)).size).toBeGreaterThan(1);
  });

  it('links into that session’s replay', async () => {
    const set = committedSet();
    const first = set.slides[0];
    if (first === undefined) throw new Error('no slide');
    const { container } = landing();
    const slide = await slideOn(container);

    const link = slide.querySelector('[data-outcome] a') as HTMLElement;
    expect(link.getAttribute('href')).toBe(paths.session(first.runId, first.sessionId));
  });

  it('carries a signed-out visitor to sign-in with the replay they asked for', async () => {
    // Not a door that fails: the protected route sends them to sign-in with the
    // destination on it, which is how every link on `/demo` to a protected screen behaves.
    const { container, router } = landing();
    const slide = await slideOn(container);
    const link = slide.querySelector('[data-outcome] a') as HTMLElement;
    const destination = link.getAttribute('href') as string;

    await userEvent.click(link);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(paths.signIn);
    });
    expect(new URLSearchParams(router.state.location.search).get(NEXT_PARAM)).toBe(destination);
  });
});

describe('moving between the people', () => {
  it('moves with the previous and next controls, and stops at either end', async () => {
    const set = committedSet();
    const { container } = landing();
    await carousel(container);

    const previous = container.querySelector('[data-carousel="previous"]') as HTMLButtonElement;
    const next = container.querySelector('[data-carousel="next"]') as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    await userEvent.click(next);
    expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[1]?.sessionId);
    expect(previous.disabled).toBe(false);

    await userEvent.click(previous);
    expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[0]?.sessionId);

    for (let step = 0; step < set.slides.length; step += 1) {
      if (!next.disabled) await userEvent.click(next);
    }
    expect(next.disabled).toBe(true);
  });

  it('moves with the arrow keys when the carousel has focus', async () => {
    const set = committedSet();
    const { container } = landing();
    await carousel(container);

    (container.querySelector('[data-dot="0"]') as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[1]?.sessionId);
    await userEvent.keyboard('{ArrowLeft}');
    expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[0]?.sessionId);

    // From the next button too: the keys belong to the carousel, not to one control in it.
    (container.querySelector('[data-carousel="next"]') as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[1]?.sessionId);
  });

  it('makes the dots a real tab list and keeps the other slides out of the tab order', async () => {
    const set = committedSet();
    const { container } = landing();
    const section = await carousel(container);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(set.slides.length);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(
      set.slides.map((_one, at) => (at === 0 ? '0' : '-1')),
    );
    expect(screen.getAllByRole('tablist').length).toBeGreaterThan(0);

    // Only the slide a reader is on is mounted, so nothing of the other four — not a
    // link, not a button — is in the tab order.
    expect(section.querySelectorAll('[data-slide]')).toHaveLength(1);
    expect(section.querySelectorAll('[data-outcome] a')).toHaveLength(1);

    // The panel is named by the tab that selects it.
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.getAttribute('id'));
  });

  it('operates the view switch by keyboard alone', async () => {
    const { container } = landing();
    await slideOn(container);

    const heat = viewButton(container, 'heat');
    heat.focus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard(' ');

    const slide = await slideOn(container);
    expect(viewButton(container, 'aoi').getAttribute('data-state')).toBe('on');
    expect(slide.querySelector('[data-overlay-layer="aoi"]')).not.toBeNull();
    // The switch's arrow keys are its own: moving inside it did not also move the slide.
    expect(slide.getAttribute('data-slide')).toBe(committedSet().slides[0]?.sessionId);
  });

  it('starts each person on the default view, because the switch is per slide', async () => {
    const set = committedSet();
    const { container } = landing();
    await slideOn(container);

    // The reader picks the Path view on the first person.
    let slide = await showView(container, 'path');
    expect(slide.querySelector('#rp-vec')).not.toBeNull();

    // Moving to the next person opens on that person's own default, not on the view the
    // last one was left at: the switch belongs to the slide.
    await userEvent.click(container.querySelector('[data-carousel="next"]') as HTMLElement);
    slide = await slideOn(container);
    expect(slide.getAttribute('data-slide')).toBe(set.slides[1]?.sessionId);
    expect(viewButton(container, 'heat').getAttribute('data-state')).toBe('on');
    expect(slide.querySelector('[data-overlay-layer="heat"]')).not.toBeNull();
    expect(slide.querySelector('#rp-vec')).toBeNull();

    // And coming back does not carry the second person's view onto the first either.
    await userEvent.click(container.querySelector('[data-carousel="previous"]') as HTMLElement);
    slide = await slideOn(container);
    expect(slide.getAttribute('data-slide')).toBe(set.slides[0]?.sessionId);
    expect(viewButton(container, 'heat').getAttribute('data-state')).toBe('on');
  });

  it('announces which person a reader is on', async () => {
    const set = committedSet();
    const { container } = landing();
    await carousel(container);

    const status = [...container.querySelectorAll('[role="status"]')].find((one) =>
      one.textContent?.includes('person 1 of'),
    );
    expect(status?.textContent).toBe(
      `${set.slides[0]?.person.name ?? ''}, person 1 of ${set.slides.length}`,
    );

    await userEvent.click(container.querySelector('[data-carousel="next"]') as HTMLElement);
    await waitFor(() => {
      expect(
        [...container.querySelectorAll('[role="status"]')].some((one) =>
          one.textContent?.includes(`${set.slides[1]?.person.name ?? ''}, person 2 of`),
        ),
      ).toBe(true);
    });
  });
});

describe('motion', () => {
  it('renders the first slide complete and still, and never advances on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const set = committedSet();
      const { container } = landing();
      const slide = await slideOn(container);

      // Complete on the first frame it is drawn: the heat is simply there, not warming up.
      expect(slide.querySelector('[data-overlay-layer="heat"] [data-heat-step]')).not.toBeNull();
      expect(slide.querySelector('[data-moment="heat"]')).toBeNull();

      // Nothing on this page is on a timer, at any motion setting.
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await slideOn(container)).getAttribute('data-slide')).toBe(set.slides[0]?.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes slides without sliding: the carousel declares no animation of its own', () => {
    const source = readFileSync(join(here, 'runCarousel.module.css'), 'utf8');
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(stripped).not.toMatch(/\banimation\b/);
    expect(stripped).not.toMatch(/\btransition\b/);
    expect(stripped).not.toMatch(/@keyframes/);
    expect(stripped).not.toMatch(/\btranslate/);
  });
});

describe('when the slide set cannot be read', () => {
  it('says so in one quiet line, and never draws a broken frame', async () => {
    served = 'this is not a slide set';
    const { container } = landing();

    const line = await waitFor(() => {
      const found = [...container.querySelectorAll('p')].find((one) =>
        one.textContent?.includes('could not be read just now'),
      );
      if (found === undefined) throw new Error('no line yet');
      return found;
    });

    expect(line.textContent).toContain('The people from this test could not be read');
    const section = container.querySelector('[data-section="landing-carousel"]') as HTMLElement;
    expect(section.querySelector('[data-slide]')).toBeNull();
    expect(section.querySelector('[data-frame]')).toBeNull();
    expect(section.querySelector('img')).toBeNull();
  });

  it('refuses a set that has drifted from the contract rather than rendering half a person', async () => {
    const set = committedSet();
    // `landingSlidesSchema` is `strictObject`, so a field nobody declared is a refusal.
    served = JSON.stringify({ ...set, invented: true });
    const { container } = landing();

    await waitFor(() => {
      const found = [...container.querySelectorAll('p')].find((one) =>
        one.textContent?.includes('could not be read just now'),
      );
      if (found === undefined) throw new Error('no line yet');
      return found;
    });
    expect(container.querySelector('[data-slide]')).toBeNull();
  });
});

describe('a 390px window', () => {
  let rule: (selectors: string | string[], condition?: string) => Record<string, string>;

  beforeEach(() => {
    const rules: Rule[] = rulesOf(readFileSync(join(here, 'runCarousel.module.css'), 'utf8'));
    rule = ruleIn(rules);
  });

  it('stacks the four parts rather than squashing them', () => {
    // Two columns at desktop width, the stage beside the three columns of prose.
    expect(rule('.slide')['grid-template-columns']).toBe('minmax(0, 2fr) minmax(0, 3fr)');
    expect(rule('.slide', '(max-width: 1000px)')['grid-template-columns']).toBe('minmax(0, 1fr)');
    // In the order the four parts are read in.
    expect(rule('.slide', '(max-width: 1000px)')['grid-template-areas']).toContain('who');
    expect(rule('.slide', '(max-width: 1000px)')['grid-template-areas']).toContain('ended');
  });

  it('keeps the phone frame inside the column rather than overflowing it', () => {
    // The frame is the column's width and no wider; the component caps it at the
    // persona's own viewport on top of that.
    expect(rule('.frame')['width']).toBe('100%');
    expect(rule('.frame')['overflow']).toBe('hidden');
    // Every track is floored at zero, so a long label wraps inside the slide rather than
    // widening it — which is what makes the page work at 390px.
    expect(rule('.trait', '(max-width: 640px)')['grid-template-columns']).toBe('minmax(0, 1fr)');
    expect(rule('.area')['grid-template-columns']).toBe('minmax(0, 1fr) auto');
    expect(rule('.controls')['flex-wrap']).toBe('wrap');
    // The mat gives the frame more of the column back at phone width.
    expect(rule('.mat', '(max-width: 640px)')['padding']).toBe('var(--space-2)');
  });
});
