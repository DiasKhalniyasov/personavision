import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
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
import { Textarea } from '@/components/ui/textarea';
import { audienceFromSentence, readAudience, updateAudience } from '@/screens/audience/store';
import { capWords, siteName } from '@/screens/sites/words';
import { newTestStep, paths } from '@/shell/paths';
import { useAudiences } from '@/shell/useAudiences';
import { useSites } from '@/sites/useSites';
import { useWizardDraft } from '../draft';
import {
  audienceWithEdits,
  byField,
  FIELD_KEYS,
  FIELD_LABELS,
  TECH_CHOICES,
  textsOf,
} from './fields';
import styles from './audience.module.css';
import type { AudienceIssue, AudienceRecord } from '@/screens/audience/store';
import type { SiteRecord } from '@/sites/store';
import type { FieldKey, FieldTexts } from './fields';

/**
 * `/new?step=audience` — **who should try it, and what should they try?**
 *
 * `#screen-newtest-feature` of `docs/design/prototype.html`: the site, the feature in the
 * user's own words, and the audience as one sentence — and then **what that sentence became**,
 * as six fields the user can disagree with. The prototype draws the audience and the feature
 * as one screen, which is why `?step=feature` resolves here (`../steps.ts`).
 *
 * Three things this screen must not do, each of them `docs/FLOW.md` section 12 in a line:
 *
 * - **It never launches a sentence.** *A free-text audience that launches without having
 *   been shown to the user is a bug and not a shortcut* — so the draft's `reviewed` flag is
 *   set here, when the structured audience is on the screen, and `canLaunch` is false until
 *   it is (`../draft.ts`). The launch step reads the flag and invents no rule of its own.
 * - **It never normalises the feature sentence.** What is typed is what the draft carries,
 *   case and punctuation and all: it is the user's own words about their own product, and
 *   the goal a model writes from it is read back on the next step.
 * - **It never presents an audience nobody wrote.** A sentence the platform could not read
 *   is one sentence the reader can act on, with the structured form as the way on, and the
 *   second card is not drawn at all.
 *
 * The audience arrives in **one call** and arrives stored (`screens/audience/store.ts`'s
 * `audienceFromSentence`), so the six fields are an edit to a record rather than a draft the
 * platform has not seen. The edit is sent when the reader goes on to the goal: shares that
 * are not a distribution are refused there, at the field they are on, in the platform's own
 * words (decision 22) — and nothing is saved.
 */

/** The second card's own words, which say what it is before it says what is in it. */
const READ_FROM_SENTENCE = 'What we read from that sentence — edit anything';

/** What the seed buys, in the prototype's words: it is why next month compares like with like. */
const SEED_FOOTNOTE =
  'This is the audience object the personas are generated from, from a seed: the same audience ' +
  'and the same seed always produce the same hundred people, so next month’s test compares ' +
  'like with like.';

/** The second control under the sentence, in the prototype's words. */
const SAVED_AUDIENCE = 'Use a saved audience instead';

/** The sentence a reader gets when the platform could not read theirs. */
const UNREADABLE = 'We could not read your audience from that sentence.';

