import { noAnswer, nothingPublished, otherValues, places, siteCheckResult } from './checks.js';
import type {
  CheckedSite,
  SiteCheck,
  SiteCheckDeps,
  SiteCheckFinding,
  SiteCheckSubject,
  SiteCheckTarget,
} from './checks.js';
import { noSiteConnections } from './connections.js';
import type { SiteRepositoryConnection } from './connections.js';

/**
 * The connected-repository check: the fourth of `docs/FLOW.md` section 13's four methods, and
 * the only one that looks nowhere.
 *
 * _"The installation exists and the connection names this site."_ There is no record to
 * resolve and no page to fetch — the check **asks the connection seam**
 * (`SiteConnections`), which answers nothing until the GitHub App of #227 fills it in. So no
 * network call is made here, no credential is read, and the result a site gets today is the
 * one that says no repository is connected to it.
 *
 * It passes **exactly when a connection names this site**. A repository connected to another
 * site of the same workspace does not verify this one, and says so in its own sentence,
 * because that is the thing the user can act on: they connected the right app to the wrong
 * site. A connection of another workspace is not in the answer at all.
 */

/** As the sentences name it: one repository, or several across a workspace. */
const REPOSITORY: SiteCheckSubject = {
  one: 'GitHub repository',
  many: 'GitHub repositories',
};

/**
 * What this check looks for, in the place the other three put the line to publish.
 *
 * There is nothing for the user to copy — the panel's control is "Connect GitHub" — so this
 * field holds the condition in words rather than a token line, which is what a screen prints
 * after "We looked for".
 */
const LOOKED_FOR = 'a GitHub repository connected to this site';

/**
 * The sentences, written here rather than composed by `checks.ts`.
 *
 * The shared composer speaks of a line published at an address, which is the shape of the
 * other three methods and not of this one: what is "found" here is a connection to a site,
 * and the sentence a user needs names the site rather than the place. The vocabulary of
 * `SiteCheckSubject` and the address joiner are still `checks.ts`'s, so the four methods keep
 * one voice.
 *
 * Both numbers are spelled, as `SiteCheckSubject` exists for: a workspace can have connected
 * repositories to several of its sites, and one site can be named by more than one connection
 * where somebody installed the app twice.
 */
const sentenceFor = (found: SiteCheckFinding): string => {
  const one = found.at.length === 1;
  switch (found.outcome) {
    case 'found':
      return one
        ? `the ${REPOSITORY.one} ${places(found.at, 'and')} is connected to this site`
        : `the ${REPOSITORY.many} ${places(found.at, 'and')} are connected to this site`;
    case 'other-values':
      return one
        ? `the ${REPOSITORY.one} ${places(found.at, 'and')} is connected to another site of this workspace`
        : `the ${REPOSITORY.many} ${places(found.at, 'and')} are connected to other sites of this workspace`;
    case 'nothing-published':
      return `no ${REPOSITORY.one} is connected to this site`;
    case 'no-answer':
      return 'GitHub did not answer, so whether a repository is connected to this site is not known';
  }
};

/**
 * The repositories these connections name, each said once.
 *
 * One repository can deploy two of a workspace's sites, so the same name reaches a sentence
 * twice without this — _"clipforge/web and clipforge/web are connected to other sites"_.
 */
const repositoriesOf = (connections: readonly SiteRepositoryConnection[]): readonly string[] => [
  ...new Set(connections.map(({ repository }) => repository)),
];

export const checkConnectedRepository: SiteCheck = async (
  site: CheckedSite,
  { now, connections }: SiteCheckDeps,
) => {
  // Absent means the default, which answers no connection anywhere — the same thing the
  // option left unset in `createPlatform` means, so a wiring that forgets the seam tells a
  // user that nothing is connected rather than throwing at them.
  const lookup = connections ?? noSiteConnections;

  const result = (found: SiteCheckFinding, lookedIn: readonly SiteCheckTarget[]) =>
    siteCheckResult({
      method: 'connected-repository',
      subject: REPOSITORY,
      lookedFor: LOOKED_FOR,
      lookedIn,
      found,
      at: now(),
      sentence: sentenceFor(found),
    });

  let connected: readonly SiteRepositoryConnection[];
  try {
    // This site's own workspace, as the route read it from the session: a connection filed
    // under another workspace is not in this answer, whatever site it names.
    connected = await lookup.forWorkspace(site.workspaceId);
  } catch {
    // The seam could not answer, so whether a repository is connected is **unknown** — not
    // "none", which would send a user to connect one they have already connected. The reason
    // the lookup gave is ours and not a sentence for a screen, so it is not quoted on.
    return result(noAnswer(['GitHub'], 'the GitHub connection could not be read'), []);
  }

  // Where it looked: the repositories this workspace has connected, which is the whole of
  // what there was to look at. None connected is an empty list, and the screen printing
  // "we looked at …" then prints nothing, because there was nowhere to look.
  const lookedIn: readonly SiteCheckTarget[] = connected.map(({ repository }) => ({
    kind: 'repository',
    value: repository,
  }));

  const naming = connected.filter(({ siteId }) => siteId === site.id);
  if (naming.length > 0) {
    return result(
      // The repository the connection names, and `passed` derives from the outcome: nothing
      // here can hand back a result that claims to have passed on anything else.
      {
        outcome: 'found',
        at: repositoriesOf(naming),
        values: [],
        because: null,
      },
      lookedIn,
    );
  }

  const elsewhere = connected.filter(({ siteId }) => siteId !== site.id);
  if (elsewhere.length > 0) {
    // The repositories, and the sites they are on as data — so a screen can name the site
    // by its URL rather than printing an id at somebody.
    return result(
      otherValues(
        repositoriesOf(elsewhere),
        elsewhere.map(({ siteId }) => siteId),
      ),
      lookedIn,
    );
  }

  // The state every site is in until #227 lands: the workspace has connected nothing.
  return result(nothingPublished([]), lookedIn);
};
