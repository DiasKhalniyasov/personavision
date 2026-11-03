import { changeSchema } from '@personavision/contract';
import type { Change, Recommendation } from '@personavision/contract';
import { z } from 'zod';
import type { WonderAsk, WonderEffort, WonderProvider, WonderReply } from './wonder.js';

/**
 * The fourth and last of the four things Muse Wonder answers: **one targeted change**
 * (`docs/FLOW.md` section 15, point 2; step #219; #263).
 *
 * Ranked recommendations and the files the caller is willing to have touched go in; one
 * `Change` — the recommendation it answers, the one file it touches, the patch, and the
 * pull-request title and body — comes out, or the ask's own validator refuses it with the
 * path. Opening the pull request, connecting the repository and running the before/after
 * comparison belong to step #227: **nothing here reads the filesystem, writes a file or
 * talks to GitHub.** The files are handed in as text by whoever already has them, and the
 * patch is handed back as text.
 *
 * Four things are load-bearing, and all four are here rather than in a prompt, because
 * `docs/meta-model-api.md` is explicit that a schema-constrained reply is a guarantee about
 * JSON and not about truth — the live change call returned five correctly typed strings and
 * named a file that was in no request:
 *
 * 1. **One change, not a list.** The reply shape carries `changes`, and a reply with two
 *    entries or none is refused with the count. A list quietly truncated to its first entry
 *    would make "one targeted change" a thing we hoped for rather than a thing we checked.
 * 2. **It may only name what it was given.** A `recommendationId` that is not in the
 *    recommendations, or a `changedFile` that is not among the files, is refused with the
 *    path named — which is the exact failure the live call produced.
 * 3. **The patch applies to the file it was given**, asserted here and not downstream, so a
 *    patch that does not apply is refused with the reason rather than handed on hopefully.
 * 4. **The body states the recommendation, its evidence and that the numbers are
 *    simulated.** A pull request is the one place a figure of ours leaves the product, and
 *    every figure this product shows about a real site is a simulation, so a body without
 *    the word is refused.
 */

/**
 * The reasoning effort this shape is worth, from the four calls timed in
 * `docs/meta-model-api.md` (2026-11-03): the change with its patch was answered at `low`,
 * produced 2,272 output tokens of which 1,638 were reasoning, cost $0.0462 and took 22.1s —
 * seven times the output of any other use. `minimal` is what the audience and the goal are
 * worth; this is not that shape.
 */
export const CHANGE_EFFORT: WonderEffort = 'low';

/**
 * The word a pull-request body must carry about its own numbers. One spelling, checked
 * case-insensitively, so that the notice a reader sees and the notice this file enforces
 * cannot drift into two.
 */
export const SIMULATED_LABEL = 'simulated';

/** The name the model is told the reply shape is called. */
export const CHANGE_REPLY_SCHEMA_NAME = 'wonder_change';

/**
 * One file the change may touch: its path in the repository and its text, exactly as the
 * caller holds it.
 *
 * It is handed in rather than read, because this file reads nothing. The path is the one the
 * patch's headers must name and the one a `Change` records in `changedFile`; the text is
 * what the patch is applied to when it is checked.
 */
export interface ChangeFile {
  readonly path: string;
  readonly text: string;
}

/** Everything one change decision is made from. */
export interface ChangeAskInput {
  /** The recommendations the change may answer, as `recommendations.json` carries them. */
  readonly recommendations: readonly Recommendation[];
  /** The files it may touch. One of them is the file the change names. */
  readonly files: readonly ChangeFile[];
  /** The run's or the request's seed, which is what makes the offline answer repeatable. */
  readonly seed: number;
  /** Overrides {@link CHANGE_EFFORT}; a caller in a hurry can ask for less thinking. */
  readonly effort?: WonderEffort;
}

/** A refused reply, in the shape `parseWonderReply` reads issues out of. */
class ChangeReplyRefused extends Error {
  readonly issues: readonly { readonly path: readonly unknown[]; readonly message: string }[];

