import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  correctionMessage,
  readReply,
  readTokens,
  sumTokens,
} from '../src/meta-request.js';

/**
 * What one request is made of, read back from the two sides the provider's retry turns on:
 * whether a reply was unreadable or merely rejected, the pair of messages that carries a
 * parse error back to the model, and the arithmetic that bills a screen asked twice (#420).
 */

const textOf = (message: { readonly content: readonly unknown[] }): string => {
  const part = message.content.find(
    (item): item is { readonly type: string; readonly text: string } =>
      typeof item === 'object' && item !== null && 'text' in item,
  );
  return part?.text ?? '';
};

const faultOf = (replyText: string): string => {
  const reading = readReply(replyText);
  return reading.ok ? 'ok' : reading.fault;
};

describe('reading a reply', () => {
  it('calls a reply that is not a JSON object unreadable, and names the position', () => {
    const reading = readReply('{"intent": "I will click the ja');

    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.fault).toBe('unreadable');
    // The position is the whole value of feeding it back: it says where to look.
    expect(reading.detail).toContain('position');
  });

  it('calls a JSON object the interface will not take rejected, not unreadable', () => {
    // Each of these parsed: asking again would get the same object back, so each is one ask.
    expect(faultOf(JSON.stringify({ intent: 'go', action: { kind: 'teleport' } }))).toBe(
      'rejected',
    );
    expect(faultOf(JSON.stringify({ intent: 'go' }))).toBe('rejected');
    expect(faultOf(JSON.stringify({ action: { kind: 'scroll' } }))).toBe('rejected');
    expect(
      faultOf(JSON.stringify({ intent: 'go', action: { kind: 'click', targetElementId: 7 } })),
    ).toBe('rejected');
  });

  it('calls a reply that parses to something other than an object unreadable', () => {
    // No object came back at all, so there is nothing for the interface to have rejected.
    expect(faultOf('"I clicked it"')).toBe('unreadable');
    expect(faultOf('42')).toBe('unreadable');
  });

  it('calls an array unreadable, and says it is no object rather than blaming the intent', () => {
    // The decision wrapped in an array is a shape slip a model really makes, and `typeof` is
    // 'object' for one — so it has to be told apart deliberately or it reads as an object
    // with no intent, and is never asked again.
    const wrapped = JSON.stringify([
      { intent: 'That is the jacket.', action: { kind: 'click', targetElementId: 'el-jacket' } },
    ]);
    const reading = readReply(wrapped);

    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.fault).toBe('unreadable');
    expect(reading.detail).toBe('the reply is not a JSON object');
    expect(faultOf('[]')).toBe('unreadable');
  });

  it('reads a fenced object on the first ask, without a correction', () => {
    const reading = readReply(
      ['```json', JSON.stringify({ intent: 'go', action: { kind: 'scroll' } }), '```'].join('\n'),
    );

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.action).toEqual({ kind: 'scroll', targetElementId: null });
  });
});

describe('the correction a retry carries', () => {
  const detail = 'the reply is not JSON: Expected ‘,’ or ‘]’ after array element at position 840';

  it('names what was wrong, verbatim, and asks for one JSON object', () => {
    const message = correctionMessage(detail);

    expect(message.role).toBe('user');
    expect(textOf(message)).toContain(detail);
    expect(textOf(message)).toContain('one JSON object and nothing else');
  });

  it('replays the unreadable reply as the assistant turn it was, verbatim', () => {
    const unreadable = '{"intent": "half';

    expect(assistantMessage(unreadable)).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: unreadable }],
    });
  });
});

describe('what two calls of one screen cost', () => {
  it('adds the four figures a screen asked twice spent', () => {
    expect(
      sumTokens([
        { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 150 },
        { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 180, reasoningTokens: 90 },
      ]),
    ).toEqual({
      inputTokens: 2200,
      cachedInputTokens: 1300,
      outputTokens: 380,
      reasoningTokens: 240,
    });
  });

  it('leaves one call’s figures exactly as they were', () => {
    const one = readTokens({
      input_tokens: 135,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 182,
      output_tokens_details: { reasoning_tokens: 146 },
    });

    expect(sumTokens([one])).toEqual(one);
  });
});
