/**
 * parser.ts — text-protocol tool-call repair (ADR-0011). Many local models, even
 * ones that advertise native tools, sometimes emit a tool call as TEXT
 * (`{"name":"read","arguments":{...}}`, a fenced ```json block, or Hermes/Qwen
 * `<tool_call>…</tool_call>` tags) instead of the native `tool_calls` field.
 *
 * When a turn produced NO native tool call, the loop runs this over the assistant
 * text and converts a recovered call into a real tool call. Native is primary;
 * this is a gated fallback. To avoid EXECUTING example/config JSON that merely
 * mentions a tool (tool names are common words), a bare (unmarked) call is
 * accepted only when it DOMINATES the message (≥ CALL_DOMINANCE of the text);
 * calls inside an explicit `<tool_call>`/fenced marker are always honored. A
 * candidate must also be call-shaped (known name + an arguments/parameters/input
 * key). (Dominance guard adapted from the ollama-local-coding-agent recovery.)
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

/** Fraction of the (trimmed) message a bare call must occupy to be honored. */
const CALL_DOMINANCE = 0.5;

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

/**
 * Coerce a parsed object into a tool call if it names a KNOWN tool AND is
 * call-shaped (carries an arguments/parameters/input key). The args-key
 * requirement rejects bare `{"name":"read"}`-style mentions that are not calls.
 */
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

  const hasArgsKey =
    'arguments' in obj ||
    'parameters' in obj ||
    'input' in obj ||
    (fn !== undefined && 'arguments' in fn);
  if (!hasArgsKey) return undefined;

  let argsRaw =
    obj.arguments ?? obj.parameters ?? obj.input ?? fn?.arguments ?? {};
  if (typeof argsRaw === 'string') {
    const parsed = looseParse(argsRaw);
    argsRaw = parsed === null ? {} : parsed;
  }
  const input =
    typeof argsRaw === 'object' && argsRaw !== null
      ? (argsRaw as JsonObject)
      : {};
  return { name: nameRaw, input };
}

/** Fence languages that denote a shell command the model wants RUN (→ bash). */
const SHELL_LANGS = new Set([
  'sh', 'bash', 'shell', 'zsh', 'console', 'shell-session',
  'powershell', 'pwsh', 'ps', 'ps1', 'cmd', 'bat',
]);

/** A marker region: 'call' = expects a JSON tool call inside; 'shell' = a shell
 *  command fence whose body should become a bash call. */
type MarkerKind = 'call' | 'shell';

/**
 * Explicit tool-call marker regions: `<tool_call>…</tool_call>` tags and fenced
 * code blocks, each with its FULL span (so leftover-stripping removes the whole
 * marker) and a kind derived from the fence language. Non-shell/non-call fences
 * (e.g. ```python examples) are ignored so prose isn't misread as a call.
 */
function markerRegions(
  text: string,
): Array<{ inner: string; start: number; end: number; kind: MarkerKind }> {
  const regions: Array<{
    inner: string;
    start: number;
    end: number;
    kind: MarkerKind;
  }> = [];

  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  for (let m = tagRe.exec(text); m !== null; m = tagRe.exec(text)) {
    regions.push({ inner: m[1], start: m.index, end: m.index + m[0].length, kind: 'call' });
  }

  const fenceRe = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  for (let m = fenceRe.exec(text); m !== null; m = fenceRe.exec(text)) {
    const lang = m[1].toLowerCase();
    let kind: MarkerKind | null = null;
    if (lang === '' || lang === 'json' || lang === 'tool_call' || lang === 'tool') {
      kind = 'call';
    } else if (SHELL_LANGS.has(lang)) {
      kind = 'shell';
    }
    if (kind) {
      regions.push({ inner: m[2], start: m.index, end: m.index + m[0].length, kind });
    }
  }
  return regions;
}

/** Build the result: leftover = text minus consumed spans, tags/fences stripped. */
function buildResult(
  text: string,
  calls: ParsedTextCall[],
  consumed: Array<[number, number]>,
): RepairResult {
  if (calls.length === 0) return { calls: [], leftoverText: text };
  const ordered = [...consumed].sort((a, b) => a[0] - b[0]);
  let leftover = '';
  let cursor = 0;
  for (const [start, end] of ordered) {
    if (start >= cursor) {
      leftover += text.slice(cursor, start);
      cursor = end;
    }
  }
  leftover += text.slice(cursor);
  leftover = leftover
    .replace(/<\/?tool_call>/g, '')
    .replace(/```[a-zA-Z0-9_+-]*/g, '')
    .trim();
  return { calls, leftoverText: leftover };
}

/**
 * Recover tool calls from assistant text. Returns any recovered calls (in order)
 * plus leftover prose. Returns no calls when the text is ordinary prose that only
 * mentions/exemplifies a tool.
 */
export function parseTextToolCalls(
  text: string,
  knownToolNames: string[],
): RepairResult {
  const known = new Set(knownToolNames);
  const trimmedTotal = text.trim().length;
  if (trimmedTotal === 0) return { calls: [], leftoverText: text };

  // 1) Explicit markers — always honored (the model signalled intent).
  const explicitCalls: ParsedTextCall[] = [];
  const explicitConsumed: Array<[number, number]> = [];
  for (const region of markerRegions(text)) {
    let recovered: ParsedTextCall | undefined;
    for (const cand of findJsonObjects(region.inner)) {
      const parsed = looseParse(cand.raw);
      const call = parsed === null ? undefined : coerceCall(parsed, known);
      if (call) {
        recovered = call;
        break;
      }
    }
    // A shell fence with no JSON call inside is a command the model wants run:
    // synthesize a bash call so it executes instead of printing as dead text.
    if (!recovered && region.kind === 'shell' && known.has('bash')) {
      const command = region.inner.trim();
      if (command.length > 0) recovered = { name: 'bash', input: { command } };
    }
    if (recovered) {
      explicitCalls.push(recovered);
      explicitConsumed.push([region.start, region.end]);
    }
  }
  if (explicitCalls.length > 0) {
    return buildResult(text, explicitCalls, explicitConsumed);
  }

  // 2) Bare objects — honored only if they DOMINATE the message.
  const bareCalls: ParsedTextCall[] = [];
  const bareConsumed: Array<[number, number]> = [];
  let consumedLen = 0;
  for (const cand of findJsonObjects(text)) {
    const parsed = looseParse(cand.raw);
    const call = parsed === null ? undefined : coerceCall(parsed, known);
    if (call) {
      bareCalls.push(call);
      bareConsumed.push([cand.start, cand.end]);
      consumedLen += cand.raw.trim().length;
    }
  }
  if (bareCalls.length > 0 && consumedLen / trimmedTotal >= CALL_DOMINANCE) {
    return buildResult(text, bareCalls, bareConsumed);
  }

  // 3) Truncation fallback — a streamed/cut-off object that IS the message.
  if (bareCalls.length === 0) {
    const firstBrace = text.indexOf('{');
    if (firstBrace !== -1) {
      const tail = text.slice(firstBrace);
      if (tail.trim().length / trimmedTotal >= CALL_DOMINANCE) {
        const parsed = looseParse(tail);
        const call = parsed === null ? undefined : coerceCall(parsed, known);
        if (call) return buildResult(text, [call], [[firstBrace, text.length]]);
      }
    }
  }

  return { calls: [], leftoverText: text };
}
