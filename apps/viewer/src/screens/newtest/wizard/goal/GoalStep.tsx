import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { newTestStep } from '@/shell/paths';
import { useWizardDraft } from '../draft';
import type { WizardDraft } from '../draft';
import { askForGoal } from './goal';
import { authorNotice, BEING_WRITTEN, nothingToWriteFrom } from './words';
import styles from './goal.module.css';

/**
 * `/new?step=goal` — **this is what the hundred of them will try to do**.
 *
 * `#screen-newtest-goal` of `docs/design/prototype.html`: the two sentences Muse Wonder
 * writes from the site and from the user's own words about the feature (`docs/FLOW.md`
 * section 12), as two editable fields, with the line that says who last wrote them.
 *
 * Three things are load-bearing here:
 *
 * 1. **The edited text is what the run records, and the run records who last wrote it.** The
 *    fields are the draft and not local state: the first keystroke in either of them takes
 *    the authorship over — on screen, before the user moves on — and that is what the draft
 *    carries to the launch step. A completion rate is only as meaningful as the criterion
 *    behind it, so a reader a month later has to be able to see which of the two wrote it.
 * 2. **The step is never a dead end.** Wonder twice unable to state an observable criterion
 *    is a refusal (`packages/provider/src/wonder-goal.ts`), and so is a platform that could
 *    not be reached. Either way the reason is rendered as it was given — decision 117, as
 *    the owner settled it — and both fields are left editable and submittable, so the goal
 *    can be written by hand. A refused *re-ask* keeps the wording that was already there: a
 *    user who asked for another wording did not ask to lose the one they had.
 * 3. **A goal is about one site and one sentence.** What the model was told is stored on the
 *    draft beside its answer, so going back a step and changing the feature sentence asks
 *    again rather than carrying forward a goal about something else.
 *
 * Nothing on this screen moves but the pulse on the two fields while the goal is being
 * written, which is `pv-pulse` from the tokens — and the tokens flatten it under
 * `prefers-reduced-motion`, so the step is complete and still there without a rule of its own.
 */

/** The goal the draft carries, as this step's fields hold it. */
type DraftGoal = NonNullable<WizardDraft['goal']>;

/** What the model is told, and what makes a stored goal this draft's goal. */
interface GoalSubject {
  readonly siteUrl: string;
  readonly feature: string;
}

/** The site and the sentence a goal would be written from, or `null` for a draft with neither. */
const subjectOf = (draft: WizardDraft): GoalSubject | null =>
  draft.site === null || draft.feature.trim() === ''
    ? null
    : { siteUrl: draft.site.url, feature: draft.feature };

/**
 * The goal in the draft, **if it is a goal about this draft**.
 *
 * A stored goal written for another site or another sentence is not this test's goal and is
 * read as absent, so the step asks again. It is compared here rather than cleared on the way
 * out of the previous step, because the step that changed the sentence is not the step that
 * knows what a goal was written for.
 */
const goalOfThisDraft = (draft: WizardDraft): DraftGoal | null => {
  const subject = subjectOf(draft);
  if (subject === null || draft.goal === null) return null;
  const { askedFor } = draft.goal;
  return askedFor.siteUrl === subject.siteUrl && askedFor.feature === subject.feature
    ? draft.goal
    : null;
};

/** The notice under the two fields: its claim, which is set in bold, and why it matters. */
interface Notice {
  readonly claim: string;
  readonly because: string;
}

/** Nobody has written this goal: the model refused or could not be reached, and nothing is typed. */
const UNWRITTEN: Notice = {
  claim: 'Nobody has written this goal yet.',
  because:
    'Write a task and a success criterion, and the test records you as the author of the goal.',
};

