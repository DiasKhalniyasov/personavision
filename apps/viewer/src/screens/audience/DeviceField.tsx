import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import styles from './audience.module.css';
import { chosenPercentTotal, showPercent } from './draft';
import type { AudienceDraft, DraftDevice } from './draft';

/**
 * The devices of `#screen-audience`, and the shares a test's device mix is really drawn
 * from.
 *
 * The prototype prints the share inside the chip — *Mobile 60% · 390 × 844* — and a mock
 * can stop there; a form cannot, because the shares are the one field of an audience with
 * an invariant spanning two of them. So each chosen device carries its share in whole
 * percentage points, and **the total is stated, never corrected**: an audience whose mix
 * comes to 95% is refused with that figure in the message, because silently scaling it to
 * 100 would hand the user a mix they did not describe (`docs/FLOW.md` section 1).
 */
export function DeviceField({
  draft,
  onChange,
  error,
  errorId,
}: {
  draft: AudienceDraft;
  onChange: (devices: readonly DraftDevice[]) => void;
  /** The message the save was refused with, if the mix is what was wrong with it. */
  error?: string;
  errorId: string;
}) {
  const hintId = useId();
  const total = chosenPercentTotal(draft);
  const chosen = draft.devices.filter((device) => device.chosen);

  const describedBy = [hintId, error === undefined ? null : errorId].filter(Boolean).join(' ');

  return (
    <fieldset className={styles.fieldGroup}>
      <legend className={styles.groupLabel}>Devices</legend>
      <div className={styles.chips}>
        <ToggleGroup
          type="multiple"
          spacing={2}
          variant="outline"
          // The prototype's chip row wraps; a toggle group is a nowrap flex row, and one
          // that cannot wrap cannot shrink below the width of all its chips together.
          className="flex-wrap"
          value={chosen.map((device) => device.name)}
          aria-describedby={describedBy}
          onValueChange={(names: string[]) =>
            onChange(
              draft.devices.map((device) => ({ ...device, chosen: names.includes(device.name) })),
            )
          }
        >
          {draft.devices.map((device) => (
            <ToggleGroupItem
              key={device.name}
              value={device.name}
              className={`rounded-full ${styles.chip}`}
            >
              {device.label} · {device.viewport.width} × {device.viewport.height}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {chosen.length > 0 ? (
        <div className={styles.addRow}>
          {chosen.map((device) => (
            <SharePercent
              key={device.name}
              device={device}
              onChange={(percent) =>
                onChange(
                  draft.devices.map((other) =>
                    other.name === device.name ? { ...other, percent } : other,
                  ),
                )
              }
              invalid={error !== undefined}
              errorId={error === undefined ? undefined : errorId}
            />
          ))}
        </div>
      ) : null}

      <span className={styles.hint} id={hintId}>
        The device mix a test reports is drawn from these shares, so it is real rather than nominal.
        They are shares of one audience and must add up to 100% — they add up to{' '}
        {showPercent(total)}% — and nothing here is rounded for you.
      </span>
      {error === undefined ? null : (
        <span className={styles.err} id={errorId} role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

function SharePercent({
  device,
  onChange,
  invalid,
  errorId,
}: {
  device: DraftDevice;
  onChange: (percent: string) => void;
  invalid: boolean;
  errorId: string | undefined;
}) {
  const id = useId();

  return (
    <span className={styles.addRow}>
      <Label htmlFor={id}>{device.label} share (%)</Label>
      <Input
        id={id}
        type="number"
        min={0}
        max={100}
        // A third of an audience is 33.333333 points, and the mix it belongs to is legal.
        step="any"
        className="w-24"
        value={device.percent}
        aria-invalid={invalid}
        {...(errorId === undefined ? {} : { 'aria-describedby': errorId })}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}
