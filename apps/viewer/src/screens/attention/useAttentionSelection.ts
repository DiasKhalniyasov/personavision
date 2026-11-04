import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { HEATMAP_OVERLAYS } from '@personavision/contract';
import type { Run } from '@personavision/contract';
import { AOI_PARAM, OUTCOME_PARAM, SEGMENT_PARAM } from '@/screens/sessions/filters';
import { paths } from '@/shell/paths';
import { useCurrentRunId, useOptionalRun } from '@/shell/useRun';

/**
 * What the Attention screen is looking at: **the URL, and nothing else**.
 *
 * `/runs/:runId/attention/:variant/:step?aoi=&overlay=&segment=&outcome=` carries the whole
 * selection, so the screen holds no state a reload would lose, a view is a link, and a
 * recommendation that names a version, a step, an area, an overlay and the people it is
 * about hands the designer exactly that view (`docs/FLOW.md` sections 3 and 14.4).
 *
 * **Which overlays are drawn is part of it** (decision 134). On the Attention screen this
 * replaces, the overlay switches were the one piece of state kept out of the URL; here the
 * overlay is a thing a citation names — *"heatmap · waiting · progress area"* — so the strip
 * above the stage and the switches in the Overlays panel are two renderings of one state and
 * that state is `?overlay=`, written once per overlay drawn. Writing it **replaces** the
 * history entry rather than pushing one, so a reader flicking between overlays does not have
 * to walk back through the flicks to leave the screen.
 * Every part of this screen — the version switch, the filmstrip, the stage, the areas
 * table, the isolate caption — reads and writes the selection through here, so there is one
 * answer to "what is on screen" and one place that changes it.
 *
 * What the URL asks for is checked against the run before it is used. A version this test
 * never ran, a step it has no screen for, an `?aoi=` naming no area of this version's step:
 * each falls back to a stated default and `fallback` carries the sentence the screen prints,
 * naming what was asked for and what is shown instead. The URL itself is left exactly as it
 * came — a fallback that rewrote it would erase the question it is answering, and reloading
 * the same link would then show a different screen.
 */

/** One area of interest, as `run.json`'s `aois` records it. */
type Aoi = Run['aois'][number];

/** Which of the three overlays, as the contract's own closed list spells them. */
export type HeatmapOverlay = (typeof HEATMAP_OVERLAYS)[number];

/**
 * `?overlay=`, repeated once per overlay drawn.
 *
 * The name is the contract's (`EVIDENCE_LINK_PARAMS`), and `heatmapLink` writes exactly one
 * of them for a citation — which opens the screen on that overlay and no other. The screen
 * writes as many as the reader has on.
 */
export const OVERLAY_PARAM = 'overlay';

/**
 * What the screen opens on when the URL names no overlay: the clicks, which is the overlay
 * `#screen-heatmaps` draws pressed and the one the screen's own question is about — *where
 * did the people who failed click?*
 */
export const DEFAULT_OVERLAYS: readonly HeatmapOverlay[] = ['clicks'];

/** Whether a word is one of the three overlays, and not a fourth somebody invented. */
const isOverlay = (value: string): value is HeatmapOverlay =>
  (HEATMAP_OVERLAYS as readonly string[]).includes(value);

/**
 * The overlays a URL asks for, in the registry's own order and each at most once.
 *
 * The order is **not** the order they were written in the query: two links that draw the
 * same overlays are the same view, and the order the layers stack in is the registry's
 * business rather than a reader's. Anything that is not one of the three is dropped, and
 * dropping all of them leaves the default rather than a page with nothing on it — a URL
 * asking for an overlay this product does not have is a bad link, not an instruction to
 * show nothing.
 */
export function resolveOverlays(asked: readonly string[]): {
  readonly overlays: readonly HeatmapOverlay[];
  readonly unknown: readonly string[];
} {
  const wanted = new Set(asked.filter(isOverlay));
  return {
    overlays: wanted.size === 0 ? DEFAULT_OVERLAYS : HEATMAP_OVERLAYS.filter((one) => wanted.has(one)),
    unknown: asked.filter((value) => !isOverlay(value)),
  };
}

