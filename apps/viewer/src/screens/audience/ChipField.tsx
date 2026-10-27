import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import styles from './audience.module.css';
import type { ChipChoice } from './draft';
import { withChip } from './draft';

/**
 * One `.chips` group of `#screen-audience`: the roles, the goals or the regions.
 *
 * The chips are the registry's toggle group, so a value is pressed and released with the
 * keyboard and announced as pressed; the only thing added to them is the direction's one
 * shape rule — every chip in this product is fully rounded — and the accent the prototype
 * fills a pressed chip with, which `audience.module.css` reads from the tokens.
 *
 * The suggestions are a starting point and not a vocabulary: the last chip opens a field
 * for a value of the user's own, because the audience is their customers and not ours.
 */
export function ChipField({
  legend,
  hint,
  addLabel,
  choice,
  onChange,
}: {
  legend: string;
  hint?: string;
  /** What the last chip reads: `+ Add a role`. Omitted where the list is the product's. */
  addLabel?: string;
  choice: ChipChoice;
  onChange: (next: ChipChoice) => void;
}) {
  const hintId = useId();
  const addId = useId();
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');

  const add = () => {
    const value = typed.trim();
    if (value === '') return;
    onChange(withChip(choice, value, true));
    setTyped('');
    setAdding(false);
  };

  return (
    <fieldset className={styles.fieldGroup}>
      <legend className={styles.groupLabel}>{legend}</legend>
      <div className={styles.chips}>
        <ToggleGroup
          type="multiple"
          spacing={2}
          variant="outline"
          // The prototype's chip row wraps; a toggle group is a nowrap flex row, and one
          // that cannot wrap cannot shrink below the width of all its chips together.
          className="flex-wrap"
          value={[...choice.chosen]}
          onValueChange={(chosen: string[]) =>
            onChange({
              offered: choice.offered,
              chosen: choice.offered.filter((value) => chosen.includes(value)),
            })
          }
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        >
          {choice.offered.map((value) => (
            <ToggleGroupItem key={value} value={value} className={`rounded-full ${styles.chip}`}>
              {value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {addLabel === undefined ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={adding}
            onClick={() => setAdding(true)}
          >
            {addLabel}
          </Button>
        )}
      </div>

      {adding && addLabel !== undefined ? (
        <div className={styles.addRow}>
          <Label htmlFor={addId}>{addLabel.replace(/^\+\s*/, '')}</Label>
          <Input
            id={addId}
            value={typed}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              // Enter adds the value rather than submitting the form around it.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={add}>
            Add
          </Button>
        </div>
      ) : null}

      {hint === undefined ? null : (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      )}
    </fieldset>
  );
}
