import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, TouchEvent } from 'react';
import { Link } from 'react-router';
import type { LandingSlide, LandingSlides } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  elapsedSeconds,
  isNeverFixated,
  lookedAtShare,
  neverFixatedLabel,
} from '@/screens/attention/attentionWording';
import type { AttentionArea } from '@/screens/attention/useAttentionAreas';
import { AoiOutlineLayer } from '@/screens/attention/stage/AoiOutlineLayer';
import { HeatKey, HeatmapLayer } from '@/screens/attention/stage/HeatmapLayer';
import type { OverlayLayerProps } from '@/screens/attention/stage/overlayLayers';
import type { Transform } from '@/screens/attention/stage/overlayTransform';
import { NO_AGGREGATE } from '@/screens/attention/useScreenFigures';
import { ClickOverlay } from '@/screens/replay/ClickOverlay';
import { GazeOverlay } from '@/screens/replay/GazeOverlay';
import type { ClickMark, GazeTrail } from '@/screens/replay/position';
import { outcomeWords } from '@/session/index.js';
import { paths } from '@/shell/paths';
import { screenshotBase } from './slideSets';
import type { SlideScreenshots } from './slideSets';
import { useLandingSlides } from './useLandingSlides';
import styles from './runCarousel.module.css';

/**
 * The carousel of agent runs on the front page: who they are, what they did, what they
 * thought, how it ended (#428).
 *
 * One slide is one generated person on one screen of one real session, read from #427's
 * committed slide set through `packages/contract`. **No figure, name or sentence on a slide
 * is written into this file.** The names, the ages, the trait values, the device, the
 * screenshot, every fixation, every area's dwell and share, both sentences the agent wrote
 * and the outcome with its reason are all the artifact's; what is written here is the layout
 * they are arranged in and the words that label them.
 *
 * **Nothing here draws attention, converts a coordinate or accumulates heat.** The three
 * views are existing layers, mounted as they are:
 *
 * - *Heatmap* is #71's `HeatmapLayer` over this person's own fixations, weighted by dwell.
 *   It is mounted bare rather than inside #125's `Warming`, so the heat is simply there on
 *   first paint — which is what this page's reduced-motion rule asks for and what every
 *   other visitor sees too, because nothing on this page animates.
 * - *Areas of interest* is #73's `AoiOutlineLayer` over the named areas the slide carries,
 *   with the stored dwell and share listed beside it in words.
 * - *Path* is the **replay's** own per-session trace: `GazeOverlay` and `ClickOverlay` over
 *   this person's fixations, saccades and clicks. The Attention screen's `ScanpathLayer` is
 *   deliberately not used, and that is decision 180: it draws a median over *areas* across
 *   the whole audience, numbered by median time to first fixation, and this slide is about
 *   one person — its marks could carry no fixation number for a thought to be tied to. The
 *   per-session trace already existed, on the Session replay, and is imported from there.
 *
 * The two coordinate bases stay apart as `docs/FLOW.md` keeps them. The overlay layers are
 * given the capture's page box, so they draw through `overlayTransform` exactly as on the
 * Attention screen. The replay's two overlays are placed as percentages of the same box —
 * the whole captured page here, rather than the replay's one scrolled viewport, which is why
 * no `scrollY` comes off a placement below.
 *
 * **It never moves on its own**, at any motion setting: there is no timer, no autoplay and no
 * slide transition, so the first slide is complete and still on first paint and a slide
 * change is a swap. The slide a reader is on is announced, the dots are a real tab list, and
 * only the current slide is mounted — so the slides nobody is looking at are not in the tab
 * order by construction.
 */

