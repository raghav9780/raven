/**
 * jsonRepair.ts — best-effort recovery of malformed JSON emitted by small local
 * models (tool arguments, text-protocol tool calls). Progressive repairs applied
 * cumulatively, re-parsing after each step and returning on the FIRST success.
 *
 * Fail-safe by design: returns `null` rather than guessing, and NEVER completes
 * an unterminated string — fabricating a closing quote would forge a truncated
 * value into a "valid" one that then gets executed/written verbatim. Better to
 * leave it unparseable. (Pattern adapted from the ollama-local-coding-agent
 * jsonRepair module.)
 */

// NOTE: this type-only import is also load-bearing for `node --check`: without a
// leading ESM marker, --check misdetects a `.ts` file with no top-level
// import/export as CommonJS and skips type-stripping (the file still runs fine
// under `import()`, but the syntax gate would fail).
import type { JsonValue } from '../contracts.ts';

/** Straighten curly/smart quotes to their ASCII equivalents. Built from unicode
 *  escapes so the source stays pure ASCII (raw smart-quote bytes in code trip up
 *  `node --check`). U+201C/U+201D = double; U+2018/U+2019 = single. */
function stripSmartQuotes(s: string): string {
  return s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

/** Convert single-quoted string literals to double-quoted ones. */
function singleToDouble(s: string): string {
  return s.replace(
    /'((?:[^'\\]|\\.)*)'/g,
    (_m, inner: string) => `"${inner.replace(/"/g, '\\"')}"`,
  );
}

/** Quote bare object keys: `{key:` / `,key:` → `{"key":` / `,"key":`. */
function quoteBareKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*):/g, '$1"$2"$3:');
}

/** Normalize Python literals to JSON (`True`/`False`/`None`). */
function pythonLiterals(s: string): string {
  return s
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
}

/** Remove a comma that immediately precedes a closing `}` or `]`. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Append matching closers for unclosed `{`/`[`. If the string ends inside an
 * open string literal, return it UNCHANGED (do not fabricate a closing quote).
 */
function closeUnbalanced(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inString) return s; // unterminated string → leave unparseable (safe)
  let out = s;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}

const STEPS: Array<(s: string) => string> = [
  (s) => s, // identity — try strict first
  stripSmartQuotes,
  singleToDouble,
  quoteBareKeys,
  pythonLiterals,
  stripTrailingCommas,
  closeUnbalanced,
  stripTrailingCommas, // a freshly added closer can expose a trailing comma
];

/**
 * Parse `raw` as JSON, progressively repairing common small-model breakage.
 * Returns the parsed value, or `null` if no repair yields valid JSON.
 */
export function looseParse(raw: string): JsonValue | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  for (const step of STEPS) {
    s = step(s);
    try {
      return JSON.parse(s) as JsonValue;
    } catch {
      // try the next repair
    }
  }
  return null;
}
