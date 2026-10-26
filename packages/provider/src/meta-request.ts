import { createHash } from 'node:crypto';
import { DECISION_ACTION_KINDS } from './types.js';
import type {
  DecisionAction,
  DecisionContext,
  DecisionScreenshot,
  DecisionSessionIdentity,
  FixatedElement,
  PastAction,
  RelevanceHints,
} from './types.js';
import type { ModelId } from './meta-pricing.js';

/**
 * What one request to the responses protocol is made of, and how a reply is read back.
 *
 * The shape of a request is decided here rather than inside the provider because the
 * caching rules are shape rules, and they are the expensive thing to get wrong:
 *
 * 1. **The whole conversation goes in `input`, every turn** — the instructions, the persona
 *    and its task, the tools, then every earlier turn, then the new message. The history is
 *    never carried by `previous_response_id`: the instructions and the tools have to be
 *    resent anyway, so the conversation is built from our own record of it.
 * 2. **The conversation is append-only.** Turn N's `input` is a byte-exact prefix of turn
 *    N+1's: an earlier message is never edited, reordered or re-rendered. Nothing in the
 *    prefix is a timestamp, a random id, a `Date.now()` or an iteration over a map whose
 *    order could change — the elements of a screen are rendered in the order the capture
 *    handed them over, and that screen's message is never touched again.
 * 4. **`previous_response_id` is not sent at all.** The protocol prepends the stored turns of
 *    the response it names and then appends `input`, so a request that carries both pays for
 *    every earlier turn twice — measured live: turn 2 of a session billed 1,363 input tokens
 *    with the id and 767 without it, for the same two screens (2026-10-27). Our own record of the
 *    conversation is the whole history, which is what the instructions and the tools having to
 *    be resent every turn already forces.
 * 3. **Only the tail is volatile**: the elements fixated on *this* screen, the action
 *    history, the step. A changed prefix is a cache miss on every screen of every session,
 *    and the run then pays uncached prices for the whole swarm.
 *
 * Nothing here reads an environment variable, and nothing here knows the key: a request
 * body built in this module is safe to hand to a trajectory file as it stands (#139).
 */

/** The protocol's text part, as it arrives from us and as it comes back. */
export interface ResponsesInputText {
  readonly type: 'input_text';
  readonly text: string;
}

export interface ResponsesOutputText {
  readonly type: 'output_text';
  readonly text: string;
}

/** A screenshot, sent only to a model whose spec says it accepts image input. */
export interface ResponsesInputImage {
  readonly type: 'input_image';
  readonly image_url: string;
}

export type ResponsesContent = ResponsesInputText | ResponsesOutputText | ResponsesInputImage;

export interface ResponsesMessage {
  readonly role: 'developer' | 'user' | 'assistant';
  readonly content: readonly ResponsesContent[];
}

/**
 * The body of one `POST /v1/responses`. `reasoning` is deliberately absent: `effort: "max"`
 * is not available on the contributor model, so no request this provider builds sets it in
 * either mode, and the reasoning tokens the model spends anyway are counted as billed
 * output rather than asked for.
 */
export interface ResponsesRequestBody {
  readonly model: ModelId;
  readonly input: readonly ResponsesMessage[];
  /** One per agent session, from persona + seed: every screen of a session shares it. */
  readonly prompt_cache_key: string;
  readonly prompt_cache_retention: '24h';
  readonly max_output_tokens: number;
}

/**
 * How much the model may spend on one screen, reasoning tokens included — and they are most
 * of it: a live contributor call on the fixture screen spent 1,697 of its 1,763 output
 * tokens on reasoning (observed 2026-10-27). The cap is well clear of that, because a screen
 * whose reasoning runs into the cap comes back `incomplete` and is lost to the run as an
 * automation failure, which costs more than the tokens would have.
 */
export const MAX_OUTPUT_TOKENS = 4096;

const developer = (text: string): ResponsesMessage => ({
  role: 'developer',
  content: [{ type: 'input_text', text }],
});

/**
 * The instructions: a constant, because every byte of the prefix that could vary is a cache
 * entry thrown away. They state the knowledge boundary the interface already enforces, so
 * that a model is told what `validateDecision` would otherwise only reject it for.
 */
