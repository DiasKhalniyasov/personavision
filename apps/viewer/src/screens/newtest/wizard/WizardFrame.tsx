import type { ReactNode } from 'react';
import type { CrumbStep } from './steps';
import { WizardBreadcrumb } from './WizardBreadcrumb';

/**
 * The page frame every step of `/new` is drawn in: the `.strip`/`.wrap` column of
 * `docs/design/prototype.html`, with the `.breadcrumb` above the step's own `.pagehead`.
 *
 * This file owns the frame and the breadcrumb and **nothing inside them**: a step ticket
 * fills its own component and never redraws the strip or the crumbs.
 *
 * The path chooser takes the wide column, because `#screen-newtest-paths` lays its two path
 * cards side by side in `.wrap`; the three form steps take `.wrap-narrow`, as their own
 * prototype screens do. The width follows from the step rather than from a prop, so a step
 * cannot be mounted at the wrong one.
 */
export function WizardFrame({ step, children }: { step: CrumbStep; children: ReactNode }) {
  return (
    <div className="strip strip-sm">
      <div className={step === 'path' ? 'wrap' : 'wrap-narrow'}>
        <WizardBreadcrumb current={step} />
        {children}
      </div>
    </div>
  );
}
