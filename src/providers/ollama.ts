/**
 * ollama.ts — the PRIMARY (local) provider adapter, over Ollama's HTTP API with
 * raw `fetch` (no SDK). Implements:
 *   - chat()         → POST /api/chat (NDJSON stream) normalized to StreamDelta
 *   - listModels()   → GET  /api/tags  (live model discovery, zero-config)
 *   - describeModel()→ POST /api/show  (derive CapabilityProfile from backend)
 *
 * Nothing is hardcoded: the base URL comes from config → $OLLAMA_HOST →
 * localhost, and capabilities are read from the model, not a static table.
 *
 * Ollama delivers whole tool-call objects (not streamed partial JSON), so the
 * adapter synthesizes tool-call-start + tool-call-done per call.
 */

import { createNdjsonDecoder } from './ndjson.ts';
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

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DISCOVERY_TIMEOUT_MS = 15_000;

// ---- wire shapes (normalized away before leaving this module) ---------------

interface OllamaToolCall {
  /** Real correlation id (newer Ollama returns one); used when present. */
  id?: string;
  function: { name: string; arguments: JsonObject | string };
}
interface OllamaWireMessage {
  role?: string;
  content?: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}
interface OllamaChatChunk {
  message?: OllamaWireMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}
interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}
interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { family?: string };
}

// ---- helpers ----------------------------------------------------------------

/** Resolve the base URL: config → $OLLAMA_HOST → localhost (never hardcoded). */
function resolveBaseUrl(cfg: ProviderConfig): string {
  const raw = cfg.baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

function blockText(content: string | Array<{ type: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Flatten internal messages + system prompt into Ollama's wire messages. */
function toOllamaMessages(
  messages: Message[],
  system: ChatOptions['system'],
): OllamaWireMessage[] {
  const out: OllamaWireMessage[] = [];
  if (system?.text) out.push({ role: 'system', content: system.text });

  // Map tool_use ids → names so tool results can carry a helpful tool_name.
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') idToName.set(block.id, block.name);
    }
  }

  for (const msg of messages) {
    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    const toolResults: ToolResultBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') toolUses.push(block);
      else if (block.type === 'tool_result') toolResults.push(block);
      // thinking/image blocks are dropped for local chat models in slice 1.
    }

    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const wire: OllamaWireMessage = {
          role: 'tool',
          content: blockText(tr.content),
        };
        const toolName = idToName.get(tr.toolUseId);
        if (toolName) wire.tool_name = toolName;
        out.push(wire);
      }
      // A user turn may legitimately carry text alongside tool results; don't
      // drop it — emit it as a following user message.
      const trailingText = textParts.join('');
      if (trailingText.length > 0) {
        out.push({ role: 'user', content: trailingText });
      }
      continue;
    }

    const wire: OllamaWireMessage = {
      role: msg.role === 'assistant' ? 'assistant' : msg.role,
      content: textParts.join(''),
    };
    if (toolUses.length > 0) {
      wire.tool_calls = toolUses.map((tu) => ({
        function: { name: tu.name, arguments: tu.input },
      }));
    }
    out.push(wire);
  }
  return out;
}

/** Convert advertised tool specs into Ollama's function-tool format. */
function toOllamaTools(tools: ToolSpec[]): JsonObject[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as JsonObject,
    },
  }));
}