export interface AttentionFallback {
  /** Which part of the selection could not be used as asked. */
  readonly what: 'variant' | 'step' | 'aoi' | 'overlay';
  /** What the URL asked for. */
  readonly given: string;
  /** What is shown instead; `null` when nothing is — an area that is simply dropped. */
  readonly used: string | null;
  /** The sentence the screen prints, in the reader's words. */
  readonly sentence: string;
}

export interface AttentionSelection {
  readonly runId: string;
  readonly variant: string;
  readonly step: string;
  /** The area of interest the screen isolates, or `null` for all of them. */
  readonly aoi: string | null;
  /** The overlays drawn, in the registry's order. Never empty. */
  readonly overlays: readonly HeatmapOverlay[];
  /** The audience segment the figures are narrowed to, or `null` for every segment. */
  readonly segment: string | null;
  /** The outcome the figures are narrowed to, or `null` for every outcome. */
  readonly outcome: string | null;
  /** Move to another version, keeping the step and the isolated area. */
  setVariant(variant: string): void;
  /** Move to another step. An isolated area belongs to a step, so this clears it. */
  setStep(step: string): void;
  /** Isolate one area of interest, or `null` to show all of them. */
  setAoi(aoi: string | null): void;
  /**
   * Draw exactly these overlays. Replaces the history entry rather than pushing one, so
   * that flicking between overlays does not fill the reader's Back button (decision 134).
   */
  setOverlays(overlays: readonly HeatmapOverlay[]): void;
  /** Narrow to one audience segment, or `null` for every segment. */
  setSegment(segment: string | null): void;
  /** Narrow to one outcome, or `null` for every outcome. */
  setOutcome(outcome: string | null): void;
  /** What could not be used as the URL asked, and what is shown instead. */
  readonly fallback: AttentionFallback | null;
}

/** What the URL asked for, before the run has had a word about it. */
export interface AskedSelection {
  readonly variant: string;
  readonly step: string;
  readonly aoi: string | null;
  /** Every `?overlay=` the URL carries, in the order it carries them. */
  readonly overlays?: readonly string[];
}

export interface ResolvedSelection extends Omit<AskedSelection, 'overlays'> {
  readonly overlays: readonly HeatmapOverlay[];
  readonly fallback: AttentionFallback | null;
}

/**
 * The one area of this version's step that carries a label, when exactly one does.
 *
 * An area of interest belongs to **one version**: the same control on A and on B is two
 * rows in `aois` with two ids, because its box and its numbers differ. Its label is the
 * name the artifact gives the same thing on both, so it is what carries an isolated area
 * across the version switch. Two areas of one step sharing a label would make the match a
 * guess, and a guess is not made: there is then no counterpart.
 */
const counterpartOf = (run: Run, variant: string, step: string, label: string): Aoi | null => {
  const matching = run.aois.filter(
    (candidate) =>
      candidate.variant === variant && candidate.step === step && candidate.label === label,
  );
  return matching.length === 1 ? (matching[0] as Aoi) : null;
};

/** What a version is called in a sentence: the name the test gave it, not its id. */
const versionName = (run: Run, variant: string): string =>
  run.variants.find((candidate) => candidate.id === variant)?.name ?? variant;

/** What a step is called in a sentence: the label the test gave it, not its id. */
const stepLabel = (run: Run, step: string): string =>
  run.steps.find((candidate) => candidate.id === step)?.label ?? step;

/**
 * The selection the screen shows, from the selection the URL asked for.
 *
 * Pure, and exported so that the fallbacks can be read without a router. `run` is `null`
 * while the run is still being read: nothing can be checked yet, so the URL's own values
 * are passed through and no fallback is claimed.
 *
 * The three are resolved in order — a step is checked against the version that is actually
 * shown, and an area against that version and step — and the **first** thing that could not
 * be used is the one the screen states. A URL that is wrong twice is one bad link, and the
 * version is the part that changes the most about what the reader is looking at.
 */
