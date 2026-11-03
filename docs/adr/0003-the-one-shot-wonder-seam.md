# 3. The one-shot model call is a second interface, not an extension of `DecisionProvider`

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

`@personavision/provider` published exactly one interface, `DecisionProvider`, and it is session-scoped by construction: `beginSession({ personaId, seed })` hands back the decider for one agent session, every screen of that session goes through that one handle, and the handle is what holds the session's conversation, its cache key and its trajectory file (#138, #139). An agent, a screen, a decision.

The owner's direction of 2026-11-03 (`docs/FLOW.md` sections 11 to 17) needs four things written by a model, and **not one of them is a decision inside a browsing session**: the structured audience from a free-text sentence, the goal — the task and the observable success criterion — from a URL and a feature description, the analysis and ranked recommendations from a finished run's aggregate, and the one change with its patch and its pull-request body. Each is one call: a document in, a structured object out. There is no screen, no element the agent looked at, no action to take and nothing to remember afterwards.

`docs/meta-model-api.md` records the model behind them, Muse Wonder, called live on the owner's key on 2026-11-03 (#248): the same endpoint, the same credential, the same protocol and the same usage object as a decision call, with a different model id, no cheap tier, a different default reasoning effort and a schema in `text.format`. That document ends by saying plainly that the seam is **not** settled by it, and leaves it to this step.

