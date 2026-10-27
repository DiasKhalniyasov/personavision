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
  const audienceId = useId();
  const audienceHintId = useId();
  const audienceErrId = useId();
  const urlAId = useId();
  const urlAHintId = useId();
  const urlAErrId = useId();
  const urlBId = useId();
  const urlBHintId = useId();
  const urlBErrId = useId();
  const taskId = useId();
  const taskHintId = useId();
  const taskErrId = useId();
  const peopleLabelId = useId();
  const repeatsId = useId();
  const repeatsHintId = useId();
  const seedId = useId();
  const seedHintId = useId();
  const seedErrId = useId();
  const noticeId = useId();

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

  const refused = Object.keys(issues).length;
  const describedBy = (hintId: string, errId: string, message: string | undefined): string =>
    message === undefined ? hintId : `${errId} ${hintId}`;

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
          {problem} Nothing you typed has been lost — try again when it is back.
        </p>
      )}
      {refused === 0 ? null : (
        <p className="notice" role="alert" id={noticeId}>
          {attentionSummary(refused)}
          {issues.form === undefined ? null : ` ${issues.form}`}
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
        fieldId={audienceId}
        hintId={audienceHintId}
        errId={audienceErrId}
      />

      <div className={styles.inline2}>
        <div className={styles.fieldGroup}>
          <Label htmlFor={urlAId}>Variant A URL</Label>
          <Input
            id={urlAId}
            type="url"
            value={draft.urlA}
            aria-invalid={issues.urlA !== undefined}
            aria-describedby={describedBy(urlAHintId, urlAErrId, issues.urlA)}
            onChange={(event) => {
              setDraft({ ...draft, urlA: event.target.value });
            }}
          />
          {issues.urlA === undefined ? null : (
            <span className={styles.err} role="alert" id={urlAErrId}>
              {issues.urlA}
            </span>
          )}
          <span className={styles.hint} id={urlAHintId}>
            Named <b>{VARIANTS[0].name}</b> in results.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={urlBId}>Variant B URL</Label>
          <Input
            id={urlBId}
            type="url"
            value={draft.urlB}
            aria-invalid={issues.urlB !== undefined}
            aria-describedby={describedBy(urlBHintId, urlBErrId, issues.urlB)}
            onChange={(event) => {
              setDraft({ ...draft, urlB: event.target.value });
            }}
          />
          {issues.urlB === undefined ? null : (
            <span className={styles.err} role="alert" id={urlBErrId}>
              {issues.urlB}
            </span>
          )}
          <span className={styles.hint} id={urlBHintId}>
            Named <b>{VARIANTS[1].name}</b> in results.
          </span>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <Label htmlFor={taskId}>Task</Label>
        <Input
          id={taskId}
          type="text"
          value={draft.task}
          aria-invalid={issues.task !== undefined}
          aria-describedby={describedBy(taskHintId, taskErrId, issues.task)}
          onChange={(event) => {
            setDraft({ ...draft, task: event.target.value });
          }}
        />
        {issues.task === undefined ? null : (
          <span className={styles.err} role="alert" id={taskErrId}>
            {issues.task}
          </span>
        )}
        <span className={styles.hint} id={taskHintId}>
          {issues.task === undefined
            ? 'One sentence, in the user’s words. It must say what counts as finishing — the simulated people stop when they believe the task is done.'
            : TASK_EXAMPLE}
        </span>
      </div>

      <TestPeople
        people={people}
        repeats={draft.repeats}
        variants={VARIANTS.length}
        labelId={peopleLabelId}
      />

      <div className={styles.inline2}>
        <div className={styles.fieldGroup}>
          <Label htmlFor={repeatsId}>Repeats per persona</Label>
          <Select
            value={String(draft.repeats)}
            onValueChange={(value) => {
              setDraft({ ...draft, repeats: Number(value) });
            }}
          >
            <SelectTrigger
              id={repeatsId}
              className={styles.picker}
              aria-describedby={repeatsHintId}
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
          <span className={styles.hint} id={repeatsHintId}>
            Each person repeats the task this many times, on a different seed. This is what produces
            the spread the verdict is stated with.
          </span>
        </div>
        <div className={styles.fieldGroup}>
          <Label htmlFor={seedId}>Base seed</Label>
          <Input
            id={seedId}
            type="text"
            inputMode="numeric"
            value={draft.seed}
            aria-invalid={issues.seed !== undefined}
            aria-describedby={describedBy(seedHintId, seedErrId, issues.seed)}
            onChange={(event) => {
              setDraft({ ...draft, seed: event.target.value });
            }}
          />
          {issues.seed === undefined ? null : (
            <span className={styles.err} role="alert" id={seedErrId}>
              {issues.seed}
            </span>
          )}
          <span className={styles.hint} id={seedHintId}>
            Same seed and same persona reproduce the run exactly.
          </span>
        </div>
      </div>

      <div className={styles.formfoot}>
        <Button type="submit" size="lg" disabled={starting}>
          {starting
            ? 'Starting…'
            : `Start test · ${String(people.length)} ${people.length === 1 ? 'person' : 'people'}`}
        </Button>
        <span className="faint">
          You can leave this page; we will have the verdict when you come back.
        </span>
      </div>
    </form>
  );
}
