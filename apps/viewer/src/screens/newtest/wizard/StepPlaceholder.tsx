import type { CrumbStep } from './steps';
import { CRUMBS } from './steps';

/**
 * A step of the wizard that is mounted and not yet built.
 *
 * The wizard, its breadcrumb and its draft are this ticket's; each step's content is its own
 * ticket's. A placeholder says which step it is and which ticket builds it, so a reader of
 * the running app is never left guessing whether they are looking at a finished screen.
 */
export function StepPlaceholder({ step, ticket }: { step: CrumbStep; ticket: string }) {
  const label = CRUMBS.find((crumb) => crumb.step === step)?.label ?? step;

  return (
    <>
      <div className="pagehead">
        <h1>{label}</h1>
      </div>
      <p className="lede">This step is not built yet.</p>
      <p className="footnote">
        The wizard around it is finished — the step in the query, the breadcrumb and the draft that
        survives a reload; {ticket} builds the step itself.
      </p>
    </>
  );
}
