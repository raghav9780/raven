/**
 * grep.ts — regex content search over the workspace, node:fs only. Reuses
 * glob.ts's `walkFiles`/`globToRegExp`. Skips binary and oversized files, bounds
 * the result count, and returns `path:line: text` hits.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { globToRegExp, walkFiles } from './glob.ts';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** Skip files larger than this (bytes) — likely data/build artifacts. */
const MAX_FILE_BYTES = 1_000_000;
/** Cap on reported matches so one broad pattern can't flood the context. */
const MAX_MATCHES = 200;
/** Truncate each reported line to keep output bounded. */
const MAX_LINE_CHARS = 300;

/** Heuristic: treat a chunk containing a NUL byte as binary. */
function looksBinary(sample: string): boolean {
  for (let i = 0; i < sample.length; i += 1) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents by regular expression. Returns matching lines as ' +
    '`path:line: text`. Optionally restrict to files matching a glob.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: {
        type: 'string',
        description: 'Base directory to search (default: working directory).',
      },
      glob: {
        type: 'string',
        description: 'Only search files whose path matches this glob (e.g. "**/*.ts").',
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  concurrencySafe: true,
  mutates: false,

  execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (pattern.length === 0) {
      return Promise.resolve({ ok: false, content: 'No pattern provided.' });
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, args.ignore_case === true ? 'i' : '');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ ok: false, content: `Invalid regex: ${message}` });
    }

    const base =
      typeof args.path === 'string' && args.path.length > 0
        ? isAbsolute(args.path)
          ? args.path
          : resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const globFilter =
      typeof args.glob === 'string' && args.glob.length > 0
        ? globToRegExp(args.glob)
        : undefined;

    const hits: string[] = [];
    let filesSearched = 0;
    let truncated = false;

    outer: for (const file of walkFiles(base)) {
      if (globFilter) {
        const relForGlob = relative(base, file).split('\\').join('/');
        if (!globFilter.test(relForGlob)) continue;
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;

      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(text.slice(0, 1024))) continue;
      filesSearched += 1;

      const relPath = relative(ctx.cwd, file).split('\\').join('/');
      // Split on CRLF or LF so `$`-anchored patterns match and no `\r` leaks.
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          const shown =
            lines[i].length > MAX_LINE_CHARS
              ? `${lines[i].slice(0, MAX_LINE_CHARS)}…`
              : lines[i];
          hits.push(`${relPath}:${i + 1}: ${shown}`);
          if (hits.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    const content =
      hits.length === 0
        ? `No matches for /${pattern}/`
        : hits.join('\n') + (truncated ? `\n… [capped at ${MAX_MATCHES} matches]` : '');
    return Promise.resolve({
      ok: true,
      content,
      truncated,
      meta: { matches: hits.length, filesSearched },
    });
  },
};