  constructor(issues: readonly { readonly path: readonly unknown[]; readonly message: string }[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'ChangeReplyRefused';
    this.issues = issues;
  }
}

/**
 * The surrounding Markdown fence the live call put round its diff, removed before the patch
 * is read (`docs/meta-model-api.md`: "the actual unified diff sat inside `patch` wrapped in
 * Markdown fences rather than as the plain diff asked for").
 *
 * A fence is packaging and not a different patch, so one is unwrapped and the unwrapped text
 * is what the `Change` carries — the patch stored is then always the patch that applies, and
 * step #227 can hand it to a repository without unwrapping it again. Anything else about a
 * patch is refused rather than repaired.
 */
const unfence = (patch: string): string => {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(patch.trim());
  return fenced === null ? patch : fenced[1];
};

/** The lines of a file, without the empty one a trailing newline leaves behind. */
const linesOf = (text: string): readonly string[] => {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
};

/**
 * Applies a unified diff to the one file it is allowed to touch, and returns the file's new
 * text. **It refuses by throwing, with the reason**, which is the whole point of it: the only
 * thing that can say whether a patch applies is the text it applies to.
 *
 * It reads the dialect `git diff` writes and nothing more: the `---`/`+++` headers with or
 * without their `a/` and `b/` prefixes, `@@ -old,count +new,count @@` hunks, and body lines
 * marked with a space, `-` or `+`. A hunk's body is read for exactly as many lines as its
 * header claims rather than up to the next `@@`, so a hunk whose counts are wrong is refused
 * by its own arithmetic and a removed line that happens to begin with `--` is never mistaken
 * for a second file's header.
 *
 * Two deliberate narrownesses, both refusals rather than guesses: a patch naming any file
 * but this one is refused (one targeted change, not a list), and whether the file ends in a
 * newline is taken from the file rather than from a `\ No newline at end of file` marker,
 * which is ignored.
 */
export const applyUnifiedPatch = (file: ChangeFile, patch: string): string => {
  const refuse = (reason: string): never => {
    throw new Error(reason);
  };
  // The patch's own trailing newline would otherwise read as one empty context line.
  const lines = linesOf(unfence(patch));
  const original = linesOf(file.text);
  const out: string[] = [];
  let cursor = 0;
  let index = 0;
  let hunks = 0;

  const header = /^(?:---|\+\+\+) (?:[ab]\/)?(.*?)(?:\t.*)?$/;
  const namesThisFile = (line: string): boolean => {
    const match = header.exec(line);
    if (match === null) return false;
    if (match[1] !== file.path) {
      refuse(
        `the patch names ${match[1] === '' ? 'an empty path' : `"${match[1]}"`} and the file it was given is "${file.path}": one targeted change touches the one file it names`,
      );
    }
    return true;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk === null) {
        refuse(`the patch has a hunk header this reader cannot parse: "${line}"`);
        return '';
      }
      const start = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      // A hunk that only adds to an empty file is `@@ -0,0 +1,n @@`; every other hunk counts
      // its first line from 1, so the file index is one less than the stated line.
      const from = oldCount === 0 ? start : start - 1;
      if (from < cursor) {
        refuse(
          `the patch's hunks are out of order: a hunk starts at line ${start} and line ${cursor} of the file has already been patched`,
        );
      }
      if (from > original.length) {
        refuse(
          `the patch has a hunk at line ${start} and "${file.path}" has ${original.length} line${original.length === 1 ? '' : 's'}`,
        );
      }
      out.push(...original.slice(cursor, from));
      cursor = from;
      index += 1;

      let oldSeen = 0;
      let newSeen = 0;
      while (oldSeen < oldCount || newSeen < newCount) {
        if (index >= lines.length) {
          refuse(
            `the patch ends inside the hunk at line ${start}: it covered ${oldSeen} of the ${oldCount} line${oldCount === 1 ? '' : 's'} the header claims`,
          );
        }
        const body = lines[index];
        index += 1;
        // "\ No newline at end of file" says something about the file's last byte, not about
        // a line of it. Whether the file ends in a newline is read off the file itself.
        if (body.startsWith('\\')) continue;
        const marker = body === '' ? ' ' : body[0];
        const content = body === '' ? '' : body.slice(1);
        if (marker === ' ' || marker === '-') {
          if (original[cursor] !== content) {
            refuse(
              `the patch does not apply: it expects line ${cursor + 1} of "${file.path}" to be ${JSON.stringify(content)} and it is ${cursor >= original.length ? 'past the end of the file' : JSON.stringify(original[cursor])}`,
            );
          }
          cursor += 1;
          oldSeen += 1;
          if (marker === ' ') {
            out.push(content);
            newSeen += 1;
          }
        } else if (marker === '+') {
          out.push(content);
          newSeen += 1;
        } else {
          refuse(
            `a line of the hunk at line ${start} begins with "${marker}": a unified diff marks its lines with a space, "-" or "+"`,
          );
        }
      }
      hunks += 1;
      continue;
    }
    // Everything before the first hunk, and between one file's hunks and the next line, is a
    // header, a `diff --git` line, an `index` line or a blank — or it is something this
    // reader will not quietly skip.
    if (
      !namesThisFile(line) &&
      line.trim() !== '' &&
      !line.startsWith('\\') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('new file mode') &&
      !line.startsWith('old mode') &&
      !line.startsWith('new mode') &&
      !line.startsWith('similarity index') &&
      !line.startsWith('rename ')
    ) {
      refuse(`the patch has a line outside any hunk this reader cannot place: "${line}"`);
    }
    index += 1;
  }

  if (hunks === 0) {
    refuse(
      'the patch carries no hunk: a patch with nothing between its @@ markers changes nothing',
    );
  }
  out.push(...original.slice(cursor));
  return out.join('\n') + (file.text.endsWith('\n') ? '\n' : '');
};

