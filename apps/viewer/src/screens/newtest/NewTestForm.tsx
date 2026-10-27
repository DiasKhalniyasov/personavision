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
import { AudiencePicker } from './AudiencePicker';
import { TestPeople } from './TestPeople';
import {
  attentionSummary,
  describedTest,
  emptyDraft,
  peopleCount,
  REPEAT_CHOICES,
  TASK_EXAMPLE,
  VARIANTS,
} from './draft';
import { startTest } from './start';
import styles from './newtest.module.css';
import type { IssuesByField, TestDraft } from './draft';
import type { AudienceRecord } from '@/screens/audience/store';

/**
 * The `.form` of `#screen-newrun`, and `#screen-newrun-invalid` when a field is refused.
 *
 * Three decisions — the audience, the two versions, the task — and the two settings that
 * change what the result can claim: the repeats, which are what produce the spread, and the
 * base seed, which is what makes the run reproducible. Every control is a shadcn primitive,
 * so the whole form is operable and submittable with the keyboard alone and each field has
 * a real label.
 *
 * What is refused is said twice: once above the form, where a reader who has just pressed
 * Start is looking, and once against the field it concerns. **Nothing is thrown away** —
 * the form keeps what was typed, because a reader who loses five fields to one missing
 * scheme does not type them again. And nothing is started: the request goes to the platform
 * only once every field is good.
 */
