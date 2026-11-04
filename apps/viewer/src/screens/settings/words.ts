/**
 * What the two GitHub screens say, in one place.
 *
 * The locked path-2 card (`/new?step=path`) and the connection screen (`/settings/github`)
 * are one answer to one question — *where would the pull request go?* — so the sentences
 * they share are written once. The lock's reason is **the owner's own words** from
 * `docs/FLOW.md` section 11, as `docs/design/prototype.html` sets them in `.lockbar`, and
 * the emphasis is part of them: the call to act is bold, the promise after it is not.
 */

/** The bold half of the lock's reason — what the user would do. */
export const CONNECT_CALL = 'Connect a GitHub repository';

/** The rest of it, including the sentence the product is never allowed to drop. */
export const CONNECT_PROMISE =
  ' and PersonaVision can write the change and open the pull request for you. It never merges: you do.';

/** The reason as one sentence, for a screen that sets it without the emphasis. */
export const CONNECT_REASON = `${CONNECT_CALL}${CONNECT_PROMISE}`;

/**
 * What a connected repository is for, said without overstating it.
 *
 * `docs/FLOW.md` section 13: the installation is what **Improve my site** needs, and being
 * able to install the app on the repository that deploys a site is the only proof of control
 * this product asks for. It is **not permission to test** and it moves no figure — every site
 * in a workspace is bound by the same caps, which protect the site being driven rather than
 * the person who asked (decision 71, settled **2026-11-03** as _no gate on testing_).
 */
export const NEEDED_FOR_IMPROVE =
  'Improve my site needs this installation: the app has to be on the repository that deploys the site, because that is where the pull request goes. It changes no figure — every site in this workspace is allowed the same.';

/** While the owner has not registered the GitHub App, this is the whole truth of it. */
export const APP_NOT_REGISTERED =
  'PersonaVision’s GitHub App is not registered yet, so there is no repository to connect today.';

/** …and the thing a user can do about it, which is the path that needs nothing from GitHub. */
export const APP_NOT_REGISTERED_NEXT =
  'Test my site needs nothing from GitHub: start a test there, and this path unlocks once the app is live.';

/** A connection state that could not be read. Locked is the safe answer, and this says so. */
export const CONNECTION_UNREADABLE =
  'This workspace’s GitHub connection could not be checked, so this path stays locked.';
