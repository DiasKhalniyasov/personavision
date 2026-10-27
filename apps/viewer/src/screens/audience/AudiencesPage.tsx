import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { useLatestRun, useOptionalRun } from '@/shell/useRun';
import { AudienceCard } from './AudienceCard';
import { NoAudienceScreen } from './NoAudienceScreen';
import { useAudienceList } from './useAudienceList';
import styles from './audience.module.css';

/**
 * `/audiences` — who this business serves.
 *
 * `#screen-audiences` of `docs/design/prototype.html`: the workspace's audiences as cards,
 * the one the latest test used marked, and a card for describing a new one. A workspace
 * with none renders the No-audience screen instead, because the product asks for the
 * audience before it offers anything else (`docs/FLOW.md` section 1).
 *
 * Which audience the latest test used is read from that test's **own frozen copy** of the
 * audience, not from the store: a run artifact carries the audience it ran with by value,
 * so editing a stored audience can never restate an old result.
 */
export function AudiencesPage() {
  const list = useAudienceList();
  const latest = useLatestRun();
  const latestRun = useOptionalRun(latest.status === 'ready' ? latest.runId : null);
  const usedAudienceId =
    latestRun !== null && latestRun.status === 'ready' ? latestRun.run.audience.id : null;

  if (list.status === 'ready' && list.records.length === 0) return <NoAudienceScreen />;

  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <div className="pagehead">
          <h1>Who does your business serve?</h1>
        </div>
        <p className="lede">
          PersonaVision generates the simulated people it tests with from the audience you describe
          here. Describe your customers once; every test is then framed as how <b>they</b> behaved.
        </p>

        {list.status === 'unreadable' ? (
          <p className="notice" role="alert">
            {list.problem}
          </p>
        ) : null}

        <div className="section">
          <div className={styles.audGrid}>
            {list.status === 'loading' ? <LoadingCards /> : null}
            {list.status === 'ready'
              ? list.records.map((record) => (
                  <AudienceCard
                    key={record.id}
                    record={record}
                    usedByLatestTest={record.audience.id === usedAudienceId}
                  />
                ))
              : null}
            <Link to={paths.newAudience} className={`card ${styles.audCard}`}>
              <h2>+ Describe a new audience</h2>
              <p className={`lede ${styles.audBlurb}`}>
                Age, role, device, region, goals, how tech-confident they are and how much price
                matters. Six fields and you are done.
              </p>
            </Link>
          </div>
        </div>

        <p className="footnote">
          An audience is not a persona. You describe the audience; PersonaVision generates the
          personas from it, from a seed, so the same audience always produces the same people and
          two tests are comparable.
        </p>
      </div>
    </div>
  );
}

/**
 * The space a card will take, while the store is being read. The grid must not jump once
 * the answer arrives, so the placeholders are the shape of the cards they stand in for.
 */
function LoadingCards() {
  return (
    <>
      {[0, 1].map((index) => (
        <div key={index} className="card" aria-hidden="true" data-loading="audience">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-5 w-48" />
          <Skeleton className="mt-4 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-5/6" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
      <p className="microlabel" role="status">
        Reading your audiences…
      </p>
    </>
  );
}
