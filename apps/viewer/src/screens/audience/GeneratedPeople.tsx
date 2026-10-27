import type { Persona } from '@personavision/contract';
import styles from './audience.module.css';
import type { AudienceIssue } from './store';

/**
 * The `.personagrid` of `#screen-audience`: the people this audience generates.
 *
 * They are **generated, not chosen**, and this screen shows them and never edits them —
 * a persona is the consequence of the audience, so somebody who wants different people
 * changes the audience above (`docs/FLOW.md` section 1). Nothing here is a control: each
 * person is their name and the generator's own `segment`, which is their device and their
 * leaning in two words.
 *
 * They come from the store, which runs `@personavision/personas` for this audience and its
 * seed. The browser never generates anybody: a second implementation of the generator
 * would be a second set of people, and the ones that matter are the ones a test will run.
 */
export function GeneratedPeople({
  people,
  seed,
  issues,
  /** A new audience has nobody yet: it generates its people the moment it is saved. */
  unsaved,
}: {
  people: readonly Persona[];
  seed: number;
  issues: readonly AudienceIssue[];
  unsaved: boolean;
}) {
  return (
    <div className={styles.fieldGroup} data-section="generated-people">
      <span className={styles.groupLabel} id="aud-people-label">
        The people this generates{' '}
        <span className="faint">seed {seed} · same audience and seed, same people</span>
      </span>

      {issues.length > 0 ? (
        <p className="notice" role="alert">
          {issues[0]?.message ?? 'This audience generates nobody.'}
        </p>
      ) : people.length === 0 ? (
        <p className={styles.hint}>
          {unsaved
            ? 'Save the audience and PersonaVision generates its people here.'
            : 'This audience generates nobody yet.'}
        </p>
      ) : (
        <div className={styles.personagrid} aria-labelledby="aud-people-label">
          {people.map((person) => (
            <div key={person.id} className={styles.personachip}>
              <b>{person.name}</b>
              <span className="faint">{person.segment}</span>
            </div>
          ))}
        </div>
      )}

      <span className={styles.hint}>
        Generated, not chosen. Change the audience above, save it, and these change with it.
      </span>
    </div>
  );
}
