import { useAudiences } from '@/shell/useAudiences';
import { useLatestRun, useOptionalRun } from '@/shell/useRun';
import { NewTestForm } from './NewTestForm';

/**
 * `/new` — choose the audience, the two versions and the task.
 *
 * `#screen-newrun` of `docs/design/prototype.html`, and `#screen-newrun-invalid` when a
 * field is refused. Three decisions and nothing more, plus the two settings that change
 * what the result can claim (`docs/FLOW.md` sections 2 and 3).
 *
 * The audiences come from the store through the shell's one hook, and the audience the form
 * opens on is **the one the most recent test ran with** — read from that run's own frozen
 * copy, which is the only place a finished test's audience is ever read from, so editing an
 * audience cannot restate an old result. A workspace with no audience never reaches this
 * screen: `/new` sends it to the No-audience screen, which asks who the customers are
 * before offering a test (#109, and `RequireAudience` in the shell).
 *
 * Starting a test is a request to the platform and a route to `/runs/:runId`. Nothing is
 * run here: the swarm is #54's and the Running state #18's.
 */
export function NewTestPage() {
  const audiences = useAudiences();
  const latest = useLatestRun();
  // The run is read for one field — which audience it ran with — through the same hook and
  // the same contract every other screen reads a run with.
  const latestRun = useOptionalRun(latest.status === 'ready' ? latest.runId : null);

  const records = audiences.status === 'ready' ? audiences.audiences : [];
  // The audience's **own** id is what a run records; the store addresses the same audience
  // by its record id, which is what this form submits. The two are two ids on purpose.
  const lastUsed = latestRun?.status === 'ready' ? latestRun.run.audience.id : null;
  const opensOn = records.find((record) => record.audience.id === lastUsed) ?? records[0];

  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <div className="pagehead">
          <h1>New test</h1>
        </div>
        <p className="lede">
          Two versions of the same page, the same audience on both, repeated with different seeds so
          the result has a spread you can trust.
        </p>
        <NewTestForm
          audiences={records}
          loading={audiences.status === 'loading'}
          defaultAudienceId={opensOn?.id ?? ''}
        />
      </div>
    </div>
  );
}