function mapDoneReason(reason: string | undefined, sawToolCall: boolean): StopReason {
  if (sawToolCall) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function conservativeProfile(): CapabilityProfile {
  return {
    nativeTools: true,
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsVision: false,
    supportsThinking: false,
    supportsPromptCache: false,
    toolCallFormat: 'native',
  };
}

// ---- adapter ----------------------------------------------------------------

/** Create an Ollama-backed ModelProvider. */
export function createOllamaProvider(cfg: ProviderConfig): ModelProvider {
  const baseUrl = resolveBaseUrl(cfg);
  const timeoutMs = cfg.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cfg.headers ?? {}),
  };

  async function listModels(): Promise<DiscoveredModel[]> {
    const res = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/tags failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as OllamaTagsResponse;
    return (body.models ?? []).map((m) => ({
      modelId: m.model ?? m.name ?? '',
      provider: 'ollama',
      sizeBytes: m.size,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
      quantization: m.details?.quantization_level,
      modifiedAt: m.modified_at,
    }));
  }

  async function describeModel(model: string): Promise<CapabilityProfile> {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Fall back to conservative defaults rather than failing discovery.
      return conservativeProfile();
    }
    const body = (await res.json()) as OllamaShowResponse;
    const tags = body.capabilities ?? [];
    const modelInfo = body.model_info ?? {};
    const ctxKey = Object.keys(modelInfo).find((k) =>
      k.endsWith('.context_length'),
    );
    const ctxVal = ctxKey ? modelInfo[ctxKey] : undefined;
    const contextWindow =
      typeof ctxVal === 'number' && ctxVal > 0 ? ctxVal : 8192;
    const nativeTools = tags.includes('tools');

    return {
      nativeTools,
      contextWindow,
      maxOutputTokens: Math.min(4096, contextWindow),
      supportsStreaming: true,
      supportsVision: tags.includes('vision'),
      supportsThinking: tags.includes('thinking'),
      supportsPromptCache: false,
      toolCallFormat: nativeTools ? 'native' : 'xml',
    };
  }

  async function* chat(
    messages: Message[],
    tools: ToolSpec[],
    options: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    // Only forward knobs the caller set, so the model's Modelfile defaults win
    // otherwise (don't force temperature to a hardcoded value).
    const ollamaOptions: JsonObject = { num_predict: options.maxTokens };
    // num_ctx is critical: without it Ollama caps context at ~4096 regardless
    // of the model's real window, silently truncating long conversations.
    if (options.numCtx !== undefined && options.numCtx > 0) {
      ollamaOptions.num_ctx = options.numCtx;
    }
    if (options.temperature !== undefined) {
      ollamaOptions.temperature = options.temperature;
    }
    if (options.topP !== undefined) ollamaOptions.top_p = options.topP;
    if (options.stopSequences && options.stopSequences.length > 0) {
      ollamaOptions.stop = options.stopSequences;
    }

    const body: JsonObject = {
      model: options.model,
      messages: toOllamaMessages(messages, options.system) as unknown as JsonObject[],
      stream: true,
      options: ollamaOptions,
    };
    if (tools.length > 0) body.tools = toOllamaTools(tools);
    if (options.extraBody) Object.assign(body, options.extraBody);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      yield {
        type: 'error',
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      let reason = detail;
      try {
        const parsed = JSON.parse(detail) as { error?: string };
        if (parsed.error) reason = parsed.error;
      } catch {
        // keep raw detail
      }
      yield {
        type: 'error',
        code: res.status === 404 ? 'model_not_found' : 'http_error',
        message: `Ollama /api/chat HTTP ${res.status}: ${reason}`.trim(),
        httpStatus: res.status,
        retryable: res.status >= 500,
      };
      return;
    }

    const decoder = createNdjsonDecoder();
    const reader = res.body.getReader();
    let toolIndex = 0;
    let sawToolCall = false;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    const handleChunk = function* (
      raw: unknown,
    ): IterableIterator<StreamDelta> {
      const chunk = raw as OllamaChatChunk;
      if (chunk.error) {
        yield {
          type: 'error',
          code: 'ollama_error',
          message: chunk.error,
          retryable: false,
        };
        return;
      }
      const msg = chunk.message;
      if (msg?.thinking) {
        yield { type: 'thinking-delta', thinking: msg.thinking };
      }
      if (msg?.content) {
        yield { type: 'text-delta', text: msg.content };
      }
      if (msg?.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          const parsed =
            typeof tc.function.arguments === 'string'
              ? (JSON.parse(tc.function.arguments || '{}') as JsonObject)
              : tc.function.arguments;
          const id = tc.id ?? `${name}-${toolIndex}`;
          yield { type: 'tool-call-start', index: toolIndex, id, name };
          yield {
            type: 'tool-call-done',
            index: toolIndex,
            id,
            name,
            input: parsed,
          };
          toolIndex += 1;
          sawToolCall = true;
        }
      }
      if (chunk.done) {
        usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
        yield { type: 'usage', usage };
        yield {
          type: 'done',
          stopReason: mapDoneReason(chunk.done_reason, sawToolCall),
          usage,
        };
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.push(value)) {
          yield* handleChunk(line.data);
        }
      }
      for (const line of decoder.flush()) {
        yield* handleChunk(line.data);
      }
    } catch (err) {
      // A cancelled request (AbortSignal) ends cleanly; any other mid-stream
      // failure (connection reset, malformed NDJSON) is surfaced as a
      // recoverable ErrorDelta rather than thrown out of the generator.
      if (options.signal?.aborted || (err as Error)?.name === 'AbortError') {
        return;
      }
      yield {
        type: 'error',
        code: 'network',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }

  return {
    id: 'ollama',
    capabilities: () => conservativeProfile(),
    chat,
    listModels,
    describeModel,
  };
}