export function AudienceStep() {
  const { draft, update } = useWizardDraft();
  const navigate = useNavigate();
  const sites = useSites();

  /** The sentence in the box. The draft keeps the one that produced the audience below. */
  const [sentence, setSentence] = useState<string>(draft.audience?.sentence ?? '');
  /** The audience as it is stored, which is what the six fields are an edit to. */
  const [record, setRecord] = useState<AudienceRecord | null>(null);
  /** The six lines as they stand. `null` is a reader who has described nobody yet. */
  const [texts, setTexts] = useState<FieldTexts | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<readonly AudienceIssue[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const siteId = draft.site?.id ?? null;
  const chosen =
    sites.status === 'ready' ? (sites.sites.find((site) => site.id === siteId) ?? null) : null;

  // The workspace's first site, for a reader who arrives with none chosen — and for one
  // whose draft names a site that is no longer in the workspace, since a site can be
  // removed on `/sites/:siteId` while a draft naming it is still in this browser. Without
  // the second case the chooser shows its "Reading your sites…" placeholder over a list
  // that is read, and the launch below goes out against an id nobody can see.
  useEffect(() => {
    if (sites.status !== 'ready') return;
    if (siteId !== null && sites.sites.some((site) => site.id === siteId)) return;
    const first = sites.sites[0];
    if (first !== undefined) update({ site: { id: first.id, url: first.url } });
  }, [siteId, sites, update]);

  // A reader who comes back to this step — from the goal, or after a reload — is shown the
  // audience they reviewed, read again rather than remembered, because it is stored.
  const storedId = draft.audience?.audienceId ?? null;
  useEffect(() => {
    // `record?.id !== storedId` rather than `record === null`: the draft can come to name a
    // *different* audience — a saved one picked after a sentence was read — and the six
    // fields then have to be that one's rather than the one already loaded.
    if (storedId === null || record?.id === storedId) return;
    let live = true;
    void readAudience(storedId).then((answer) => {
      if (!live || !answer.ok) return;
      setRecord(answer.value);
      setTexts(textsOf(answer.value.audience));
    });
    return () => {
      live = false;
    };
  }, [record, storedId]);

  /** The one call: the sentence in, one stored audience out. */
  const read = async (): Promise<void> => {
    setProblem(null);
    setIssues([]);
    setReading(true);
    const answer = await audienceFromSentence(sentence);
    setReading(false);
    if (!answer.ok) {
      // Every way this can fail is one sentence the reader can act on. An audience is never
      // half-drawn from a reply nobody could read, so the card below stays as it was.
      setProblem(answer.kind === 'refused' ? (answer.issues[0]?.message ?? '') : answer.problem);
      return;
    }
    setRecord(answer.value);
    setTexts(textsOf(answer.value.audience));
    // Shown to the user, which is the one thing a launch waits for.
    update({
      audience: { sentence, audienceId: answer.value.id, reviewed: true },
    });
  };

  /** The edit, and then the goal. Refused, it stays here with the refusal on the field. */
  const save = async (): Promise<void> => {
    if (record === null || texts === null) return;
    setProblem(null);
    const edited = audienceWithEdits(record.audience, texts);
    if (!edited.ok) {
      setIssues(edited.issues);
      return;
    }
    setIssues([]);
    setSaving(true);
    const answer = await updateAudience(record.id, edited.audience);
    setSaving(false);
    if (answer.ok) {
      setRecord(answer.value);
      setTexts(textsOf(answer.value.audience));
      void navigate(newTestStep('goal'));
      return;
    }
    if (answer.kind === 'refused') {
      setIssues(answer.issues);
      return;
    }
    setProblem(answer.problem);
  };

  const fields = byField(issues);

  return (
    <>
      <div className="pagehead">
        <h1>Who should try it, and what should they try?</h1>
      </div>

      <form
        className={`${styles.form} card card-lg`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void read();
        }}
      >
        <SiteField
          sites={sites.status === 'ready' ? sites.sites : []}
          unreadable={sites.status === 'unreadable' ? sites.problem : null}
          loading={sites.status === 'loading'}
          chosen={chosen}
          onChoose={(site) => {
            update({ site: { id: site.id, url: site.url } });
          }}
        />

        <FeatureField
          feature={draft.feature}
          onChange={(feature) => {
            // Exactly as typed: no trim, no case, no punctuation of ours.
            update({ feature });
          }}
        />

        <SentenceField
          sentence={sentence}
          reading={reading}
          problem={problem}
          onChange={setSentence}
        />
      </form>

      {texts === null && !reading ? null : (
        <ReadAudience
          name={record?.audience.name ?? ''}
          texts={texts}
          fields={fields}
          busy={reading}
          saving={saving}
          onEdit={(key, value) => {
            // The sentence is not read again: an edit changes what would be saved, and the
            // model is not asked to make something else of a sentence nobody retyped.
            if (texts !== null) setTexts({ ...texts, [key]: value });
          }}
          onGoOn={() => {
            void save();
          }}
        />
      )}
    </>
  );
}

/**
 * The site this test is against, chosen among the workspace's own, with **the URL it is and
 * what it allows** under it.
 *
 * The address is written the way every other screen writes it, through `siteName` — which
 * drops the scheme and **any user and password in the URL**, because a step a reader is
 * about to launch from is read over a shoulder and a screenshot keeps what is on it
 * (`screens/sites/words`). The platform stores a URL carrying credentials as given, so the
 * raw `url` is not what a screen prints. The figures beside it are the platform's, on the
 * site's answer. **Nothing here is about who controls the address**, because a site is a URL
 * and nothing more (`docs/FLOW.md` section 13).
 *
 * A workspace with no site is not offered an empty list: it is pointed at `/sites/new`,
 * because there is nothing to test until there is a site.
 */
