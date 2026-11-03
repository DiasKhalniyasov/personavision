import { createElement, useEffect } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import { RequireAudience } from '@/shell/AppLayout';
import { STEP_PARAM } from '@/shell/paths';
import { NewTestPage } from '../NewTestPage';
import { useHeldWizardDraft, WizardDraftContext } from './draft';
import { AudienceStep } from './audience/AudienceStep';
import { EstimateStep } from './estimate/EstimateStep';
import { GoalStep } from './goal/GoalStep';
import { PathStep } from './path/PathStep';
import { isCanonical, resolveStep } from './steps';
import type { CrumbStep } from './steps';
import { WizardFrame } from './WizardFrame';

/**
 * `/new` — one route, with the step in the query (`docs/FLOW.md` section 13).
 *
 * A step is a section of this screen and not a route of its own, so back, reload and a
 * shared link all land where the user was. The query is read and nothing else: a step the
 * vocabulary does not know is the path chooser with the URL put right, rather than a
 * not-found inside a wizard the user is halfway through.
 *
 * The draft is held here and shared with whatever the step renders, so a form and the button
 * beside it read one copy (`draft.ts`).
 *
 * `?step=variants` is the two-URL A/B form as it stands — the same screen, the same tests,
 * mounted here instead of at `/new` itself (decision 78). It keeps #109's guard, because it
 * submits a saved audience record's id and a workspace with none cannot fill it in; the four
 * new steps do not, because the second of them is where an audience is described in a
 * sentence and a wizard that asked for one first would be a loop.
 */
const STEP_CONTENT: Readonly<Record<CrumbStep, () => ReactElement>> = {
  path: PathStep,
  audience: AudienceStep,
  goal: GoalStep,
  estimate: EstimateStep,
};

export function NewTestWizard() {
  const held = useHeldWizardDraft();
  const [params, setParams] = useSearchParams();
  const raw = params.get(STEP_PARAM);
  const step = resolveStep(raw);
  const canonical = isCanonical(raw, step);

  // The address is put right **in place**: no step, an unknown step and `feature` — section
  // 13's own name for the audience-and-feature screen — all render their step and replace
  // the URL with the one that names it, so reloading or sharing it lands in the same place.
  useEffect(() => {
    if (canonical) return;
    const next = new URLSearchParams(params);
    next.set(STEP_PARAM, step);
    setParams(next, { replace: true });
  }, [canonical, params, setParams, step]);

  return (
    <WizardDraftContext.Provider value={held}>
      {step === 'variants' ? (
        <RequireAudience>
          <NewTestPage />
        </RequireAudience>
      ) : (
        <WizardFrame step={step}>{createElement(STEP_CONTENT[step])}</WizardFrame>
      )}
    </WizardDraftContext.Provider>
  );
}
