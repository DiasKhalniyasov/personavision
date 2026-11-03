import { Link, useMatch } from 'react-router';
import type { Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { AccountMenu } from './AccountMenu';
import { matches, paths, patterns } from './paths';
import { SimulatedBadge, SimulatedBadgePlaceholder } from './SimulatedBadge';
import { TestPicker, TestPickerPlaceholder } from './TestPicker';
import type { RunState } from './useRun';
import { WorkspaceName } from './WorkspaceName';

/**
 * The signed-in chrome of a hosted platform, as `#chrome` and `#tabbar` draw it in
 * `docs/design/prototype.html`: the product name, the workspace, the test being read, the
 * simulated-audience badge, New test, the account menu, and the tabs — Verdict, Score
 * breakdown, Attention, Sessions, Funnel & timing, Analysis, with Sites and Audiences at the
 * end.
 *
 * **These are the same tabs for every kind of run, not a second set** (`docs/FLOW.md`
 * section 14). Two of them answer to the run: the lead reads *Verdict* for a run with two
 * versions and *Summary* for a run with one, which is what section 14 calls each, and *Score
 * breakdown* is there only for a run with two, because a run with one has nothing to compare.
 * *Improve* and *Sites of this test* are later steps' tabs and are not in the bar yet.
 *
 * Sites and Audiences are about the workspace rather than about one test, which is why
 * `#tabbar` puts them after the gap: a signed-in user has to be able to reach their sites
 * (`docs/FLOW.md` section 13) from any screen, including one that is about no test at all.
 *
 * Every screen behind sign-in renders inside it. The tabs are **links**, so the chrome is
 * operable by keyboard and a tab opens in a new window like any other link; the prototype's
 * `data-go` buttons were the static demo's navigation and the router replaces them. There
 * is no dark-mode toggle: dark mode is the tokens file's own `prefers-color-scheme` block.
 *
 * While the run directory is being read, the test picker and the badge hold their shape in
 * a quiet placeholder state, so the chrome does not shift when they resolve.
 */

/** Whether this run compares two versions, which is what the first two tabs turn on. */
const comparesTwo = (run: Run): boolean => run.variants.length > 1;

/** What the lead tab is called: the whole answer, named for the kind of run it leads. */
export const leadTabLabel = (run: Run): string => (comparesTwo(run) ? 'Verdict' : 'Summary');

/** The tabs, each with the pattern it is the current one for, in `#tabbar`'s order. */
const tabsFor = (run: Run) => [
  { label: leadTabLabel(run), to: paths.run(run.runId), match: patterns.run },
  ...(comparesTwo(run)
    ? [{ label: 'Score breakdown', to: paths.breakdown(run.runId), match: patterns.breakdown }]
    : []),
  {
    label: 'Attention',
    // The step and version the verdict turns on: the run says which, so the tab opens on
    // the evidence rather than on an arbitrary first step.
    to: paths.attention(run.runId, run.verdict.heroEvidence.variant, run.verdict.heroEvidence.step),
    match: matches.attention,
  },
  { label: 'Sessions', to: paths.sessions(run.runId), match: matches.sessions },
  { label: 'Funnel & timing', to: paths.funnel(run.runId), match: patterns.funnel },
  { label: 'Analysis', to: paths.analysis(run.runId), match: patterns.analysis },
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
          <Tab label="Sites" to={paths.sites} match={matches.sites} />
          <Tab label="Audiences" to={paths.audiences} match={matches.audiences} />
        </div>
      </nav>
    </>
  );
}

/**
 * The tab labels, so the bar keeps its height while the run is being read.
 *
 * The fullest bar: which of them the run actually has is not known until it has been read,
 * and a bar that starts short and grows is the shift this placeholder exists to prevent.
 */
const TAB_PLACEHOLDERS = [
  'Verdict',
  'Score breakdown',
  'Attention',
  'Sessions',
  'Funnel & timing',
  'Analysis',
];