function SiteField({
  sites,
  unreadable,
  loading,
  chosen,
  onChoose,
}: {
  sites: readonly SiteRecord[];
  unreadable: string | null;
  loading: boolean;
  chosen: SiteRecord | null;
  onChoose: (site: SiteRecord) => void;
}) {
  const fieldId = useId();
  const footId = useId();

  if (unreadable !== null) {
    return (
      <div className={styles.fieldGroup}>
        <span className={styles.groupLabel}>Site</span>
        <p className="notice" role="alert">
          {unreadable}
        </p>
      </div>
    );
  }

  if (!loading && sites.length === 0) {
    return (
      <div className={styles.fieldGroup}>
        <span className={styles.groupLabel}>Site</span>
        <p className="notice" role="alert">
          This workspace has no site yet. <Link to={paths.newSite}>Add the site</Link> you want
          tested, and come back.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.fieldGroup}>
      <Label htmlFor={fieldId}>Site</Label>
      <Select
        value={chosen?.id ?? ''}
        disabled={loading}
        onValueChange={(id: string) => {
          const picked = sites.find((site) => site.id === id);
          if (picked !== undefined) onChoose(picked);
        }}
      >
        <SelectTrigger id={fieldId} className="w-full" aria-describedby={footId}>
          <SelectValue placeholder="Reading your sites…" />
        </SelectTrigger>
        <SelectContent>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>
              {siteName(site.url)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="footnote" id={footId}>
        {chosen === null
          ? 'Which of your sites the hundred people are put through.'
          : `${siteName(chosen.url)} · ${capWords(chosen.caps)}.`}
      </p>
    </div>
  );
}

/** The feature, in the user's words, kept as they wrote them. */
function FeatureField({
  feature,
  onChange,
}: {
  feature: string;
  onChange: (feature: string) => void;
}) {
  const fieldId = useId();
  const footId = useId();

  return (
    <div className={styles.fieldGroup}>
      <Label htmlFor={fieldId}>The feature whose experience you want tested</Label>
      <Textarea
        id={fieldId}
        rows={2}
        value={feature}
        aria-describedby={footId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p className="footnote" id={footId}>
        Your sentence, kept as you wrote it. “checking out with a promo code”, “signing up with
        Google”, “finding the refund policy” all work.
      </p>
    </div>
  );
}

/**
 * The audience in a sentence, and the two controls under it.
 *
 * The second control is a **picker**, not a way off this screen: the saved audience has to
 * land in the same six fields, so that a reader who chose one can disagree with it exactly
 * as they can with one a sentence became. A workspace with no saved audience is offered the
 * structured form instead, which is the one thing there is to offer.
 */
function SentenceField({
  sentence,
  reading,
  problem,
  onChange,
}: {
  sentence: string;
  reading: boolean;
  problem: string | null;
  onChange: (sentence: string) => void;
}) {
  const fieldId = useId();
  const errId = useId();

  return (
    <div className={styles.fieldGroup}>
      <Label htmlFor={fieldId}>Describe your audience in a sentence — or pick a saved one</Label>
      <Textarea
        id={fieldId}
        rows={2}
        value={sentence}
        aria-invalid={problem !== null}
        {...(problem === null ? {} : { 'aria-describedby': errId })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {problem === null ? null : (
        <span className={styles.err} role="alert" id={errId}>
          {UNREADABLE} {problem} <Link to={paths.newAudience}>Describe them on the form</Link>{' '}
          instead.
        </span>
      )}
      <div className={styles.formfoot}>
        <Button type="submit" size="sm" disabled={reading || sentence.trim() === ''}>
          {reading ? 'Reading your sentence…' : 'Turn this into an audience'}
        </Button>
        <SavedAudience />
      </div>
    </div>
  );
}

/** `Use a saved audience instead`: the workspace's audiences, in place. */
function SavedAudience() {
  const audiences = useAudiences();
  const { update } = useWizardDraft();
  const saved = audiences.status === 'ready' ? audiences.audiences : [];
  const fieldId = useId();

  if (saved.length === 0) {
    return <Link to={paths.audiences}>{SAVED_AUDIENCE}</Link>;
  }

  return (
    <Select
      value=""
      onValueChange={(id: string) => {
        const picked = saved.find((candidate) => candidate.id === id);
        if (picked === undefined) return;
        // A saved audience has been described and read by its own screen, so choosing one
        // is the same reviewed state as reading a sentence: the fields below are its.
        update({ audience: { sentence: '', audienceId: picked.id, reviewed: true } });
      }}
    >
      {/*
       * `role="combobox"` takes no name from its own content, so the placeholder a reader
       * sees is stated as the label too: without it the control is a box with no name.
       */}
      <SelectTrigger
        id={fieldId}
        className={styles.savedPicker}
        size="sm"
        aria-label={SAVED_AUDIENCE}
      >
        <SelectValue placeholder={SAVED_AUDIENCE} />
      </SelectTrigger>
      <SelectContent>
        {saved.map((candidate) => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {candidate.audience.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The second card: what the sentence became, as six fields.
 *
 * While the sentence is being read the card renders **its frame** — the label, the six
 * fields and the footnote — so the layout does not move when the audience arrives. It is
 * never drawn empty before a sentence has been described: there is nothing to disagree with
 * yet, and a card of blank fields would read as an audience of nobody.
 */
function ReadAudience({
  name,
  texts,
  fields,
  busy,
  saving,
  onEdit,
  onGoOn,
}: {
  name: string;
  texts: FieldTexts | null;
  fields: Readonly<Partial<Record<FieldKey | 'form', string>>>;
  busy: boolean;
  saving: boolean;
  onEdit: (key: FieldKey, value: string) => void;
  onGoOn: () => void;
}) {
  const labelId = useId();
  const footId = useId();

  return (
    <section className="card card-lg" aria-labelledby={labelId} aria-busy={busy}>
      <span className="microlabel">{READ_FROM_SENTENCE}</span>
      <h2 className={`${styles.audienceName} ${busy ? styles.reading : ''}`} id={labelId}>
        {busy ? 'Reading your sentence…' : name}
      </h2>
      {fields.form === undefined ? null : (
        <p className="notice" role="alert">
          {fields.form}
        </p>
      )}
      <div className={styles.segbar}>
        {FIELD_KEYS.map((key) => (
          <ReadField
            key={key}
            field={key}
            value={texts?.[key] ?? ''}
            busy={busy}
            {...(fields[key] === undefined ? {} : { error: fields[key] as string })}
            onEdit={(value) => {
              onEdit(key, value);
            }}
          />
        ))}
      </div>
      <p className="footnote" id={footId}>
        {SEED_FOOTNOTE}
      </p>
      <div className={styles.formfoot}>
        <Button type="button" disabled={busy || saving || texts === null} onClick={onGoOn}>
          {saving ? 'Saving…' : 'Write the goal'}
        </Button>
      </div>
    </section>
  );
}

/**
 * One of the six. Five are a line of text, because that is what the prototype draws and what
 * a share of an audience reads as; how tech-confident they are takes one of three answers,
 * and a field with three answers is a `select` rather than a sentence to spell correctly.
 */
function ReadField({
  field,
  value,
  busy,
  error,
  onEdit,
}: {
  field: FieldKey;
  value: string;
  busy: boolean;
  error?: string;
  onEdit: (value: string) => void;
}) {
  const fieldId = useId();
  const errId = useId();
  const described = error === undefined ? {} : { 'aria-describedby': errId };

  return (
    <div className={styles.fieldGroup}>
      <Label htmlFor={fieldId}>{FIELD_LABELS[field]}</Label>
      {field === 'tech' ? (
        <Select value={value} disabled={busy} onValueChange={onEdit}>
          <SelectTrigger
            id={fieldId}
            className="w-full"
            aria-invalid={error !== undefined}
            {...described}
          >
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {TECH_CHOICES.map((choice) => (
              <SelectItem key={choice.text} value={choice.text}>
                {choice.text}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={fieldId}
          type={field === 'size' ? 'number' : 'text'}
          {...(field === 'size' ? { min: 1 } : {})}
          value={value}
          disabled={busy}
          aria-invalid={error !== undefined}
          {...described}
          onChange={(event) => {
            onEdit(event.target.value);
          }}
        />
      )}
      {error === undefined ? null : (
        <span className={styles.err} role="alert" id={errId}>
          {error}
        </span>
      )}
    </div>
  );
}