export function GoalStep() {
  const { draft, update } = useWizardDraft();
  const navigate = useNavigate();
  const taskId = useId();
  const successId = useId();
  const footnoteId = useId();

  const subject = subjectOf(draft);
  const goal = goalOfThisDraft(draft);

  // The goal is asked for on the first paint when there is something to ask about and nothing
  // written yet, so the frame arrives with its fields already pending rather than blank and
  // then suddenly busy.
  const [writing, setWriting] = useState(() => subject !== null && goal === null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** What has already been asked for, so one draft never asks about itself twice. */
  const asked = useRef<string | null>(null);

  const write = useCallback(
    async (about: GoalSubject) => {
      setWriting(true);
      setRefusal(null);
      const answer = await askForGoal(about);
      setWriting(false);
      if (!answer.ok) {
        // The wording that was already there is left alone: a refused re-ask takes nothing
        // away, and a refused first ask had nothing to take.
        setRefusal(answer.reason);
        return;
      }
      update({
        goal: {
          task: answer.value.task,
          success: answer.value.successCriterion,
          author: answer.value.lastWrittenBy,
          // The instant it arrived, which is the instant it was written to within the time of
          // one request. The platform answers the contract's `Goal` and the contract has no
          // field for when — asking it to grow one for a line on one screen would be a
          // second statement of the same fact, and the one that matters here is **who**.
          writtenAt: new Date().toISOString(),
          askedFor: about,
        },
      });
    },
    [update],
  );

  // One ask per draft. A refusal leaves the subject marked as asked, because its answer is on
  // the screen: asking again is the button that says so, and not a render.
  useEffect(() => {
    if (subject === null || goal !== null) return;
    const key = `${subject.siteUrl}\n${subject.feature}`;
    if (asked.current === key) return;
    asked.current = key;
    void write(subject);
  }, [subject, goal, write]);

  /** The user's own words, in either field: the authorship is theirs from here on. */
  const edit = (field: 'task' | 'success', value: string): void => {
    if (subject === null) return;
    update({
      goal: {
        task: field === 'task' ? value : (goal?.task ?? ''),
        success: field === 'success' ? value : (goal?.success ?? ''),
        author: 'user',
        writtenAt: new Date().toISOString(),
        askedFor: subject,
      },
    });
  };

  // No site, or no sentence: the model is asked for nothing, and the user is sent back to the
  // step that collects both rather than left in front of a form that cannot be filled in.
  if (subject === null) {
    return (
      <>
        <div className="pagehead">
          <h1>This is what the hundred of them will try to do</h1>
        </div>
        <p className="lede">
          {nothingToWriteFrom(draft.site !== null, draft.feature.trim() !== '')}
        </p>
        <div className={styles.back}>
          <Button asChild>
            <Link to={newTestStep('audience')}>Describe the audience and the feature</Link>
          </Button>
        </div>
      </>
    );
  }

  const notice: Notice = writing
    ? { claim: BEING_WRITTEN, because: '' }
    : goal === null
      ? UNWRITTEN
      : authorNotice(goal.author, goal.writtenAt);

  return (
    <>
      <div className="pagehead">
        <h1>This is what the hundred of them will try to do</h1>
      </div>
      <p className="lede">
        Written by Muse Wonder from your URL and your sentence. Read it, change anything, and it is
        the edited text the test records.
      </p>

      <form
        className={`form card card-lg ${styles.form}`}
        onSubmit={(event) => {
          event.preventDefault();
          // Both halves are `required` markup, so a browser refuses the submission with its
          // own message before it reaches here. A step that moved on without a criterion
          // would be a hundred agents scored against nothing.
          if (goal === null || goal.task.trim() === '' || goal.success.trim() === '') return;
          void navigate(newTestStep('estimate'));
        }}
      >
        {refusal !== null && (
          <p className="notice" role="alert">
            {refusal}
          </p>
        )}

        <div className={styles.fieldGroup}>
          <Label htmlFor={taskId}>The task each person attempts</Label>
          <Textarea
            id={taskId}
            rows={2}
            required
            value={writing ? '' : (goal?.task ?? '')}
            // Read-only rather than disabled: a disabled field leaves the tab order, so the
            // focus ring would land somewhere else while the goal is being written and
            // somewhere else again when it arrives.
            readOnly={writing}
            aria-busy={writing}
            className={writing ? styles.pending : undefined}
            onChange={(event) => {
              edit('task', event.target.value);
            }}
          />
        </div>

        <div className={styles.fieldGroup}>
          <Label htmlFor={successId}>What counts as success</Label>
          <Textarea
            id={successId}
            rows={2}
            required
            value={writing ? '' : (goal?.success ?? '')}
            readOnly={writing}
            aria-busy={writing}
            aria-describedby={footnoteId}
            className={writing ? styles.pending : undefined}
            onChange={(event) => {
              edit('success', event.target.value);
            }}
          />
          <p className="footnote" id={footnoteId}>
            It has to be something we can see in the page &mdash; an element, a URL or a piece of
            text. &ldquo;The user is happy&rdquo; is not a success criterion, and Wonder is asked
            again until it names one we can observe.
          </p>
        </div>

        {/*
         * The authorship line, and the one thing on this screen a reader is told about without
         * looking for it: a live region, so taking the authorship over is announced rather
         * than only seen. It is always in the document, because an announcement is made by
         * changing a region that was already there and not by inserting one.
         */}
        <div className="notice info" role="status">
          <span>
            <b>{notice.claim}</b>
            {notice.because === '' ? null : ` ${notice.because}`}
          </span>
        </div>

        <div className={styles.formfoot}>
          <Button type="submit" disabled={writing}>
            Looks right &mdash; see the estimate
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={writing}
            onClick={() => {
              void write(subject);
            }}
          >
            Ask for another wording
          </Button>
        </div>
      </form>
    </>
  );
}
