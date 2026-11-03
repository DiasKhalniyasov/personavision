import { useCallback, useState } from 'react';
import { z } from 'zod';

/**
 * The New test wizard's draft: what the four steps fill in, and what survives a reload.
 *
 * One object, in one place, because the steps are sections of one screen: the site the test
 * is about, the user's own sentence about the feature, the audience **and whether the user
 * has seen it**, and the goal with who last wrote it (`docs/FLOW.md` sections 11 and 12).
 *
 * `canLaunch` is here rather than on the launch screen. FLOW section 12 is explicit that an
 * audience which has not been shown to the user cannot launch — *a free-text audience that
 * launches without having been shown to the user is a bug and not a shortcut* — so the rule
 * is stated once, against the draft, and the launch step reads the flag.
 *
 * ponytail: `sessionStorage`, one key, parsed through the schema below. It is per tab and
 * per browser, which is what a reload and a mistyped URL need; a draft that has to follow a
 * user to another device is a platform record and belongs behind an API, not here.
 */

/** Who last wrote the goal — the model or the user — which a run records (section 12). */
export const GOAL_AUTHORS = ['model', 'user'] as const;

const draftSchema = z.object({
  /** The site under test: a record in the workspace, with the URL the feature starts on. */
  site: z.object({ id: z.string(), url: z.string() }).nullable(),
  /** The feature whose experience is being tested, in the user's words, as they wrote it. */
  feature: z.string(),
  audience: z
    .object({
      /** The sentence the user described the audience in, if they used one. */
      sentence: z.string(),
      /** The audience record the test runs with, once there is one. */
      audienceId: z.string(),
      /** Whether the user has **seen** what that became. Nothing launches until they have. */
      reviewed: z.boolean(),
    })
    .nullable(),
  goal: z
    .object({
      task: z.string(),
      success: z.string(),
      author: z.enum(GOAL_AUTHORS),
    })
    .nullable(),
});

export type WizardDraft = z.infer<typeof draftSchema>;

/** A first visit: nothing chosen, nothing written, nothing reviewed. */
export const emptyWizardDraft = (): WizardDraft => ({
  site: null,
  feature: '',
  audience: null,
  goal: null,
});

/**
 * Whether this draft may be launched.
 *
 * One rule: the audience has been reviewed. The launch step reads this and invents no rule
 * of its own, so there is a single answer to "why is the button refusing me".
 */
export const canLaunch = (draft: WizardDraft): boolean => draft.audience?.reviewed === true;

const KEY = 'personavision.newtest.draft';

/**
 * The draft as it stands, read **synchronously**: a step must not flash a spinner before its
 * own content, so nothing here is a promise. Anything that does not parse is a first visit.
 */
export const readWizardDraft = (): WizardDraft => {
  let raw: string | null = null;
  try {
    raw = globalThis.sessionStorage?.getItem(KEY) ?? null;
  } catch {
    // Storage a browser refuses — private mode, a blocked origin — is a draft that does not
    // survive a reload, which is quieter than a screen that will not render.
    return emptyWizardDraft();
  }
  if (raw === null) return emptyWizardDraft();
  try {
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyWizardDraft();
  } catch {
    return emptyWizardDraft();
  }
};

export const writeWizardDraft = (draft: WizardDraft): void => {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Nothing a user can act on, and nothing worth losing their step over.
  }
};

export const forgetWizardDraft = (): void => {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    // As above.
  }
};

/**
 * The draft, and one way to change it.
 *
 * Each step reads it for itself — one step is mounted at a time and storage is the single
 * copy — so a step is a component with no props and the wizard passes nothing down.
 */
export function useWizardDraft(): readonly [WizardDraft, (patch: Partial<WizardDraft>) => void] {
  const [draft, setDraft] = useState<WizardDraft>(readWizardDraft);
  const update = useCallback((patch: Partial<WizardDraft>) => {
    setDraft((previous) => {
      const next = { ...previous, ...patch };
      writeWizardDraft(next);
      return next;
    });
  }, []);
  return [draft, update];
}