/** Whitespace collapsed, so a sentence wrapped across lines of a body still reads as itself. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The reply shape the model is asked for and the reply shape that is enforced, derived from
 * the contract's own `changeSchema` so that the two cannot drift. The array is the mechanism
 * by which "one change, not a list" is checked rather than hoped for: a model that would
 * rather make two can say so, and be refused with the count.
 */
const changeReplySchema = z.strictObject({ changes: z.array(changeSchema) });

/** `z.toJSONSchema` labels its output; the structured-reply parameter takes the schema. */
const jsonSchemaOf = (schema: z.ZodType): Readonly<Record<string, unknown>> => {
  const schemaObject = z.toJSONSchema(schema) as Record<string, unknown>;
  delete schemaObject.$schema;
  return schemaObject;
};

/**
 * Everything about a change that a JSON Schema cannot say: that it names a recommendation
 * and a file it was given, that its patch applies to that file, and that its body states
 * what `docs/FLOW.md` section 15 asks a pull-request body to state.
 *
 * Every failure is collected before any is thrown, so a reply that is wrong in three places
 * is reported in three places rather than one at a time.
 */
const checkChange = (change: Change, input: ChangeAskInput): Change => {
  const at = (field: string, message: string) => ({ path: ['changes', 0, field], message });
  const issues: { readonly path: readonly unknown[]; readonly message: string }[] = [];

  const recommendation = input.recommendations.find((one) => one.id === change.recommendationId);
  if (recommendation === undefined) {
    issues.push(
      at(
        'recommendationId',
        `the change answers recommendation "${change.recommendationId}", which was not in its input: the recommendations it was given are ${input.recommendations.map((one) => `"${one.id}"`).join(', ')}`,
      ),
    );
  }

  const file = input.files.find((one) => one.path === change.changedFile);
  const patch = unfence(change.patch);
  if (file === undefined) {
    issues.push(
      at(
        'changedFile',
        `the change touches "${change.changedFile}", which was not in its input: the files it was given are ${input.files.map((one) => `"${one.path}"`).join(', ')}`,
      ),
    );
  } else {
    try {
      applyUnifiedPatch(file, patch);
    } catch (error) {
      issues.push(at('patch', error instanceof Error ? error.message : String(error)));
    }
  }

  const body = flat(change.pullRequest.body);
  if (!body.includes(SIMULATED_LABEL)) {
    issues.push(
      at(
        'pullRequest',
        `the pull-request body does not say the numbers behind this change are ${SIMULATED_LABEL}: every number this product shows about a real site is a simulation, and a pull request is the one place one leaves the product`,
      ),
    );
  }
  if (recommendation !== undefined) {
    if (!body.includes(flat(recommendation.sentence))) {
      issues.push(
        at(
          'pullRequest',
          `the pull-request body does not state the recommendation it comes from: ${JSON.stringify(recommendation.sentence)}`,
        ),
      );
    }
    if (!body.includes(flat(recommendation.evidence))) {
      issues.push(
        at(
          'pullRequest',
          `the pull-request body does not state the evidence that recommendation cites: ${JSON.stringify(recommendation.evidence)}`,
        ),
      );
    }
  }

  if (issues.length > 0) throw new ChangeReplyRefused(issues);
  // The patch stored is the patch that applies: unwrapped once, here, and never again.
  return { ...change, patch };
};

