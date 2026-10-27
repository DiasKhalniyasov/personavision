# The Meta Model API protocol

This is the one place the Meta Model API is written down: the endpoint, the two model ids, the shape of a request and
of a response, the exact path of every usage figure, what caching really does, and what a call costs. The provider in
`packages/provider/src/` (#43) is built against this document, and the trajectory log (#139) stores the request and
response bodies described here verbatim.

Everything below was either read on the vendor's documentation or **observed live**. The two are labelled separately
throughout, because they disagree in three places and the observed answer is the one the code has to be written
against. The live calls were made on **2026-10-27** from the owner's machine (#133).

## The credential

The key lives in the environment variable **`MODEL_API_KEY`**, on the owner's machine only. It is not in this
repository, not in an issue, not in a commit, not in a run's files and not in a log line. The provider reads it at call
time, puts it in one `Authorization` header, and redacts it out of anything it emits; no trajectory record carries a
request header at all.

Nothing in the build, the lint, the tests or the demo requires the key or the network. The one test that calls the real
API (`packages/provider/tests/meta-model-live.test.ts`) skips itself, visibly and with the reason in its name, when
`MODEL_API_KEY` is not in the environment.

## Endpoint and auth

| What       | Value                                            |
| ---------- | ------------------------------------------------ |
| Endpoint   | `POST https://api.meta.ai/v1/responses`          |
| Base URL   | `https://api.meta.ai/v1`                         |
| Auth       | `Authorization: Bearer $MODEL_API_KEY`           |
| Content    | `Content-Type: application/json`                 |
| Protocol   | the responses protocol                           |
| Docs       | https://dev.meta.ai/docs/protocols/responses     |

The responses protocol is the only endpoint of the three (responses, chat completions, messages) that carries the
model's chain of thought between turns, which is why this project uses it. An earlier `401` against
`https://api.llama.com/v1/models` is dead information: the base URL was wrong, the key was not.

## The two models, and the one difference between them

The mode is a per-run setting. Both model ids were called live with the same key on 2026-10-27 and both answered
`200` with `"status": "completed"`.

| Mode          | Model id                      | Live status (2026-10-27) | Training on your content |
| ------------- | ----------------------------- | ------------------------ | ------------------------ |
| `standard`    | `muse-spark-1.3`              | `200` / `completed`      | No                       |
| `contributor` | `muse-spark-1.3-contributor`  | `200` / `completed`      | **Yes** — see below      |

**Only the `model` field differs.** Everything else in this document — the input array, `prompt_cache_key`,
`prompt_cache_retention`, `max_output_tokens`, image input, the response envelope, the usage field paths — behaved
identically on both ids in every call made. There is no second endpoint, no second header and no second body shape for
contributor mode.

**The contributor caveat.** In contributor mode Meta may use the content of a request — the prompts, and what the model
replies — to train future Meta models. A customer's content must therefore never go through contributor mode. The
project's own development, tests and demo runs are exactly what the cheap tier is for.

## Prices

Per 1M tokens, from https://dev.meta.ai/docs/pricing-rate-limits, **read 2026-10-27**. A price change is a dated edit
to this table and a one-line change in `packages/provider/src/meta-pricing.ts`, which is the only place in the code a
rate appears.

| Usage        | `muse-spark-1.3` (standard) | `muse-spark-1.3-contributor` |
| ------------ | --------------------------- | ---------------------------- |
| Input        | $1.25                       | $0.10                        |
| Cached input | $0.15                       | $0.002                       |
| Output       | $4.25                       | $0.20                        |

Contributor mode is 12.5× cheaper on input, 75× cheaper on cached input and 21× cheaper on output — **in exchange for
permission to train on the content**. There is no per-call fee: a call costs its tokens and nothing else. The page
states no long-context premium, so the rate is the same whether the context window is nearly empty or nearly full.

Reasoning tokens are billed as output tokens at the output rate; they are not a row of their own. They are most of what
a decision costs — see "Reasoning" below.

### Rate limits

Per team, not per key: every key in a team counts toward the same limits. These bound how wide a persona swarm can run.

| Model                        | Requests / minute | Tokens / minute |
| ---------------------------- | ----------------- | --------------- |
| `muse-spark-1.3`             | 3,000             | 4,000,000       |
| `muse-spark-1.3-contributor` | **150**           | 3,000,000       |

Contributor mode allows 150 requests per minute — one twentieth of standard. A swarm that makes one call per screen is
limited to 150 screens a minute in the mode the project develops in. Over a limit the API rejects the request; retry
with exponential backoff and jitter. Every successful token-based response carries
`x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-limit-requests` and
`x-ratelimit-remaining-requests`, which is the cheaper way to find the ceiling than hitting it.

## A decision call: the request

One screen is one `POST /v1/responses`. This is a real request, sent live on 2026-10-27, trimmed to one developer
message and one screen so the shape is readable:

```json
{
  "model": "muse-spark-1.3-contributor",
  "input": [
    {
      "role": "developer",
      "content": [{ "type": "input_text", "text": "You are one simulated person using a website. Answer with one JSON object: …" }]
    },
    {
      "role": "user",
      "content": [{ "type": "input_text", "text": "Screen 1 of this session; step: s1 — the product page\n\nWhat you have looked at on this screen:\n- e1 · button · “Add to basket” · 3 fixations, 900ms\n\nWhat do you do now? One JSON object." }]
    }
  ],
  "prompt_cache_key": "pv-probe-doc-example",
  "prompt_cache_retention": "24h",
  "max_output_tokens": 2048,
  "reasoning": { "effort": "minimal" },
  "store": false
}
```

The fields this project uses, and what each one is for:

| Field                     | Type                               | Required | What it does                                                                          |
| ------------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `model`                   | string                             | yes      | One of the two ids above. The only field that differs between the modes.               |
| `input`                   | string, or array of typed items    | yes      | The whole conversation. See "The conversation shape".                                  |
| `prompt_cache_key`        | string                             | no       | Routing hint that raises the cache hit rate. Not what turns caching on.                |
| `prompt_cache_retention`  | `"in_memory"` \| `"24h"` \| `null` | no       | A **hint** for how long the prefix is kept. `"in_memory"` is the default behaviour.    |
| `max_output_tokens`       | integer, minimum 16                | no       | Caps visible output **and reasoning together**. Too low and the answer is cut off.     |
| `reasoning.effort`        | enum, see below                    | no       | How much the model thinks. Omitted, it reasons at a model-determined level.            |
| `store`                   | boolean, default `true`            | no       | Whether the response is kept server-side for retrieval and for `previous_response_id`. |
| `instructions`            | string                             | no       | Developer-level text the server inserts at the top of the context. Not used here.      |
| `truncation`              | `"auto"` \| `"disabled"`           | no       | Only `"disabled"` (the default) is accepted; `"auto"` returns `400`.                   |

The provider sends `model`, `input`, `prompt_cache_key`, `prompt_cache_retention: "24h"` and
`max_output_tokens: 4096`, and nothing else. It does not send `reasoning`, `instructions`, `tools` or
`previous_response_id` — the reasons are below.

### `max_output_tokens` is a reasoning budget, not a reply budget

`max_output_tokens` bounds visible output and reasoning tokens together, and reasoning is almost all of it. Observed
live on a one-sentence answer with no `reasoning.effort` set:

| Call                                              | `output_tokens` | of which reasoning | Response status |
| ------------------------------------------------- | --------------- | ------------------ | --------------- |
| Screen 1, `max_output_tokens: 512`                | 512             | 510                | `incomplete`    |
| Screen 1, `max_output_tokens: 4096`               | 2,624           | 2,609              | `completed`     |
| Screen 2 of the same session, 4096                | 1,076           | 1,061              | `completed`     |

At 512 the model spent the whole budget thinking and the answer came back `incomplete` with nothing to read. **A cap
that is too low loses the screen and still bills for every reasoning token spent hitting it**, which is why the
provider's cap is 4096 rather than something tighter.

## The conversation shape

`input` takes either a plain string or an array of typed items. This project always sends the array, and sends **the
whole conversation every turn**: the instructions, the persona and its task, the tools, then every earlier turn, then
the new screen.

```json
{
  "model": "muse-spark-1.3",
  "input": [
    { "role": "developer", "content": [{ "type": "input_text", "text": "<instructions>" }] },
    { "role": "developer", "content": [{ "type": "input_text", "text": "<persona and task>" }] },
    { "role": "developer", "content": [{ "type": "input_text", "text": "<tools>" }] },
    { "role": "user",      "content": [{ "type": "input_text", "text": "<screen 1>" }] },
    { "role": "assistant", "content": [{ "type": "output_text", "text": "<the model's reply to screen 1>" }] },
    { "role": "user",      "content": [{ "type": "input_text", "text": "<screen 2>" }] }
  ]
}
```

- **Roles** are `developer`, `system`, `user` and `assistant`. `developer` is the recommended one for instructions.
  Several `developer` messages in one array are accepted — the three the provider sends are three separate messages.
- **Content parts** are typed: `input_text`, `input_image`, `input_file`, `input_video` on the way in, and
  `output_text` for a replayed assistant turn. A replayed assistant message uses `output_text`, not `input_text`.
- **Instructions, persona and tools are all just messages.** The protocol has an `instructions` parameter and a `tools`
  array; this project uses neither, because the whole of what the model is given is then the whole of what the cached
  prefix covers. The six actions a persona may take are written out as a `developer` message.
- **The history is append-only.** Turn N's `input` is a byte-exact prefix of turn N+1's: no earlier message is edited,
  reordered or re-rendered, and nothing in the prefix is a timestamp, a random id or an iteration over a map whose
  order could change. That is not a style preference — it is the whole of what makes the cache hit.
- **The volatile part goes last.** The elements fixated on this screen, the action history and the step are the tail of
  the array, after everything stable.

### `previous_response_id`: accepted, and deliberately not used

`previous_response_id` is accepted and it works. It carries **conversation turns only** — user and assistant messages —
not request-level parameters: top-level `instructions` does not persist across turns and has to be resent. The server
reconstructs prior turns from the response it names and appends the new `input`.

It is not used here, for two measured reasons.

**It does not save anything.** Observed live (contributor, 2026-10-27), for the same two-screen conversation:

| How turn 2 was sent                                     | `input_tokens` | `cached_tokens` |
| ------------------------------------------------------- | -------------- | --------------- |
| Our own history in `input`, no `previous_response_id`   | 549            | 497             |
| Only the new screen, with `previous_response_id`        | 535            | 369             |
| **Both** — full history *and* `previous_response_id`    | **1,015**      | 369             |

Chaining billed 535 against 549 for managing the history ourselves: no saving worth server-side state. Sending both
pays for the conversation **twice** (1,015 tokens for the same two screens), which is the mistake to avoid.

> **Documented vs observed.** The caching page states that with `previous_response_id` a follow-up "reports only the
> new turn's `input_tokens` and `cached_tokens`, not the full reconstructed prefix". Observed, the chained follow-up
> billed 535 input tokens for a conversation whose own new screen is ~50 tokens — about what the full prefix costs. The
> reconstructed prefix is billed. Do not plan a budget on the documented behaviour.

**It is a second source of truth.** The instructions and the tools have to be resent every turn anyway, so our own
record of the conversation is already the whole history. Depending on a server-side chain as well would mean a run
whose replay depends on state we do not hold. `previous_response_id` cannot be combined with
`include: ["reasoning.encrypted_content"]` either — that returns `400` with `param: "include"`.

### Reasoning items in the input

The protocol's own way to carry chain of thought across turns is to take `reasoning` items out of one response's
`output` and replay them in the next request's `input`. This project does not: it replays the assistant's visible
reply as an `output_text` message and lets the model re-reason, because a persona deciding one screen at a time has
nothing to carry over that the screen message does not already say.

If a later ticket does replay them, three rules bite:

- Every replayed reasoning item must carry its `encrypted_content`. A bare `rs_…` id returns
  `400` ("Referenced reasoning item … was not found or has expired").
- `summary` is required on input — send `[]` when there is none. `id` is optional on input, required on output.
- A replayed reasoning item must be followed by an assistant message or a `function_call` before the next `user`,
  `system` or `developer` message, or the request is `400`.

## A decision call: the response

The same call's real response, with the reasoning blob trimmed:

```json
{
  "id": "resp_6ae03de828dfad3e5fca4c83",
  "object": "response",
  "status": "completed",
  "created_at": 1793080808,
  "completed_at": 1793080808,
  "error": null,
  "incomplete_details": null,
  "model": "muse-spark-1.3-contributor",
  "store": false,
  "temperature": 1,
  "top_p": 1,
  "max_output_tokens": 2048,
  "prompt_cache_key": "pv-probe-doc-example",
  "reasoning": { "effort": "minimal" },
  "service_tier": "auto",
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "truncation": "disabled",
  "instructions": null,
  "output": [
    {
      "type": "reasoning",
      "id": "rs_6ae03de828dfad3e5fca4c83:rs_8417dd0f-437d-4018-ab24-30aeb74c2383",
      "encrypted_content": "Q-PaDgHFOgc9CHs3…",
      "summary": [],
      "status": "completed"
    },
    {
      "type": "message",
      "id": "msg_3256e23c-fd8c-491e-809a-ae3e4ef7f078",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "{\"intent\": \"add product to basket\", \"action\": {\"kind\": \"click\", \"targetElementId\": \"e1\"}}",
          "annotations": [],
          "logprobs": []
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 135,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 182,
    "output_tokens_details": { "reasoning_tokens": 146 },
    "total_tokens": 317
  }
}
```

Three things about it are load-bearing.

**`output` is an array, and the reply is not the first item.** Every observed response put a `reasoning` item first and
the assistant `message` second. A reader that takes `output[0]` gets the chain of thought; a reader that concatenates
every text part in `output` prepends reasoning text to the JSON and loses the decision. **Read the reply from `output`
items of `type: "message"` only**, and from their `output_text` content parts.

**`status` is the response's own, separate from the HTTP status.** Every observed call returned HTTP `200` and then said
in the body whether it had finished: `completed`, or `incomplete` when `max_output_tokens` cut it off, with
`incomplete_details` saying why. An `incomplete` response is a lost screen that was still billed.

**A refusal is an item, not an error.** A model that declines returns HTTP `200` with a `refusal` content part
(`{"type": "refusal", "refusal": "<explanation>"}`). It is not a `4xx` and it is not an empty reply.

### The reasoning item

```json
{
  "type": "reasoning",
  "id": "rs_<response id>:rs_<uuid>",
  "encrypted_content": "<opaque, ~2.4 kB base64url>",
  "summary": [],
  "status": "completed"
}
```

| Field               | Type                                                | On output | Notes                                                        |
| ------------------- | --------------------------------------------------- | --------- | ------------------------------------------------------------ |
| `type`              | `"reasoning"`                                       | always    |                                                              |
| `id`                | string                                              | always    | Required on output, optional when replayed as input.          |
| `encrypted_content` | string \| null                                      | observed  | Opaque. Cannot be read, summarised or rewritten — only kept whole or dropped. |
| `summary`           | array of `{ type: "summary_text", text }`           | always    | `[]` unless `reasoning.summary` was asked for.                |
| `content`           | array of `{ type: "reasoning_text", text }`         | no        | Not present in any observed response.                         |
| `status`            | `in_progress` \| `completed` \| `incomplete`        | observed  |                                                               |

> **Documented vs observed.** The protocol page says `encrypted_content` "is omitted by default" and that
> `include: ["reasoning.encrypted_content"]` is needed to receive it. Observed, it came back **populated on every
> call**, with `store: false` and no `include`. It is about 2.4 kB of base64url per response — which matters to #139,
> because a trajectory that stores response bodies verbatim stores one of these per screen.

### The usage object

The field paths, exactly. All five are present on every observed response.

| Figure                 | Path                                              | Notes                                                       |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Total input tokens     | `usage.input_tokens`                              | Includes the cached ones. Not an extra charge.               |
| Of which from cache    | `usage.input_tokens_details.cached_tokens`        | A **subset** of `input_tokens`, billed at the cached rate.   |
| Total output tokens    | `usage.output_tokens`                             | Includes the reasoning ones.                                 |
| Of which reasoning     | `usage.output_tokens_details.reasoning_tokens`    | A **subset** of `output_tokens`, billed at the output rate.  |
| Total                  | `usage.total_tokens`                              | `input_tokens + output_tokens`.                              |

Both breakdowns really are "of which", as every live call confirmed: 497 cached of 546 input, 1,061 reasoning of 1,076
output. So a call's cost is

```
((input_tokens − cached_tokens) × input_rate + cached_tokens × cached_rate + output_tokens × output_rate) ÷ 1e6
```

and nothing in it is counted twice. A figure the response does not report is **zero, never a guess**: inventing a
cached count would make a run look cheaper than the invoice.

Note for the chat completions protocol, if anything ever uses it: the same figure lives at
`usage.prompt_tokens_details.cached_tokens`, and the totals are `prompt_tokens` / `completion_tokens`.

## Caching

**Caching is automatic.** There is no flag and no key to manage: every request's tokenised prefix is compared against
recently cached state, the matching leading tokens are served from cache, and only the tokens after the first
difference are computed. The one real control is **order** — stable content first, volatile content last.

`prompt_cache_key` does **not** turn caching on. It groups requests so that ones sharing a prefix route to the same
backend, which raises the hit rate at volume. `prompt_cache_retention` asks for longer retention — `"in_memory"` (the
default) or `"24h"` — and is explicitly **a hint**: actual retention is server-side and entries may be evicted early
under load. Caching is independent of `store`: `store: false` turns off retrieval, not caching.

### What the live calls showed

Two calls of one session sharing one `prompt_cache_key` and an identical prefix, in each mode (2026-10-27, HTTP `200`
on all four):

| Mode          | Turn | `input_tokens` | `cached_tokens` | Response status |
| ------------- | ---- | -------------- | --------------- | --------------- |
| `standard`    | 1    | 497            | **0**           | `completed`     |
| `standard`    | 2    | 546            | **497**         | `completed`     |
| `contributor` | 1    | 498            | **0**           | `completed`     |
| `contributor` | 2    | 549            | **497**         | `completed`     |

**Caching behaves identically in both modes** — same miss on the first turn, same 497 tokens served on the second.
A cache that worked in one mode and not the other would have changed what a cheap run costs; it does not.

Turn 2 was served the whole of turn 1's prefix and paid full price only for the new screen. On the project's real
prefix the provider's own live test reported the same 497 — and on a **repeated** session, minutes later with the same
persona, seed and cache key, turn 1 itself came back with `cached_tokens: 497` on its very first call. With
`prompt_cache_retention: "24h"`, a re-run of the same audience hits the cache from its opening screen.

### The minimum cacheable prefix, observed

Nothing documents a minimum. Measured, with a shared prefix shrunk until nothing was served (contributor, same method,
same day):

| Shared prefix (`input_tokens` of turn 1) | Turn 2 `input_tokens` | Turn 2 `cached_tokens` |
| --------------------------------------- | --------------------- | ---------------------- |
| 90                                      | 134                   | **0**                  |
| 139                                     | 186                   | 113                    |
| 169                                     | 218                   | 113                    |
| 199                                     | 243                   | 113                    |
| 497                                     | 546                   | 497                    |

So: **below roughly 100 billed input tokens nothing is served from cache at all**, and between there and ~200 tokens a
fixed 113 came back regardless of how much was actually shared. The cache is block-granular and the blocks do not
divide the billed token counts evenly — the vendor injects unbilled steering context into every prompt, which is the
likely reason the boundaries land where they do.

**This was observed, not documented.** The practical rule: a prefix of a few hundred tokens caches reliably, a prefix
under a hundred does not cache at all, and the amount served is **read from `cached_tokens`, never predicted**. The
project's real prefix — instructions, persona, tools — is ~500 tokens, comfortably past the threshold.

> **Documented vs the way this project uses it.** The caching page advises a `prompt_cache_key` that names an
> application or use case and warns against per-user or per-session keys, because unique keys route independently and
> lower the hit rate. This project uses one key per agent session (a digest of persona + seed). That is deliberate: a
> session's prefix *is* its persona, so two sessions share no prefix worth routing together, and a persona id a
> customer chose must not travel to the vendor as a key. The cost is that a swarm's keys are many and narrow. If hit
> rates ever disappoint at swarm scale, this is the first thing to change — one key per audience rather than per
> session — and it is a one-line change in `promptCacheKey`.

## `reasoning.effort`

Set it on the responses protocol as `reasoning.effort` (nested). On chat completions the same control is the top-level
`reasoning_effort`.

| Value       | Documented                                                   | Observed on `muse-spark-1.3-contributor` |
| ----------- | ------------------------------------------------------------ | ---------------------------------------- |
| `"none"`    | Not supported by Muse Spark; returns `400`                   | `400`, as documented                     |
| `"minimal"` | Shortest reasoning pass                                      | `200` / `completed`                      |
| `"low"`     | Light reasoning                                              | `200`                                    |
| `"medium"`  | Moderate depth                                               | `200`                                    |
| `"high"`    | Deep reasoning                                               | `200`                                    |
| `"xhigh"`   | Deeper reasoning                                             | `200` / `completed`                      |
| `"max"`     | Beyond `xhigh`; **"not available with `…-contributor`"**     | **`200` / `completed`**                  |

> **Documented vs observed — the contributor model does accept `"max"`.** The reasoning page's table says `"max"` is
> not available with `muse-spark-1.3-contributor`, and this was the owner's understanding too. Live, on 2026-10-27, a
> contributor request with `reasoning: { "effort": "max" }` returned HTTP `200` and `"status": "completed"`, spending
> 414 reasoning tokens of 424 output on a one-word reply (`xhigh` spent 208 of 218 for the same prompt). The API's own
> error message is the clearest evidence: rejecting `"none"` on the contributor model, it names the supported values as
> **`[minimal, low, medium, high, xhigh, max]`**.
>
> ```
> HTTP 400
> {"type": "invalid_request_error", "param": "reasoning.effort", "code": null,
>  "message": "reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'.
>              Supported values: [minimal, low, medium, high, xhigh, max]"}
> ```
>
> So `#43` may send any effort but `"none"`, on either model. It currently sends none at all, which is still the right
> default: a persona deciding one screen does not need extended reasoning, and effort is what reasoning tokens — the
> bulk of the bill — are spent on. The flag `acceptsReasoningEffort` in `meta-pricing.ts` is `false` for both models on
> the strength of the documentation; by the API it could be `true` for both.

Omitting `reasoning` entirely still reasons, at a model-determined level — and, as the table under
`max_output_tokens` shows, that level spends 2,600 output tokens on a one-sentence answer.

## Reasoning tokens

They are the bill. Observed, on this project's own request shape (contributor, 2026-10-27):

| Call                                    | `output_tokens` | `reasoning_tokens` | Share |
| --------------------------------------- | --------------- | ------------------ | ----- |
| Screen 1 of a session                   | 2,209           | 2,120              | 96%   |
| Screen 2 of the same session            | 1,466           | 1,400              | 95%   |
| A one-word reply, `effort: "minimal"`   | 27              | 17                 | 63%   |
| A one-word reply, no `effort` set       | 182             | 146                | 80%   |

A cost figure that counted only the visible reply would understate a run by an order of magnitude. `reasoning_tokens`
is inside `output_tokens`, so costing a call from `output_tokens` at the output rate is correct and complete; the
breakdown is for explaining the bill, not for adding to it.

What a screen actually cost in contributor mode, as the provider computed it from the figures above: **$0.00045** for
the first screen of a session and **$0.00032** for the second. The same two calls in standard mode would be ~21× that.
User-visible commentary before a tool call counts toward `output_tokens` but is not inside `reasoning_tokens`.

## Image input

**Accepted, on both models.** A 64×64 PNG sent as a base64 `data:` URL was described correctly by
`muse-spark-1.3-contributor` and by `muse-spark-1.3` on 2026-10-27, both HTTP `200` / `completed`.

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "What colour fills this image?" },
    { "type": "input_image", "image_url": "data:image/png;base64,<encoded bytes>" }
  ]
}
```

`image_url` is a **plain string**, not an object (that object form is the chat completions protocol's). Three sources
are accepted and nothing else:

- a public `https://` or `http://` URL,
- a base64 `data:` URL, as above,
- a `file_id` instead of `image_url`, for an image uploaded through the files API — as `input_image` or `input_file`.

