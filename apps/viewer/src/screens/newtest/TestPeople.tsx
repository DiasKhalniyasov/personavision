import type { Persona } from '@personavision/contract';
import styles from './newtest.module.css';

/**
 * The `.personagrid` of `#screen-newrun`: the people this test will run with, and the
 * arithmetic of how many sessions that comes to.
 *
 * They are **generated, not chosen** — a persona is the consequence of the audience, so
 * somebody who wants different people changes the audience (`docs/FLOW.md` section 1).
 * Nothing here is a control. They come from the audience store, which runs
 * `@personavision/personas` for the chosen audience and its seed; the browser never
 * generates anybody, because a second implementation of the generator would be a second
 * set of people and the ones that matter are the ones the test will run.
 */
export function TestPeople({
  people,
  repeats,
  variants,
  labelId,
}: {
  people: readonly Persona[];
  /** Sessions per person per version — what the repeats field is set to. */
  repeats: number;
  /** How many versions the test compares, which is what makes the total. */
  variants: number;
  labelId: string;
}) {
  const perVersion = people.length * repeats;

  return (
    <div className={styles.fieldGroup} data-section="test-people">
      <span className={styles.groupLabel} id={labelId}>
        The people this generates{' '}
        <span className="faint">
          {people.length} {people.length === 1 ? 'persona' : 'personas'} ·{' '}
          {repeats === 1 ? 'one seed each' : `${String(repeats)} seeds each`} · {String(perVersion)}{' '}
          per version · {String(perVersion * variants)} sessions in all
        </span>
      </span>

      {people.length === 0 ? (
        <p className={styles.hint}>
          This audience generates nobody, so there is nobody to test on.
        </p>
      ) : (
        <div className={styles.personagrid} aria-labelledby={labelId}>
          {people.map((person) => (
            <div key={person.id} className={styles.personachip}>
              <b>{person.name}</b>
              <span className="faint">{person.segment}</span>
            </div>
          ))}
        </div>
      )}

      <span className={styles.hint}>
        Generated from the audience, not chosen here. To change who is tested, change the audience.
      </span>
    </div>
  );
}