Four tickets are written against the answer (#257, #259, #261, #263), three steps are blocked on them, and each of the four uses was specified to be writable **independently of the other three**. So the shape of this seam decides whether those four can be worked in parallel.

## Decision

**A second interface, `WonderProvider`, beside `DecisionProvider` — not an extension of it, and not a widening of it.**

```ts
interface WonderProvider {
  readonly name: string;
  readonly mode: ProviderMode;
  readonly modelId?: string;
  ask<T>(ask: WonderAsk<T>): Promise<WonderReply<T>>;
}
```

**The ask carries its own validator and its own offline generator.** This is the load-bearing part, and it is what lets the four uses be written independently:

```ts
interface WonderAsk<T> {
  readonly use: 'audience' | 'goal' | 'analysis' | 'change';
  readonly document: string;
  readonly seed: number;
  readonly replySchema: { readonly name: string; readonly schema: Readonly<Record<string, unknown>> };
  readonly effort?: WonderEffort;
  readonly parse: (reply: unknown) => T;
  readonly offline: (seed: number) => T;
}
```

There is **no registry of uses** to edit and **no implementation has a case per use**. A use declares the shape it wants (from `@personavision/contract`, which is where the artifact's words for all four are declared, #250), the schema to constrain the reply with, how much thinking the shape is worth, the validator to hold the answer to, and the deterministic answer to give when there is no model. An implementation sends the document and hands what comes back to that validator; the offline implementation hands its own generator's answer to the same one.

The seam has **exactly two outcomes**: the parsed object, or a `WonderReplyError` naming the path it was wrong at. Never a half-filled object, never a defaulted one, never an empty recommendation list standing in for an answer that did not arrive. Both implementations go through one `parseWonderReply`, so that is one behaviour and not two that agree today.

A reply reports the **same five usage figures a decision reports, by the same type** — `DecisionUsage`, the contract's `RunUsage` without `calls` — so a Wonder call and a decision add up through the existing `totalUsage` and nothing anywhere grows a second usage block.

**Selection lives in the one place selection already lives** (`select.ts`, the only sanctioned credential read in the repository besides the model provider and the live tests) and follows the same four rules: offline with no key, a mode never upgraded implicitly, a model request that names no model refused rather than resolved, and a named model never substituted. It differs in its **default**: asked for nothing at all, `selectWonderProvider` returns the offline implementation even where a key is present, whereas `selectDecisionProvider` would have returned a model in contributor mode. That is the absence of a cheap tier rather than an inconsistency — `muse-wonder-1.0-contributor` answers `404 model_not_found`, so every Wonder call is billed at the standard rate, 40× Spark contributor on input and 100× on output. For the same reason every named Wonder model is model-or-nothing: there is no cheaper tier to fall back to, so a fall-back could only be a simulated answer standing in for a model run, which is worse than a refusal (owner decision, 2026-10-28).

## Alternatives considered

**Extend `DecisionProvider` with a one-shot method.** Rejected: every implementation would carry a branch, and the two halves have nothing in common to share. The offline decision policy scores the elements an agent looked at against its goal; the offline one-shot implementation answers from the ask's own generator and knows nothing about any use. Worse, the contract suite would have to gate half its assertions on which half of the interface was being exercised — a decision targets an element the agent fixated on, which is meaningless for a document — and a suite full of `if`s is how two implementations drift apart while the tests stay green.

**Force the four uses through `DecisionProvider` by inventing a session per call.** Rejected: `beginSession({ personaId, seed })` would need a persona that does not exist for a call that reads a URL, and `DecisionContext` would need a goal, traits, a step and a list of fixated elements for a call that has none of them. The knowledge boundary `types.ts` exists to hold — a decision may target only an element the agent actually looked at — would become a rule with four exceptions in it.

**Widen `DecisionContext` with the document, and `Decision` with the object.** Rejected for the same reason the session handle exists at all: a field added to `DecisionContext` widens what *every* provider may act on. A `document` there would be readable by the decision policy on every screen of every session, and nothing in the interface would say that it must not be.

**A new package for the one-shot seam.** Rejected: it is the same credential, the same endpoint, the same pricing table and the same `MODEL_API_KEY` rule, and `tests/workspace.test.ts` holds the list of files that may read a credential to a short, named one. Two packages reading a key is the thing that list exists to prevent, and there would be nothing else in the new package.

**A zod schema on the ask instead of a `parse` function.** Rejected: it would put `zod` in this package's dependencies for one field, and — more to the point — a schema is not a validator. `docs/meta-model-api.md` records a live Wonder reply that was schema-valid and wrong: `filePath` was `"patches/startup-project-asteria-ksa.md"`, a file named after nothing in the request, while the unified diff sat inside `patch` wrapped in Markdown fences. Structured output is a guarantee about JSON, not about truth, so every use validates the *content* after the parse — a path that exists, a diff that applies, a citation naming a session the run holds. A function is what can do that; a schema is what the ask carries separately, as `replySchema`, for the model to be constrained by.

**No `effort` on the ask, chosen by the implementation instead.** Rejected: it is a property of the shape being asked for rather than of the transport, and the live figures say so — the audience and the goal were answered at `minimal`, the recommendations and the change needed `low`, and the four cost between $0.007 and $0.046. Wonder's own default is `max`, which spent 357 reasoning tokens of 381 on a one-word answer, so an implementation left to choose would either be wrong for two of the four uses or would grow a case per use, which is the thing this interface is shaped to avoid.

## Consequences

- The four uses are four files that share nothing but this interface. None of them edits a registry, and none of them is blocked on another.
- A new one-shot implementation inherits the contract suite from `@personavision/provider/testing` in about five lines, as a new decision provider does. **Neither suite asserts a prompt string**: an implementation's wording is its own business and changes whenever its model does.
- `DecisionProvider`, `DecisionContext`, `Decision` and the session handle are **unchanged** by this step. `packages/provider/src/types.ts` was not touched.
- A one-shot reply lands in a run's existing `usage` block. A test's whole Wonder budget is about nine cents against a Spark swarm's cents per screen, and both are one number.
- The offline implementation is the default everywhere: a fresh clone with no key and no network type-checks, lints, tests, builds and demos, and the four uses' offline answers are seeded, so a demo is repeatable.
- The cost of this decision is two interfaces to learn instead of one, and two selection functions whose defaults differ. The second is written down here and in `select.ts` because it would otherwise read as an oversight.
