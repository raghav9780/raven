/**
 * ndjson.ts — newline-delimited JSON line decoder for Ollama's `/api/chat`
 * streaming responses. Ollama emits one complete JSON object per line while
 * streaming (NOT SSE, no `data:` prefix, no `[DONE]` sentinel), terminating with
 * a line whose `done` field is true.
 *
 * The decoder buffers across arbitrary TCP chunk boundaries: a chunk may split a
 * line mid-object, so we only surface a line once its trailing `\n` arrives.
 */

import type { DecodedLine, LineDecoder } from '../contracts.ts';

/**
 * Create a stateful NDJSON decoder. Push raw bytes/strings as they arrive from
 * the HTTP body; each call yields whatever complete lines are now available.
 */
export function createNdjsonDecoder(): LineDecoder {
  let buffer = '';
  const textDecoder = new TextDecoder();

  function decodeChunk(chunk: Uint8Array | string): string {
    return typeof chunk === 'string'
      ? chunk
      : textDecoder.decode(chunk, { stream: true });
  }

  function* drain(final: boolean): IterableIterator<DecodedLine> {
    // Split on newlines; keep the last (possibly partial) segment buffered
    // unless this is the final flush.
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const trimmed = rawLine.trim();
      if (trimmed.length > 0) {
        yield { data: JSON.parse(trimmed), raw: trimmed };
      }
      newlineIndex = buffer.indexOf('\n');
    }
    if (final) {
      const trimmed = buffer.trim();
      buffer = '';
      if (trimmed.length > 0) {
        yield { data: JSON.parse(trimmed), raw: trimmed };
      }
    }
  }

  return {
    push(chunk: Uint8Array | string): IterableIterator<DecodedLine> {
      buffer += decodeChunk(chunk);
      return drain(false);
    },
    flush(): IterableIterator<DecodedLine> {
      // Drain any bytes stranded inside the TextDecoder (a stream ending
      // mid-multibyte-sequence) before emitting the final buffered line.
      buffer += textDecoder.decode();
      return drain(true);
    },
  };
}