export function NewTestForm({
  audiences,
  loading,
  /** The audience the most recent test ran with, which is the one this form opens on. */
  defaultAudienceId,
}: {
  audiences: readonly AudienceRecord[];
  loading: boolean;
  defaultAudienceId: string;
}) {
  const navigate = useNavigate();
  // One id for the screen and a name per field under it: the fields the form itself owns.
  // The audience picker and the people grid hold their own.
  const base = useId();
  const id = (part: string): string => `${base}-${part}`;

  const [draft, setDraft] = useState<TestDraft>(emptyDraft);
  const [issues, setIssues] = useState<IssuesByField>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The audience the picker is on: what the reader chose, or the one the most recent test
  // used. Resolved on each render rather than seeded into the draft, so the default still
  // lands when the list arrives after the form — and an id this workspace no longer has
  // leaves the picker empty rather than naming an audience that is not there.
  const chosenId = draft.audienceId === '' ? defaultAudienceId : draft.audienceId;
  const chosen = audiences.find((record) => record.id === chosenId) ?? null;
  const people = chosen?.people ?? [];

  const start = async (): Promise<void> => {
    setProblem(null);
    const described = describedTest({ ...draft, audienceId: chosen?.id ?? '' });
    if (!described.ok) {
      setIssues(described.issues);
      return;
    }
    setIssues({});
    setStarting(true);
    const answer = await startTest(described.request);
    setStarting(false);
    if (answer.ok) {
      void navigate(paths.run(answer.runId));
      return;
    }
    setProblem(answer.problem);
  };

  // `form` is not a field, so it is not counted as one: a refusal that belongs to no field
  // is said above the form on its own rather than making the notice point at nothing.
  const refused = Object.keys(issues).filter((key) => key !== 'form').length;
  const describedBy = (part: string, message: string | undefined): string =>
    message === undefined ? id(`${part}-hint`) : `${id(`${part}-err`)} ${id(`${part}-hint`)}`;

  return (
    <form
      className={`${styles.form} card card-lg`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      {problem === null ? null : (
        <p className="notice" role="alert">
          {problem} Nothing you typed has been lost.
        </p>
      )}
      {refused === 0 && issues.form === undefined ? null : (
        <p className="notice" role="alert">
          {refused === 0 ? '' : `${attentionSummary(refused)} `}
          {issues.form ?? ''}
        </p>
      )}

      <AudiencePicker
        audiences={audiences}
        chosen={chosen}
        loading={loading}
        problem={issues.audience}
        onChoose={(recordId) => {
          setDraft({ ...draft, audienceId: recordId });
        }}
      />

      <div className={styles.inline2}>
        <div className={styles.fieldGroup}>
          <Label htmlFor={id('url-a')}>Variant A URL</Label>
          <Input
            id={id('url-a')}
            type="url"
            value={draft.urlA}
            aria-invalid={issues.urlA !== undefined}
            aria-describedby={describedBy('url-a', issues.urlA)}
            onChange={(event) => {
              setDraft({ ...draft, urlA: event.target.value });
            }}
          />
          {issues.urlA === undefined ? null : (
            <span className={styles.err} role="alert" id={id('url-a-err')}>
              {issues.urlA}
            </span>
          )}
          <span className={styles.hint} id={id('url-a-hint')}>
            Named <b>{VARIANTS[0].name}</b> in results.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={id('url-b')}>Variant B URL</Label>
          <Input
            id={id('url-b')}
            type="url"
            value={draft.urlB}
            aria-invalid={issues.urlB !== undefined}
            aria-describedby={describedBy('url-b', issues.urlB)}
            onChange={(event) => {
              setDraft({ ...draft, urlB: event.target.value });
            }}
          />
          {issues.urlB === undefined ? null : (
            <span className={styles.err} role="alert" id={id('url-b-err')}>
              {issues.urlB}
            </span>
          )}
          <span className={styles.hint} id={id('url-b-hint')}>
            Named <b>{VARIANTS[1].name}</b> in results.
          </span>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <Label htmlFor={id('task')}>Task</Label>
        <Input
          id={id('task')}
          type="text"
          value={draft.task}
          aria-invalid={issues.task !== undefined}
          aria-describedby={describedBy('task', issues.task)}
          onChange={(event) => {
            setDraft({ ...draft, task: event.target.value });
          }}
        />
        {issues.task === undefined ? null : (
          <span className={styles.err} role="alert" id={id('task-err')}>
            {issues.task}
          </span>
        )}
        <span className={styles.hint} id={id('task-hint')}>
          {issues.task === undefined
            ? 'One sentence, in the user’s words. It must say what counts as finishing — the simulated people stop when they believe the task is done.'
            : TASK_EXAMPLE}
        </span>
      </div>

      <TestPeople people={people} repeats={draft.repeats} variants={VARIANTS.length} />

      <div className={styles.inline2}>
        <div className={styles.fieldGroup}>
          <Label htmlFor={id('repeats')}>Repeats per persona</Label>
          <Select
            value={String(draft.repeats)}
            onValueChange={(value) => {
              setDraft({ ...draft, repeats: Number(value) });
            }}
          >
            <SelectTrigger
              id={id('repeats')}
              className="w-full"
              aria-describedby={id('repeats-hint')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPEAT_CHOICES.map((choice) => (
                <SelectItem key={choice.repeats} value={String(choice.repeats)}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className={styles.hint} id={id('repeats-hint')}>
            Each person repeats the task this many times, on a different seed. This is what produces
            the spread the verdict is stated with.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={id('seed')}>Base seed</Label>
          <Input
            id={id('seed')}
            type="text"
            inputMode="numeric"
            value={draft.seed}
            aria-invalid={issues.seed !== undefined}
            aria-describedby={describedBy('seed', issues.seed)}
            onChange={(event) => {
              setDraft({ ...draft, seed: event.target.value });
            }}
          />
          {issues.seed === undefined ? null : (
            <span className={styles.err} role="alert" id={id('seed-err')}>
              {issues.seed}
            </span>
          )}
          <span className={styles.hint} id={id('seed-hint')}>
            Same seed and same persona reproduce the run exactly.
          </span>
        </div>
      </div>

      <div className={styles.formfoot}>
        <Button type="submit" size="lg" disabled={starting}>
          {starting ? 'Starting…' : `Start test · ${peopleCount(people.length)}`}
        </Button>
        {refused === 0 && problem === null ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(emptyDraft());
              setIssues({});
              setProblem(null);
            }}
          >
            Reset
          </Button>
        )}
        <span className="faint">
          You can leave this page; we will have the verdict when you come back.
        </span>
      </div>
    </form>
  );
}
