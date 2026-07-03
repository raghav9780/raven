/**
 * render.ts — pure ANSI/string formatting for the terminal UI (no I/O). The REPL
 * (repl.ts) does the actual writing; this module turns tool calls, results,
 * diffs, and permission requests into colored strings.
 */

import type { JsonObject, PermissionRequest, ToolResult } from '../contracts.ts';

/** Raw ANSI codes. */
export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** Wrap `s` in a color and reset. */
export function paint(s: string, color: string): string {
  return `${color}${s}${C.reset}`;
}

/** Frames for the "thinking" spinner. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** One-line summary of a tool call, e.g. `⏺ write(note.txt)`. */
export function toolCallLine(name: string, input: JsonObject): string {
  let summary: string;
  if (typeof input.command === 'string') summary = clip(input.command, 80);
  else if (typeof input.path === 'string') summary = String(input.path);
  else if (typeof input.pattern === 'string') summary = String(input.pattern);
  else summary = clip(JSON.stringify(input), 80);
  return paint(`⏺ ${name}(${summary})`, C.cyan);
}

/** Indented, truncated result line with a ✓/✗ status. */
export function toolResultLine(result: ToolResult): string {
  const mark = result.ok ? paint('✓', C.green) : paint('✗', C.red);
  const body =
    typeof result.content === 'string'
      ? result.content
      : '[structured content]';
  const preview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  const indented = preview
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `  ${mark}\n${paint(indented, C.gray)}`;
}

/** Render a red/green line diff of `oldStr` → `newStr`. */
export function renderDiff(oldStr: string, newStr: string): string {
  const removed = oldStr
    .split('\n')
    .map((l) => paint(`- ${l}`, C.red))
    .join('\n');
  const added = newStr
    .split('\n')
    .map((l) => paint(`+ ${l}`, C.green))
    .join('\n');
  return `${removed}\n${added}`;
}

/**
 * A preview of what a tool is about to do, shown above a permission prompt:
 * the command for bash, a diff for edit, a content preview for write.
 */
export function permissionPreview(request: PermissionRequest): string {
  const input = request.input;
  if (request.toolName === 'bash' && typeof input.command === 'string') {
    return paint(`  $ ${input.command}`, C.yellow);
  }
  if (
    request.toolName === 'edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  ) {
    const path = typeof input.path === 'string' ? input.path : '(file)';
    return `  ${paint(path, C.bold)}\n${renderDiff(input.old_string, input.new_string)}`;
  }
  if (request.toolName === 'write' && typeof input.content === 'string') {
    const path = typeof input.path === 'string' ? input.path : '(file)';
    const lines = input.content.split('\n').slice(0, 12).join('\n');
    const more =
      input.content.split('\n').length > 12 ? paint('\n  …', C.dim) : '';
    return `  ${paint(path, C.bold)}\n${paint(lines, C.green)}${more}`;
  }
  return paint(`  ${request.toolName} ${JSON.stringify(input)}`, C.dim);
}
