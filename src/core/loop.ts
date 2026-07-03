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
import {
  recordAssistantMessage,
  recordError,
  recordToolCall,
  recordToolResult,
  recordUsage,
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
  /** Streaming sink for the UI (text/tool deltas); optional. */
  onDelta?: (delta: StreamDelta) => void;
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

    const messages = buildRequest(session.events);
    const chatOptions: ChatOptions = {
      model: opts.model,
      maxTokens: opts.maxTokens,
      numCtx: opts.contextWindow,
      system: opts.system,
      temperature: opts.temperature,
      toolChoice: { type: 'auto' },
      signal: opts.signal,
    };

    const stream = deps.provider.chat(
      messages,
      deps.registry.specs(),
      chatOptions,
    );

    // Reducing the stream may throw on an unrecoverable/streamed provider error
    // (or an aborted fetch). Contain it: the loop returns a clean stop reason
    // rather than unwinding the stack. Bounded backoff/fallback lands in slice 6.
    let turn: Awaited<ReturnType<typeof reduceStream>>;
    try {
      turn = await reduceStream(stream, deps.onDelta);
    } catch (err) {
      if (opts.signal?.aborted) {
        stopReason = 'aborted';
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
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

    if (turn.toolUses.length === 0) {
      stopReason = 'no_tool_use';
      break;
    }

    // Slice 1 executes tools serially (bash mutates; read is safe but kept
    // simple). Parallel read-only execution via `concurrencySafe` lands later.
    // On abort, synthesize an error result for every not-yet-executed tool_use
    // so the event log never holds an orphaned tool_use (which would produce an
    // invalid conversation on resume/replay).
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
