import { useId } from 'react';
import { Link } from 'react-router';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { paths } from '@/shell/paths';
import { ageWords, deviceShares, priceWords } from '@/screens/audience/words';
import { peopleCount } from './draft';
import styles from './newtest.module.css';
import type { AudienceRecord } from '@/screens/audience/store';

/**
 * The audience `select` of `#screen-newrun`: who this test runs with.
 *
 * It lists this workspace's audiences and nothing else, and it is the first field on the
 * screen because **a test cannot be started without one** (`docs/FLOW.md` section 2). A
 * workspace with none never reaches this form at all: `/new` sends it to the No-audience
 * screen, which asks who the customers are (#109).
 *
 * An audience is named here the way the Audiences screen names it — through
 * `screens/audience/words`, so the two screens cannot describe the same customers
 * differently. The count is the audience's own people and never a session count
 * (decision 1 on #105); what the sessions come to is said under the people below.
 */

/** `Outdoor-gear shoppers — 25–45, mostly mobile, price-aware (4 people)`. */
export const audienceOption = (record: AudienceRecord): string => {
  const { audience, people } = record;
  const loudest = deviceShares(audience.devices)[0]?.name;
  const parts = [
    ageWords(audience.ageRange),
    loudest === undefined ? null : `mostly ${loudest}`,
    priceWords(audience.priceSensitivity).toLowerCase(),
  ].filter((part) => part !== null);
  return `${audience.name} — ${parts.join(', ')} (${peopleCount(people.length)})`;
};

export function AudiencePicker({
  audiences,
  chosen,
  /** The workspace's audiences are still being read: the picker waits, the form does not. */
  loading,
  problem,
  onChoose,
}: {
  audiences: readonly AudienceRecord[];
  chosen: AudienceRecord | null;
  loading: boolean;
  problem: string | undefined;
  onChoose: (recordId: string) => void;
}) {
  // The field's own three ids. Nothing outside this component refers to them, so it holds
  // them rather than taking them from the form.
  const fieldId = useId();
  const hintId = useId();
  const errId = useId();

  return (
    <div className={styles.fieldGroup}>
      <Label htmlFor={fieldId}>Audience</Label>
      <Select
        value={chosen?.id ?? ''}
        disabled={loading}
        onValueChange={(recordId) => {
          onChoose(recordId);
        }}
      >
        <SelectTrigger
          id={fieldId}
          className="w-full"
          aria-invalid={problem !== undefined}
          aria-describedby={problem === undefined ? hintId : `${errId} ${hintId}`}
        >
          <SelectValue placeholder="Reading your audiences…" />
        </SelectTrigger>
        <SelectContent>
          {audiences.map((record) => (
            <SelectItem key={record.id} value={record.id}>
              {audienceOption(record)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {problem === undefined ? null : (
        <span className={styles.err} role="alert" id={errId}>
          {problem}
        </span>
      )}
      <span className={styles.hint} id={hintId}>
        The people this test runs with are generated from this audience.{' '}
        {chosen === null ? null : (
          <>
            <Link to={paths.audience(chosen.id)}>Edit the audience</Link>.
          </>
        )}
      </span>
    </div>
  );
}
