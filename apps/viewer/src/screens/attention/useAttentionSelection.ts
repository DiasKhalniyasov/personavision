import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Run } from '@personavision/contract';
import { AOI_PARAM } from '@/screens/sessions/filters';
import { paths } from '@/shell/paths';
import { useCurrentRunId, useOptionalRun } from '@/shell/useRun';

/**
 * What the Attention screen is looking at: **the URL, and nothing else**.
 *
 * `/runs/:runId/attention/:variant/:step?aoi=` carries the whole selection, so the screen
 * holds no state a reload would lose, a view is a link, and a finding that names a version,
 * a step and an area hands the designer exactly that view (`docs/FLOW.md` section 3).
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

export interface AttentionFallback {
  /** Which part of the selection could not be used as asked. */
  readonly what: 'variant' | 'step' | 'aoi';
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
  /** Move to another version, keeping the step and the isolated area. */
  setVariant(variant: string): void;
  /** Move to another step. An isolated area belongs to a step, so this clears it. */
  setStep(step: string): void;
  /** Isolate one area of interest, or `null` to show all of them. */
  setAoi(aoi: string | null): void;
  /** What could not be used as the URL asked, and what is shown instead. */
  readonly fallback: AttentionFallback | null;
}

/** What the URL asked for, before the run has had a word about it. */
export interface AskedSelection {
  readonly variant: string;
  readonly step: string;
  readonly aoi: string | null;
}

export interface ResolvedSelection extends AskedSelection {
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
  if (run === null) return { ...asked, fallback: null };

  let fallback: AttentionFallback | null = null;

  // `runSchema` holds `variants` and `steps` to at least one entry each, so both defaults
  // exist for every run that parsed.
  const firstVariant = run.variants[0] as Run['variants'][number];
  const firstStep = run.steps[0] as Run['steps'][number];

  let variant = asked.variant;
  if (!run.variants.some((candidate) => candidate.id === variant)) {
    variant = firstVariant.id;
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

  return { variant, step, aoi, fallback };
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
  // The three the selection is made of, taken one by one rather than as an object, so that
  // a render which changed none of them resolves to the result it resolved to before.
  const askedVariant = params.variant ?? '';
  const askedStep = params.step ?? '';
  const askedAoi = query.get(AOI_PARAM);
  const { variant, step, aoi, fallback } = useMemo(
    () => resolveSelection(run, { variant: askedVariant, step: askedStep, aoi: askedAoi }),
    [run, askedVariant, askedStep, askedAoi],
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

  return { runId, variant, step, aoi, setVariant, setStep, setAoi, fallback };
}