export const INSTRUCTIONS = [
  'You are one simulated person using a website, and you report what you do one screen at a time.',
  'You can see only what this screen’s list of looked-at elements says you looked at. There is no',
  'page source, no selector and no element you were not told about: an element that is not on the',
  'list does not exist for you, and naming one invalidates your whole answer.',
  '',
  'Answer with one JSON object and nothing else — no prose around it, no code fence:',
  '{"intent": "<what you are doing, in your own words, first person>",',
  ' "action": {"kind": "<one of the kinds below>", "targetElementId": "<an element id>" or null},',
  ' "relevanceHints": {"<element id>": <0..1>}}',
  '',
  '"relevanceHints" is optional: include it only for elements you actually weighed, and score how',
  'much each one looked like the thing you are after.',
].join('\n');

/**
 * The tools: the six things the person can do, as the interface publishes them. Sent as part
 * of the conversation rather than as a protocol `tools` array, so that one append-only
 * `input` is the whole of what the model is given and the cached prefix is the whole of what
 * it costs.
 */
export const TOOLS = [
  'The only actions you have, exactly one per screen:',
  '- click (targetElementId required) — act on an element you looked at.',
  '- read (targetElementId required) — read an element’s words properly before acting.',
  '- scroll (targetElementId null) — look further down this screen.',
  '- hesitate (targetElementId null) — pause, because the screen is not yielding.',
  '- backtrack (targetElementId null) — go back to the screen before this one.',
  '- abandon (targetElementId null) — give up on the task.',
  '',
  'click and read name an element from this screen’s list. The other four always have',
  'targetElementId null, because they are not aimed at an element.',
].join('\n');

const trait = (name: string, value: number): string => `- ${name}: ${value}`;

/**
 * Who this session is and what it is trying to do — the second half of the stable prefix.
 * Both are a session's own and neither changes between its screens, so both belong here
 * rather than in the per-screen message.
 */
const personaMessage = (context: DecisionContext): ResponsesMessage =>
  developer(
    [
      'Who you are, as behaviour on a scale of 0 to 1:',
      trait('persistence', context.traits.persistence),
      trait('scanning vs reading (0 reads every word, 1 scans)', context.traits.scanningVsReading),
      trait('detail orientation', context.traits.detailOrientation),
      trait('familiarity with interfaces like this', context.traits.interfaceFamiliarity),
      trait('patience', context.traits.patience),
      trait('risk tolerance', context.traits.riskTolerance),
      '',
      'What you came to do:',
      context.goal.text,
    ].join('\n'),
  );

/**
 * The three messages that open every request of a session, in the order the owner fixed:
 * instructions, persona and task, tools. Built once per session from its first screen and
 * never rebuilt — see `conversationPrefix`'s note in `meta-model.ts`.
 */
export const buildPrefix = (context: DecisionContext): readonly ResponsesMessage[] => [
  developer(INSTRUCTIONS),
  personaMessage(context),
  developer(TOOLS),
];

const elementLine = (element: FixatedElement): string => {
  const named = element.name === undefined ? '' : ` (accessible name: “${element.name}”)`;
  return `- ${element.id} · ${element.role ?? 'no role'} · “${element.text}”${named} · ${element.fixationCount} fixations, ${element.dwellMs}ms`;
};

const historyLine = (action: PastAction, index: number): string =>
  `${index + 1}. on ${action.step}: ${action.kind}${
    action.targetElementId === null ? '' : ` on ${action.targetElementId}`
  } — ${action.ok ? 'it did what you expected' : 'it did not work'}`;

/**
 * The volatile tail: this screen, this step, this action history. Everything that changes
 * from screen to screen is in this one message, and the screenshot joins it only when the
 * model called accepts image input.
 */
/**
 * **The image part's wire shape is not settled.** No model in the price table accepts image
 * input, so this branch sends nothing today; `image_url` carries the run-relative path the
 * context gave us, which is not something an HTTP API can fetch. Whichever ticket flips a
 * model's `acceptsImages` owes this a verified encoding — a data URL built from the file, or a
 * hosted URL — and the test that covers the branch asserts the screenshot is there rather than
 * blessing the shape.
 */