/** The three views, in the owner's words and in this codebase's existing vocabulary. */
const VIEWS = [
  {
    id: 'heat',
    label: 'Heatmap',
    /** What the picture is, for the stage's text alternative. */
    drawn: 'their fixations, weighted by how long each one held',
  },
  {
    id: 'aoi',
    label: 'Areas of interest',
    drawn: 'the areas this test named on the page, each outlined',
  },
  {
    id: 'path',
    label: 'Path',
    drawn: 'their fixations numbered in the order they happened, with the moves between them',
  },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

const DEFAULT_VIEW: ViewId = 'heat';

/** How far a finger has to travel across the stage before it counts as a swipe. */
const SWIPE_PX = 40;

/**
 * The traits a slide may show, each under the name a reader knows it by.
 *
 * Every key `personaTraitsSchema` declares is here, because which third trait a slide
 * carries is the slide set's choice (#427) and a key with no word would print a field name
 * on the front page. *Tech confidence* is `interfaceFamiliarity` under the owner's own name
 * for it; **price sensitivity is not in this list**, because it is the audience's and no
 * person's (decision 178) and is stated once on the set's own line above the slides.
 */
const TRAIT_WORDS: Readonly<Record<LandingSlide['person']['traits'][number]['key'], string>> = {
  interfaceFamiliarity: 'tech confidence',
  patience: 'patience',
  persistence: 'persistence',
  scanningVsReading: 'scanning over reading',
  detailOrientation: 'detail',
  riskTolerance: 'risk tolerance',
};

/**
 * How a session ended, in the product's own words for this page.
 *
 * The status and its colour token come from the session vocabulary (#20), so an outcome
 * gains a colour in `docs/design/tokens.css` and never here, and the three other statuses
 * take the vocabulary's own label rather than a copy of it. Only `abandoned`'s word is
 * overridden: this page states it as **gave up**, which is what the score cards, the
 * segments table and the Sessions list already print it as, and what the ticket's own line
 * asks for. The four are never folded into one bucket; `automation_failure` therefore still
 * reads as itself, because no slide in the committed set is one — our own breakage is not a
 * person's behaviour — and a set that held one would say so plainly rather than dress it as
 * a result.
 */
const outcomeWord = (status: LandingSlide['outcome']['status']): string =>
  status === 'abandoned' ? 'Gave up' : outcomeWords(status).label;

/** `iPhone 15 · 390 × 844`, as every other screenshot in the product is labelled. */
const deviceLabel = (device: LandingSlide['person']['device']): string =>
  `${device.name} · ${device.viewport.width} × ${device.viewport.height}`;

/**
 * Which version and step the slide's page is, in the artifact's own words, built once for
 * the two places that name it: the device label above the frame and the stage's own
 * alternative under it.
 *
 * Read off the areas, which carry both: a slide holds no run to look a step's label up in,
 * so what the page says is the run's own `A` and `review` rather than a word invented here.
 * `null` for a slide whose screen had no area of interest at all, and then the sentences
 * below say what is drawn without naming a screen they cannot name.
 */
const screenWords = (slide: LandingSlide): string | null => {
  const first = slide.areas[0];
  return first === undefined ? null : `the ${first.step} step of ${first.variant}`;
};

/** The capture's page box: what every layer draws against (`overlayTransform`). */
const transformOf = (slide: LandingSlide): Transform => ({
  pageWidth: slide.screenshot.viewport.width,
  pageHeight: slide.screenshot.pageHeight,
});

/** One area of a slide, with the `aoiMetrics` row #427 nested inside it. */
type SlideArea = LandingSlide['areas'][number];

/**
 * One slide area in the shape the Attention screen's layers take.
 *
 * `{ aoi, metric }` is `AttentionArea`, and both halves are copies: the area is the slide's
 * own row minus the metrics nested inside it, and the metric is that nested row with the
 * `aoiId` the area already carries put back on, which is the one field #427 leaves out
 * because a slide states nothing twice. The metric is therefore **never** `null` here, which
 * is why the list below reads `area.metrics` rather than going back through this shape and
 * handling an absence that cannot arise.
 */
const asAttentionArea = ({ metrics, ...aoi }: SlideArea): AttentionArea => ({
  aoi,
  metric: { aoiId: aoi.id, ...metrics },
});

/**
 * Whether this test has a name for the area, rather than only a kind.
 *
 * The pipeline labels an area from the page and falls back to its accessibility role where
 * the element carries no accessible name — `label: "generic"` beside `role: "generic"` — so
 * a page of thirty boxes is mostly structure. The *Areas of interest* view outlines and
 * lists the named ones, which is the same rule the Verdict screen's caption uses to decide
 * what a sentence may name; the count of the rest is stated under the list rather than left
 * out.
 */
const isNamed = (area: SlideArea): boolean => area.label !== area.role;

/** The named areas, longest dwell first: the order a reader of this list is asking for. */
const namedAreas = (slide: LandingSlide): readonly SlideArea[] =>
  slide.areas
    .filter(isNamed)
    .slice()
    .sort((one, other) => other.metrics.totalDwellMs - one.metrics.totalDwellMs);

/** How long this area held attention, or `never` where the run says none ever landed. */
const dwellWord = (metrics: SlideArea['metrics']): string =>
  isNeverFixated({ aoiId: '', ...metrics })
    ? neverFixatedLabel()
    : elapsedSeconds(metrics.totalDwellMs);

/**
 * This person's trace, in the shape the replay's gaze layer draws.
 *
 * Placed as a percentage of the **whole captured page**, which is the box the frame holds
 * here: the replay's frame is one viewport at one scroll offset, and this one is the page
 * the overlay layers beside it are registered to, so the two pictures of one screen cannot
 * come out of register with each other.
 *
 * A saccade is looked up by a fixation's own `index` rather than by a position in the list,
 * because a slide carries the fixations of one screen out of a session that numbered them
 * continuously — the first of them is fixation 18, not fixation 0.
 */
const trailOf = (slide: LandingSlide): GazeTrail => {
  const { viewport, pageHeight } = slide.screenshot;
  const place = (fixation: LandingSlide['fixations'][number]) => ({
    xPct: viewport.width > 0 ? (fixation.pageX / viewport.width) * 100 : 0,
    yPct: pageHeight > 0 ? (fixation.pageY / pageHeight) * 100 : 0,
  });
  const byIndex = new Map(slide.fixations.map((fixation) => [fixation.index, fixation]));

  return {
    // `current` is false throughout: the replay marks the fixation its scrubber is on, and
    // this stage has no scrubber, so no mark wears the current colour.
    marks: slide.fixations.map((fixation) => ({
      number: fixationNumber(fixation.index),
      ...place(fixation),
      durationMs: fixation.durationMs,
      current: false,
    })),
    hops: slide.saccades.flatMap((saccade) => {
      const from = byIndex.get(saccade.fromFixation);
      const to = byIndex.get(saccade.toFixation);
      if (from === undefined || to === undefined) return [];
      const start = place(from);
      const end = place(to);
      return [
        {
          fromNumber: fixationNumber(from.index),
          toNumber: fixationNumber(to.index),
          fromXPct: start.xPct,
          fromYPct: start.yPct,
          toXPct: end.xPct,
          toYPct: end.yPct,
        },
      ];
    }),
  };
};

/**
 * What a fixation is called on screen: its `index` plus one, which is the replay's own
 * numbering and the unit its scrubber counts in (*fixation 21 of 29*). A thought carries the
 * `index` the session gave it, so a thought and the marker it belongs to are the same number
 * by construction rather than by a second rule written here.
 */
const fixationNumber = (index: number): number => index + 1;

/**
 * Where this person pressed, in the replay's own marks.
 *
 * **A click carries no coordinates**: the session records the area it was aimed at, and the
 * run records where that area is, so a mark is the centre of that area's own box — the
 * honest placement, as the replay states it. A click whose area this slide does not carry
 * draws nothing; the outcome and the thought beside it still say what happened.
 */
const clickMarksOf = (slide: LandingSlide): readonly ClickMark[] => {
  const boxes = new Map(slide.areas.map((area) => [area.id, area.bbox]));
  const { viewport, pageHeight } = slide.screenshot;

  return slide.clicks.flatMap((click, index) => {
    const bbox = boxes.get(click.aoiId);
    if (bbox === undefined || viewport.width <= 0 || pageHeight <= 0) return [];
    const xPct = ((bbox.x + bbox.width / 2) / viewport.width) * 100;
    const yPct = ((bbox.y + bbox.height / 2) / pageHeight) * 100;
    if (xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) return [];
    return [{ index, xPct, yPct, label: click.target ?? click.aoiId, current: false }];
  });
};

/** The two sentences the agent wrote on this screen, each with the fixation it sits at. */
const thoughtsOf = (slide: LandingSlide) =>
  (['intent', 'decidedAction'] as const).flatMap((which) => {
    const thought = slide.thoughts[which];
    return thought === undefined ? [] : [{ which, ...thought }];
  });

export function RunCarousel() {
  const state = useLandingSlides();

  // The section reserves its space from the first frame, so the page below it does not jump
  // when the slide set arrives — which is what makes this page complete and still on first
  // paint rather than merely still.
  if (state.status === 'loading') {
    return (
      <section className={styles.section} data-section="landing-carousel" aria-busy="true">
        <Skeleton className={styles.waiting} />
      </section>
    );
  }

  // The slide set is committed, so there is no empty state — only an unreadable one, and it
  // is one quiet line in the section's place, exactly as the evidence band above says it.
  if (state.status === 'unreadable') {
    return (
      <section className={styles.section} data-section="landing-carousel">
        <p className={styles.unavailable}>
          The people from this test could not be read just now, so they are not on this page &mdash;
          every person here is a test&rsquo;s own or they are not shown.
        </p>
      </section>
    );
  }

  return <Carousel set={state.set} screenshots={state.screenshots} />;
}

function Carousel({ set, screenshots }: { set: LandingSlides; screenshots: SlideScreenshots }) {
  const [at, setAt] = useState(0);
  const headingId = useId();
  const panelId = useId();
  const tabsId = useId();
  const touchX = useRef<number | null>(null);

  const total = set.slides.length;
  const slide = set.slides[at] as LandingSlide;
  const tabId = (index: number): string => `${tabsId}-${index}`;

  const go = useCallback(
    (index: number) => {
      setAt(Math.min(Math.max(index, 0), total - 1));
    },
    [total],
  );

  /**
   * The arrow keys, for the whole carousel rather than for one control in it.
   *
   * It reads the event on the way up, so a reader whose focus is on the dots, on either
   * button or on the view switch can move between people without first tabbing to a
   * particular control. A control that has already handled the key — the dots below, and
   * Radix's own roving focus inside the view switch — calls `preventDefault`, and this
   * leaves those alone rather than moving two steps at once.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(at - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(at + 1);
    }
  };

  /** The dots are a tab list, so they move selection and focus together, as tabs do. */
  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next =
      event.key === 'ArrowLeft'
        ? at - 1
        : event.key === 'ArrowRight'
          ? at + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? total - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const moved = Math.min(Math.max(next, 0), total - 1);
    go(moved);
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(moved))}`)
      ?.focus();
  };

  return (
    <section
      className={styles.section}
      data-section="landing-carousel"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
    >
      <h2 className={styles.heading} id={headingId}>
        The people this test generated, one at a time
      </h2>

      {/* The task once, above the slides: every person in a set was asked the same thing,
          which is what makes the differences between them the point. The audience's price
          sensitivity is on this line too, labelled as the audience's — it is a reading of
          the audience and not a number the run holds about any one of them (decision 178). */}
      <p className={styles.task}>
        Every one of them was asked: <q>{set.task}</q>
      </p>
      <p className="microlabel" data-carousel-audience>
        {set.audience.name} &middot; price sensitivity {set.audience.priceSensitivity.toFixed(2)}{' '}
        &mdash; the audience&rsquo;s, not one person&rsquo;s
      </p>

      <div className={styles.controls}>
        <Button
          variant="outline"
          size="sm"
          // The visible word is part of the accessible name, which is what keeps the
          // arrow a decoration rather than a glyph read out in place of a word.
          aria-label="Previous person"
          disabled={at === 0}
          data-carousel="previous"
          onClick={() => go(at - 1)}
        >
          <span aria-hidden="true">&larr;</span> Previous
        </Button>

        <div
          role="tablist"
          aria-label="The people in this test"
          className={styles.dots}
          aria-orientation="horizontal"
        >
          {set.slides.map((one, index) => (
            <button
              key={`${one.sessionId}-${one.screenIndex}`}
              type="button"
              role="tab"
              id={tabId(index)}
              className={styles.dot}
              aria-controls={panelId}
              aria-selected={index === at}
              aria-label={`${one.person.name}, ${index + 1} of ${total}`}
              tabIndex={index === at ? 0 : -1}
              data-dot={index}
              onClick={() => go(index)}
              onKeyDown={onTabKeyDown}
            />
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          aria-label="Next person"
          disabled={at === total - 1}
          data-carousel="next"
          onClick={() => go(at + 1)}
        >
          Next <span aria-hidden="true">&rarr;</span>
        </Button>
      </div>

      {/* Which person a reader is on, for somebody who cannot see which dot is filled. */}
      <p className="sr-only" role="status">
        {`${slide.person.name}, person ${at + 1} of ${total}`}
      </p>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(at)}
        className={styles.panel}
        // A swipe on a touch device, which is the other half of the arrow keys. The
        // threshold keeps a tap on the screenshot from counting as one.
        onTouchStart={(event: TouchEvent<HTMLElement>) => {
          touchX.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event: TouchEvent<HTMLElement>) => {
          const from = touchX.current;
          const to = event.changedTouches[0]?.clientX ?? null;
          touchX.current = null;
          if (from === null || to === null || Math.abs(to - from) < SWIPE_PX) return;
          go(to < from ? at + 1 : at - 1);
        }}
      >
        {/* Keyed by the slide, so moving to another person mounts a new `Slide` and the
            view switch starts at the default again: the switch is **per slide**, which it
            would not be if React reused this position's state across a slide change. The
            key is the session and the screen together, as the dots' is, because a set may
            hold two screens of one session. */}
        <Slide
          key={`${slide.sessionId}-${slide.screenIndex}`}
          slide={slide}
          screenshots={screenshots}
        />
      </div>
    </section>
  );
}

/** One person: who they are, what they did, what they thought, how it ended. */
function Slide({ slide, screenshots }: { slide: LandingSlide; screenshots: SlideScreenshots }) {
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW);
  const { person } = slide;
  const onWhat = screenWords(slide) ?? 'this page';
  const named = useMemo(() => namedAreas(slide), [slide]);
  const unnamed = slide.areas.length - named.length;
  // The layer is handed the areas of whichever view is drawn: the outlines view is about
  // the areas this test can name, and the heat is about where this person looked.
  const forLayer = useMemo(
    () => (view === 'aoi' ? named : slide.areas).map(asAttentionArea),
    [view, named, slide.areas],
  );
  const thoughts = thoughtsOf(slide);
  const outcome = outcomeWords(slide.outcome.status);
  const transform = transformOf(slide);

  // The artifact's own `path`, resolved against wherever this set's captures live — the
  // run-data mount for a run committed under `runs/`, this app's own assets for a run that is
  // not (`slideSets.ts`, #429). Either way the only host asked is this one, never a third
  // party's.
  const screenshotUrl = new URL(
    slide.screenshot.path,
    new URL(screenshotBase(screenshots, slide.runId), window.location.href),
  ).toString();

  /** What every layer is given. `NO_AGGREGATE` is honest: a slide has no aggregate. */
  const layerProps: OverlayLayerProps = {
    fixations: slide.fixations,
    saccades: slide.saccades,
    areas: forLayer,
    isolatedAoiId: null,
    transform,
    screen: NO_AGGREGATE,
    loading: false,
  };

  const drawn = VIEWS.find((one) => one.id === view)?.drawn ?? '';

  return (
    <article className={styles.slide} data-slide={slide.sessionId}>
      {/* ---- 1. Who they are ------------------------------------------------- */}
      <div className={styles.who}>
        <h3 className={styles.name}>{person.name}</h3>
        <p className={styles.role}>
          {/* Nothing where the run recorded no age: a generated persona mostly carries
              none, and an absent age is not a placeholder to print. */}
          {person.ageYears === undefined ? null : <span data-person-age>{person.ageYears}, </span>}
          <span data-person-segment>{person.segment}</span>
        </p>

        <dl className={styles.traits}>
          {person.traits.map((trait) => (
            <div className={styles.trait} key={trait.key} data-trait={trait.key}>
              <dt>{TRAIT_WORDS[trait.key]}</dt>
              <dd>
                {/* The track is a picture of the value beside it, so it is `aria-hidden`:
                    the number is the reading, and a bar read out as "0.76 of 1" twice is
                    noise. The width is the artifact's own value and so is set inline. */}
                <span
                  className={styles.track}
                  aria-hidden="true"
                  style={{ '--trait-value': trait.value } as CSSProperties}
                />
                <b className="num">{trait.value.toFixed(2)}</b>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ---- 2. What they did ------------------------------------------------ */}
      <div className={styles.stage}>
        <p className="microlabel" data-device>
          {deviceLabel(person.device)}
          {screenWords(slide) === null ? '' : ` \u00b7 ${onWhat}`}
        </p>

        <ToggleGroup
          type="single"
          value={view}
          aria-label={`What to draw on ${person.name}\u2019s screen`}
          className={styles.views}
          onValueChange={(next) => {
            // Radix sends '' when the pressed item is pressed again. One view is always
            // drawn, so that is not a state this control has.
            if (next !== '') setView(next as ViewId);
          }}
        >
          {VIEWS.map((one) => (
            <ToggleGroupItem key={one.id} value={one.id} data-view={one.id}>
              {one.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <figure className={styles.figure}>
          {/* The device, drawn as that frame: a touch device is a phone \u2014 a dark shell
              around the page, capped at the persona's own viewport width \u2014 and a desktop
              one lies on a plain mat. Which it is, is the person's `device.touch` and not
              the capture's shape, because the capture of this run is 390 wide for every
              person in it and the device is what the slide is telling the reader about. */}
          <div className={styles.mat} data-frame={person.device.touch ? 'phone' : 'mat'}>
            <div
              className={styles.frame}
              // The box is the capture's own: both figures are known before the image
              // decodes, which is what keeps the slide from moving when it arrives, and the
              // page the overlays are registered to is exactly the page in the picture.
              style={{
                aspectRatio: `${slide.screenshot.viewport.width} / ${slide.screenshot.pageHeight}`,
                maxWidth: person.device.touch
                  ? `min(100%, ${person.device.viewport.width}px)`
                  : `min(100%, ${slide.screenshot.viewport.width}px)`,
              }}
            >
              <div className={styles.page}>
                <img
                  src={screenshotUrl}
                  alt={`${onWhat}, as ${person.name} saw it`}
                  loading="lazy"
                  decoding="async"
                />
              </div>

              {view === 'heat' ? <HeatmapLayer {...layerProps} /> : null}
              {view === 'aoi' ? <AoiOutlineLayer {...layerProps} /> : null}
              {view === 'path' ? (
                <>
                  <GazeOverlay trail={trailOf(slide)} />
                  <ClickOverlay marks={clickMarksOf(slide)} />
                </>
              ) : null}
            </div>
          </div>

          {/* The stage's text alternative: what is drawn, and on whose screen. Every layer
              above is `aria-hidden`, as it is on the Attention screen, because a drawing of
              where somebody looked cannot be read out \u2014 so this caption, and the list and
              the thoughts under it, are what carry the same content in words. A
              `figcaption` is the figure's own description, which is how the Verdict screen
              gives its heatmap one too. */}
          <figcaption className={styles.caption} data-stage-alt={view}>
            {`On ${onWhat}: ${drawn}.`}
            {/* The heat key: the ramp the colours on the page are read against, which is
                the layer's own legend and the one the Attention screen puts under the same
                overlay's switch. It is mounted only while the heat is actually drawn, so it
                is never a ramp for a page with no heat on it. */}
            {view === 'heat' ? <HeatKey /> : null}
          </figcaption>
        </figure>

        {view === 'aoi' ? (
          <>
            {/* A capped, scrolling list, so it is **focusable and named**: a reader
                without a pointer has no other way to move down a list taller than its box
                (WCAG 2.1.1), which is the same reason the Attention screen's own frame is a
                named `group` with a tab stop. */}
            <dl
              className={styles.areas}
              data-areas
              role="group"
              aria-label={`Every area this test named on ${onWhat}, with its dwell and the share who looked, scrollable`}
              tabIndex={0}
            >
              {named.map((area) => (
                <div key={area.id} className={styles.area} data-area={area.id}>
                  <dt>{area.label}</dt>
                  <dd>
                    <span data-area-dwell>{dwellWord(area.metrics)}</span>{' '}
                    <span className={styles.areaShare} data-area-share>
                      {lookedAtShare(area.metrics.lookedAtShare)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="footnote">
              Dwell and the share who looked are this test&rsquo;s own figures for the whole
              audience, not this person&rsquo;s.{' '}
              {unnamed === 0
                ? ''
                : `${unnamed} more areas on this page carry no name of their own and are left off this list.`}
            </p>
          </>
        ) : null}
      </div>

      {/* ---- 3. What they thought -------------------------------------------- */}
      <div className={styles.thinking}>
        <p className="microlabel">What they thought</p>
        {thoughts.length === 0 ? (
          <p className={styles.noThought}>
            This person wrote no sentence on this screen, so there is nothing of theirs to quote
            here.
          </p>
        ) : (
          <ol className={styles.thoughts}>
            {thoughts.map((thought) => (
              <li
                key={thought.which}
                className={styles.thought}
                data-thought={thought.which}
                data-fixation-number={fixationNumber(thought.fixationIndex)}
              >
                {/* The tie to the drawing is a shared number: this is the number the Path
                    view's marker carries, because both are the session's own fixation index
                    plus one. The sentence itself is printed and never parsed or rephrased. */}
                <span className={styles.pin} aria-hidden="true">
                  {fixationNumber(thought.fixationIndex)}
                </span>
                <q>{thought.text}</q>
                <span className="sr-only">
                  {` — at fixation ${fixationNumber(thought.fixationIndex)}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* ---- 4. How it ended ------------------------------------------------- */}
      <div className={styles.ended} data-outcome={slide.outcome.status}>
        <p className={styles.outcome}>
          {/* The outcome's own colour token, read from the session vocabulary rather than
              written here, so the word and the colour cannot disagree. */}
          <b style={{ color: `var(${outcome.token})` }}>{outcomeWord(slide.outcome.status)}</b> at
          the {slide.outcome.step} step
        </p>
        <p className={styles.reason}>{slide.outcome.reason}</p>
        <Link className={styles.replay} to={paths.session(slide.runId, slide.sessionId)}>
          Watch {person.name}&rsquo;s session &rarr;
        </Link>
      </div>
    </article>
  );
}
