import type { Run, Session } from '@personavision/contract';
import type { SessionTimeline, TimelineMoment } from '@/session/index.js';
import { eventLog, NOTHING_RECORDED } from './eventLog';
import type { LogEvent, ScreenCard } from './eventLog';
import styles from './replay.module.css';

/**
 * The `.tl-screen` cards inside `#rp-timeline`: what the agent thought it was doing on each
 * screen, and the transcript of what it did there.
 *
 * It follows the scrubber — the card covering the scrubber's moment is marked, and so is the
 * row for the latest thing that had happened by then — and it works the other way too:
 * every row moves the scrubber to the nearest moment the scrubber has. A gaze row has a
 * fixation of its own; an action is taken to the nearest fixation on its own screen, since
 * the scrubber's unit is a fixation and the frame must not step off the screen the row sits
 * under. So the log is how a reader navigates the session as well as how they read it.
 *
 * This is the replay's **accessible representation**. The frame is a picture; this column is
 * the same session in words, down to how long each fixation was held, so somebody who
 * cannot see the frame reads the session rather than being told there is one.
 */
export function ScreenTimeline({
  run,
  session,
  timeline,
  moment,
  onGoTo,
}: {
  run: Run;
  session: Session;
  timeline: SessionTimeline;
  moment: TimelineMoment;
  /** Moves the scrubber, by fixation number, exactly as its own controls do. */
  onGoTo: (fixationNumber: number) => void;
}) {
  const log = eventLog({ session, run, timeline, moment });

  if (log.problem !== null) return <p className={styles.broken}>{log.problem}</p>;

  return (
    <>
      {log.cards.map((card) => (
        <Card key={card.index} card={card} onGoTo={onGoTo} />
      ))}
    </>
  );
}

function Card({ card, onGoTo }: { card: ScreenCard; onGoTo: (fixationNumber: number) => void }) {
  const headingId = `rp-screen-${card.index}`;

  return (
    <section
      className={styles.tlScreen}
      data-active={card.active}
      data-screen-card={card.index}
      aria-labelledby={headingId}
      aria-current={card.active ? 'true' : undefined}
    >
      <header>
        <h2 className="microlabel" id={headingId}>
          {card.title}
        </h2>
        <span className={styles.meta}>{card.meta}</span>
        {/* The active card is bordered in the accent colour, and no colour in this product
            carries a meaning on its own, so the state is also a word. */}
        {card.active ? <span className={styles.showing}>showing now</span> : null}
      </header>

      <p className={styles.intent}>{card.intent}</p>

      {card.events.length === 0 ? (
        <p className={styles.nothing}>{NOTHING_RECORDED}</p>
      ) : (
        <ul className={styles.events}>
          {card.events.map((event) => (
            <li key={event.key}>
              <Row event={event} onGoTo={onGoTo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One row. It is a control wherever the scrubber has somewhere to go — which is every
 * session that recorded a fixation. A session that recorded none has a disabled scrubber,
 * so its rows are read rather than walked, and a button that could not move anything would
 * be a promise the screen cannot keep.
 */
function Row({ event, onGoTo }: { event: LogEvent; onGoTo: (fixationNumber: number) => void }) {
  const body = (
    <>
      <span className={styles.t}>{event.time}</span>
      <span>
        <span className={styles.kind}>{event.kind}</span>
        {words(event).map((part, at) => (
          <span key={at}> &middot; {part}</span>
        ))}
      </span>
    </>
  );
  const shared = {
    className: styles.event,
    'data-event': event.key,
    'aria-current': event.current ? ('true' as const) : undefined,
  };

  if (event.fixationNumber === null) return <span {...shared}>{body}</span>;

  return (
    <button type="button" {...shared} onClick={() => onGoTo(event.fixationNumber as number)}>
      {body}
    </button>
  );
}

/** What follows the kind on a row, in the order a reader wants it. */
function words(event: LogEvent): string[] {
  return [event.target, event.detail, event.inconsistency].filter(
    (part): part is string => part !== null,
  );
}
