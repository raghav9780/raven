/**
 * loop.ts — the ReAct/TAO agent loop over the event log. Each turn: project
 * messages → call the provider → reduce the stream into an assistant turn →
 * append it → if it requested no tools, stop; otherwise permission-gate and
 * execute each tool, append observations, and loop. Backstops: maxTurns, token
 * budget, and AbortSignal.
 *
 * The loop is intentionally small (Thesis 1): all the substance lives in the
 * surrounding subsystems it wires together.
 */

import { buildRequest, reduceStream } from './messages.ts';
import { parseTextToolCalls } from './parser.ts';
import { compactMessages } from './compact.ts';
import { coerceArgs, validateArgs } from '../tools/validate.ts';
import { renderTodoReminder } from '../tools/todo.ts';
import {
  backoffDelay,
  isRetryable,
  looksLikeDeferral,
  looksLikeNarration,
  looksLikeSuccessClaim,
  sleepWithAbort,
  toolFingerprint,
} from './recovery.ts';
import {
  lastToolResultErrored,
  recordAssistantMessage,
  recordCompaction,
  recordError,
  recordToolCall,
  recordToolResult,
  recordUsage,
  recordUserMessage,
  textOf,
} from './events.ts';
import type {
  AgentLoopOptions,
  AgentRunResult,
  ChatOptions,
  ContentBlock,
  HarnessPaths,
  JsonObject,
  Logger,
  LoopStopReason,
  ModelProvider,
  PermissionChecker,
  Session,
  StreamDelta,
  TodoItem,
  ToolContext,
  ToolResult,
  ToolUseBlock,
} from '../contracts.ts';

/** Everything the loop needs, injected (no globals). */
export interface LoopDeps {
  provider: ModelProvider;
  registry: import('../contracts.ts').ToolRegistry;
  checkPermission: PermissionChecker;
  logger: Logger;
  paths: HarnessPaths;
  /** Low-level streaming sink (raw deltas); optional. NOTE: assistant PROSE is
   *  delivered via `onAssistantText` AFTER tool-call recovery, not here — so the
   *  UI never shows a tool call the model emitted as text. */
  onDelta?: (delta: StreamDelta) => void;
  /** Reconciled assistant prose for a turn, emitted once AFTER recovery has
   *  stripped any text-encoded tool call. Empty on pure tool-call turns. */
  onAssistantText?: (text: string) => void;
  /** Out-of-band notice to the user (not model prose): e.g. a diagnostic that the
   *  model may not support the tools API. Optional; the UI prints it dimmed. */
  onNotice?: (text: string) => void;
  /** Called after new events are appended so a writer can flush the transcript
   *  tail (crash-safe incremental persistence); optional. */
  persist?: (session: Session) => void;
}

function totalTokens(session: Session): number {
  return session.totalUsage.inputTokens + session.totalUsage.outputTokens;
}

