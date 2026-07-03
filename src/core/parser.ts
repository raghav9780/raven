/**
 * parser.ts — text-protocol tool-call repair (ADR-0011). Many local models,
 * even ones that advertise native tools, sometimes emit a tool call as TEXT
 * (`{"name":"read","arguments":{...}}`, a fenced ```json block, or Hermes/Qwen
 * `<tool_call>…</tool_call>` tags) instead of the native `tool_calls` field.
 *
 * When a turn produced NO native tool call, the loop runs this over the assistant
 * text: if it finds a JSON object naming a KNOWN tool with an arguments object,
 * it converts it into a real tool call. This is a FALLBACK — native is primary,
 * and matching is gated on a known tool name to keep false positives low
 * (a model merely printing example JSON should not trigger execution unless the
 * name matches a real tool).
 */

import { looseParse } from './jsonRepair.ts';
import type { JsonObject } from '../contracts.ts';

/** A tool call recovered from assistant text. */
export interface ParsedTextCall {
  name: string;
  input: JsonObject;
}

/** Result of a repair pass: recovered calls + the prose with call blocks removed. */
export interface RepairResult {
  calls: ParsedTextCall[];
  leftoverText: string;
}

/** Scan for top-level `{…}` objects, honoring strings/escapes/nesting. */
function findJsonObjects(
  text: string,
): Array<{ raw: string; start: number; end: number }> {
  const out: Array<{ raw: string; start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          out.push({ raw: text.slice(start, i + 1), start, end: i + 1 });
          start = -1;
        }
      }
    }
  }
  return out;
}

/** Coerce a parsed object into a tool call if it names a known tool. */
function coerceCall(
  value: unknown,
  known: Set<string>,
): ParsedTextCall | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const fn =
    typeof obj.function === 'object' && obj.function !== null
      ? (obj.function as Record<string, unknown>)
      : undefined;

  const nameRaw = obj.name ?? obj.tool ?? obj.tool_name ?? fn?.name;
  if (typeof nameRaw !== 'string' || !known.has(nameRaw)) return undefined;

  let argsRaw =
    obj.arguments ?? obj.parameters ?? obj.input ?? fn?.arguments ?? {};
  if (typeof argsRaw === 'string') {
    try {
      argsRaw = JSON.parse(argsRaw);
    } catch {
      argsRaw = {};
    }
  }
  const input =
    typeof argsRaw === 'object' && argsRaw !== null
      ? (argsRaw as JsonObject)
      : {};
  return { name: nameRaw, input };
}

/**
 * Attempt to recover tool calls from assistant text. Returns any recovered calls
 * (in order) plus the leftover prose (matched call blocks and `<tool_call>` tags
 * stripped). If nothing matches, `calls` is empty and `leftoverText` is the input.
 */
export function parseTextToolCalls(
  text: string,
  knownToolNames: string[],
): RepairResult {
  const known = new Set(knownToolNames);
  const calls: ParsedTextCall[] = [];
  const consumed: Array<[number, number]> = [];

  for (const candidate of findJsonObjects(text)) {
    const parsed = looseParse(candidate.raw);
    if (parsed === null) continue;
    const call = coerceCall(parsed, known);
    if (call) {
      calls.push(call);
      consumed.push([candidate.start, candidate.end]);
    }
  }

  // Truncation fallback: the balanced scanner can't capture an object that was
  // cut off mid-stream (no closing brace). Try repairing from the first `{`.
  if (calls.length === 0) {
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
      const parsed = looseParse(text.slice(firstBrace));
      const call = parsed === null ? undefined : coerceCall(parsed, known);
      if (call) {
        calls.push(call);
        consumed.push([firstBrace, text.length]);
      }
    }
  }

  if (calls.length === 0) return { calls: [], leftoverText: text };

  // Build leftover prose: original text minus the consumed JSON spans, then
  // strip any dangling Hermes/Qwen tool-call tags and code fences.
  let leftover = '';
  let cursor = 0;
  for (const [start, end] of consumed) {
    leftover += text.slice(cursor, start);
    cursor = end;
  }
  leftover += text.slice(cursor);
  leftover = leftover
    .replace(/<\/?tool_call>/g, '')
    .replace(/```(?:json)?/g, '')
    .trim();

  return { calls, leftoverText: leftover };
}
