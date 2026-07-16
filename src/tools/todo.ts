/**
 * todo.ts — the `todo_write` planning tool. The model maintains a short working
 * plan; each call REPLACES the whole list (so statuses stay in sync). The loop
 * re-injects the current list as a `<system-reminder>` every turn to keep a weak
 * model on-plan and stop it from forgetting remaining steps mid-task.
 *
 * The tool owns no state: it validates + normalizes the items and hands them to
 * `ctx.setTodos` (the loop holds the run-scoped list). Read-only w.r.t. the
 * filesystem, so it's concurrency-safe and never gated.
 */

import type {
  JsonObject,
  JsonValue,
  TodoItem,
  TodoStatus,
  Tool,
  ToolContext,
  ToolResult,
} from '../contracts.ts';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/** Coerce one raw array element into a TodoItem, or null if unusable. */
function toItem(raw: JsonValue): TodoItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as JsonObject;
  const content = typeof obj.content === 'string' ? obj.content.trim() : '';
  if (content.length === 0) return null;
  const status =
    typeof obj.status === 'string' && (STATUSES as string[]).includes(obj.status)
      ? (obj.status as TodoStatus)
      : 'pending';
  return { content, status };
}

const SYMBOL: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/** Render the list for the tool's own result (the loop injects the reminder). */
function summarize(items: TodoItem[]): string {
  const counts = { completed: 0, in_progress: 0, pending: 0 };
  for (const it of items) counts[it.status] += 1;
  const lines = items.map((it) => `  ${SYMBOL[it.status]} ${it.content}`);
  return (
    `Plan updated (${items.length} item${items.length === 1 ? '' : 's'}: ` +
    `${counts.completed} done, ${counts.in_progress} in progress, ${counts.pending} pending):\n` +
    lines.join('\n')
  );
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Record or update your working plan for a multi-step task as a checklist. ' +
    'Pass the FULL list every time (it replaces the previous one); mark each item ' +
    'pending, in_progress, or completed. Keep exactly one item in_progress. Use ' +
    'this for non-trivial tasks so you do not lose track of remaining steps; skip ' +
    'it for a single trivial action.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list (replaces any previous list).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step does.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending | in_progress | completed.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  concurrencySafe: true,
  mutates: false,

  execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const items = raw.map(toItem).filter((it): it is TodoItem => it !== null);
    if (items.length === 0) {
      return Promise.resolve({
        ok: false,
        content:
          'No valid todos provided. Pass a non-empty `todos` array of ' +
          '{ content, status } objects.',
      });
    }
    if (!ctx.setTodos) {
      return Promise.resolve({
        ok: false,
        content: 'Planning is not available in this context.',
      });
    }
    ctx.setTodos(items);
    return Promise.resolve({
      ok: true,
      content: summarize(items),
      meta: { count: items.length },
    });
  },
};

/** Render the working plan as a `<system-reminder>` block. The tool owns this
 *  wire format; the loop only decides WHEN/WHERE to inject it (last, each turn). */
export function renderTodoReminder(items: TodoItem[]): string {
  const lines = items.map((it) => `  ${SYMBOL[it.status]} ${it.content}`);
  return (
    '<system-reminder>\n' +
    'Your current plan (keep working through it; update it with todo_write as ' +
    'items complete). Do NOT mention this reminder to the user.\n' +
    lines.join('\n') +
    '\n</system-reminder>'
  );
}