async function executeToolUse(
  toolUse: ToolUseBlock,
  session: Session,
  opts: AgentLoopOptions,
  deps: LoopDeps,
  todos: { items: TodoItem[] },
): Promise<void> {
  recordToolCall(session, toolUse.id, toolUse.name, toolUse.input);

  const decision = await deps.checkPermission({
    toolName: toolUse.name,
    input: toolUse.input,
    cwd: session.cwd,
    mode: opts.permissionMode,
  });

  if (decision.effect !== 'allow') {
    const reason = decision.reason ?? 'Denied by the permission policy.';
    recordToolResult(session, toolUse.id, {
      ok: false,
      content: `Permission ${decision.effect}: ${reason}`,
    });
    return;
  }

  const tool = deps.registry.get(toolUse.name);
  if (!tool) {
    recordToolResult(session, toolUse.id, {
      ok: false,
      content: `Unknown tool: ${toolUse.name}`,
    });
    return;
  }

  // Coerce stringified scalars toward the schema's declared types ("5000"→5000,
  // "true"→true) — local models often stringify args. Type-only, so it doesn't
  // affect the permission decision already made above. Then schema-validate the
  // coerced args (missing/wrong/unexpected fields) with a uniform, tool-aware
  // message so the model corrects (and picks the right tool) instead of hitting
  // an ad-hoc per-tool error.
  const coerced = coerceArgs(tool.inputSchema, toolUse.input);
  const invalid = validateArgs(
    tool.name,
    tool.inputSchema,
    coerced,
    tool.disambiguationHint,
  );
  if (invalid) {
    recordToolResult(session, toolUse.id, { ok: false, content: invalid.message });
    return;
  }

  const ctx: ToolContext = {
    cwd: session.cwd,
    checkPermission: deps.checkPermission,
    logger: deps.logger.child({ tool: tool.name }),
    signal: opts.signal ?? new AbortController().signal,
    paths: deps.paths,
    depthRemaining: opts.maxSubagentDepth,
    env: {},
    // Run-scoped plan: the todo_write tool sets it; the loop re-injects it as a
    // <system-reminder> each turn. Copy so the tool can't mutate it after return.
    setTodos: (items) => {
      todos.items = items.slice();
    },
  };

  const input = (decision.updatedInput ?? coerced) as JsonObject;
  let result: ToolResult;
  try {
    result = await tool.execute(input, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { ok: false, content: `Tool threw: ${message}` };
  }
  recordToolResult(session, toolUse.id, capToolResult(result));
}

/** Defense-in-depth: no single tool result may exceed this many characters. A
 *  tool that ignores its own budget (or a future tool with none) can otherwise
 *  push one giant observation into the context and blow the model window. */
const MAX_TOOL_RESULT_CHARS = 40_000;

function capToolResult(result: ToolResult): ToolResult {
  if (typeof result.content !== 'string') return result;
  if (result.content.length <= MAX_TOOL_RESULT_CHARS) return result;
  const dropped = result.content.length - MAX_TOOL_RESULT_CHARS;
  return {
    ...result,
    content:
      result.content.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n… [tool output truncated: ${dropped} more chars dropped to protect the ` +
      'context window — narrow the request]',
    truncated: true,
  };
}

/**
 * Run the agent loop until natural completion (no tool calls), a backstop, or
 * abort. Mutates `session` (append-only event log) and returns a summary.
 */
export async function runAgentLoop(
  session: Session,
  opts: AgentLoopOptions,
  deps: LoopDeps,
): Promise<AgentRunResult> {
  let turns = 0;
  let stopReason: LoopStopReason = 'no_tool_use';
  let finalText = '';
  // Stuck-loop + narration-nudge guards (bounded, reset on progress).
  const MAX_REPEATS = 2;
  const MAX_NUDGES = 2;
  // One corrective feedback before the hard loop-stop (see the guard below).
  const MAX_LOOP_NUDGES = 1;
  let loopNudges = 0;
  // tools-ignored diagnostic: if the model is advertised native-tools-capable
  // but never emits a native call and then stalls, warn the user once.
  const toolsAdvertised = deps.registry.specs().length > 0;
  let sawNativeToolCall = false;
  let toolsIgnoredNoticed = false;
  const warnToolsIgnoredOnStall = (): void => {
    if (toolsIgnoredNoticed) return;
    if (opts.nativeTools === true && toolsAdvertised && !sawNativeToolCall) {
      toolsIgnoredNoticed = true;
      deps.onNotice?.(
        'The model produced no native tool calls and stalled. This model/endpoint ' +
          'may be ignoring the tools API — if it keeps describing actions instead of ' +
          'doing them, switch to a tools-capable model (e.g. via /model).',
      );
    }
  };
  let lastFingerprint = '';
  let repeatCount = 0;
  let nudges = 0;
  // Consecutive turns that made a tool call but no REAL progress (no successful
  // mutation / new observation) — catches the "keeps emitting a throwaway call
  // plus a 'done' claim" flood that the byte-identical repeat guard misses.
  const MAX_NO_PROGRESS = 3;
  let noProgressTurns = 0;
  // Last prose emitted to the user, normalized — so back-to-back identical or
  // near-identical "already done / no further action" messages print once.
  let lastEmitted = '';
  const emitText = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const norm = trimmed.replace(/\s+/g, ' ').toLowerCase();
    if (norm === lastEmitted) return; // consecutive duplicate → skip
    lastEmitted = norm;
    deps.onAssistantText?.(text);
  };
  // Run-scoped working plan (the todo_write tool sets it via ctx.setTodos); the
  // loop re-injects it as an ephemeral <system-reminder> each turn.
  const todos: { items: TodoItem[] } = { items: [] };

  while (turns < opts.maxTurns) {
    if (opts.signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (opts.tokenBudget && totalTokens(session) >= opts.tokenBudget) {
      stopReason = 'token_budget';
      break;
    }
    turns += 1;

    // Compact the projected messages if they'd overflow the model window
    // (model-free; the event log stays append-only, a compaction event is added).
    let messages = buildRequest(session.events);
    const compaction = compactMessages(messages, opts.contextWindow ?? 8192);
    if (compaction.compacted) {
      messages = compaction.messages;
      recordCompaction(
        session,
        compaction.strategy === 'placeholder-clear' ? 'placeholder-clear' : 'snip',
        compaction.before,
        compaction.after,
      );
      deps.persist?.(session);
      deps.logger.info('compacted context', {
        strategy: compaction.strategy,
        before: compaction.before,
        after: compaction.after,
      });
    }

    // Re-inject the working plan as an EPHEMERAL system-reminder (not persisted
    // to the event log — it's rebuilt from the live list each turn), so a weak
    // model keeps the remaining steps in view. Appended last = most recent.
    if (todos.items.length > 0) {
      messages = [
        ...messages,
        { role: 'user', content: [{ type: 'text', text: renderTodoReminder(todos.items) }] },
      ];
    }

    const chatOptions: ChatOptions = {
      model: opts.model,
      maxTokens: opts.maxTokens,
      numCtx: opts.contextWindow,
      system: opts.system,
      temperature: opts.temperature,
      toolChoice: { type: 'auto' },
      signal: opts.signal,
    };

    // Call the model with bounded retry on transient errors (network / 5xx /
    // overloaded). A non-retryable error or exhausted attempts ends cleanly.
    let turn: Awaited<ReturnType<typeof reduceStream>> | null = null;
    let lastError: unknown = null;
    const maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (opts.signal?.aborted) break;
      try {
        turn = await reduceStream(
          deps.provider.chat(messages, deps.registry.specs(), chatOptions),
          deps.onDelta,
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (opts.signal?.aborted || !isRetryable(err) || attempt >= maxAttempts) {
          break;
        }
        const delayMs = backoffDelay(
          attempt,
          opts.retry,
          (err as { retryAfterSeconds?: number }).retryAfterSeconds,
        );
        recordError(
          session,
          'transient',
          `retrying (${attempt}/${maxAttempts}) in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        deps.logger.warn('model call failed, retrying', { attempt, delayMs });
        await sleepWithAbort(delayMs, opts.signal);
      }
    }
    if (opts.signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (!turn) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      recordError(session, 'provider_error', message);
      deps.logger.error('model turn failed', { error: message });
      stopReason = 'error';
      break;
    }

    // Record whether the PROVIDER returned a native tool call this turn (before
    // text-recovery may synthesize one) — drives the tools-ignored diagnostic.
    if (turn.toolUses.length > 0) sawNativeToolCall = true;

    // Text-protocol fallback (ADR-0011): if the model emitted NO native tool
    // call, try to recover one from its text — small local models (e.g.
    // qwen2.5-coder via Ollama) often emit tool calls as JSON / `<tool_call>`
    // text instead of the native field. Native remains the primary path.
    if (turn.toolUses.length === 0) {
      const rawText = textOf(turn.content);
      if (rawText.trim().length > 0) {
        const repaired = parseTextToolCalls(
          rawText,
          deps.registry.list().map((tool) => tool.name),
        );
        if (repaired.calls.length > 0) {
          // Preserve any thinking block; replace the raw text with the leftover
          // prose, then append the recovered tool_use blocks.
          const rebuilt: ContentBlock[] = turn.content.filter(
            (block) => block.type === 'thinking',
          );
          if (repaired.leftoverText.length > 0) {
            rebuilt.push({ type: 'text', text: repaired.leftoverText });
          }
          repaired.calls.forEach((call, i) => {
            const block: ToolUseBlock = {
              type: 'tool_use',
              id: `${call.name}-${turns}-${i}-txt`,
              name: call.name,
              input: call.input,
            };
            rebuilt.push(block);
            turn.toolUses.push(block);
          });
          turn.content = rebuilt;
          turn.stopReason = 'tool_use';
          deps.logger.debug('recovered tool call(s) from text', {
            count: repaired.calls.length,
          });
        }
      }
    }

    recordAssistantMessage(session, turn.content, turn.stopReason, opts.model);
    recordUsage(session, turn.usage, opts.model);
    deps.persist?.(session);
    finalText = textOf(turn.content);

    if (turn.toolUses.length === 0) {
      // Are we actually mid-task? An objective, non-lexical signal: the model
      // has already made a tool call this run, OR it set itself a working plan
      // with unfinished steps. Only then is a no-tool "I'll do it" / "which
      // file?" reply a genuine STALL worth nudging. On a fresh turn with neither
      // (a greeting, a plain question, chit-chat) there is nothing to complete —
      // we trust the model's reply and let IT decide whether action is needed,
      // rather than our code guessing from the wording of the message.
      const midTask =
        sawNativeToolCall ||
        todos.items.some((t) => t.status !== 'completed');
      // Error gate: a failed last action + a "done"-style final message is a
      // hallucinated success. Reject it once — tell the model the truth and let
      // it retry or report honestly — instead of printing the false claim.
      if (
        nudges < MAX_NUDGES &&
        lastToolResultErrored(session) &&
        looksLikeSuccessClaim(finalText)
      ) {
        nudges += 1;
        recordUserMessage(session, [
          {
            type: 'text',
            text:
              'The last tool call FAILED (see the error result above), so the ' +
              'task is NOT complete. Do not claim success. Either retry with ' +
              'corrected arguments or a more suitable tool, or state plainly ' +
              'what failed and why.',
          },
        ]);
        deps.persist?.(session);
        continue;
      }
      // Stall nudge: a weak model sometimes DESCRIBES an action instead of doing
      // it, or DEFERS by asking the user for a value it could pick itself. Nudge
      // it to choose defaults and act, then continue (bounded by MAX_NUDGES).
      if (
        nudges < MAX_NUDGES &&
        midTask &&
        (looksLikeNarration(finalText) || looksLikeDeferral(finalText))
      ) {
        nudges += 1;
        recordUserMessage(session, [
          {
            type: 'text',
            text:
              'You have NOT completed the task. Do not describe the action, and ' +
              'do not ask me to make trivial choices or supply values you can ' +
              'pick yourself (file names, sample text, a song\'s words, etc.) — ' +
              'choose sensible defaults and emit the tool call NOW. Only stop to ' +
              'ask if you are genuinely blocked (e.g. missing credentials), and ' +
              'if so say exactly what is blocking. If the task is already done, ' +
              'say so plainly with no tool call.',
          },
        ]);
        deps.persist?.(session);
        continue;
      }
      // Accepted as the final answer — emit the reconciled prose ONCE (recovery
      // has already stripped any text-encoded tool call; nothing streamed raw).
      emitText(finalText);
      // If this "final" turn is really a stall (narration/deferral) mid-task and
      // the model never made a native call, it likely can't tool-call — surface
      // it once. On a fresh conversational turn (no mid-task signal) a friendly
      // reply isn't a stall, so we stay quiet.
      if (
        midTask &&
        (looksLikeNarration(finalText) || looksLikeDeferral(finalText))
      ) {
        warnToolsIgnoredOnStall();
      }
      stopReason = 'no_tool_use';
      break;
    }
    // Tool-use turn: show any leftover prose that accompanied the call(s).
    emitText(finalText);
    nudges = 0; // a tool call is progress

    // Stuck-loop guard: the same tool call(s) repeated with no progress.
    const fingerprint = toolFingerprint(turn.toolUses);
    if (fingerprint === lastFingerprint) {
      repeatCount += 1;
    } else {
      repeatCount = 0;
      lastFingerprint = fingerprint;
    }
    // First repeat: don't run the identical call again — give the model ONE
    // corrective shot with actionable feedback (it often omitted a required
    // argument, e.g. a directory path) instead of silently giving up. Synthesize
    // results so no tool_use is left orphaned, then let it retry.
    if (repeatCount >= 1 && loopNudges < MAX_LOOP_NUDGES) {
      loopNudges += 1;
      for (const toolUse of turn.toolUses) {
        recordToolResult(session, toolUse.id, {
          ok: false,
          content:
            'Skipped: this call is identical to your previous one and gives the ' +
            'same result. Do NOT repeat it. Re-read the user\'s request and the ' +
            "tool's parameters — you likely left out a required argument (for " +
            'example a directory/path the user specified). Change the arguments ' +
            'and make a DIFFERENT call, or give your final answer.',
        });
      }
      deps.persist?.(session);
      continue;
    }
    if (repeatCount >= MAX_REPEATS) {
      for (const toolUse of turn.toolUses) {
        recordToolResult(session, toolUse.id, {
          ok: false,
          content:
            'Stopped: the same tool call was repeated with no progress. Try a different approach.',
        });
      }
      deps.persist?.(session);
      recordError(session, 'loop', 'repeated the same tool call with no progress');
      stopReason = 'loop';
      break;
    }

    // Tools execute serially (bash/writes must not interleave). On abort,
    // synthesize an error result for every not-yet-executed tool_use so the
    // event log never holds an orphaned tool_use (invalid on resume/replay).
    let aborted = false;
    const startEvents = session.events.length;
    for (let i = 0; i < turn.toolUses.length; i += 1) {
      if (opts.signal?.aborted) {
        for (let j = i; j < turn.toolUses.length; j += 1) {
          recordToolResult(session, turn.toolUses[j].id, {
            ok: false,
            content: 'Aborted before execution.',
          });
        }
        aborted = true;
        break;
      }
      await executeToolUse(turn.toolUses[i], session, opts, deps, todos);
      deps.persist?.(session);
    }

    if (aborted) {
      deps.persist?.(session);
      stopReason = 'aborted';
      break;
    }

    // No-progress guard: a turn "progressed" if a non-todo tool succeeded this
    // turn. A run of tool turns that accomplish nothing real (failed edits,
    // todo_write-only churn) while the model keeps claiming completion is the
    // flood the byte-identical repeat guard can't see — cap it.
    const realIds = new Set(
      turn.toolUses.filter((t) => t.name !== 'todo_write').map((t) => t.id),
    );
    const progressed = session.events
      .slice(startEvents)
      .some(
        (e) =>
          e.type === 'tool_result' && e.result.ok === true && realIds.has(e.toolUseId),
      );
    if (progressed) {
      noProgressTurns = 0;
    } else {
      noProgressTurns += 1;
      if (noProgressTurns >= MAX_NO_PROGRESS) {
        recordError(
          session,
          'loop',
          'multiple tool turns with no real progress — stopping',
        );
        deps.persist?.(session);
        stopReason = 'loop';
        break;
      }
    }
    if (turns >= opts.maxTurns) {
      stopReason = 'max_turns';
      break;
    }
  }

  return {
    stopReason,
    turns,
    finalText,
    usage: session.totalUsage,
    session,
  };
}