> **A run-relative path is not a URL.** Sending `"image_url": "screens/step-1.png"` — the shape the provider's screen
> message would produce today — returns:
>
> ```
> HTTP 400
> {"type": "invalid_request_error", "param": null, "code": null,
>  "message": "unsupported URL scheme at input[0].content[1]:
>              only http://, https://, and data: URIs are accepted"}
> ```
>
> So the branch in `buildScreenMessage` that attaches `context.screenshot.path` would fail every call it ever made. Any
> ticket that flips `acceptsImages` owes that branch a base64 `data:` URL built from the file (or a files-API upload),
> and a test that asserts the encoding rather than the presence of the field.

`meta-pricing.ts` currently has `acceptsImages: false` for both models, and the swarm therefore decides from fixated
elements alone. **By the API that flag is wrong** — both models read images. Whether a persona *should* see the
screenshot is a product question (a simulated person who reads the pixels is not reading the fixation list), not an
API one, so this document records only that the API accepts it.

## Errors

| HTTP  | Shape                                                                                | What it means                                               |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `400` | `{"type": "invalid_request_error", "message": …, "param": …, "code": null}`           | The body was wrong. `param` names the field when it can.     |
| `429` | — | Over a rate limit. Retry with exponential backoff and jitter.                        |
| `504` | `gateway_timeout`                                                                     | A non-streaming request ran past the server's time limit.    |
| `200` | body `"status": "incomplete"` with `incomplete_details`                               | Usually our own `max_output_tokens`. Billed, and lost.       |
| `200` | a `refusal` content part in `output`                                                  | The model declined. Not an error status.                     |

