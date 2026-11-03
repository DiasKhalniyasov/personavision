import { Fragment } from 'react';
import { Link } from 'react-router';
import { newTestStep } from '@/shell/paths';
import type { CrumbStep } from './steps';
import { CRUMBS } from './steps';

/**
 * The `.breadcrumb` of `#screen-newtest-paths`, `#screen-newtest-feature`,
 * `#screen-newtest-goal` and `#screen-newtest-estimate` in `docs/design/prototype.html`:
 * *Path / Audience & feature / Goal / Launch*.
 *
 * The current step is bold, the steps already passed are links back to themselves and the
 * steps ahead are plain text — a user may go back to a step they have filled in and cannot
 * jump ahead to one they have not. The prototype's crumbs are anchors on the steps behind
 * and bare text on the steps ahead, which is exactly that rule drawn.
 */
export function WizardBreadcrumb({ current }: { current: CrumbStep }) {
  const at = CRUMBS.findIndex((crumb) => crumb.step === current);

  return (
    <p className="breadcrumb">
      {CRUMBS.map((crumb, index) => (
        <Fragment key={crumb.step}>
          {index === 0 ? null : ' / '}
          {index === at ? (
            <b>{crumb.label}</b>
          ) : index < at ? (
            <Link to={newTestStep(crumb.step)}>{crumb.label}</Link>
          ) : (
            crumb.label
          )}
        </Fragment>
      ))}
    </p>
  );
}
