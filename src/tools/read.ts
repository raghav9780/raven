/**
 * read.ts — read a file's contents, resolved against the tool context's cwd.
 * Read-only and concurrency-safe. Output is capped and optionally windowed by
 * line offset/limit to protect the context window. Errors (missing file, is a
 * directory) return `ok:false` in-band rather than throwing.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** Hard cap on returned characters before truncation. */
const MAX_READ_CHARS = 30_000;

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a UTF-8 text file and return its contents with 1-based line numbers. ' +
    'Optionally window the output with `offset` (start line) and `limit` (max lines).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      offset: {
        type: 'number',
        description: '1-based line to start reading from.',
      },
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  concurrencySafe: true,
  mutates: false,

  async execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    if (rawPath.length === 0) {
      return { ok: false, content: 'No path provided.' };
    }
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

    let text: string;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Could not read ${rawPath}: ${message}` };
    }

    const allLines = text.split('\n');
    const offset =
      typeof args.offset === 'number' && args.offset > 0
        ? Math.floor(args.offset)
        : 1;
    const limit =
      typeof args.limit === 'number' && args.limit > 0
        ? Math.floor(args.limit)
        : allLines.length;

    const startIndex = offset - 1;
    const selected = allLines.slice(startIndex, startIndex + limit);
    const numbered = selected
      .map((line, i) => `${startIndex + i + 1}\t${line}`)
      .join('\n');

    const truncated = numbered.length > MAX_READ_CHARS;
    const content = truncated
      ? `${numbered.slice(0, MAX_READ_CHARS)}\n… [truncated]`
      : numbered;

    return {
      ok: true,
      content: content.length > 0 ? content : '(empty file)',
      truncated,
      meta: { path: absolute, totalLines: allLines.length },
    };
  },
};
