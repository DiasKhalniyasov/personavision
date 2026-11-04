import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { siteName } from '@/screens/sites/words';
import { newTestStep } from '@/shell/paths';
import { createSite } from '@/sites/store';
import { refreshSites, useSites } from '@/sites/useSites';
import { EXAMPLE_TESTS } from './templates';
import type { WizardDraft } from './wizard/draft';
import type { ExampleTest } from './templates';
import type { SiteRecord } from '@/sites/store';
import styles from './examples.module.css';

/**
 * The five example tests, offered as cards — on `/new?step=path` under the two path cards,
 * and on the **No tests** state.
 *
 * One component for both, because the five are one feature reading one file
 * (`./templates.ts`): a screen that spelled a template would be a second place for the
 * owner's wording to drift. What the two surfaces differ in is **where the filled draft
 * goes**, which is the one thing passed in.
 *
 * A card is a **group with one real control**, as decision 94 settled it for the path cards
 * beside it: the card is read as a whole and one thing in it can be pressed. Five cards the
 * size of a button would be five ways to start a test by brushing against it.
 *
 * Pressing *Try this test* does, in order:
 *
 * 1. **the site record.** A workspace site whose address is this template's is reused;
 *    otherwise the template is added through `POST /sites` — the same route and the same
 *    refusals the Add-a-site form uses (`sites/store.ts`). **Nothing is half-filled**: a
 *    refusal is rendered in the card the user pressed, in the store's own words, and the
 *    draft is not touched.
 *
 *    A press **waits for the workspace's sites to be readable**, because a site cannot be
 *    reused before it is known and the platform does not refuse a URL a workspace already
 *    holds (`addSite`: *"the same URL added by two workspaces is two records"*) — so a press
 *    into an unread list would quietly add a second record for the same address. While the
 *    list is being read the control says so, in the words the audience step's own site
 *    chooser uses; a list that cannot be read at all states why, once, above the five.
 * 2. **the draft**, in one write: the site, the feature, the goal, and the audience
 *    *sentence* — which lands in the audience step's box and is read by that step's own
 *    control, never on the user's behalf.
 * 3. **`?step=audience`**, with every one of the four editable and nothing launched.
 *
 * The goal is carried as the **user's** (`author: 'user'`), with the moment it was chosen:
 * no model wrote it, the user chose it, and the goal step shows it exactly as it shows a
 * goal the user edited. `goalAuthorSchema` grows no third author for it (the auto-decision
 * of 2026-11-04 on #417).
 */

/** The section's own heading, which is all either screen says about the five. */
const OFFER = 'Or try one of these, on a real public site';

/** The one control on a card: what it says, and what it says while it is working. */
const TRY = 'Try this test';
const ADDING = 'Adding the site…';
/** While the workspace's sites are being read — the audience step's own words for it. */
const READING_SITES = 'Reading your sites…';
/** What an unreadable list of sites means for the five, beside the store's own sentence. */
const UNTIL_SITES_READ =
  'An example test adds its site to this workspace, so none of them can be started until ' +
  'your sites can be read.';

/** What a card says about the sentence under it: the audience it suggests, unread. */
const SUGGESTED = 'Suggested audience';

/**
 * Whether these two addresses are the same site.
 *
 * Compared as URLs rather than as strings, because the platform stores a URL as it was
 * typed: `https://www.ikea.com` and `https://www.ikea.com/` are one address written twice,
 * and adding the second to a workspace that holds the first is a refusal the user did not
 * ask for. Anything unparseable falls back to the strings, which is the honest answer about
 * a record this build cannot read.
 */
const sameSite = (one: string, other: string): boolean => {
  try {
    return new URL(one).href === new URL(other).href;
  } catch {
    return one === other;
  }
};

