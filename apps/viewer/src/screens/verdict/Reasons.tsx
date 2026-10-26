import type { Run } from '@personavision/contract';
import './verdict.css';

/**
 * The one or two reasons, in plain words, drawn from the top findings: the `.reasons` of `#screen-verdict`.
 *
 * `verdict.reasons`, under a quiet *Why* label. **Never three:** the cap is the contract
 * (`docs/FLOW.md` section 5) and a screen that grows a third reason has stopped being this
 * screen, so an artifact carrying more renders the first two and says nothing about the
 * rest. A run with no reason at all renders no block rather than an empty label.
 */

/** `docs/FLOW.md` section 5: one or two reasons, and the artifact's schema holds the pipeline to it. */
const MAX_REASONS = 2;

export function Reasons({ run }: { run: Run }) {
  const reasons = run.verdict.reasons.slice(0, MAX_REASONS);

  if (reasons.length === 0) return null;

  return (
    <div className="reasons" data-section="reasons">
      <span className="microlabel">Why</span>
      <div className="reason-list">
        {reasons.map((reason) => (
          <p className="reason" key={reason}>
            <i aria-hidden="true" />
            <span>{reason}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