/**
 * The reply, held to the contract's shape and then to everything above it. Exactly one
 * change comes out; two or none is refused with the count, never truncated.
 */
const parseChange = (reply: unknown, input: ChangeAskInput): Change => {
  // A model answers the shape it was asked for, which carries `changes`. The offline
  // generator answers in the contract's shape directly — it decided one change and has no
  // list to be refused for — and is wrapped here so that both go through one validator and
  // one set of content checks rather than two that happen to agree today.
  const wrapped =
    typeof reply === 'object' && reply !== null && 'changes' in reply
      ? reply
      : { changes: [reply] };
  const parsed = changeReplySchema.parse(wrapped);
  if (parsed.changes.length !== 1) {
    throw new ChangeReplyRefused([
      {
        path: ['changes'],
        message:
          parsed.changes.length === 0
            ? 'the reply carries no change: one targeted change is the answer, and an empty list is a refusal written as an answer'
            : `the reply carries ${parsed.changes.length} changes and the answer is one targeted change: a list is refused rather than truncated to its first entry`,
      },
    ]);
  }
  return checkChange(parsed.changes[0], input);
};

/** `# a line`, `// a line`, `<!-- a line -->` — as the file's own language would spell it. */
const commentLine = (path: string, text: string): string => {
  if (/\.(html?|md|markdown|vue|svelte|xml|svg)$/i.test(path)) return `<!-- ${text} -->`;
  if (/\.(css|scss|sass|less)$/i.test(path)) return `/* ${text} */`;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|java|go|rs|c|cc|cpp|h|hpp|swift|kt|php)$/i.test(path))
    return `// ${text}`;
  return `# ${text}`;
};

/**
 * The change when there is no model: the top-ranked recommendation, a seeded file, and a
 * patch that inserts one line naming what was decided.
 *
 * The recommendation needs no guess — the ranking already says which one matters most — so
 * the seed is spent on the one thing the input does not say, which is the file that
 * implements a sentence. It is a stand-in and reads like one: what it is for is a demo, a
 * test and a fresh clone with no key, all of which need the same input to give the same
 * change, and a patch that genuinely applies to the file it names.
 */