Every one of these is an automation failure in this project's vocabulary (`docs/FLOW.md` section 8): a screen lost to a
timeout, a refusal or a bad request is our breakage, never a person who abandoned the task.

## What was observed rather than documented

The three places where the live API and the documentation disagree, collected so that nobody has to re-derive them:

| Subject                              | Documented                                                   | Observed 2026-10-27                                                   |
| ------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `reasoning.effort: "max"`            | Not available on `muse-spark-1.3-contributor`                | Accepted: `200` / `completed`, and listed as supported in a `400` body |
| `reasoning.encrypted_content`        | Omitted unless asked for with `include`                      | Present on every response, ~2.4 kB, with `store: false`                |
| `previous_response_id` accounting    | Follow-up bills only the new turn, not the reconstructed prefix | Follow-up billed 535 tokens — about the full prefix                 |

And the two things the documentation does not state at all, settled by measurement: **caching is automatic** (no flag,
no key required), and **the minimum cacheable prefix is somewhere under ~100 billed input tokens, below which nothing
is served** — with the amount served block-granular and therefore always to be read from `cached_tokens` rather than
predicted.

## How this was verified

39 live calls on 2026-10-27 from the owner's machine: 7 to `muse-spark-1.3` and 32 to
`muse-spark-1.3-contributor`, the cheap tier carrying the protocol probing. Total cost well under ten cents. The key
was read from the environment, never printed, and the recorded request and response bodies were checked not to contain
it before anything was written down.

What was covered: a cached pair sharing one `prompt_cache_key` in each mode; three shorter prefixes to find the caching
floor; all seven `reasoning.effort` values on the contributor model; image input on both models as a `data:` URL and as
a run-relative path; `previous_response_id` alone and combined with a resent history; and the provider's own live test
(`packages/provider/tests/meta-model-live.test.ts`), which walks two screens of one session through the real request
builder. The figures quoted throughout are from those calls, and the statuses are reported on #133.
