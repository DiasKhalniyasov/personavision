import type { ReactNode } from 'react';
import { crumbOf } from './steps';
import type { CrumbStep } from './steps';
import { WizardBreadcrumb } from './WizardBreadcrumb';

/**
 * The page frame every step of `/new` is drawn in: the `.strip`/`.wrap` column of
 * `docs/design/prototype.html`, with the `.breadcrumb` above the step's own `.pagehead`.
 *
 * This file owns the frame and the breadcrumb and **nothing inside them**: a step ticket
 * fills its own component and never redraws the strip or the crumbs.
 *
 * The column is the step's own, from `CRUMBS` — `.wrap` for the path chooser and
 * `.wrap-narrow` for the three form steps, as their prototype screens are drawn. It follows
 * from the step rather than from a prop, so a step cannot be mounted at the wrong one.
 */
export function WizardFrame({ step, children }: { step: CrumbStep; children: ReactNode }) {
  return (
    <div className="strip strip-sm">
      <div className={crumbOf(step).wrap}>
        <WizardBreadcrumb current={step} />
        {children}
      </div>
    </div>
  );
}
