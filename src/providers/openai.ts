/**
 * openai.ts — generic OpenAI-COMPATIBLE provider adapter over raw `fetch` (no
 * SDK). One adapter covers every service speaking the /v1/chat/completions
 * dialect: OpenAI, DeepSeek, Groq, OpenRouter, Together, Mistral, LM Studio,
 * vLLM, llama.cpp server, authenticated Ollama gateways, and the OpenAI-compat
 * endpoints of Anthropic/Gemini. Implements:
 *   - chat()       → POST {base}/chat/completions (SSE stream) → StreamDelta
 *   - listModels() → GET  {base}/models
 *
 * Nothing provider-specific is hardcoded: base URL, API key (already resolved
 * from `env:VAR` by config/load.ts), and extra headers all come from
 * ProviderConfig. Auth is `Authorization: Bearer <key>` per the spec.
 *
 * Unlike Ollama (whole tool-call objects), this dialect streams tool-call
 * ARGUMENTS as partial-JSON fragments keyed by index; the adapter accumulates
 * them and emits tool-call-start + tool-call-done per call (same normalized
 * shape the loop already consumes).
 */

import { createIdleWatchdog, describeTransportError } from './watchdog.ts';
import { looseParse } from '../core/jsonRepair.ts';
import type {
  CapabilityProfile,
  ChatOptions,
  DiscoveredModel,
  JsonObject,
  Message,
  ModelProvider,
  ProviderConfig,
  StopReason,
  StreamDelta,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from '../contracts.ts';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DISCOVERY_TIMEOUT_MS = 15_000;
/** Same rationale as the Ollama adapter (ADR-0032); cloud endpoints respond
 *  faster than a cold local model, but gateways may proxy to one. */
const CHAT_IDLE_TIMEOUT_MS = 120_000;

// ---- wire shapes (normalized away before leaving this module) ---------------

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface WireChoiceDelta {
  content?: string | null;
  /** DeepSeek-R1 style reasoning stream (also `reasoning` on some gateways). */
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: WireToolCallDelta[];
}
interface WireChunk {
  choices?: Array<{ delta?: WireChoiceDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string } | string;
}
interface WireModelsResponse {
  data?: Array<{ id?: string; created?: number; owned_by?: string }>;
}

// ---- helpers ----------------------------------------------------------------

/**
 * Resolve the API base: config → OpenAI default. A base without a version path
 * segment gets `/v1` appended (services differ on whether the published base
 * includes it — e.g. "https://api.deepseek.com" vs ".../v1"). To opt out of the
 * append (e.g. Gemini's ".../v1beta/openai") end the configured baseUrl with a
 * version-like segment or a trailing slash — a base already carrying a path
 * segment after its version is left untouched.
 */
function resolveBaseUrl(cfg: ProviderConfig): string {
  const configured = cfg.baseUrl ?? DEFAULT_BASE_URL;
  // A trailing slash is an explicit "this is the full base" signal — honor it.
  if (/\/$/.test(configured)) return configured.replace(/\/+$/, '');
  const raw = configured.replace(/\/+$/, '');
  // Already versioned anywhere in the path (…/v1, …/v1beta, …/v1beta/openai)?
  return /\/v\d+[a-z]*(\/|$)/i.test(raw) ? raw : `${raw}/v1`;
}

function blockText(content: string | Array<{ type: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Flatten internal messages + system prompt into chat-completions messages. */
function toWireMessages(
  messages: Message[],
  system: ChatOptions['system'],
): JsonObject[] {
  const out: JsonObject[] = [];
  if (system?.text) out.push({ role: 'system', content: system.text });

  for (const msg of messages) {
    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    const toolResults: ToolResultBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') toolUses.push(block);
      else if (block.type === 'tool_result') toolResults.push(block);
      // thinking/image blocks are dropped (parity with the Ollama adapter).
    }

    if (toolResults.length > 0) {
      // Each tool result is its own `tool` role message keyed by tool_call_id.
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: blockText(tr.content),
        });
      }
      const trailingText = textParts.join('');
      if (trailingText.length > 0) {
        out.push({ role: 'user', content: trailingText });
      }
      continue;
    }

    const wire: JsonObject = {
      role: msg.role,
      content: textParts.join(''),
    };
    if (toolUses.length > 0) {
      wire.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
      }));
    }
    out.push(wire);
  }
  return out;
}

