import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { paths } from '@/shell/paths';
import { BehaviourMeters } from './BehaviourMeters';
import { ChipField } from './ChipField';
import { DeviceField } from './DeviceField';
import { GeneratedPeople } from './GeneratedPeople';
import { byField, refusalSummary } from './issues';
import { audienceOf, SIZE_CHOICES } from './draft';
import { createAudience, updateAudience } from './store';
import { refreshAudiences } from './useAudienceList';
import styles from './audience.module.css';
import type { AudienceDraft } from './draft';
import type { AudienceIssue, AudienceRecord } from './store';
import type { IssuesByField } from './issues';

/**
 * The `.form` of `#screen-audience`: the audience itself, and under it the people it
 * generates.
 *
 * Every control is a shadcn primitive, so the whole form is operable and submittable with
 * the keyboard alone and each field has a real label. What is refused is said twice: once
 * above the form, where a reader who has just pressed Save is looking, and once against
 * the field it concerns. **Nothing a save was refused for is thrown away** — the form
 * keeps what was typed, because a reader who loses six fields to one bad number does not
 * type them again.
 *
 * The people underneath are the store's answer for the audience **as it is stored**. The
 * browser does not run the generator (`packages/platform/src/audience/people.ts`), so they
 * change when a save does: describe different customers, save, and different people come
 * back.
 */
export function AudienceForm({
  record,
  initial,
}: {
  /** The stored audience being edited, or `null` on `/audiences/new`. */
  record: AudienceRecord | null;
  initial: AudienceDraft;
}) {
  const navigate = useNavigate();
  const nameId = useId();
  const ageMinId = useId();
  const ageMaxId = useId();
  const sizeId = useId();
  const nameHintId = useId();
  const errorId = useId();

  const [draft, setDraft] = useState<AudienceDraft>(initial);
  const [saved, setSaved] = useState<AudienceRecord | null>(record);
  const [issues, setIssues] = useState<readonly AudienceIssue[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fields: IssuesByField = byField(issues);
  const field = (key: keyof IssuesByField): string | undefined => fields[key];

  /** Save, and answer whether the audience is now stored. */
  const save = async (): Promise<boolean> => {
    setProblem(null);
    const described = audienceOf(draft);
    if (!described.ok) {
      setIssues(described.issues);
      return false;
    }
    setIssues([]);
    setSaving(true);
    const answer =
      saved === null
        ? await createAudience(described.audience)
        : await updateAudience(saved.id, described.audience);
    setSaving(false);

    if (answer.ok) {
      setSaved(answer.value);
      refreshAudiences();
      return true;
    }
    if (answer.kind === 'refused') {
      setIssues(answer.issues);
      return false;
    }
    setProblem(answer.problem);
    return false;
  };

  return (
    <form
      className={`${styles.form} card card-lg`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save().then((stored) => {
          if (stored) void navigate(paths.audiences);
        });
      }}
    >
      {problem === null ? null : (
        <p className="notice" role="alert">
          {problem} Nothing you typed has been lost — try again when it is back.
        </p>
      )}
      {issues.length === 0 ? null : (
        <p className="notice" role="alert" id={errorId}>
          {refusalSummary(issues)}
        </p>
      )}

      <div className={styles.fieldGroup}>
        <Label htmlFor={nameId}>Audience name</Label>
        <Input
          id={nameId}
          value={draft.name}
          aria-invalid={field('name') !== undefined}
          aria-describedby={nameHintId}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        {field('name') === undefined ? null : (
          <span className={styles.err} role="alert">
            {field('name')}
          </span>
        )}
        <span className={styles.hint} id={nameHintId}>
          What you call this group of customers. It appears above every verdict.
        </span>
      </div>

      <div className={styles.inline3}>
        <div className={styles.fieldGroup}>
          <Label htmlFor={ageMinId}>Age from</Label>
          <Input
            id={ageMinId}
            type="number"
            min={0}
            value={draft.ageMin}
            aria-invalid={field('ageMin') !== undefined || field('ageRange') !== undefined}
            onChange={(event) => setDraft({ ...draft, ageMin: event.target.value })}
          />
          {field('ageMin') === undefined ? null : (
            <span className={styles.err} role="alert">
              {field('ageMin')}
            </span>
          )}
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={ageMaxId}>Age to</Label>
          <Input
            id={ageMaxId}
            type="number"
            min={0}
            value={draft.ageMax}
            aria-invalid={field('ageMax') !== undefined || field('ageRange') !== undefined}
            onChange={(event) => setDraft({ ...draft, ageMax: event.target.value })}
          />
          {field('ageMax') === undefined ? null : (
            <span className={styles.err} role="alert">
              {field('ageMax')}
            </span>
          )}
          {field('ageRange') === undefined ? null : (
            <span className={styles.err} role="alert">
              {field('ageRange')}
            </span>
          )}
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={sizeId}>People per test</Label>
          <Select
            value={String(draft.size)}
            onValueChange={(value: string) => setDraft({ ...draft, size: Number(value) })}
          >
            <SelectTrigger id={sizeId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZE_CHOICES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} people
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className={styles.hint}>
            How many simulated people this audience generates. A test runs every one of them on both
            versions, across several seeds, so it records more sessions than people.
          </span>
        </div>
      </div>

      <ChipField
        legend="Who they are"
        hint="Roles name the generated people and group the results into segments."
        addLabel="+ Add a role"
        choice={draft.roles}
        onChange={(roles) => setDraft({ ...draft, roles })}
      />

      <ChipField
        legend="What they came to do"
        hint="Goals decide what the simulated people treat as relevant on a page — the engine’s top-down relevance input, unchanged."
        choice={draft.goals}
        onChange={(goals) => setDraft({ ...draft, goals })}
      />

      <div className={styles.inline2}>
        <DeviceField
          draft={draft}
          onChange={(devices) => setDraft({ ...draft, devices })}
          {...(field('devices') === undefined ? {} : { error: field('devices') })}
          errorId={`${errorId}-devices`}
        />
        <ChipField
          legend="Regions"
          addLabel="+ Add a region"
          choice={draft.regions}
          onChange={(regions) => setDraft({ ...draft, regions })}
        />
      </div>

      <BehaviourMeters
        techSavviness={draft.techSavviness}
        priceSensitivity={draft.priceSensitivity}
        onChange={(values) => setDraft({ ...draft, ...values })}
      />

      <GeneratedPeople
        people={saved?.people ?? []}
        seed={draft.seed}
        issues={saved?.issues ?? []}
        unsaved={saved === null}
      />

      <div className={styles.formfoot}>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save audience'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => {
            void save().then((stored) => {
              if (stored) void navigate(paths.newTest);
            });
          }}
        >
          Save and start a test
        </Button>
        <span className="faint">
          Changing an audience does not change a finished test: a test records the audience it ran
          with.
        </span>
      </div>
    </form>
  );
}
