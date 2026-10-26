/**
 * The line every results screen ends with: the numbers rank versions for this audience and
 * are not an estimate of conversion lift (`docs/FLOW.md` section 3).
 *
 * One component, reused by the Verdict, Score breakdown, Attention, Sessions and Session
 * replay screens, so the sentence is written once. **#14 fills it**; the shell publishes
 * the name and the place it sits.
 */
export function SimulatedDisclaimer() {
  return <p className="footnote" data-shell="simulated-disclaimer" />;
}
