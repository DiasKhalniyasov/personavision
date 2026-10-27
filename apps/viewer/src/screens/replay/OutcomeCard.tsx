import { Link } from 'react-router';
import { runPaths } from '@personavision/contract';
import type { Run, Session } from '@personavision/contract';
import { attributionWords, findingsForSession, outcomeWords } from '@/session/index.js';
import type { Finding } from '@/session/index.js';
import { evidenceUrl } from '@/screens/verdict/evidenceLink';
import { useFindings } from '@/shell/useRun';
import styles from './replay.module.css';
import { stepLabel } from './runWords';

/**
 * The `.outcome-card` that closes `#rp-timeline`: what this session means, and why it can
 * be believed.
 *
 * It answers the four things a sceptical designer asks of one person's session — how it
 * ended and whose fault that was, why, which of the run's conclusions it is evidence for,
 * and whether our own harness held up while it happened — and then says where the file is,
 * so the whole claim can be checked from a terminal.
 *
 * **Every outcome gets this card.** The prototype draws it for an abandonment and paints
 * itself with the abandoned tokens; here the colour comes from the outcome's own token
 * through the session vocabulary (#20), because dressing a success as an abandonment would
 * be the one thing this screen must never do. The four outcomes keep four words and four
 * colours, and the word is always beside the colour.
 *
 * **The findings are a lookup, not a reading.** A session is evidence for a finding when
 * that finding lists its id in `sessionIds`; no claim sentence is matched, and each finding
 * links to the target its own `evidence_link` names, which is resolved in the one place the
 * app resolves it.
 */
export function OutcomeCard({ run, session }: { run: Run; session: Session }) {
  const outcome = outcomeWords(session.outcome.status);
  const attribution = attributionWords(session.outcome.attribution);
  const endedOn = stepLabel(run, session.outcome.step);
  const headingId = `rp-outcome-${session.sessionId}`;
  const integrity = integrityWords(session);

  return (
    <section
      className={styles.outcome}
      data-outcome={session.outcome.status}
      aria-labelledby={headingId}
      // The card's colour is the outcome's own token, read from the vocabulary rather than
      // written here: an outcome gains a colour in `docs/design/tokens.css`, not in a screen.
      style={{
        borderColor: `var(${outcome.backgroundToken})`,
        background: `var(${outcome.backgroundToken})`,
      }}
    >
      <h2 id={headingId} style={{ color: `var(${outcome.token})` }}>
        {outcome.label} at the {endedOn} step &middot;{' '}
        {/* Whose fault it was wears the attribution's own token — but only where there was
            a fault: `--attr-product` is the colour of something counting against the
            version, and a successful session is not that. */}
        <span
          style={
            session.outcome.status === 'success'
              ? undefined
              : { color: `var(${attribution.token})` }
          }
        >
          {fault(session, attribution.label)}
        </span>
      </h2>

      <p>{session.outcome.reason}</p>

      <dl className={styles.kv}>
        <dt>Supports findings</dt>
        <dd>
          <SupportedFindings runId={run.runId} sessionId={session.sessionId} />
        </dd>

        <dt>Automation integrity</dt>
        <dd>
          <span className="tag tag-automation">{integrity.tag}</span> {integrity.sentence}
        </dd>

        <dt>Reproduce</dt>
        <dd className="mono">{runPaths(`runs/${run.runId}`).session(session.sessionId)}</dd>
      </dl>
    </section>
  );
}

/**
 * The attribution, in the same breath as the outcome. A successful session is attributed to
 * the product too, and nothing was at fault in it, so the sentence is about who the result
 * belongs to rather than who is to blame.
 */
function fault(session: Session, attribution: string): string {
  if (session.outcome.attribution === 'automation') {
    return `our own ${attribution} was at fault, not the product`;
  }
  return session.outcome.status === 'success'
    ? `this is the ${attribution}’s own result, not our simulation’s`
    : `the ${attribution} was at fault, not our simulation`;
}

const failureWords = (count: number): string =>
  count === 0 ? 'no selector failures' : `${count} selector failure${count === 1 ? '' : 's'}`;

const retryWords = (count: number): string =>
  count === 0 ? 'no retries' : count === 1 ? '1 retry' : `${count} retries`;

/**
 * Whether our own harness held up, with the numbers next to the claim.
 *
 * Zero selector failures is what makes the outcome the product's, so the claim is made with
 * the count beside it rather than on its own. A session our browsing broke makes the
 * opposite claim, and says what follows from it: it is in the replay to be inspected, and in
 * none of the figures.
 */
function integrityWords(session: Session): { tag: string; sentence: string } {
  const { selectorFailures, retries } = session.integrity;
  const counts = `${failureWords(selectorFailures)}, ${retryWords(retries)}`;

  if (session.outcome.status === 'automation_failure') {
    return {
      tag: 'automation failure',
      sentence: `our own browsing broke on this session — ${counts} — so this person is excluded from the friction score and from every area-of-interest metric.`,
    };
  }

  if (selectorFailures === 0) {
    return {
      tag: 'no selector failures',
      sentence: `every action resolved, with ${retryWords(retries)}, so the outcome is the product’s and not the harness’s.`,
    };
  }

  return {
    tag: failureWords(selectorFailures),
    sentence: `${counts}: the session reached its end, but our own browsing slipped on the way, so this outcome is not the clean claim about the product that no selector failures would make.`,
  };
}

/**
 * The findings this session is evidence for, best-ranked first.
 *
 * The row is never blank. While `findings.json` is being read it says so, because an empty
 * row would read as "supports nothing"; a session no finding cites says that in a sentence;
 * and a findings file that could not be read, or a finding whose evidence link names no
 * route, says the link could not be resolved rather than quietly dropping the row.
 */
function SupportedFindings({ runId, sessionId }: { runId: string; sessionId: string }) {
  const state = useFindings(runId);

  if (state.status === 'loading') {
    return (
      <span aria-busy="true" role="status">
        Reading this test’s findings.
      </span>
    );
  }

  if (state.status === 'unreadable') {
    return <>The findings this person supports could not be resolved: {state.problem}.</>;
  }

  const supported = findingsForSession(state.findings, sessionId);

  if (supported.length === 0) {
    return <>No finding in this test cites this person.</>;
  }

  return (
    <>
      {supported.map((finding, position) => (
        <span key={finding.id}>
          {position === 0 ? null : ' · '}
          <SupportedFinding finding={finding} runId={runId} />
        </span>
      ))}
    </>
  );
}

/** One finding, as a door to the evidence it names — or, when it names none, as words. */
function SupportedFinding({ finding, runId }: { finding: Finding; runId: string }) {
  const claim = finding.claim.trim() === '' ? finding.id : finding.claim;
  const named = `#${finding.rank} ${claim}`;
  const href = evidenceUrl(runId, finding.evidence_link);

  if (href === null) {
    return <>{named} (its evidence link could not be resolved)</>;
  }
  return <Link to={href}>{named}</Link>;
}
