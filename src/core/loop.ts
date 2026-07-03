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
import {
  backoffDelay,
  isRetryable,
  looksLikeNarration,
  sleepWithAbort,
  toolFingerprint,
} from './recovery.ts';
import {
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

  const ctx: ToolContext = {
    cwd: session.cwd,
    checkPermission: deps.checkPermission,
    logger: deps.logger.child({ tool: tool.name }),
    signal: opts.signal ?? new AbortController().signal,
    paths: deps.paths,
    depthRemaining: opts.maxSubagentDepth,
    env: {},
  };

  const input = (decision.updatedInput ?? toolUse.input) as JsonObject;
  let result: ToolResult;
  try {
    result = await tool.execute(input, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { ok: false, content: `Tool threw: ${message}` };
  }
  recordToolResult(session, toolUse.id, result);
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
  const MAX_NUDGES = 1;
  let lastFingerprint = '';
  let repeatCount = 0;
  let nudges = 0;

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
    // Emit the reconciled prose ONCE, now that recovery has removed any
    // text-encoded tool call — the UI streams nothing raw before this point.
    if (finalText.trim().length > 0) deps.onAssistantText?.(finalText);

    if (turn.toolUses.length === 0) {
      // Narration nudge: a weak model sometimes DESCRIBES an action instead of
      // emitting the tool call. Once per stall, remind it to act, then continue.
      if (nudges < MAX_NUDGES && looksLikeNarration(finalText)) {
        nudges += 1;
        recordUserMessage(session, [
          {
            type: 'text',
            text:
              'You described an action but did not perform it. If a tool is ' +
              'needed, emit the tool call now — do NOT describe it or put it in ' +
              'a code fence. If the task is already done, say so plainly.',
          },
        ]);
        deps.persist?.(session);
        continue;
      }
      stopReason = 'no_tool_use';
      break;
    }
    nudges = 0; // a tool call is progress

    // Stuck-loop guard: the same tool call(s) repeated with no progress. Record
    // synthetic results (no orphaned tool_use) and stop instead of looping.
    const fingerprint = toolFingerprint(turn.toolUses);
    if (fingerprint === lastFingerprint) {
      repeatCount += 1;
    } else {
      repeatCount = 0;
      lastFingerprint = fingerprint;
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
      await executeToolUse(turn.toolUses[i], session, opts, deps);
      deps.persist?.(session);
    }

    if (aborted) {
      deps.persist?.(session);
      stopReason = 'aborted';
      break;
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