export function resolveSelection(run: Run | null, asked: AskedSelection): ResolvedSelection {
  // The overlays are checked against the contract's own list and not against the run, so
  // they resolve whether or not the run has arrived: a link naming a fourth overlay is a bad
  // link at any time.
  const asking = resolveOverlays(asked.overlays ?? []);
  const overlayFallback: AttentionFallback | null =
    asking.unknown.length === 0
      ? null
      : {
          what: 'overlay',
          given: asking.unknown.join(', '),
          used: asking.overlays.join(', '),
          sentence: `This screen has no overlay ${asking.unknown.map((one) => `“${one}”`).join(' or ')}. Showing ${asking.overlays.join(' and ')}.`,
        };

  if (run === null) {
    return { ...asked, overlays: asking.overlays, fallback: overlayFallback };
  }

  let fallback: AttentionFallback | null = overlayFallback;

  // `runSchema` holds `variants` and `steps` to at least one entry each, so both defaults
  // exist for every run that parsed.
  const firstVariant = run.variants[0] as Run['variants'][number];
  const firstStep = run.steps[0] as Run['steps'][number];

  let variant = asked.variant;
  if (!run.variants.some((candidate) => candidate.id === variant)) {
    variant = firstVariant.id;
    // The version is the part that changes the most about what the reader is looking at, so
    // it is the one stated even when the overlay was also wrong.
    fallback = {
      what: 'variant',
      given: asked.variant,
      used: variant,
      sentence: `This test has no version “${asked.variant}”. Showing ${firstVariant.name}, the first version it ran.`,
    };
  }

  let step = asked.step;
  if (!run.steps.some((candidate) => candidate.id === step)) {
    step = firstStep.id;
    fallback ??= {
      what: 'step',
      given: asked.step,
      used: step,
      sentence: `This test has no step “${asked.step}”. Showing ${firstStep.label}, the earliest step your audience reached.`,
    };
  }

  let aoi: string | null = null;
  if (asked.aoi !== null && asked.aoi !== '') {
    const here = run.aois.find(
      (candidate) =>
        candidate.id === asked.aoi && candidate.variant === variant && candidate.step === step,
    );
    if (here !== undefined) {
      aoi = here.id;
    } else {
      // The area may be this step's on the *other* version — which is what arriving from a
      // finding on A and switching to B looks like. The same area on this version is then
      // what the reader asked to see, so it is what is isolated.
      const elsewhere = run.aois.find((candidate) => candidate.id === asked.aoi);
      const counterpart =
        elsewhere !== undefined && elsewhere.step === step
          ? counterpartOf(run, variant, step, elsewhere.label)
          : null;
      if (counterpart !== null) {
        aoi = counterpart.id;
        fallback ??= {
          what: 'aoi',
          given: asked.aoi,
          used: counterpart.id,
          sentence: `“${counterpart.label}” is a different area on each version. Showing the one on ${versionName(run, variant)}.`,
        };
      } else {
        fallback ??= {
          what: 'aoi',
          given: asked.aoi,
          used: null,
          sentence: `There is no area “${asked.aoi}” on ${versionName(run, variant)} at the ${stepLabel(run, step)} step. Showing every area.`,
        };
      }
    }
  }

  return { variant, step, aoi, overlays: asking.overlays, fallback };
}

/**
 * The selection, read from the route and written back to it.
 *
 * It takes nothing: the route is the argument. The run it checks the selection against is
 * the shell's single read of it (`useRun`), so this adds no second read of `run.json`.
 */
