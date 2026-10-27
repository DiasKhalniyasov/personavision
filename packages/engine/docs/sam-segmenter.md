# SAM 3.1 segmentation

The engine's second `Segmenter`: the regions the DOM does not explain, segmented by
**SAM 3.1 on the Meta Model API** instead of by the offline heuristic.

It is **additive and never required.** The offline heuristic segmenter (#66) is the
default and stays the default: the demo, CI, `pnpm test` and a cold clone with no
credential build exactly the areas they built before this module existed. Nothing in this
document is needed for a green build.

> **Status: deferred.** On 2026-10-27 the owner decided not to test SAM 3.1 for now (#69).
> The mapping, the selection rules and the fallback are implemented and tested offline; the
> **request and response shape below is written from the responses protocol and the model's
> documented output and has not been confirmed against a live call.** Confirming it is the
> first thing to do when SAM 3.1 resumes, and the live test exists for exactly that.

## The credential

| | |
| --- | --- |
| Variable | `MODEL_API_KEY` |
| Where it lives | `~/.config/personavision/.env` on the owner's machine only |
| Endpoint | `POST https://api.meta.ai/v1/responses` |
| Auth | `Authorization: Bearer $MODEL_API_KEY` |

One key covers every model this project calls, SAM 3.1 among them; see #43. **How to
obtain access:** a Meta Model API account with the model enabled, from
<https://dev.meta.ai> — the owner provisions it and exports the variable in that file.

**The engine does not read it.** The project sanctions exactly one place to read a
credential out of the environment — `packages/provider/src/select.ts`, with
`packages/provider/src/meta-model.ts` reading it again at the moment of a call — and
`tests/workspace.test.ts` fails the build for a read anywhere else. So the caller hands the
value over as `credential`, and this module puts it in one `Authorization` header. The value
is never committed, never pasted into an issue and never printed: no message, error, report
or area produced here carries it, and `tests/sam-segmenter.test.ts` asserts that.

**Licence and cost are unassessed.** The engine may call segmentation once per capture, so
whoever turns the live path on should record the per-call price and the licence terms on
#69 first. The decision layer's own pricing table (`packages/provider/src/meta-pricing.ts`)
covers the text models only and says nothing about SAM.

## Using it

`samSegmenter` is a factory, not a segmenter. It answers **either** the SAM path **or** a
stated reason it is unavailable, and either way hands back a segmenter that works:

```ts
import { readFile } from 'node:fs/promises';
import { buildAois, samSegmenter } from '@personavision/engine';

const segmentation = samSegmenter({
  mode: run.engine.mode,                        // 'model' — anything else is reason 'mode'
  modelId: run.engine.models?.segmentation,     // as run.json spells it
  credential: selected.credential,              // from provider selection's sanctioned read
  imageScale: persona.device.deviceScaleFactor, // the screenshot is in device pixels
  runDir,
  readScreenshot: (path) => readFile(path),
  transport: async ({ url, method, headers, body, signal }) => {
    const response = await fetch(url, {
      method,
      headers: { ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    // A proxy's HTML 502 is not JSON, and a transport that threw on it would lose the
    // status: the body is passed on as it came and the status is reported as `http_status`.
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  },
  report: (unavailable) => log.warn(unavailable.message),
});

if (!segmentation.available) log.warn(segmentation.unavailable.message);
const aois = await buildAois({ capture, variant, segmenter: segmentation.segmenter });
```

`imageScale` is the capture's device scale factor, and it matters: the browser step
captures with `scale: 'device'`, so a persona on a device whose scale factor is three hands
over an image three times the size of the page the capture describes, and the model answers
in the pixels of the image it was shown. A capture carries no scale factor of its own, so
the caller states it. Left at its default of 1 on a scaled capture, every mask lands outside
the page and the call reports that it kept nothing — loudly, and with the offline segmenter
behind it — rather than placing regions at three times their true position.

The transport and the screenshot reader are **injected, with no defaults**, because
`packages/engine` opens no socket and reads no file — a rule its own tests assert over
these sources. Node's built-in `fetch` and `readFile` are all a caller needs; no dependency
is added for either, and the lockfile is untouched.

## Selection, and what unavailable means

A run gets this path only when all five hold: `engine.mode` is `model`,
`engine.models.segmentation` names a model, a transport was given, a screenshot reader was
given, and the credential was handed over. A miss is a `SamUnavailable` — a reason and a
readable message — never an exception and never a segmenter that quietly answers nothing:

| Reason | When |
| --- | --- |
| `mode` | the run did not ask for the model engine |
| `configuration` | no segmentation model, no transport or no screenshot reader |
| `credential` | no credential was handed to the segmenter |
| `transport` | the call never reached a reply, or the screenshot could not be read |
| `timeout` | our own timeout (`DEFAULT_SAM_TIMEOUT_MS`, 60s) ran out first |
| `http_status` | a reply arrived with a status that is not 2xx |
| `unparseable` | a 2xx reply with no `masks` array, or one whose masks were all dropped |

The first three are answered by the factory, up front. The last four happen during a call:
they go to `report`, and **that call answers with the fallback segmenter's areas** — the
offline heuristic one, built with the `runDir` and the `config` this factory was given so
that it can open the capture's run-directory-relative screenshot, unless `fallback` named
another. So a torn connection costs a run its
model-segmented regions and nothing else. An empty `masks` array is *not* a failure: it is
a screen with no unexplained region on it, and it is reported as no regions rather than as
the fallback's.

## The wire shape (provisional)

**Request.** One user message carrying the instruction and the full-page screenshot as a
`data:` URL:

```json
{
  "model": "sam-3.1",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "Segment the visually distinct regions … Already explained (label: x,y WxH): …" },
    { "type": "input_image", "image_url": "data:image/png;base64,…" }
  ]}]
}
```

The areas the capture's elements already explain are in the instruction because they are
the question: the seam asks for what the DOM is silent about, not for every region.

**Response.** The first `masks` array found in the reply, searched depth-first in document
order — so the envelope may be top-level, under `output`, or inside a content part without
the parser caring, which is deliberate while the shape is unconfirmed. Each mask may spell
its geometry four ways, and the two array spellings mean different things:

```json
{ "label": "product card grid", "box": [16, 112, 464, 344] }
{ "label": "product card grid", "bbox": [16, 112, 448, 232] }
{ "label": "product card grid", "box": { "x": 16, "y": 112, "width": 448, "height": 232 } }
{ "label": "promo tile", "polygon": [[300, 60], [420, 60], [420, 100], [300, 100]] }
```

`box` is a **corner pair**, `[x0, y0, x1, y1]`; `bbox` is **extents**,
`[x, y, width, height]`, as it is throughout the SAM and COCO lineage. Reading one as the
other would put a plausible-looking rectangle in the wrong part of the page and pass every
check after it, so each key is read as what it means rather than as whichever arrived
first.

A run-length-encoded mask with no box and no polygon is **not** decoded — there is no pixel
work in the engine — and is dropped. A reply whose every mask is undecodable is reported
`unparseable` rather than presented as an empty segmentation.

## Mapping rules

Each one is stated here and tested in `tests/sam-segmenter.test.ts` against the recorded
reply in `tests/sam-response.fixture.json`:

- **Image pixels to page space.** Boxes are read in the screenshot's pixel space and
  divided by `imageScale` to reach the page space the capture's elements use.
- **Outside the page is dropped; the edge is clipped.** A rectangle is clipped to
  `0,0 … viewport.width × pageHeight`, then rounded to whole pixels; one wholly outside, or
  with no extent left, is dropped.
- **Overlapping an explained area is dropped, not shrunk.** The same rule #66 states: an
  area of interest that overlapped a control would split that control's dwell.
- **Labels.** The model's own `label`, `name` or `category`, capitalised — "Product card
  grid" reads in the areas-of-interest table where "region-7" does not. A mask the reply
  named nothing reads `Unnamed segment`.
- **Ids.** `aoiId` over the variant, the step, the clipped box and the label, the same
  composition the element-derived areas use, so metrics join across sessions. Two masks
  that round to one rectangle with one label are one region.
- **Deterministic.** The order the service listed its masks in is discarded: what survives
  is cut to `segmentation.maxRegions` largest-first, then returned in reading order. The
  same reply gives byte-identical areas, ids and order.
- **`source: "sam"` and `role: null`.** Both are `buildAois`'s to set, not a segmenter's;
  a region nobody could name is never the primary action.
- **Nothing kept is reported, nothing found is not.** A reply saying `masks: []` is an
  honest empty answer: no unexplained region on this screen, and no fallback. A reply that
  listed masks and kept none of them — all undecodable, all off the page, all over controls
  — is reported `unparseable` and answered with the fallback's areas, because an empty
  segmentation presented as a success would read as a screen with nothing on it.

## Testing

`pnpm -F @personavision/engine test` covers all of the above with **no key and no network**.
The one test that would call the real service needs both the credential *and* an explicit
opt-in, because the owner's decision is not to call SAM yet:

```sh
PERSONAVISION_SAM_LIVE=1 pnpm -F @personavision/engine test sam-segmenter
```

It skips visibly, with the reason in its name, when either is missing —
`PERSONAVISION_SAM_MODEL_ID` overrides the model id it asks for. What it settles is the one
thing this ticket could not: the request and response shape. A failure there is a fixture
to re-record and a parser to correct, never a broken run.
