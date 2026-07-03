/**
 * edit.ts — surgical edit by exact string replacement. `old_string` must occur
 * EXACTLY ONCE (unless `replace_all`), which forces the model to supply enough
 * surrounding context to make the edit unambiguous. Returns a compact diff.
 *
 * The lint-gate-with-revert (run a syntax check after applying; revert + 3-part
 * error if the edit introduces new errors) lands in slice 6; here the edit is
 * applied directly once the match is unique.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { checkSyntax } from './lint.ts';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** A minimal line-oriented diff of the changed region (context-free). */
function miniDiff(oldStr: string, newStr: string): string {
  const removed = oldStr.split('\n').map((l) => `- ${l}`);
  const added = newStr.split('\n').map((l) => `+ ${l}`);
  return [...removed, ...added].join('\n');
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace an exact string in a file with a new string. `old_string` must ' +
    'match EXACTLY and be unique (include surrounding context) unless ' +
    '`replace_all` is true. Returns a diff of the change.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find (must be unique unless replace_all).',
      },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring uniqueness.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  concurrencySafe: false,
  mutates: true,

  async execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    const replaceAll = args.replace_all === true;
    if (rawPath.length === 0) return { ok: false, content: 'No path provided.' };
    if (oldString.length === 0) {
      return { ok: false, content: 'old_string must not be empty.' };
    }
    if (oldString === newString) {
      return { ok: false, content: 'old_string and new_string are identical.' };
    }

    const absolute = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    let original: string;
    try {
      original = await readFile(absolute, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Could not read ${rawPath}: ${message}` };
    }

    const occurrences = countOccurrences(original, oldString);
    if (occurrences === 0) {
      return {
        ok: false,
        content: `old_string not found in ${rawPath}. It must match the file exactly (whitespace included).`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        content: `old_string is not unique in ${rawPath} (${occurrences} matches). Add surrounding context to make it unique, or set replace_all.`,
      };
    }

    // Use split/join (replace_all) or a replacer FUNCTION (single) so special
    // replacement patterns in new_string ($$, $&, $`, $') are inserted
    // literally rather than interpreted by String.prototype.replace.
    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, () => newString);

    // Lint-gate: reject an edit that would introduce a syntax error, leaving the
    // file unchanged, so the model sees the problem and can correct it.
    const syntaxError = checkSyntax(absolute, updated);
    if (syntaxError) {
      return {
        ok: false,
        content:
          `Edit rejected — it would introduce a syntax error, so ${rawPath} was ` +
          `NOT changed:\n${syntaxError}\n\nAdjust the edit and try again.`,
      };
    }

    try {
      await writeFile(absolute, updated, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Could not write ${rawPath}: ${message}` };
    }

    const replacements = replaceAll ? occurrences : 1;
    return {
      ok: true,
      content: `Edited ${rawPath} (${replacements} replacement${replacements === 1 ? '' : 's'}):\n${miniDiff(oldString, newString)}`,
      meta: { path: absolute, replacements },
    };
  },
};
