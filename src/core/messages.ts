/**
 * messages.ts — the streaming reducer and request builder. `reduceStream`
 * consumes a provider's `StreamDelta` async-iterable and folds it into ONE
 * canonical assistant turn (thinking + text + tool_use blocks) plus usage and a
 * stop reason. It accumulates tool-call argument fragments by index and relies
 * on the adapter having already parsed whole objects into `tool-call-done`.
 *
 * `buildRequest` is the thin wrapper the loop calls to project the event log
 * into the provider message array.
 */

import { projectMessages } from './events.ts';
import { looseParse } from './jsonRepair.ts';
import type {
  AgentEvent,
  ContentBlock,
  Message,
  StopReason,
  StreamDelta,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from '../contracts.ts';

/** The canonical assistant turn produced by reducing a provider stream. */
export interface ReducedTurn {
  content: ContentBlock[];
  toolUses: ToolUseBlock[];
  stopReason: StopReason;
  usage: Usage;
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Error thrown when the provider stream surfaces an ErrorDelta. Carries the
 *  transport metadata so the loop's recovery layer can decide whether to retry. */
export class ProviderStreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  constructor(delta: Extract<StreamDelta, { type: 'error' }>) {
    super(
      `provider error [${delta.code}]${
        delta.httpStatus ? ` (HTTP ${delta.httpStatus})` : ''
      }: ${delta.message}`,
    );
    this.name = 'ProviderStreamError';
    this.code = delta.code;
    this.retryable = delta.retryable ?? false;
    this.httpStatus = delta.httpStatus;
    this.retryAfterSeconds = delta.retryAfterSeconds;
  }
}

/** Best-effort parse of an accumulated partial-JSON tool-arg fragment, with
 *  small-model JSON repair (trailing commas, single quotes, truncation, …). */
function parseFragment(frag: string): Record<string, unknown> {
  const parsed = looseParse(frag);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Project the event log into provider messages for the next model call. */
export function buildRequest(events: AgentEvent[]): Message[] {
  return projectMessages(events);
}

/**
 * Reduce a provider stream into an assistant turn. `onDelta` (optional) is
 * invoked for every delta so the UI can render text/tool calls as they stream.
 * NEVER parses tool-arg fragments itself — it appends `tool-call-delta`
 * fragments by index and takes the parsed `input` from `tool-call-done`.
 */
export async function reduceStream(
  deltas: AsyncIterable<StreamDelta>,
  onDelta?: (delta: StreamDelta) => void,
): Promise<ReducedTurn> {
  let text = '';
  let thinking = '';
  let thinkingSignature: string | undefined;
  let stopReason: StopReason = 'unknown';
  let usage: Usage = EMPTY_USAGE;

  // index → assembled tool call
  const toolCalls = new Map<
    number,
    { id: string; name: string; frag: string; input?: Record<string, unknown> }
  >();

  for await (const delta of deltas) {
    onDelta?.(delta);
    switch (delta.type) {
      case 'text-delta':
        text += delta.text;
        break;
      case 'thinking-delta':
        thinking += delta.thinking;
        if (delta.signature) thinkingSignature = delta.signature;
        break;
      case 'tool-call-start':
        toolCalls.set(delta.index, {
          id: delta.id,
          name: delta.name,
          frag: '',
        });
        break;
      case 'tool-call-delta': {
        const call = toolCalls.get(delta.index);
        if (call) call.frag += delta.fragment;
        break;
      }
      case 'tool-call-done': {
        const existing = toolCalls.get(delta.index);
        if (existing) {
          existing.id = delta.id;
          existing.name = delta.name;
          existing.input = delta.input;
        } else {
          toolCalls.set(delta.index, {
            id: delta.id,
            name: delta.name,
            frag: '',
            input: delta.input,
          });
        }
        break;
      }
      case 'usage':
        usage = delta.usage;
        break;
      case 'done':
        stopReason = delta.stopReason;
        if (delta.usage) usage = delta.usage;
        break;
      case 'error':
        // Surface as a typed throw; the loop's recovery layer decides whether to
        // retry based on `retryable`/`httpStatus`.
        throw new ProviderStreamError(delta);
      default:
        break;
    }
  }

  const content: ContentBlock[] = [];
  if (thinking.length > 0) {
    const block: ThinkingBlock = { type: 'thinking', thinking };
    if (thinkingSignature) block.signature = thinkingSignature;
    content.push(block);
  }
  if (text.length > 0) {
    const block: TextBlock = { type: 'text', text };
    content.push(block);
  }

  const toolUses: ToolUseBlock[] = [];
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    // Prefer the parsed `input` from tool-call-done. If the stream ended before
    // that (truncation / max_tokens mid-arguments), fall back to parsing the
    // accumulated fragment; on failure use {} (the tool reports the bad args).
    const input = call.input ?? parseFragment(call.frag);
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: input as ToolUseBlock['input'],
    };
    content.push(block);
    toolUses.push(block);
  }

  // If the model emitted tool calls, normalize the stop reason to tool_use.
  if (toolUses.length > 0 && stopReason !== 'tool_use') {
    stopReason = 'tool_use';
  }

  return { content, toolUses, stopReason, usage };
}
