import { Link } from 'react-router';
import type { Run, Session } from '@personavision/contract';
import { attributionWords, outcomeWords } from '@/session/index.js';
import type { Attribution, OutcomeStatus } from '@/session/index.js';
import { paths } from '@/shell/paths';
import { timeLabel } from './position';

/**
 * Who this was, before anything moves: the breadcrumb, the heading and the tag line of
 * `#screen-replay`.
 *
 * It states the five things that make a replay checkable — who, which version, which seed,
 * on what device, and how it ended — and then says that those are enough to produce this
 * person again. Nothing here is computed from the gaze: every value is read out of the run
 * artifact and the session file, and the words for an outcome and its attribution come from
 * the session vocabulary (#20) so that this screen and the Sessions list cannot disagree.
 */

/** The chip classes `src/styles/base.css` draws, by the enum the contract stores. */
const OUTCOME_TAG: Readonly<Record<OutcomeStatus, string>> = {
  success: 'tag-success',
  abandoned: 'tag-abandoned',
  failed: 'tag-failed',
  // Our own automation breaking is not an outcome of the product under test, so it wears
  // the attribution chip rather than an outcome one — as the tokens file declares it.
  automation_failure: 'tag-automation',
};

const ATTRIBUTION_TAG: Readonly<Record<Attribution, string>> = {
  product: 'tag-product',
  automation: 'tag-automation',
};

/** A persona's traits, as the contract names them. */
type Traits = NonNullable<Session['persona']>['traits'];

/**
 * The traits a replay states, in the words a reader can use. Every one the contract
 * declares is here: a persona's behaviour is what makes its session reproducible, so none
 * of them is left off the screen.
 */
const TRAIT_WORDS: readonly (readonly [keyof Traits, string])[] = [
  ['persistence', 'persistence'],
  ['patience', 'patience'],
  ['scanningVsReading', 'scanning over reading'],
  ['detailOrientation', 'detail'],
  ['interfaceFamiliarity', 'interface familiarity'],
  ['riskTolerance', 'risk tolerance'],
];

/** `product` → `Product at fault`: the vocabulary's word, in the prototype's sentence. */
const atFault = (label: string): string =>
  `${label.slice(0, 1).toUpperCase()}${label.slice(1)} at fault`;

export function ReplayHeader({ run, session }: { run: Run; session: Session }) {
  const persona = run.personas.find((candidate) => candidate.id === session.persona?.id) ?? null;
  const personaName = persona?.name ?? session.persona?.id ?? 'Imported participant';
  const variantName =
    run.variants.find((variant) => variant.id === session.variant)?.name ?? session.variant;
  const stepLabel =
    run.steps.find((step) => step.id === session.outcome.step)?.label ?? session.outcome.step;
  const outcome = outcomeWords(session.outcome.status);
  const attribution = attributionWords(session.outcome.attribution);
  const device = session.persona?.device ?? null;
  const traits = session.persona?.traits ?? null;

  const heading = [
    session.sessionId,
    personaName,
    variantName,
    session.seed === null ? null : `seed ${session.seed}`,
  ].filter((part) => part !== null);

  return (
    <>
      <p className="breadcrumb">
        <Link to={paths.run(run.runId)}>Verdict</Link> /{' '}
        <Link to={paths.sessions(run.runId)}>People</Link> / {session.sessionId}
      </p>

      <div className="pagehead">
        <h1>{heading.join(' · ')}</h1>
      </div>

      <p className="lede">
        <span className={`tag tag-${session.variant.toLowerCase()}`}>
          {session.variant} {variantName}
        </span>{' '}
        <span className={`tag ${OUTCOME_TAG[session.outcome.status]}`}>
          {outcome.label} at {timeLabel(session.durationMs)}
        </span>{' '}
        <span className={`tag ${ATTRIBUTION_TAG[session.outcome.attribution]}`}>
          {atFault(attribution.label)}
        </span>{' '}
        <span className="faint">
          {device === null
            ? null
            : `${device.name} · ${device.viewport.width} × ${device.viewport.height} · `}
          {session.fixations.length} fixations · {session.screens.length} screens · ended on the{' '}
          {stepLabel} screen · generated from the {run.audience.name} audience, reproducible from
          that audience, {session.seed === null ? 'its seed' : `seed ${session.seed}`} and the{' '}
          {variantName} pages
        </span>
      </p>

      {traits === null ? null : (
        <p className="lede">
          <span className="microlabel">Traits</span>{' '}
          <span className="faint">
            {TRAIT_WORDS.map(([key, word]) => `${word} ${traits[key]}`).join(' · ')}
          </span>
        </p>
      )}
    </>
  );
}
