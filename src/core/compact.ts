/**
 * compact.ts — model-free context compaction over the PROJECTED message array
 * (the event log stays append-only; a synthetic `compaction` event records that
 * it happened). Runs before each model call; keeps context under a fraction of
 * the model's window so long/local sessions don't silently overflow `num_ctx`.
 *
 * Two cheapest-first stages (no extra model call): (1) placeholder-clear — shrink
 * large, older tool-result blocks to a marker (pair-safe); (2) drop-middle — keep
 * the first user message + the last K messages, replace the rest with a note.
 * An LLM-summary rung (contracts' `Summarize` strategy) can be added later.
 */

import type { ContentBlock, Message } from '../contracts.ts';

/** Fraction of the window we compact down toward (leaves headroom for output). */
const TARGET_FRACTION = 0.72;
/** Trigger compaction once usage exceeds this fraction of the window. */
const TRIGGER_FRACTION = 0.82;
/** Recent messages always kept verbatim. */
const KEEP_RECENT = 8;
/** A tool_result larger than this (chars) is eligible for placeholder-clear. */
const BIG_TOOL_RESULT_CHARS = 2000;

/** Tokenizer-free estimate (overestimate-biased): ~4 chars/token. */
export function estimateTokens(text: string): number {
  return tokensFromChars(text.length);
}

/** Tokens from a character count (~4 chars/token). */
function tokensFromChars(chars: number): number {
  return Math.ceil(chars / 4) + 1;
}

function blockChars(block: ContentBlock): number {
  if (block.type === 'text') return block.text.length;
  if (block.type === 'thinking') return block.thinking.length;
  if (block.type === 'tool_use') return block.name.length + JSON.stringify(block.input).length;
  if (block.type === 'tool_result') {
    return typeof block.content === 'string'
      ? block.content.length
      : JSON.stringify(block.content).length;
  }
  return 0;
}

function messageChars(message: Message): number {
  return message.content.reduce((sum, b) => sum + blockChars(b), 0);
}

function totalChars(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + messageChars(m), 0);
}

/** Total estimated tokens for a message array. */
export function estimateMessagesTokens(messages: Message[]): number {
  return tokensFromChars(totalChars(messages));
}

/** Placeholder-clear: shrink large tool_result blocks in all but the last
 *  `KEEP_RECENT` messages, keeping the tool_use↔tool_result pairing intact. */
function placeholderClear(messages: Message[]): Message[] {
  const cutoff = Math.max(0, messages.length - KEEP_RECENT);
  return messages.map((message, i) => {
    if (i >= cutoff) return message;
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length > BIG_TOOL_RESULT_CHARS
      ) {
        changed = true;
        return {
          ...block,
          content: `[earlier tool output elided to save context — ${block.content.length} chars]`,
        };
      }
      return block;
    });
    return changed ? { ...message, content } : message;
  });
}

/** Drop the middle: keep the first message + the last KEEP_RECENT, replace the
 *  rest with a single note. Last resort when placeholder-clear isn't enough. */
function dropMiddle(messages: Message[]): Message[] {
  if (messages.length <= KEEP_RECENT + 1) return messages;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-KEEP_RECENT);
  const note: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '[Earlier conversation was truncated to fit the context window. Ask to re-read any file you need.]',
      },
    ],
  };
  return [...head, note, ...tail];
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  strategy?: 'placeholder-clear' | 'drop-middle';
  before: number;
  after: number;
}

/**
 * Compact `messages` if they exceed `TRIGGER_FRACTION` of `contextWindow`.
 * Returns the (possibly rewritten) messages and whether/how it compacted.
 */
export function compactMessages(
  messages: Message[],
  contextWindow: number,
): CompactResult {
  const window = contextWindow > 0 ? contextWindow : 8192;
  const trigger = Math.floor(window * TRIGGER_FRACTION);
  const target = Math.floor(window * TARGET_FRACTION);
  const before = tokensFromChars(totalChars(messages));

  if (before <= trigger) return { messages, compacted: false, before, after: before };

  // Stage 1: placeholder-clear (pair-safe).
  const cleared = placeholderClear(messages);
  const afterClear = tokensFromChars(totalChars(cleared));
  if (afterClear <= target) {
    return { messages: cleared, compacted: true, strategy: 'placeholder-clear', before, after: afterClear };
  }

  // Stage 2: drop the middle.
  const dropped = dropMiddle(cleared);
  const afterDrop = tokensFromChars(totalChars(dropped));
  return { messages: dropped, compacted: true, strategy: 'drop-middle', before, after: afterDrop };
}
