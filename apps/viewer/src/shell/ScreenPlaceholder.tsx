/**
 * A route that is mounted and not yet built.
 *
 * The route table of `docs/FLOW.md` section 3 is complete from this ticket on, so that a
 * screen ticket fills one file and touches no router and no sibling. Each placeholder says
 * which screen it is and which ticket builds it, rather than rendering a blank page.
 */
export function ScreenPlaceholder({ screen, ticket }: { screen: string; ticket: string }) {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="pagehead">
          <h1>{screen}</h1>
        </div>
        <p className="lede">This screen is not built yet.</p>
        <p className="footnote">
          The route is mounted and the shell around it is finished; {ticket} builds the screen
          itself.
        </p>
      </div>
    </div>
  );
}
