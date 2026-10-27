import { useId } from 'react';
import { Slider } from '@/components/ui/slider';
import styles from './audience.module.css';

/**
 * The `.meters` of `#screen-audience`: how tech-confident the audience is, and how much
 * price matters to them.
 *
 * Both are the sliders the whole generated swarm hangs off, so each one states **what it
 * moves** and shows the value it is on. A slider with no stated consequence is a slider
 * nobody can set honestly, and the consequence here is not ours to invent: the mapping
 * from these two values to the generated people's traits is published by the generator
 * (`docs/FLOW.md` section 1), and the hint below says what it does in the user's words.
 */

/** The scale the two values live on, in the steps the slider moves in. */
const STEPS = 100;

export function BehaviourMeters({
  techSavviness,
  priceSensitivity,
  onChange,
}: {
  techSavviness: number;
  priceSensitivity: number;
  onChange: (values: { techSavviness: number; priceSensitivity: number }) => void;
}) {
  const hintId = useId();

  return (
    <fieldset className={styles.fieldGroup}>
      <legend className={styles.groupLabel}>How they behave</legend>
      <div className={styles.meters}>
        <Meter
          label="How tech-confident they are"
          value={techSavviness}
          describedBy={hintId}
          onChange={(next) => onChange({ techSavviness: next, priceSensitivity })}
        />
        <Meter
          label="How much price matters to them"
          value={priceSensitivity}
          describedBy={hintId}
          onChange={(next) => onChange({ techSavviness, priceSensitivity: next })}
        />
      </div>
      <span className={styles.hint} id={hintId}>
        These two move the generated people’s traits: how familiar an interface feels, how closely a
        total is read, and how quickly somebody gives up when a price changes.
      </span>
    </fieldset>
  );
}

function Meter({
  label,
  value,
  describedBy,
  onChange,
}: {
  label: string;
  value: number;
  describedBy: string;
  onChange: (value: number) => void;
}) {
  const shown = value.toFixed(2);

  return (
    <div className={styles.meter}>
      <span>{label}</span>
      <Slider
        min={0}
        max={STEPS}
        step={1}
        value={[Math.round(value * STEPS)]}
        aria-label={label}
        aria-valuetext={shown}
        aria-describedby={describedBy}
        onValueChange={([next]: number[]) => {
          if (next !== undefined) onChange(next / STEPS);
        }}
      />
      <span className={`${styles.val} num`}>{shown}</span>
    </div>
  );
}
