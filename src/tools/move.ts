/**
 * move.ts — rename or move a file/directory. A dedicated verb so the model never
 * shoehorns a rename into `edit` (a content find/replace) or `write` (a full
 * rewrite). Renaming ≠ editing content; keeping them distinct is the single
 * biggest reliability win for local models (see ADR-0025).
 *
 * Uses fs.rename, with a copy+unlink fallback for the EXDEV case (rename across
 * devices/drives, common on Windows: D:\ → C:\). Refuses to clobber an existing
 * destination unless `overwrite` is true. Mutating and not concurrency-safe.
 */

import { rename, copyFile, unlink, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** True if `ancestor` is the same path as, or a parent of, `child`. */
function containsPath(ancestor: string, child: string): boolean {
  if (ancestor === child) return true;
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return child.startsWith(a);
}

export const moveTool: Tool = {
  name: 'move',
  description:
    'Rename or move a file or directory from `source` to `destination`. Use this ' +
    'for renames and moves — do NOT use edit (content find/replace) or write ' +
    '(full rewrite) to rename a file. Fails if the destination exists unless ' +
    '`overwrite` is true.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Existing path to move/rename (absolute or relative).',
      },
      destination: {
        type: 'string',
        description: 'New path (absolute or relative). Parent dirs are created.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite the destination if it already exists (default false).',
      },
    },
    required: ['source', 'destination'],
    additionalProperties: false,
  },
  concurrencySafe: false,
  mutates: true,
  disambiguationHint:
    '`move` renames or moves a file and needs `source` + `destination`. To change ' +
    "a file's contents use `edit` (find/replace) or `write` (full rewrite).",

  async execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const rawSource = typeof args.source === 'string' ? args.source : '';
    const rawDest = typeof args.destination === 'string' ? args.destination : '';
    const overwrite = args.overwrite === true;
    if (rawSource.length === 0) return { ok: false, content: 'No source provided.' };
    if (rawDest.length === 0) return { ok: false, content: 'No destination provided.' };

    // resolve() both normalizes separators AND honors an already-absolute path
    // (the cwd base is ignored when rawSource/rawDest is absolute) — so the
    // guards below compare canonical, same-separator paths.
    const source = resolve(ctx.cwd, rawSource);
    const dest = resolve(ctx.cwd, rawDest);
    const cwd = resolve(ctx.cwd);

    // Refuse to relocate the working directory itself or any parent of it —
    // moving the project root out from under a live session is catastrophic
    // (it orphans the harness's own state). Move specific files/subfolders.
    if (containsPath(source, cwd)) {
      return {
        ok: false,
        content:
          `Refusing to move "${rawSource}": it is the working directory ` +
          `(or a parent of it). That would relocate the whole project including ` +
          `the running session. Move specific files or subfolders instead ` +
          `(e.g. name each file, or a named subfolder).`,
      };
    }
    // Refuse to move something INTO itself (dest inside source) — an infinite-ish
    // recursive move.
    if (containsPath(source, dest)) {
      return {
        ok: false,
        content: `Refusing to move "${rawSource}" into itself ("${rawDest}").`,
      };
    }

    if (!existsSync(source)) {
      return { ok: false, content: `Source does not exist: ${rawSource}` };
    }
    if (source === dest) {
      return { ok: false, content: 'source and destination are identical.' };
    }
    if (existsSync(dest) && !overwrite) {
      return {
        ok: false,
        content: `Destination already exists: ${rawDest}. Set overwrite:true to replace it.`,
      };
    }

    try {
      // Create the destination parent only when missing (mkdir on an existing
      // drive root like D:\ throws EPERM — same guard as write.ts).
      const parent = dirname(dest);
      if (!existsSync(parent)) await mkdir(parent, { recursive: true });
      try {
        await rename(source, dest);
      } catch (err) {
        // Cross-device rename (EXDEV) — copy then remove. Files only; a
        // cross-device directory move is out of scope, surface a clear error.
        if ((err as { code?: string }).code === 'EXDEV') {
          if ((await stat(source)).isDirectory()) {
            return {
              ok: false,
              content:
                `Cannot move a directory across drives in one step (${rawSource} → ${rawDest}). ` +
                'Move its files individually or use bash.',
            };
          }
          await copyFile(source, dest);
          await unlink(source);
        } else {
          throw err;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Could not move ${rawSource} → ${rawDest}: ${message}` };
    }

    return {
      ok: true,
      content: `Moved ${rawSource} → ${rawDest}.`,
      meta: { source, destination: dest, overwritten: existsSync(dest) && overwrite },
    };
  },
};