const offlineChange = (input: ChangeAskInput, seed: number): Change => {
  const recommendation = [...input.recommendations].sort((a, b) => a.rank - b.rank)[0];
  const file = input.files[seed % input.files.length];
  const inserted = commentLine(
    file.path,
    `PersonaVision ${recommendation.id}: ${recommendation.sentence}`,
  );
  const first = linesOf(file.text)[0];
  const patch =
    first === undefined
      ? `--- a/${file.path}\n+++ b/${file.path}\n@@ -0,0 +1,1 @@\n+${inserted}\n`
      : `--- a/${file.path}\n+++ b/${file.path}\n@@ -1,1 +1,2 @@\n+${inserted}\n ${first}\n`;

  return {
    recommendationId: recommendation.id,
    changedFile: file.path,
    patch,
    pullRequest: {
      title: recommendation.sentence,
      body: [
        `This change answers recommendation ${recommendation.id}: ${recommendation.sentence}`,
        '',
        `The evidence it cites: ${recommendation.evidence}`,
        '',
        `Every number behind this change is ${SIMULATED_LABEL}. It comes from a PersonaVision test run by simulated personas against a copy of the site, not from measured traffic.`,
      ].join('\n'),
    },
  };
};

/** The recommendations and the files, as the model reads them. */
const documentOf = (input: ChangeAskInput): string =>
  [
    'Decide one targeted change to the source of a website, from the recommendations a PersonaVision test produced.',
    '',
    '## The recommendations, best first',
    '',
    ...[...input.recommendations]
      .sort((a, b) => a.rank - b.rank)
      .flatMap((recommendation) => [
        `### ${recommendation.id}`,
        `Recommendation: ${recommendation.sentence}`,
        `Evidence: ${recommendation.evidence}`,
        '',
      ]),
    '## The files you may change, exactly as they are',
    '',
    ...input.files.flatMap((file) => [`### ${file.path}`, '```', file.text, '```', '']),
    '## What to answer',
    '',
    '- Exactly one change in `changes`. Two changes, or none, is refused.',
    '- `recommendationId` is one of the ids above, and `changedFile` is one of the paths above. Anything else is refused with the path named.',
    '- `patch` is a plain unified diff of that one file: `--- a/<path>`, `+++ b/<path>`, then `@@` hunks whose context lines match the text above exactly as it is given, character for character. No Markdown fences, no prose, no second file.',
    '- `pullRequest.title` is one short sentence.',
    `- \`pullRequest.body\` states the recommendation sentence it comes from, the evidence sentence that recommendation cites, and that the numbers behind it are ${SIMULATED_LABEL}. A body that does not say so is refused.`,
  ].join('\n');

/**
 * One ask for one change. The use owns its words, its schema, its validation and its offline
 * answer; the seam and every implementation of it own none of the four (`wonder.ts`).
 */
export const changeAsk = (input: ChangeAskInput): WonderAsk<Change> => {
  if (input.recommendations.length === 0) {
    throw new TypeError(
      'a change answers a recommendation, and this ask carries none: a run that recommended nothing has no change to decide',
    );
  }
  if (input.files.length === 0) {
    throw new TypeError(
      'a change touches a file, and this ask carries none: the files the change may touch are handed in, because nothing in this use reads a repository',
    );
  }
  return {
    use: 'change',
    document: documentOf(input),
    seed: input.seed,
    replySchema: {
      name: CHANGE_REPLY_SCHEMA_NAME,
      schema: jsonSchemaOf(changeReplySchema),
    },
    effort: input.effort ?? CHANGE_EFFORT,
    parse: (reply) => parseChange(reply, input),
    offline: (seed) => offlineChange(input, seed),
  };
};

/**
 * The one change, through whichever implementation the caller selected. The reply carries the
 * five usage figures a decision reports, so a change call adds to a run's usage through the
 * one `totalUsage` and there is no second block for it (#32).
 */
export const decideChange = async (
  provider: WonderProvider,
  input: ChangeAskInput,
): Promise<WonderReply<Change>> => provider.ask(changeAsk(input));
