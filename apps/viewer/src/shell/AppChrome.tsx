import { Link, useMatch } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { AccountMenu } from './AccountMenu';
import { patterns, paths } from './paths';
import { SimulatedBadge, SimulatedBadgePlaceholder } from './SimulatedBadge';
import { TestPicker, TestPickerPlaceholder } from './TestPicker';
import type { RunState } from './useRun';
import { WorkspaceName } from './WorkspaceName';

/**
 * The signed-in chrome of a hosted platform, as `#chrome` and `#tabbar` draw it in
 * `docs/design/prototype.html`: the product name, the workspace, the test being read, the
 * simulated-audience badge, New test, the account menu, and the tabs — Verdict, Score
 * breakdown, Attention, Sessions, with Audiences at the end.
 *
 * Every screen behind sign-in renders inside it. The tabs are **links**, so the chrome is
 * operable by keyboard and a tab opens in a new window like any other link; the prototype's
 * `data-go` buttons were the static demo's navigation and the router replaces them. There
 * is no dark-mode toggle: dark mode is the tokens file's own `prefers-color-scheme` block.
 *
 * While the run directory is being read, the test picker and the badge hold their shape in
 * a quiet placeholder state, so the chrome does not shift when they resolve.
 */

/** The tabs, each with the pattern it is the current one for. */
const tabsFor = (run: Run) => [
  { label: 'Verdict', to: paths.run(run.runId), match: patterns.run },
  { label: 'Score breakdown', to: paths.breakdown(run.runId), match: patterns.breakdown },
  {
    label: 'Attention',
    // The step and version the verdict turns on: the run says which, so the tab opens on
    // the evidence rather than on an arbitrary first step.
    to: paths.attention(run.runId, run.verdict.heroEvidence.variant, run.verdict.heroEvidence.step),
    match: `${patterns.run}/attention/*`,
  },
  { label: 'Sessions', to: paths.sessions(run.runId), match: `${patterns.sessions}/*` },
];

function Tab({ label, to, match }: { label: string; to: string; match: string }) {
  const current = useMatch(match) !== null;
  return (
    <Link className="tab" to={to} aria-current={current ? 'page' : undefined}>
      {label}
    </Link>
  );
}

export function AppChrome({ run }: { run: RunState | null }) {
  const current = run?.status === 'ready' ? run.run : null;
  const reading = run !== null && run.status === 'loading';

  return (
    <>
      <div className="appbar" data-shell="chrome">
        <div className="wrap">
          <Link className="logo" to={paths.home}>
            PersonaVision
          </Link>
          <WorkspaceName />
          {current ? <TestPicker run={current} /> : reading ? <TestPickerPlaceholder /> : null}
          {current || reading ? null : <span className="grow" />}
          {current ? (
            <SimulatedBadge calibration={current.calibration} />
          ) : (
            <SimulatedBadgePlaceholder />
          )}
          <Button asChild>
            <Link to={paths.newTest}>New test</Link>
          </Button>
          <AccountMenu />
        </div>
      </div>
      <nav className="tabs" aria-label="This test" data-shell="tabbar">
        <div className="wrap">
          {current
            ? tabsFor(current).map((tab) => <Tab key={tab.label} {...tab} />)
            : reading
              ? TAB_PLACEHOLDERS.map((label) => (
                  <span className="tab" key={label} aria-hidden="true">
                    {label}
                  </span>
                ))
              : null}
          <span className="grow" />
          <Tab label="Audiences" to={paths.audiences} match={`${patterns.audiences}/*`} />
        </div>
      </nav>
    </>
  );
}

/** The four tab labels, so the bar keeps its height while the run is being read. */
const TAB_PLACEHOLDERS = ['Verdict', 'Score breakdown', 'Attention', 'Sessions'];