export const buildScreenMessage = (
  context: DecisionContext,
  options: { readonly acceptsImages: boolean },
): ResponsesMessage => {
  const step =
    context.step.label === undefined
      ? context.step.id
      : `${context.step.id} — ${context.step.label}`;
  const text = [
    `Screen ${context.step.index + 1} of this session; step: ${step}`,
    '',
    context.fixatedElements.length === 0
      ? 'You have looked at nothing on this screen yet.'
      : [
          'What you have looked at on this screen:',
          ...context.fixatedElements.map(elementLine),
        ].join('\n'),
    '',
    context.history.length === 0
      ? 'You have done nothing yet this session.'
      : ['What you have done so far:', ...context.history.map(historyLine)].join('\n'),
    '',
    'What do you do now? One JSON object.',
  ].join('\n');

  const screenshot: DecisionScreenshot | undefined = options.acceptsImages
    ? context.screenshot
    : undefined;

  return {
    role: 'user',
    content:
      screenshot === undefined
        ? [{ type: 'input_text', text }]
        : [
            { type: 'input_text', text },
            { type: 'input_image', image_url: screenshot.path },
          ],
  };
};

/** The model's own reply, replayed back to it as the turn it was. */
export const assistantMessage = (replyText: string): ResponsesMessage => ({
  role: 'assistant',
  content: [{ type: 'output_text', text: replyText }],
});

/**
 * One agent session's cache key: a digest of persona + seed, so that every screen of a
 * session shares one cache entry and two sessions never share one. A digest rather than the
 * two values themselves, so that a persona id a customer chose never travels to the provider
 * as a key.
 */
export const promptCacheKey = (identity: DecisionSessionIdentity): string =>
  `pv-${createHash('sha256').update(`${identity.personaId}\u0000${identity.seed}`).digest('hex').slice(0, 24)}`;

/**
 * The cache key for a decision that belongs to no session: a digest of the stable prefix
 * itself. Two one-off decisions for the same persona and task share an entry, which is what
 * they would share anyway, and neither of them joins a real session's.
 */
export const anonymousCacheKey = (prefix: readonly ResponsesMessage[]): string =>
  `pv-anon-${createHash('sha256').update(JSON.stringify(prefix)).digest('hex').slice(0, 24)}`;

export const buildRequestBody = (options: {
  readonly modelId: ModelId;
  readonly input: readonly ResponsesMessage[];
  readonly promptCacheKey: string;
}): ResponsesRequestBody => ({
  model: options.modelId,
  input: options.input,
  prompt_cache_key: options.promptCacheKey,
  prompt_cache_retention: '24h',
  max_output_tokens: MAX_OUTPUT_TOKENS,
});

