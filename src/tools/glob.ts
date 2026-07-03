/**
 * glob.ts — filename matching over the workspace using only node:fs (no
 * ripgrep, no fast-glob). Exports a shared `walkFiles` + `globToRegExp` used by
 * grep.ts too. Supports `**` (any depth), `*` (any run within a segment), and
 * `?` (single char). Common noise dirs are skipped.
 */

import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** Directories never descended into (huge and rarely relevant). */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  '.raven',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
];

/** Hard cap on files visited so a huge tree can't hang the agent. */
const MAX_FILES = 20_000;

/** Translate a glob pattern into an anchored RegExp (POSIX-style forward slashes). */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` → any number of path segments; consume an optional trailing slash
        re += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Recursively list files under `root`, skipping ignored dirs, capped. */
export function walkFiles(
  root: string,
  ignoreDirs: readonly string[] = DEFAULT_IGNORE_DIRS,
): string[] {
  const out: string[] = [];
  const ignore = new Set(ignoreDirs);
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir → skip
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/*.json"). Returns matching ' +
    'paths relative to the working directory. Supports **, *, and ?.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match.' },
      path: {
        type: 'string',
        description: 'Base directory to search (default: working directory).',
      },
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
    const base =
      typeof args.path === 'string' && args.path.length > 0
        ? isAbsolute(args.path)
          ? args.path
          : resolve(ctx.cwd, args.path)
        : ctx.cwd;

    const re = globToRegExp(pattern);
    const matches: string[] = [];
    for (const file of walkFiles(base)) {
      const rel = relative(base, file).split('\\').join('/');
      if (re.test(rel)) matches.push(relative(ctx.cwd, file).split('\\').join('/'));
    }
    matches.sort();
    const content =
      matches.length === 0
        ? `No files match ${pattern}`
        : matches.join('\n');
    return Promise.resolve({
      ok: true,
      content,
      meta: { count: matches.length },
    });
  },
};
