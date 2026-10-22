/**
 * events.ts — the append-only event log (the OpenHands spine) and the message
 * projection. The only durable state is `Session.events: AgentEvent[]`; the
 * provider message array is a pure projection rebuilt each turn by
 * `projectMessages`. Event constructors stamp seq/timestamp/agentId and push.
 */

import type {
  AgentEvent,
  AssistantMessageEvent,
  ContentBlock,
  ErrorEvent,
  JsonObject,
  LifecycleEvent,
  Message,
  MetaEvent,
  Session,
  StopReason,
  ToolCallEvent,
  ToolResultBlock,
  ToolResultEvent,
  ToolUseBlock,
  UsageEvent,
  UserMessageEvent,
  Usage,
} from '../contracts.ts';

/** Agent id stamped on events produced by the top-level (non-subagent) loop. */
export const MAIN_AGENT = 'main';

function stamp(session: Session, type: AgentEvent['type']) {
  return {
    seq: session.events.length,
    type,
    timestamp: new Date().toISOString(),
    agentId: MAIN_AGENT,
  };
}

function pushEvent<T extends AgentEvent>(session: Session, event: T): T {
  session.events.push(event);
  session.updatedAt = event.timestamp;
  return event;
}

/** Record a user prompt as a UserMessageEvent. */
export function recordUserMessage(
  session: Session,
  content: ContentBlock[],
): UserMessageEvent {
  const event: UserMessageEvent = {
    ...stamp(session, 'user_message'),
    type: 'user_message',
    content,
  };
  return pushEvent(session, event);
}

/** Record a completed assistant turn (text + thinking + tool_use blocks). */
export function recordAssistantMessage(
  session: Session,
  content: ContentBlock[],
  stopReason: StopReason,
  model: string,
): AssistantMessageEvent {
  const event: AssistantMessageEvent = {
    ...stamp(session, 'assistant_message'),
    type: 'assistant_message',
    content,
    stopReason,
    model,
  };
  return pushEvent(session, event);
}

/** Record that the assistant requested a tool (an Action). */
export function recordToolCall(
  session: Session,
  toolUseId: string,
  toolName: string,
  input: JsonObject,
): ToolCallEvent {
  const event: ToolCallEvent = {
    ...stamp(session, 'tool_call'),
    type: 'tool_call',
    toolUseId,
    toolName,
    input,
  };
  return pushEvent(session, event);
}

/** Record a tool's result (an Observation). */
export function recordToolResult(
  session: Session,
  toolUseId: string,
  result: ToolResultEvent['result'],
): ToolResultEvent {
  const event: ToolResultEvent = {
    ...stamp(session, 'tool_result'),
    type: 'tool_result',
    toolUseId,
    result,
  };
  return pushEvent(session, event);
}

/** Record a usage snapshot from a model call and roll it into the session total. */
export function recordUsage(
  session: Session,
  usage: Usage,
  model: string,
): UsageEvent {
  session.totalUsage = addUsage(session.totalUsage, usage);
  const event: UsageEvent = {
    ...stamp(session, 'usage'),
    type: 'usage',
    usage,
    model,
  };
  return pushEvent(session, event);
}

/** Record a session lifecycle marker (start/end/resume); `cwd` is stored on start. */
export function recordLifecycle(
  session: Session,
  phase: 'start' | 'end' | 'resume',
  cwd?: string,
): LifecycleEvent {
  const event: LifecycleEvent = {
    ...stamp(session, 'lifecycle'),
    type: 'lifecycle',
    phase,
    ...(cwd ? { cwd } : {}),
  };
  return pushEvent(session, event);
}

/** Record a session name (append-only; the latest one wins on replay). */
export function recordMeta(session: Session, name: string): MetaEvent {
  const event: MetaEvent = {
    ...stamp(session, 'meta'),
    type: 'meta',
    name,
  };
  session.name = name;
  return pushEvent(session, event);
}

/** Record that context compaction rewrote the projected history. */
export function recordCompaction(
  session: Session,
  strategy: import('../contracts.ts').CompactionStrategy,
  tokensBefore: number,
  tokensAfter: number,
): import('../contracts.ts').CompactionEvent {
  const event: import('../contracts.ts').CompactionEvent = {
    ...stamp(session, 'compaction'),
    type: 'compaction',
    strategy,
    tokensBefore,
    tokensAfter,
  };
  return pushEvent(session, event);
}

/** Record an error observation (transport/recovery) in the event log. */
export function recordError(
  session: Session,
  code: string,
  message: string,
  recovery?: string,
): ErrorEvent {
  const event: ErrorEvent = {
    ...stamp(session, 'error'),
    type: 'error',
    code,
    message,
    ...(recovery ? { recovery } : {}),
  };
  return pushEvent(session, event);
}

/** Sum two usage records field-by-field. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
    cacheCreationTokens:
      (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

function toToolResultBlock(event: ToolResultEvent): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId: event.toolUseId,
    content: event.result.content,
    isError: event.result.ok === false,
  };
}

/**
 * Project the event log into the provider message array. User messages and
 * assistant messages map 1:1; consecutive tool results are grouped into a single
 * following `user` message of `tool_result` blocks (the Anthropic-shaped
 * invariant the loop and adapters expect). Non-conversational events
 * (usage/permission/lifecycle) are skipped.
 */
export function projectMessages(events: AgentEvent[]): Message[] {
  const messages: Message[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flush = (): void => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'user_message':
        flush();
        messages.push({ role: 'user', content: event.content });
        break;
      case 'assistant_message':
        flush();
        messages.push({ role: 'assistant', content: event.content });
        break;
      case 'tool_result':
        pendingToolResults.push(toToolResultBlock(event));
        break;
      default:
        // usage/permission/compaction/hook/subagent/error/lifecycle/meta,
        // and tool_call (the tool_use blocks already live on the assistant
        // message) are not part of the projected conversation.
        break;
    }
  }
  flush();
  return messages;
}

/**
 * True if the most recent tool_result in the log is an error (ok === false) —
 * i.e. the last ACTION the agent took failed. Used by the loop's
 * success-hallucination guard: a failed last action + a "done" final message is
 * a hallucinated success to reject. (The current final turn carries no tool_use,
 * so the last tool_result is genuinely the preceding action's outcome.)
 */
export function lastToolResultErrored(session: Session): boolean {
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const event = session.events[i];
    if (event.type === 'tool_result') return event.result.ok === false;
  }
  return false;
}

/** Extract tool_use blocks from a set of content blocks. */
export function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  );
}

/** Concatenate the text of all text blocks in a content array. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> =>
      block.type === 'text',
    )
    .map((block) => block.text)
    .join('');
}
