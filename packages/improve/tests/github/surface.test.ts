import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as improve from '../../src/index.js';
import { createGitHubClient, createRecordedTransport } from '../../src/index.js';

/**
 * The test that proves the product *cannot* merge, rather than merely declining to.
 *
 * The App's permissions are repository contents **read** and pull requests **read and write**
 * (#231), and nothing in this product should be able to merge a pull request, close one, push
 * to a default branch or delete anything — not behind a flag, not behind a guard. The client
 * is the only way this product reaches GitHub, so its public surface is the permission
 * surface, and it is asserted against an exact list: a ticket that adds a merge call fails
 * here and has to argue with this file rather than slip past it.
 */

const SOURCE_DIRECTORY = fileURLToPath(new URL('../../src/github/', import.meta.url));

const sources = (): readonly { readonly name: string; readonly text: string }[] =>
  readdirSync(SOURCE_DIRECTORY)
    .filter((entry) => entry.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(`${SOURCE_DIRECTORY}${name}`, 'utf8') }));

/** Every call the client has, and the whole of what it has. */
const CALLS = [
  'createBranch',
  'editComment',
  'openPullRequest',
  'postComment',
  'readBranch',
  'readComments',
  'readDeployments',
  'readDeploymentStatuses',
  'readFile',
  'readPullRequest',
  'writeFile',
] as const;

/** What no call may be about. */
const FORBIDDEN =
  /merge|squash|rebase|close|reopen|delete|remove|push|force|dismiss|approve|protect/i;

/**
 * A generic sender would make the exact list above meaningless: a caller could compose
 * `PUT /repos/o/r/pulls/1/merge` itself and never add a method anybody reviewed.
 */
const GENERIC = ['request', 'send', 'call', 'fetch', 'get', 'post', 'put', 'patch', 'query'];

const client = createGitHubClient({
  token: 'installation-token-for-tests-0123456789',
  transport: createRecordedTransport([]).transport,
});

describe("the client's public surface is the permission surface", () => {
  it('has exactly the calls this product makes, and no others', () => {
    expect(Object.keys(client).sort()).toEqual([...CALLS].sort());
  });

  it('has no call that merges, closes, deletes or pushes', () => {
    expect(Object.keys(client).filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });

  it('has no generic sender a caller could compose a merge with', () => {
    expect(Object.keys(client).filter((name) => GENERIC.includes(name))).toEqual([]);
  });

  it('is exported from the package index under one name, with its transport injected', () => {
    expect(improve.createGitHubClient).toBe(createGitHubClient);
    expect(improve.createRecordedTransport).toBeTypeOf('function');
    expect(improve.createFetchTransport).toBeTypeOf('function');
  });

  it('exports nothing else whose name is about merging or pushing either', () => {
    expect(Object.keys(improve).filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});

describe('no path this client can build is a merge', () => {
  it('names no merge endpoint anywhere in its source', () => {
    for (const { name, text } of sources()) {
      expect(text, name).not.toContain('/merge');
    }
  });

  it('cannot send a DELETE, because the method is not one of the four it has', () => {
    const transport = sources().find(({ name }) => name === 'transport.ts');

    expect(transport).toBeDefined();
    expect(transport?.text).not.toContain("'DELETE'");
  });

  it('writes only to a branch of ours, so a default branch has no path at all', () => {
    const client$ = sources().find(({ name }) => name === 'client.ts');

    // The guard is one function, called by both writing calls and by nothing else.
    expect(client$?.text.match(/ownBranch\(/g)).toHaveLength(3);
  });
});
