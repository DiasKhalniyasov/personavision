/**
 * The boot placeholder: the product name and one line saying no run is loaded.
 *
 * Deliberately the whole of this app's UI. The chrome and the route table arrive with the
 * app-shell step, the Comparison screen with it, and the remaining screens with their own
 * steps; none of them is stubbed here.
 */
export function Boot() {
  return (
    <main className="boot">
      <h1 className="boot-name">PersonaVision</h1>
      <p className="boot-line">No run has been loaded yet.</p>
    </main>
  );
}
