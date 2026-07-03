/**
 * write.ts — create or overwrite a file with the given contents, resolved
 * against the tool context's cwd. Parent directories are created as needed.
 * Mutating and not concurrency-safe (serialized with other writes/bash).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write text to a file (creating it or overwriting existing contents), ' +
    'creating parent directories as needed. Use `edit` for surgical changes to ' +
    'an existing file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path, absolute or relative to the working directory.',
      },
      content: { type: 'string', description: 'Full file contents to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  concurrencySafe: false,
  mutates: true,

  async execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const rawPath = typeof args.path === 'string' ? args.path : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (rawPath.length === 0) {
      return { ok: false, content: 'No path provided.' };
    }
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    const existed = existsSync(absolute);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Could not write ${rawPath}: ${message}` };
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    const lines = content.length === 0 ? 0 : content.split('\n').length;
    return {
      ok: true,
      content: `${existed ? 'Overwrote' : 'Created'} ${rawPath} (${lines} lines, ${bytes} bytes).`,
      meta: { path: absolute, created: !existed, bytes },
    };
  },
};