export function ExampleTests({
  /** Where the filled draft goes: the wizard's own `update`, or `fillWizardDraft`. */
  fill,
}: {
  fill: (patch: Partial<WizardDraft>) => void;
}) {
  const headingId = useId();
  const navigate = useNavigate();
  const sites = useSites();
  /**
   * The template being set up. **One press at a time, across all five**: the one that was
   * pressed says what it is doing and the other four are refused, because two presses would
   * be two sites and two drafts — and the slower of the two would write its own site,
   * feature and goal over the draft the user is already looking at.
   */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Why the site could not be added, and **which card was pressed**: one at a time, because
   * a refusal is the answer to a press and a reader makes one press at a time. It is
   * rendered in that card and nowhere else.
   */
  const [refusal, setRefusal] = useState<{
    readonly id: string;
    readonly message: string;
  } | null>(null);

  // A press is honoured only against a list that was read: see the note above.
  const known = sites.status === 'ready' ? sites.sites : null;

  const choose = async (template: ExampleTest): Promise<void> => {
    if (known === null || busy !== null) return;
    setRefusal(null);
    const existing = known.find((site) => sameSite(site.url, template.siteUrl));
    let site: SiteRecord;
    if (existing === undefined) {
      setBusy(template.id);
      const answer = await createSite(template.siteUrl);
      setBusy(null);
      if (!answer.ok) {
        // The store's own words, where the user pressed. The draft is left as it was: a
        // test about a site the workspace does not hold is not a test.
        setRefusal({
          id: template.id,
          message:
            answer.kind === 'refused'
              ? (answer.issues[0]?.message ?? 'That site could not be saved.')
              : answer.problem,
        });
        return;
      }
      // The workspace holds one more site than the remembered list does, and the next step
      // chooses among that list.
      refreshSites();
      site = answer.value;
    } else {
      site = existing;
    }

    fill({
      site: { id: site.id, url: site.url },
      feature: template.feature,
      // Waiting to be read, by the audience step's own control: a template is not a way
      // past decision 161's refusal, and `canLaunch` still waits for an audience the user
      // has seen.
      audienceSentence: template.audienceSentence,
      audience: null,
      goal: {
        task: template.task,
        success: template.successCriterion,
        author: 'user',
        writtenAt: new Date().toISOString(),
        // The site as the workspace holds it, so the goal step reads this as a goal about
        // this draft rather than asking Muse Wonder for another one.
        askedFor: { siteUrl: site.url, feature: template.feature },
      },
    });
    void navigate(newTestStep('audience'));
  };

  return (
    <section className={styles.examples} aria-labelledby={headingId}>
      <h2 className={styles.heading} id={headingId}>
        {OFFER}
      </h2>
      {sites.status === 'unreadable' ? (
        <p className="notice" role="alert">
          {sites.problem} {UNTIL_SITES_READ}
        </p>
      ) : null}
      <div className={styles.cards}>
        {EXAMPLE_TESTS.map((template) => (
          <ExampleCard
            key={template.id}
            template={template}
            reading={sites.status === 'loading'}
            busy={busy === template.id}
            // One press at a time, across all five, and none at all until the sites are read.
            refused={busy !== null || known === null}
            {...(refusal?.id === template.id ? { refusal: refusal.message } : {})}
            onChoose={() => {
              void choose(template);
            }}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One of the five: the host, what the test is about, the task in the user's own register,
 * the audience it suggests — and one control.
 *
 * The address is written through `siteName`, the way every other screen in the product
 * writes one, so the card reads `docs.stripe.com` rather than eleven characters of scheme
 * that are the same on all five.
 */
function ExampleCard({
  template,
  reading,
  busy,
  refused,
  refusal,
  onChoose,
}: {
  template: ExampleTest;
  /** The workspace's sites are still being read, which the control says rather than hides. */
  reading: boolean;
  /** This is the template being set up. */
  busy: boolean;
  /** Nothing may be pressed: another card is working, or the sites could not be read. */
  refused: boolean;
  refusal?: string;
  onChoose: () => void;
}) {
  const nameId = useId();

  return (
    <div className={`card ${styles.card}`} role="group" aria-labelledby={nameId}>
      <h3 className={styles.host} id={nameId}>
        {siteName(template.siteUrl)}
      </h3>
      <p className={styles.feature}>{template.feature}</p>
      <p className={styles.task}>{template.task}</p>
      <span className="microlabel">{SUGGESTED}</span>
      <p className={styles.audience}>{template.audienceSentence}</p>
      {refusal === undefined ? null : (
        <p className={`notice ${styles.refusal}`} role="alert">
          {refusal}
        </p>
      )}
      <Button
        size="sm"
        className={styles.control}
        disabled={busy || refused || reading}
        onClick={onChoose}
      >
        {busy ? ADDING : reading ? READING_SITES : TRY}
      </Button>
    </div>
  );
}
