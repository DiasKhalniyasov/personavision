import type { DecisionUsage, ProviderMode } from './types.js';

/**
 * The **one-shot** model seam: a document in, a typed object out.
 *
 * This is the package's second interface, and it sits **beside** `DecisionProvider` rather
 * than extending it (`docs/adr/0003-the-one-shot-wonder-seam.md`). A decision belongs to an
 * agent session and carries a screen; the four things Muse Wonder answers — the structured
 * audience from a sentence, the goal, the analysis and the one change — belong to no session
 * and see no screen. Forcing them through `DecisionProvider` would mean inventing a fake
 * session per call, and one interface covering both would put a branch in every
 * implementation (`docs/FLOW.md` sections 12 and 16; step #219).
 *
 * Three things are load-bearing here, and they are the reason this file is small:
 *
 * 1. **The ask carries its own validator and its own offline generator.** There is no
 *    registry of uses to edit and no implementation has a case per use, so the four uses
 *    after this ticket are written independently of each other and of every implementation.
 * 2. **The reply is the parsed object or an error naming the path.** Never a half-filled
 *    object, never a defaulted one, never an empty list standing in for an answer that did
 *    not arrive. `docs/meta-model-api.md` is blunt about why: a schema-constrained reply is
 *    a guarantee about JSON and not about truth — the live change call named a file that
 *    was in no request — so every use validates the content after the parse and this seam
 *    makes a refusal the only other outcome.
 * 3. **Usage is the run's existing usage block.** A Wonder reply reports the same five
 *    figures a decision does, by the same type, so a Wonder call and a decision add up
 *    through `totalUsage` and there is no second usage block to total (#32).
 */

/**
 * The four things Muse Wonder answers, named in `docs/FLOW.md` section 16. The set is
 * closed because the artifact's words for all four are already declared in
 * `@personavision/contract` (#250): a fifth use would be a fifth shape there first.
 */
export const WONDER_USES = ['audience', 'goal', 'analysis', 'change'] as const;

export type WonderUse = (typeof WONDER_USES)[number];

/**
 * How much thinking an answer is worth, in the vocabulary the model behind this seam
 * publishes: `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`docs/meta-model-api.md`,
 * observed 2026-11-03 — `none` is a `400` on this model).
 *
 * It is on the ask rather than on the implementation because it is a property of the
 * *shape* being asked for and not of the transport: the audience and the goal were answered
 * at `minimal`, the recommendations and the change needed `low`, and the four cost between
 * $0.007 and $0.046 accordingly. Wonder's own default is `max`, which is the most expensive
 * setting there is and spent 357 reasoning tokens of 381 on a one-word answer — so an
 * implementation that reads this field must still send *some* effort when the ask names
 * none, rather than let that default stand. An implementation with no such knob ignores it.
 */
export const WONDER_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type WonderEffort = (typeof WONDER_EFFORTS)[number];

/**
 * One ask: everything one call needs, and nothing that belongs to the implementation.
 *
 * `T` is the shape of the answer — a `Goal`, an `Audience`, a `Recommendations`, a `Change`
 * as `@personavision/contract` declares them. The ask is built by the use that wants it, and
 * it is the use — not this seam and not any implementation — that owns the words it sends,
 * the schema it asks the reply to satisfy, the validation it holds the reply to and the
 * answer it gives when there is no model.
 */
export interface WonderAsk<T> {
  /** Which of the four this is. Carried so a record, a log line or an error can name it. */
  readonly use: WonderUse;
  /**
   * What the model reads: the sentence, the URL and feature description, the aggregate's
   * numbers. The use's own wording goes in here with it — a prompt is an implementation's
   * business only in the sense that no implementation has to invent one, and nothing in the
   * contract suite asserts a string of it.
   */
  readonly document: string;
  /**
   * What the offline implementation answers from, and what makes a demo repeatable. It is
   * the run's or the request's seed, exactly as a session's is.
   */
  readonly seed: number;
  /**
   * The schema the reply is constrained to, as the structured-reply mechanism takes it: the
   * name the model is told the shape is called, and the JSON Schema itself. A use derives
   * it from the same contract schema its {@link parse} runs, so the shape asked for and the
   * shape enforced cannot drift.
   *
   * It is required rather than optional because every use in this project wants an object:
   * an ask carrying no schema is an ask for prose, and then `parse` is holding a paragraph
   * to a shape. An implementation that cannot constrain a reply ignores it and leans on
   * `parse`, which is where the refusal belongs anyway.
   */
  readonly replySchema: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
  /** How much thinking this shape is worth; absent leaves the choice to the implementation. */
  readonly effort?: WonderEffort;
  /**
   * The contract's schema, and whatever else the use holds the answer to: a path that
   * exists, a diff that applies, a citation naming a session the run holds.
   *
   * **It refuses by throwing, with the path named.** A `zod` schema's `parse` does that
   * already and is what the uses pass; anything that throws an error whose message names
   * where the reply is wrong does as well. What it must never do is return a partial object,
   * a defaulted one or an empty list: this seam has exactly two outcomes and that is the
   * other one.
   */
  readonly parse: (reply: unknown) => T;
  /**
   * The answer when there is no model: deterministic, seeded, and the project's default.
   *
   * The seed it is handed is derived from this ask's own `seed` **and** its document, the
   * way the offline decision policy derives its stream from the seed and a digest of the
   * context — so two sentences on one seed are two audiences, and the same sentence on one
   * seed is the same audience in every process and on every platform. What it returns goes
   * through {@link parse} like a model's reply, so a generator that disagrees with its own
   * validator is an error naming the path rather than an object no screen can read.
   */
  readonly offline: (seed: number) => T;
}

