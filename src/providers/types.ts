/**
 * types.ts — provider-layer type surface. Re-exports the provider-related
 * contract types so adapters and the loop can import them from one place, and
 * defines a small `StreamAdapter` helper contract used by adapters that must
 * accumulate streamed tool-call argument fragments before parsing (Anthropic /
 * OpenAI). Ollama delivers whole tool-call objects and does not need it, but the
 * helper lives here so slice-7 adapters share it.
 */

export type {
  ModelProvider,
  CapabilityProfile,
  DiscoveredModel,
  StreamDelta,
  ChatOptions,
  ToolSpec,
  Message,
  Usage,
} from '../contracts.ts';

import type { JsonObject } from '../contracts.ts';

/**
 * Accumulates partial-JSON tool-call argument fragments keyed by stream index,
 * then parses each once at block stop. Providers that deliver whole objects
 * (Ollama, Gemini) can bypass this entirely.
 */
export interface ToolArgAccumulator {
  /** Begin a new tool call at `index` with its id + name. */
  start(index: number, id: string, name: string): void;
  /** Append a raw partial-JSON fragment to the call at `index`. */
  append(index: number, fragment: string): void;
  /** Finalize `index`: JSON.parse the concatenated fragments, return the call. */
  finish(index: number): { id: string; name: string; input: JsonObject };
}

/**
 * A default in-memory accumulator. Kept dependency-free; a single `JSON.parse`
 * happens in `finish` (never on an individual fragment).
 */
export function createToolArgAccumulator(): ToolArgAccumulator {
  const calls = new Map<number, { id: string; name: string; frag: string }>();
  return {
    start(index, id, name) {
      calls.set(index, { id, name, frag: '' });
    },
    append(index, fragment) {
      const call = calls.get(index);
      if (call) call.frag += fragment;
    },
    finish(index) {
      const call = calls.get(index);
      if (!call) throw new Error(`no tool call buffered at index ${index}`);
      const input =
        call.frag.trim().length > 0 ? JSON.parse(call.frag) : {};
      return { id: call.id, name: call.name, input: input as JsonObject };
    },
  };
}
