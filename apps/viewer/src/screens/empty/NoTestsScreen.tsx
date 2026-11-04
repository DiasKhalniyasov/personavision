import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { ExampleTests } from '@/screens/newtest/ExampleTests';
import { fillWizardDraft } from '@/screens/newtest/wizard/draft';
import { paths } from '@/shell/paths';

/**
 * `#screen-empty` of `docs/design/prototype.html`: the workspace has an audience but no
 * test. Its two actions are the prototype's own — open the example test of the demo shop,
 * or point PersonaVision at two versions of a page.
 *
 * *Open the example test* goes to `/demo`, which is the committed example run's Verdict
 * (#124): the one test that exists in every install, with no API key and no network.
 *
 * Under the two of them sit **the five example tests** (#417) — the same five the first New
 * test screen offers, read from the same file (`screens/newtest/templates.ts`): this screen
 * states nothing of its own about them. Choosing one fills the New test draft and goes to
 * its audience step, so a workspace with no test can run one on a real public site without
 * inventing anything. The screen is **not** a step of the wizard, so the draft is filled
 * through `fillWizardDraft` and the wizard reads it on the step it opens on.
 */
export function NoTestsScreen() {
  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h2>No tests yet</h2>
          <p>
            This workspace has an audience but no test. Open the example test of our demo shop to
            see what a result looks like, or point PersonaVision at two versions of one of your own
            pages.
          </p>
          <div className="actions">
            <Button asChild size="lg">
              <Link to={paths.demo}>Open the example test</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to={paths.newTest}>New test</Link>
            </Button>
          </div>
          <p className="faint">
            The example test needs no API key and no network: it was produced by the deterministic
            offline engine.
          </p>
        </div>
        <ExampleTests fill={fillWizardDraft} />
      </div>
    </div>
  );
}