function toWireTools(tools: ToolSpec[]): JsonObject[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as JsonObject,
    },
  }));
}

function mapToolChoice(choice: ChatOptions['toolChoice']): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return undefined;
  }
}

function mapFinishReason(reason: string | null | undefined, sawToolCall: boolean): StopReason {
  if (reason === 'tool_calls' || sawToolCall) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

/** Conservative cloud defaults; per-model overrides come from config `models`. */
function conservativeProfile(): CapabilityProfile {
  return {
    nativeTools: true,
    contextWindow: 32_768,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsVision: false,
    supportsThinking: false,
    supportsPromptCache: false,
    toolCallFormat: 'native',
  };
}

// ---- adapter ----------------------------------------------------------------

/** Create an OpenAI-compatible ModelProvider from a ProviderConfig. */
export function createOpenAIProvider(cfg: ProviderConfig): ModelProvider {
  const baseUrl = resolveBaseUrl(cfg);
  const timeoutMs = cfg.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const idleTimeoutMs = cfg.idleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(cfg.headers ?? {}),
  };

  async function listModels(): Promise<DiscoveredModel[]> {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`${baseUrl}/models failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as WireModelsResponse;
    return (body.data ?? [])
      .filter((m): m is { id: string } => typeof m.id === 'string')
      .map((m) => ({ modelId: m.id, provider: cfg.id }));
  }

  async function* chat(
    messages: Message[],
    tools: ToolSpec[],
    options: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    const body: JsonObject = {
      model: options.model,
      messages: toWireMessages(messages, options.system) as unknown as JsonObject[],
      stream: true,
      // Ask for a final usage chunk; compat servers that don't know the field
      // ignore it (worst case: usage stays zero, same as before).
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.stopSequences && options.stopSequences.length > 0) {
      body.stop = options.stopSequences;
    }
    if (tools.length > 0) {
      body.tools = toWireTools(tools);
      const tc = mapToolChoice(options.toolChoice);
      if (tc !== undefined) body.tool_choice = tc as JsonObject;
      if (options.temperature === undefined) body.temperature = 0.1;
    }
    if (options.extraBody) Object.assign(body, options.extraBody);

    const watchdog = createIdleWatchdog(options.signal, idleTimeoutMs);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
    } catch (err) {
      watchdog.cleanup();
      if (options.signal?.aborted) return;
      if (watchdog.idleFired()) {
        yield {
          type: 'error',
          code: 'network',
          message:
            `no response from ${baseUrl} for ${idleTimeoutMs / 1000}s — ` +
            'the server may be down or unresponsive',
          retryable: true,
        };
        return;
      }
      if ((err as Error)?.name === 'AbortError') return;
      yield {
        type: 'error',
        code: 'network',
        message: describeTransportError(err),
        retryable: true,
      };
      return;
    }

    watchdog.resetIdle(); // headers arrived — fresh window for first token

    if (!res.ok || !res.body) {
      watchdog.cleanup();
      const detail = await res.text().catch(() => '');
      let reason = detail;
      try {
        const parsed = JSON.parse(detail) as {
          error?: { message?: string } | string;
        };
        if (typeof parsed.error === 'string') reason = parsed.error;
        else if (parsed.error?.message) reason = parsed.error.message;
      } catch {
        // keep raw detail
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      yield {
        type: 'error',
        code:
          res.status === 404
            ? 'model_not_found'
            : res.status === 429
              ? 'rate_limit'
              : res.status === 401 || res.status === 403
                ? 'auth_error'
                : 'http_error',
        message: `${baseUrl}/chat/completions HTTP ${res.status}: ${reason}`.trim(),
        httpStatus: res.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterSeconds: retryAfter }
          : {}),
        retryable: res.status === 429 || res.status >= 500,
      };
      return;
    }

    // Per-call tool-call accumulator: this dialect streams argument fragments
    // keyed by choice index; parse once when the stream finishes.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const started = new Set<number>();
    let toolCounter = 0;
    let sawToolCall = false;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | null | undefined;
    let doneEmitted = false;

    const finishToolCalls = function* (): IterableIterator<StreamDelta> {
      for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        const input =
          ((looseParse(call.args) as JsonObject | null) ?? {}) as JsonObject;
        yield { type: 'tool-call-done', index, id: call.id, name: call.name, input };
      }
      calls.clear();
    };

    const handleChunk = function* (raw: string): IterableIterator<StreamDelta> {
      let chunk: WireChunk;
      try {
        chunk = JSON.parse(raw) as WireChunk;
      } catch {
        return; // tolerate malformed keep-alive lines
      }
      if (chunk.error) {
        const msg =
          typeof chunk.error === 'string'
            ? chunk.error
            : (chunk.error.message ?? JSON.stringify(chunk.error));
        yield { type: 'error', code: 'provider_error', message: msg, retryable: false };
        return;
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta) {
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) yield { type: 'thinking-delta', thinking };
        if (delta.content) yield { type: 'text-delta', text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          let call = calls.get(index);
          if (!call) {
            call = {
              id: tc.id ?? `call-${toolCounter}`,
              name: tc.function?.name ?? '',
              args: '',
            };
            calls.set(index, call);
            toolCounter += 1;
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name = call.name || tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
          if (!started.has(index) && call.name) {
            started.add(index);
            sawToolCall = true;
            yield { type: 'tool-call-start', index, id: call.id, name: call.name };
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = '';

    // Emit one SSE payload line ("data: …"); returns true on `[DONE]` so the
    // caller can stop. Non-data lines (comments, `event:`, blanks) are ignored.
    const emitLine = function* (line: string): IterableIterator<StreamDelta> {
      const clean = line.replace(/\r$/, '');
      if (!clean.startsWith('data:')) return;
      const payload = clean.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        doneSignalled = true;
        return;
      }
      yield* handleChunk(payload);
    };
    let doneSignalled = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        watchdog.resetIdle();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE framing: events separated by newlines; payload lines start with
        // "data:". A single read may carry many events — split eagerly.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield* emitLine(line);
          if (doneSignalled) break;
        }
        if (doneSignalled) break;
      }
      // Drain any residual unterminated final line — a compat server may close
      // the stream with its last event not newline-terminated (and no [DONE]).
      // Without this the last token, or a whole tool-call's args, is lost.
      buffer += decoder.decode();
      if (!doneSignalled && buffer.length > 0) yield* emitLine(buffer);
      yield* finishToolCalls();
      yield { type: 'usage', usage };
      yield {
        type: 'done',
        stopReason: mapFinishReason(finishReason, sawToolCall),
        usage,
      };
      doneEmitted = true;
    } catch (err) {
      if (options.signal?.aborted) return;
      if (watchdog.idleFired()) {
        yield {
          type: 'error',
          code: 'network',
          message:
            `stream stalled: no data from ${baseUrl} for ` +
            `${idleTimeoutMs / 1000}s — the server may have crashed`,
          retryable: true,
        };
        return;
      }
      if ((err as Error)?.name === 'AbortError') return;
      if (!doneEmitted) {
        yield {
          type: 'error',
          code: 'network',
          message: describeTransportError(err),
          retryable: true,
        };
      }
    } finally {
      watchdog.cleanup();
      // Cancel the underlying request if the consumer abandoned the stream.
      watchdog.abort();
    }
  }

  return {
    id: cfg.id,
    capabilities: () => conservativeProfile(),
    chat,
    listModels,
  };
}