export function useAttentionSelection(): AttentionSelection {
  const params = useParams();
  const [query, setQuery] = useSearchParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const state = useOptionalRun(useCurrentRunId());
  const run = state?.status === 'ready' ? state.run : null;

  const runId = params.runId ?? '';
  // The parts the selection is made of, taken one by one rather than as an object, so that
  // a render which changed none of them resolves to the result it resolved to before. The
  // overlays are joined into one string for the same reason: `getAll` answers a fresh array
  // every render, which as a dependency would re-resolve on every one of them.
  const askedVariant = params.variant ?? '';
  const askedStep = params.step ?? '';
  const askedAoi = query.get(AOI_PARAM);
  const askedOverlays = query.getAll(OVERLAY_PARAM).join('\u0000');
  // The two filters are narrowings and not names the run can check: which segments and
  // outcomes a figure exists for is the aggregate's business, and a composition it holds no
  // slice for is stated on the screen rather than silently replaced here (criterion:
  // "a filter composition no session satisfies renders a stated line"). An absent parameter
  // and an empty one are both "every": `?segment=` narrows nothing, which is not a filter.
  const segment = query.get(SEGMENT_PARAM) ?? '';
  const outcome = query.get(OUTCOME_PARAM) ?? '';
  const { variant, step, aoi, overlays, fallback } = useMemo(
    () =>
      resolveSelection(run, {
        variant: askedVariant,
        step: askedStep,
        aoi: askedAoi,
        overlays: askedOverlays === '' ? [] : askedOverlays.split('\u0000'),
      }),
    [run, askedVariant, askedStep, askedAoi, askedOverlays],
  );

  const setVariant = useCallback(
    (next: string) => {
      if (next === variant) return;
      // The query string travels verbatim: the isolated area is kept, and an area that
      // belongs to the version being left is resolved to this version's own on arrival.
      navigate({ pathname: paths.attention(runId, next, step), search });
    },
    [navigate, runId, search, step, variant],
  );

  const setStep = useCallback(
    (next: string) => {
      if (next === step) return;
      // No search: an area of interest belongs to a step, so moving step drops `?aoi=`
      // rather than carrying an area that is not on the step now being shown.
      navigate(paths.attention(runId, variant, next));
    },
    [navigate, runId, step, variant],
  );

  const setAoi = useCallback(
    (next: string | null) => {
      const written = new URLSearchParams(query);
      if (next === null) written.delete(AOI_PARAM);
      else written.set(AOI_PARAM, next);
      setQuery(written);
    },
    [query, setQuery],
  );

  const setOverlays = useCallback(
    (next: readonly HeatmapOverlay[]) => {
      const written = new URLSearchParams(query);
      written.delete(OVERLAY_PARAM);
      // In the registry's order, so that two readers who turned the same overlays on are at
      // the same URL however they got there.
      for (const one of HEATMAP_OVERLAYS) {
        if (next.includes(one)) written.append(OVERLAY_PARAM, one);
      }
      // Replace, not push: see decision 134. Flicking between overlays is reading, and
      // Back should leave the screen rather than retrace the flicks.
      setQuery(written, { replace: true });
    },
    [query, setQuery],
  );

  /** One filter written or cleared. Absent is "every", so clearing deletes the parameter. */
  const setFilter = useCallback(
    (param: string, next: string | null) => {
      const written = new URLSearchParams(query);
      if (next === null || next === '') written.delete(param);
      else written.set(param, next);
      setQuery(written);
    },
    [query, setQuery],
  );

  const setSegment = useCallback(
    (next: string | null) => {
      setFilter(SEGMENT_PARAM, next);
    },
    [setFilter],
  );

  const setOutcome = useCallback(
    (next: string | null) => {
      setFilter(OUTCOME_PARAM, next);
    },
    [setFilter],
  );

  return {
    runId,
    variant,
    step,
    aoi,
    overlays,
    segment: segment === '' ? null : segment,
    outcome: outcome === '' ? null : outcome,
    setVariant,
    setStep,
    setAoi,
    setOverlays,
    setSegment,
    setOutcome,
    fallback,
  };
}