/** What the model spent, as the five figures a decision reports minus the price. */
export interface ReportedTokens {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

/**
 * What the response says it cost. A figure the response does not report is **zero, never a
 * guess**: a model that reports no `input_tokens_details.cached_tokens` served nothing from
 * cache as far as we can tell, and inventing a cached count would make a run look cheaper
 * than the invoice. The two "of which" figures are clamped to their totals, because a
 * decision whose cached tokens exceeded its input tokens would be rejected by
 * `validateDecision` and lose the whole call.
 *
 * Both figures really are "of which", as the live calls on 2026-10-27 reported them: 497
 * cached of 572 input tokens, and 1,697 reasoning of 1,763 output tokens. The clamp therefore
 * only fires if the protocol's own accounting changes under us.
 */
export const readTokens = (usage: unknown): ReportedTokens => {
  const block = isObject(usage) ? usage : {};
  const inputDetails = isObject(block.input_tokens_details) ? block.input_tokens_details : {};
  const outputDetails = isObject(block.output_tokens_details) ? block.output_tokens_details : {};
  const inputTokens = count(block.input_tokens);
  const outputTokens = count(block.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(count(inputDetails.cached_tokens), inputTokens),
    outputTokens,
    reasoningTokens: Math.min(count(outputDetails.reasoning_tokens), outputTokens),
  };
};

export interface ReadResponse {
  readonly replyText: string;
  readonly tokens: ReportedTokens;
}

/**
 * Why a response produced no decision. The three are kept apart because they send an
 * investigation to three different places: the model declined, our own output cap cut the
 * answer off, or the envelope was not what the protocol documents.
 */
export type ResponseFault = 'refusal' | 'incomplete' | 'unparseable';

export type ResponseReading =
  | { readonly ok: true; readonly value: ReadResponse }
  | { readonly ok: false; readonly fault: ResponseFault; readonly detail: string };

const faulty = (fault: ResponseFault, detail: string): ResponseReading => ({
  ok: false,
  fault,
  detail,
});

/**
 * Reads the protocol's envelope: the reply text out of the assistant's message, and the usage
 * out of `usage`.
 *
 * The text is taken from `output` items of type `message` only. A `reasoning` item that
 * carried a text part would otherwise be concatenated in front of the JSON — the decision
 * would be lost as unparseable, and the conversation would replay back to the model something
 * it never said.
 */
export const readResponse = (body: unknown): ResponseReading => {
  if (!isObject(body)) {
    return faulty('unparseable', `the response body is not an object: ${typeof body}`);
  }

  const status = typeof body.status === 'string' ? body.status : undefined;
  const output = Array.isArray(body.output) ? body.output : [];
  const texts: string[] = [];
  const refusals: string[] = [];

  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === 'refusal' && typeof item.refusal === 'string') refusals.push(item.refusal);
    if (item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (!isObject(part)) continue;
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') refusals.push(part.refusal);
    }
  }

  if (refusals.length > 0) return faulty('refusal', `the model refused: ${refusals.join(' ')}`);
  if (status === 'incomplete') {
    // Our own `max_output_tokens` is the usual reason, and it is our failure rather than the
    // model's: a run that lost screens this way should be sent to the cap, not to the model.
    const details = isObject(body.incomplete_details)
      ? JSON.stringify(body.incomplete_details)
      : '';
    return faulty(
      'incomplete',
      `the answer was cut off before it finished${details === '' ? '' : `: ${details}`}`,
    );
  }
  if (status !== undefined && status !== 'completed') {
    return faulty('unparseable', `the response came back ${status} rather than completed`);
  }
  if (texts.length === 0) {
    return faulty('unparseable', 'the response carried no output text to read a decision from');
  }

  return { ok: true, value: { replyText: texts.join(''), tokens: readTokens(body.usage) } };
};

/** What the model said it does, before the interface's own check is applied to it. */
export interface ReadReply {
  readonly intent: string;
  readonly action: DecisionAction;
  readonly relevanceHints?: RelevanceHints;
}

export type ReplyReading =
  | { readonly ok: true; readonly value: ReadReply }
  | { readonly ok: false; readonly detail: string };

const FENCED = /```(?:json)?\s*([\s\S]*?)```/;

/**
 * Reads the JSON object out of the model's reply. A fenced block is unwrapped — models fence
 * JSON however often they are asked not to, and throwing the call away over three backticks
 * would cost the run a screen — but anything that is not a JSON object with an intent and an
 * action is reported, never patched into a decision.
 */
export const readReply = (replyText: string): ReplyReading => {
  const fenced = FENCED.exec(replyText);
  const source = (fenced?.[1] ?? replyText).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      detail: `the reply is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isObject(parsed)) return { ok: false, detail: 'the reply is not a JSON object' };
  const { intent, action, relevanceHints } = parsed;
  if (typeof intent !== 'string') return { ok: false, detail: 'the reply carries no intent' };
  if (!isObject(action)) return { ok: false, detail: 'the reply carries no action' };

  const kind = action.kind;
  if (typeof kind !== 'string' || !DECISION_ACTION_KINDS.includes(kind as never)) {
    return { ok: false, detail: `the reply’s action kind is ${JSON.stringify(kind)}` };
  }
  const target = action.targetElementId;
  if (target !== undefined && target !== null && typeof target !== 'string') {
    return { ok: false, detail: `the reply’s target is ${JSON.stringify(target)}` };
  }

  const hints = isObject(relevanceHints)
    ? Object.fromEntries(
        Object.entries(relevanceHints).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      )
    : undefined;

  return {
    ok: true,
    value: {
      intent,
      action: {
        kind: kind as DecisionAction['kind'],
        targetElementId: typeof target === 'string' ? target : null,
      },
      ...(hints === undefined || Object.keys(hints).length === 0 ? {} : { relevanceHints: hints }),
    },
  };
};
