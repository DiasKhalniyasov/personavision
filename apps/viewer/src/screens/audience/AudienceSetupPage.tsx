import { Link, useParams } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { paths } from '@/shell/paths';
import { AudienceForm } from './AudienceForm';
import { draftOf, emptyDraft } from './draft';
import { useAudience } from './useAudienceList';
import styles from './audience.module.css';

/**
 * `/audiences/new` and `/audiences/:audienceId` — describing the customers a test runs on.
 *
 * `#screen-audience` of `docs/design/prototype.html`: the breadcrumb, the audience's name
 * as the page heading, the form, and under it the people the audience generates.
 *
 * The id in the path is the **record's**, which is what the store addresses an audience by
 * and what the Audiences screen links with; the audience's own id is the one a run
 * artifact records. A path naming no audience of this workspace says so rather than
 * rendering an empty form that would quietly create a second one.
 */
export function AudienceSetupPage() {
  const { audienceId = null } = useParams();
  const state = useAudience(audienceId);
  const isNew = audienceId === null;

  if (!isNew && state.status === 'loading') return <LoadingForm />;
  if (!isNew && state.status === 'not-found') {
    return (
      <Shell title="No audience with that id" breadcrumb={null}>
        <div className="empty">
          <p>
            This workspace has no audience at{' '}
            <span className="mono">{paths.audience(audienceId)}</span>.
          </p>
          <div className="actions">
            <Link to={paths.audiences}>Back to your audiences</Link>
          </div>
        </div>
      </Shell>
    );
  }
  if (!isNew && state.status === 'unreadable') {
    return (
      <Shell title="That audience could not be read" breadcrumb={null}>
        <p className="notice" role="alert">
          {state.problem}
        </p>
      </Shell>
    );
  }

  // `isNew` and the state agree, because the hook clears its answer when no audience is
  // asked for; taking the record only when it is this route's is the belt to that brace.
  const record = !isNew && state.status === 'ready' ? state.record : null;

  return (
    <Shell
      title={record === null ? 'Describe your audience' : record.audience.name}
      breadcrumb={record === null ? 'New audience' : record.audience.name}
    >
      <p className="lede">
        The audience your business actually serves. Every figure in a test using it is framed as how
        these people behaved.
      </p>
      <AudienceForm
        record={record}
        initial={record === null ? emptyDraft(new Date()) : draftOf(record.audience)}
        // A different audience is a different form, and React keeps state by position.
        key={record?.id ?? 'new'}
      />
    </Shell>
  );
}

function Shell({
  title,
  breadcrumb,
  children,
}: {
  title: string;
  breadcrumb: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="strip strip-sm">
      <div className="wrap">
        <p className="breadcrumb">
          <Link to={paths.audiences}>Audiences</Link>
          {breadcrumb === null ? null : ` / ${breadcrumb}`}
        </p>
        <div className="pagehead">
          <h1>{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The form's own space, reserved while the audience being edited is read. */
function LoadingForm() {
  return (
    <Shell title="Audience" breadcrumb={null}>
      <div className={`${styles.form} card card-lg`} aria-hidden="true" data-loading="audience">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
      <p className="microlabel" role="status">
        Reading this audience…
      </p>
    </Shell>
  );
}