/**
 * Which model produced an answer, and in which mode. `null` on a reply nothing was called
 * for — the offline implementation's.
 *
 * The words are the implementation's own, as `DecisionModel`'s are and for the same reason:
 * the tier vocabulary belongs to the provider that implements it, so this interface takes
 * the words rather than declaring them. What it insists on is that both are present on
 * every reply a model produced, because a cost can only be checked against an invoice if
 * each call says what it was priced at.
 */
export interface WonderModel {
  /** The provider's own name for the tier it called. */
  readonly mode: string;
  /** The model actually called, never one substituted for it. */
  readonly modelId: string;
}

/** What one ask came back with: the parsed object, who produced it, and what it cost. */
export interface WonderReply<T> {
  /** The answer, as the ask's own validator returned it. */
  readonly value: T;
  /** The model that produced it, or `null` where none was called. */
  readonly model: WonderModel | null;
  /**
   * The five figures `run.json`'s `usage` block totals, by the same type a decision reports
   * — so a Wonder call adds to `calls`, the tokens and the cost like any other call, and
   * nothing anywhere has a second usage block for Wonder. Five zeroes where the call was
   * free, reported rather than left unknown.
   */
  readonly usage: DecisionUsage;
}

/**
 * The one-shot seam. One method, and the two facts a run records about the implementation
 * behind it.
 */
export interface WonderProvider {
  /** The implementation's name, as a run or a log line records it. */
  readonly name: string;
  /** Whether a model ran, in the same two words `run.json`'s `engine.mode` uses. */
  readonly mode: ProviderMode;
  /**
   * The model this implementation calls. Absent on one that calls none — the offline
   * default — so that a caller which named a model can see it was handed another:
   * `selectWonderProvider` refuses a substitution rather than record a model id nothing was
   * costed at (#143).
   */
  readonly modelId?: string;
  /** One ask, one answer. No session, no screen, and nothing kept between calls. */
  ask<T>(ask: WonderAsk<T>): Promise<WonderReply<T>>;
}

/**
 * A reply the ask's own validator refused, with the path it was wrong at.
 *
 * It is an **automation failure** in this project's vocabulary (`docs/FLOW.md` section 8),
 * exactly as a lost screen is: a goal that could not be written is our breakage, never a
 * person who gave up. It carries the use, the model that produced the reply — `null` where
 * the offline generator did — and every path the validator named, so a caller can report
 * what was wrong instead of showing an empty list.
 */
export class WonderReplyError extends Error {
  readonly attribution = 'automation' as const;
  readonly use: WonderUse;
  readonly model: WonderModel | null;
  /** Each path the validator refused at, as it named them. Empty where it named none. */
  readonly paths: readonly string[];

  constructor(options: {
    readonly message: string;
    readonly use: WonderUse;
    readonly model: WonderModel | null;
    readonly paths: readonly string[];
    readonly cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WonderReplyError';
    this.use = options.use;
    this.model = options.model;
    this.paths = options.paths;
  }
}

/** One refused field, in the shape a schema library's error carries them. */
interface RefusedIssue {
  readonly path?: readonly unknown[];
  readonly message?: unknown;
}

/**
 * The issues a thrown refusal carries, read structurally rather than by importing a schema
 * library: `zod`'s `ZodError` has them, and so does anything else that spells them the same
 * way. A refusal that carries none is reported by its message alone.
 */
const issuesOf = (error: unknown): readonly RefusedIssue[] => {
  if (typeof error !== 'object' || error === null) return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is RefusedIssue => typeof issue === 'object' && issue !== null,
  );
};

/** A path as a reader of a reply would write it: `devices[0].share`, or the empty string. */
const pathOf = (path: readonly unknown[] | undefined): string =>
  (path ?? [])
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`))
    .join('')
    .replace(/^\./, '');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs the ask's own validator over whatever was produced for it, and turns a refusal into a
 * {@link WonderReplyError} naming the path.
 *
 * **Every implementation of {@link WonderProvider} goes through this**, the offline default
 * included, which is what makes "the parsed shape or an error naming the path" one
 * behaviour rather than two that happen to agree today. The value returned is the
 * validator's own — never the raw reply — so a schema that strips an unknown field or
 * narrows a type is what the caller gets.
 */
export const parseWonderReply = <T>(
  ask: WonderAsk<T>,
  reply: unknown,
  model: WonderModel | null,
): T => {
  try {
    return ask.parse(reply);
  } catch (error) {
    const issues = issuesOf(error);
    const paths = issues.map((issue) => pathOf(issue.path));
    const named =
      issues.length === 0
        ? messageOf(error)
        : issues
            .map((issue, index) => {
              const where = paths[index] === '' ? 'the reply itself' : paths[index];
              return `${where}: ${issue.message === undefined ? 'refused' : String(issue.message)}`;
            })
            .join('; ');
    const by = model === null ? 'the offline generator' : `${model.modelId} (${model.mode})`;
    throw new WonderReplyError({
      message: `the ${ask.use} reply from ${by} was refused by the ask’s own validator at ${named} — a refused reply is reported with the path, never turned into a partial, defaulted or empty answer`,
      use: ask.use,
      model,
      paths,
      cause: error,
    });
  }
};
