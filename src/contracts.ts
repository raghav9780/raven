/**
 * contracts.ts — THE SINGLE SOURCE OF TRUTH for the Raven agent harness.
 *
 * Every future module imports its shared types from this file. It contains
 * TYPES ONLY — no runtime implementations, no side effects — so it type-checks
 * standalone and is safe to import anywhere (including from provider adapters,
 * tools, the loop, and tests).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHORING CONSTRAINTS (Node v22 `--experimental-strip-types`, erasable-only TS)
 * ─────────────────────────────────────────────────────────────────────────────
 * Node strips types rather than compiling them, so ONLY erasable syntax is legal:
 *   - NO `enum`            → use `const` objects `as const` + a derived union type.
 *   - NO `namespace`/module → use plain exported types.
 *   - NO parameter properties (`constructor(private x)`) — n/a here (types only).
 *   - NO decorators, NO `import =` / `export =`.
 *   - Runtime imports MUST use explicit `.ts` extensions; type-only imports use
 *     `import type`. (This file has zero imports by design.)
 *
 * The few `const` objects below (PermissionMode, ToolCallFormat, …) are the
 * erasable-safe replacement for enums: real runtime values plus a `typeof`
 * -derived union type so both value and type positions are covered.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NAMING: internal canonical camelCase everywhere. Provider wire formats
 * (Anthropic snake_case `tool_use`, OpenAI `tool_calls`, Gemini `functionCall`,
 * Ollama `tool_calls`) are normalized INTO these types by each adapter and are
 * never leaked past the provider layer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================================
// SECTION 0 — Primitive & JSON Schema building blocks
// ============================================================================

/** A JSON value. The lingua franca for tool args, tool results, hook I/O. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object (the shape tool arguments always take). */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Hand-written JSON-Schema subset (draft 2020-12 flavored) used to describe
 * tool parameters. We deliberately do NOT use Zod or any schema library — this
 * is the exact object shipped to providers as a tool's `input_schema`
 * (Anthropic) / `parameters` (OpenAI/Ollama/Gemini). Keep it minimal but
 * expressive enough for real tools.
 */
export interface JsonSchema {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null';
  /** For `type:"object"`: property name → schema. */
  properties?: Record<string, JsonSchema>;
  /** For `type:"object"`: which properties are mandatory. */
  required?: string[];
  /** For `type:"object"`: allow/deny keys beyond `properties`. */
  additionalProperties?: boolean | JsonSchema;
  /** For `type:"array"`: element schema. */
  items?: JsonSchema;
  /** Closed set of allowed values. */
  enum?: JsonValue[];
  /** Human-readable description surfaced to the model. */
  description?: string;
  /** Default value (documentation only; not enforced by us). */
  default?: JsonValue;
  /** Union: value must satisfy at least one branch. */
  anyOf?: JsonSchema[];
  /** Simple string format hints (e.g. "uri", "date-time"). */
  format?: string;
  /** Numeric bounds (documentation/validation hints). */
  minimum?: number;
  maximum?: number;
  /** String length bounds. */
  minLength?: number;
  maxLength?: number;
}

// ============================================================================
// SECTION 1 — Messages, content blocks, usage
// ----------------------------------------------------------------------------
// The canonical conversation shape. Provider adapters translate to/from wire
// formats. Assistant turns are appended VERBATIM (incl. thinking+signature and
// tool_use blocks) because Anthropic 400s otherwise; see providers/anthropic.ts.
// ============================================================================

/** Who authored a message. `tool` is only used by providers that model tool
 *  results as their own role (OpenAI/Ollama); internally we carry tool results
 *  as content blocks on a `user` message (Anthropic shape) — see MessageRole. */
export const MessageRole = {
  System: 'system',
  User: 'user',
  Assistant: 'assistant',
  /** Reserved: some adapters emit a dedicated tool role on the wire. Internally
   *  tool results ride on a `user` message as `ToolResultBlock`s. */
  Tool: 'tool',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

/** Discriminator values for content blocks. */
export const ContentBlockType = {
  Text: 'text',
  Thinking: 'thinking',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
  Image: 'image',
} as const;
export type ContentBlockType =
  (typeof ContentBlockType)[keyof typeof ContentBlockType];

/** Plain assistant/user text. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Extended-thinking / reasoning block. `signature` (Anthropic) and Gemini's
 * `thoughtSignature` MUST be preserved and echoed back verbatim on the next
 * request or the provider rejects the turn. `redacted` marks encrypted thinking
 * we cannot read but must still forward.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** Opaque provider signature; round-trip unchanged. */
  signature?: string;
  /** True when the provider returned redacted/encrypted reasoning. */
  redacted?: boolean;
}

/**
 * A model's request to call a tool. `input` is the fully-parsed arguments
 * object (adapters accumulate streaming fragments and `JSON.parse` ONCE at
 * block stop — never mid-stream). `id` correlates with the matching
 * ToolResultBlock. Gemini has no native id → adapter synthesizes `name+counter`.
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: JsonObject;
}

/**
 * Result of executing a tool, sent back to the model. On Anthropic this is a
 * content block on a `user` message that MUST come first in the array and
 * immediately follow the assistant `tool_use` message. `isError` maps errors
 * IN-BAND (the loop almost never throws) so the model self-corrects next turn.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  /** Correlates with the ToolUseBlock.id that requested this. */
  toolUseId: string;
  /** Result payload. String for simple text; blocks for rich/multimodal. */
  content: string | Array<TextBlock | ImageBlock>;
  /** When true, provider marks the result as an error to the model. */
  isError?: boolean;
}

/** Image content (vision). `data` is base64; `source` may point at a URL. */
export interface ImageBlock {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string;
  /** Base64-encoded bytes (mutually exclusive with `url`). */
  data?: string;
  /** Remote URL (providers that fetch server-side). */
  url?: string;
}

/** Any block that can appear in message content. */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

/**
 * A single conversation message. Content is always an array of blocks
 * (normalized; adapters may accept a bare string on input but we store blocks).
 */
export interface Message {
  role: MessageRole;
  content: ContentBlock[];
  /**
   * Optional cache hint: when true, the adapter places a prompt-cache breakpoint
   * at/after this message (Anthropic `cache_control`). Ignored by providers
   * without caching. See Open Question #8.
   */
  cacheBreakpoint?: boolean;
}

/** The system prompt is carried separately (Anthropic `system`, others fold
 *  into a system-role message). Adapters translate as needed. */
export interface SystemPrompt {
  text: string;
  /** Place a cache breakpoint after the system prompt when supported. */
  cacheBreakpoint?: boolean;
}

/**
 * Normalized token accounting. `inputTokens`/`outputTokens` come from the
 * server when available and ANCHOR our tokenizer-free estimator (ceil(chars/4)+1)
 * — we only estimate the delta since the last anchor, dropping error ~30% → <5%.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from prompt cache (Anthropic cache_read, Gemini cached). */
  cachedTokens?: number;
  /** Tokens written INTO the cache this call (Anthropic cache_creation). */
  cacheCreationTokens?: number;
  /** Reasoning/thinking tokens (Anthropic thinking, Gemini thoughtsTokenCount). */
  reasoningTokens?: number;
}

// ============================================================================
// SECTION 2 — Provider layer: streaming deltas & ModelProvider
// ----------------------------------------------------------------------------
// A provider adapter is a generator: read HTTP body → decode SSE/NDJSON →
// normalize to the StreamDelta union below → the loop reduces deltas into a
// canonical assistant turn. The pivot: Anthropic/OpenAI stream tool args as
// accumulate-by-index PARTIAL JSON strings (stateful reducer inside the adapter),
// while Gemini/Ollama deliver WHOLE objects (adapter synthesizes start+args+stop).
// Consumers of StreamDelta never see raw fragments — only completed `input`.
// ============================================================================

/** How a model expects tool calls to be expressed. */
export const ToolCallFormat = {
  /** Structured tool_use/tool_calls blocks (Anthropic/OpenAI/Gemini/Ollama). */
  Native: 'native',
  /** Harness-parsed XML-ish tags for non-tool models (unreliable; repair-gated). */
  Xml: 'xml',
  /** Harness-parsed fenced/bare JSON for non-tool models (unreliable; repaired). */
  Json: 'json',
} as const;
export type ToolCallFormat =
  (typeof ToolCallFormat)[keyof typeof ToolCallFormat];

/** Why the model stopped generating. Normalized across providers. */
export const StopReason = {
  /** Natural completion; if no tool_use blocks present → loop terminates. */
  EndTurn: 'end_turn',
  /** Model wants to call ≥1 tool → execute + continue. */
  ToolUse: 'tool_use',
  /** Hit output cap → escalate max_tokens with terse "continue" and retry. */
  MaxTokens: 'max_tokens',
  /** A stop sequence matched. */
  StopSequence: 'stop_sequence',
  /** Provider paused a long turn (Anthropic pause_turn) → resend unchanged. */
  Pause: 'pause_turn',
  /** Content filtered/refused (OpenAI content_filter, Gemini SAFETY, refusal). */
  Filtered: 'filtered',
  /** Server says the request exceeded the model context window. */
  ContextOverflow: 'model_context_window_exceeded',
  /** Adapter could not map the provider reason. */
  Unknown: 'unknown',
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Discriminator for the streaming delta union. */
export const StreamDeltaType = {
  /** A chunk of assistant-visible text. */
  Text: 'text-delta',
  /** A chunk of thinking/reasoning text (may carry a trailing signature). */
  Thinking: 'thinking-delta',
  /** Announces a new tool call: index + id + name (args stream separately). */
  ToolCallStart: 'tool-call-start',
  /** A fragment of a tool call's argument JSON, keyed by index. NEVER parse
   *  a single fragment — the adapter concatenates then parses once at stop. */
  ToolCallDelta: 'tool-call-delta',
  /** A tool call's args are complete: carries the final parsed `input`. */
  ToolCallDone: 'tool-call-done',
  /** Usage counters (may arrive incrementally; take the latest/cumulative). */
  Usage: 'usage',
  /** Terminal delta: the turn is finished with a normalized stop reason. */
  Done: 'done',
  /** A recoverable/streamed error surfaced by the provider (e.g. overloaded). */
  Error: 'error',
} as const;
export type StreamDeltaType =
  (typeof StreamDeltaType)[keyof typeof StreamDeltaType];

export interface TextDelta {
  type: 'text-delta';
  text: string;
}

export interface ThinkingDelta {
  type: 'thinking-delta';
  thinking: string;
  /** Present only on the final thinking fragment (Anthropic signature_delta). */
  signature?: string;
}

export interface ToolCallStartDelta {
  type: 'tool-call-start';
  /** Stable index used to correlate subsequent arg fragments. */
  index: number;
  /** Provider tool-call id (synthesized as name+counter when absent, e.g. Gemini). */
  id: string;
  name: string;
}

export interface ToolCallArgsDelta {
  type: 'tool-call-delta';
  index: number;
  /** A raw partial-JSON fragment. Concatenate by index; do not parse alone. */
  fragment: string;
}

export interface ToolCallDoneDelta {
  type: 'tool-call-done';
  index: number;
  id: string;
  name: string;
  /** Fully parsed arguments (adapter did the single JSON.parse here). */
  input: JsonObject;
}

export interface UsageDelta {
  type: 'usage';
  usage: Usage;
}

export interface DoneDelta {
  type: 'done';
  stopReason: StopReason;
  /** Final usage snapshot if the provider reports it at end-of-stream. */
  usage?: Usage;
}

export interface ErrorDelta {
  type: 'error';
  /** Machine code (e.g. "overloaded_error", "rate_limit"). */
  code: string;
  message: string;
  /** HTTP status if the error came from the transport (e.g. 429, 529). */
  httpStatus?: number;
  /** Seconds to wait before retry, if the provider supplied Retry-After. */
  retryAfterSeconds?: number;
  /** Whether the loop's recovery layer may retry this. */
  retryable?: boolean;
}

/** The precisely-defined stream-delta union yielded by ModelProvider.chat(). */
export type StreamDelta =
  | TextDelta
  | ThinkingDelta
  | ToolCallStartDelta
  | ToolCallArgsDelta
  | ToolCallDoneDelta
  | UsageDelta
  | DoneDelta
  | ErrorDelta;

/**
 * A tool as advertised to the model (NOT the executable Tool — see Section 4).
 * This is the provider-facing shape the adapter serializes into each wire
 * format's tool declaration.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-Schema object describing the arguments. */
  inputSchema: JsonSchema;
}

/** How the model may/must use tools this turn. */
export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

/** Per-call knobs passed to a provider. Provider ignores unsupported fields. */
export interface ChatOptions {
  /** Model id to invoke (overrides the provider's default). */
  model: string;
  /** Hard cap on output tokens for this call (escalated on max_tokens stop). */
  maxTokens: number;
  /** System prompt for this call. */
  system?: SystemPrompt;
  /** Sampling temperature (0..1 typical). */
  temperature?: number;
  topP?: number;
  /** Stop sequences. */
  stopSequences?: string[];
  /** Tool-choice policy. */
  toolChoice?: ToolChoice;
  /** Force ≤1 tool call per turn (Anthropic disable_parallel_tool_use). */
  disableParallelToolUse?: boolean;
  /** Extended-thinking budget in tokens, when the model supports it. */
  thinkingBudgetTokens?: number;
  /** Cancels the in-flight request (wired to the loop's AbortController). */
  signal?: AbortSignal;
  /**
   * Requested context window in tokens for this call. Ollama maps this to
   * `options.num_ctx` — WITHOUT it Ollama silently caps context at its small
   * default (~4096) regardless of the model's true window. Other providers
   * ignore it (their context size is fixed server-side).
   */
  numCtx?: number;
  /** Provider-specific escape hatch merged into the request body last. */
  extraBody?: JsonObject;
}

/**
 * Static description of what a model can do. Loaded from config per model and
 * consulted by the loop (streaming on/off), context manager (window size), and
 * the tool-call layer (native vs text-protocol repair path).
 */
export interface CapabilityProfile {
  /** True if the model exposes native structured tool calling. */
  nativeTools: boolean;
  /** Max context window in tokens (drives the compaction threshold). */
  contextWindow: number;
  /** Default/maximum output tokens the model will emit. */
  maxOutputTokens: number;
  /** True if the provider streams (else the adapter buffers then emits deltas). */
  supportsStreaming: boolean;
  /** True if the model accepts image content blocks. */
  supportsVision: boolean;
  /** True if the model emits extended-thinking blocks. */
  supportsThinking: boolean;
  /** True if the provider supports prompt caching (cache breakpoints). */
  supportsPromptCache: boolean;
  /** How tool calls are expressed. `native` is the primary path; xml/json route
   *  through the output-repair layer and are treated as UNRELIABLE. */
  toolCallFormat: ToolCallFormat;
}

/**
 * A model found by live discovery (e.g. Ollama `/api/tags`). Nothing here is
 * hardcoded: it is read from the backend at startup / on `/model`. The harness
 * picks the first entry as the default when no model is persisted, and derives a
 * CapabilityProfile from the backend (`describeModel`) rather than a static table.
 */
export interface DiscoveredModel {
  /** Wire model id passed to the provider (e.g. "qwen2.5-coder:7b"). */
  modelId: string;
  /** Provider adapter id that surfaced it (e.g. "ollama"). */
  provider: string;
  /** On-disk size in bytes, when the backend reports it. */
  sizeBytes?: number;
  /** Model family/architecture (e.g. "qwen2", "llama"), when reported. */
  family?: string;
  /** Parameter count label (e.g. "7B"), when reported. */
  parameterSize?: string;
  /** Quantization label (e.g. "Q4_K_M"), when reported. */
  quantization?: string;
  /** Last-modified timestamp string, when reported (used for stable ordering). */
  modifiedAt?: string;
  /** Raw capability tags from the backend (e.g. ["completion","tools","vision"]),
   *  used to derive the CapabilityProfile without a hardcoded lookup. */
  capabilityTags?: string[];
}

/**
 * The provider seam. One implementation per backend (anthropic.ts, ollama.ts,
 * openai.ts, gemini.ts). `chat` is an async generator yielding normalized
 * StreamDelta values; the loop reduces them into an assistant Message + Usage.
 * Adapters must be stateless between calls (all per-call state lives locally).
 */
export interface ModelProvider {
  /** Stable id, e.g. "anthropic", "ollama". */
  readonly id: string;
  /** Capabilities for a given model id (used before/independent of a call). */
  capabilities(model: string): CapabilityProfile;
  /**
   * Run one model turn. Yields StreamDelta values in wire order. Must translate
   * transport failures into `ErrorDelta` where recoverable, and only throw for
   * unrecoverable programmer/config errors.
   */
  chat(
    messages: Message[],
    tools: ToolSpec[],
    options: ChatOptions,
  ): AsyncIterable<StreamDelta>;
  /**
   * Live model discovery. Optional because not every backend enumerates models
   * (cloud adapters may return a static or empty list). Ollama implements this
   * via `/api/tags`. Order is backend order; the harness treats index 0 as the
   * zero-config default when nothing is persisted.
   */
  listModels?(): Promise<DiscoveredModel[]>;
  /**
   * Derive a CapabilityProfile for a model from the backend at runtime rather
   * than a hardcoded table (Ollama: `/api/show` → context_length + capability
   * tags). Falls back to conservative defaults for fields the backend omits.
   * Optional; when absent the harness uses `capabilities(model)`.
   */
  describeModel?(model: string): Promise<CapabilityProfile>;
}

/**
 * Low-level wire decoders shared across adapters. `sse.ts` serves
 * Anthropic/OpenAI/Gemini; `ndjson.ts` serves Ollama. Both buffer across TCP
 * reads and skip `:`-prefixed keepalive comments.
 */
export interface LineDecoder {
  /** Push a raw chunk; yields any complete logical events decoded so far. */
  push(chunk: Uint8Array | string): IterableIterator<DecodedLine>;
  /** Flush at stream end; yields a trailing buffered event if any. */
  flush(): IterableIterator<DecodedLine>;
}

/** One decoded SSE event or NDJSON object. */
export interface DecodedLine {
  /** SSE `event:` name when present (Anthropic uses named events). */
  event?: string;
  /** The parsed `data:` payload (or the whole NDJSON object). */
  data: JsonValue;
  /** Raw data string before JSON.parse (for `[DONE]`-style sentinels). */
  raw: string;
}

// ============================================================================
// SECTION 3 — Permissions & safety
// ----------------------------------------------------------------------------
// Claude Code's 6-step deny-first pipeline is the single choke point:
//   PreToolUse hook → deny rules → ask rules → mode → allow rules → callback.
// Deny returns a MESSAGE to the model (never throws). Protected-path check runs
// BEFORE allow rules. Bash matching does operator-split + word-boundary +
// wrapper-strip. See permissions/gate.ts, bash-match.ts, paths.ts.
// ============================================================================

/** Interactive/automation posture. `bypass` still honors deny + explicit ask. */
export const PermissionMode = {
  /** Prompt on anything not explicitly allowed. */
  Default: 'default',
  /** Auto-approve file edits/writes; still gate bash & network. */
  AcceptEdits: 'acceptEdits',
  /** Read-only planning; block all mutating tools. */
  Plan: 'plan',
  /** Auto-approve everything EXCEPT deny rules and explicit ask rules. */
  Bypass: 'bypass',
} as const;
export type PermissionMode =
  (typeof PermissionMode)[keyof typeof PermissionMode];

/** The three verdicts a rule/pipeline stage can produce. */
export const PermissionEffect = {
  Allow: 'allow',
  Deny: 'deny',
  Ask: 'ask',
} as const;
export type PermissionEffect =
  (typeof PermissionEffect)[keyof typeof PermissionEffect];

/**
 * A permission rule string, e.g. `"Bash"`, `"Bash(git status)"`,
 * `"Read(src/**)"`, `"Bash(npm run test:*)"`. Parsed into tool + optional
 * specifier; bash specifiers get the full matching defenses.
 */
export type PermissionRule = string;

/** Layered rule sets. Precedence managed > cli > local > project > user, with
 *  MONOTONIC deny (a deny in any layer beats an allow in any layer). */
export interface PermissionRuleSet {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

/** A request to use a tool, evaluated by the gate before execution. */
export interface PermissionRequest {
  toolName: string;
  /** The (possibly hook-rewritten) arguments about to be executed. */
  input: JsonObject;
  /** Absolute working directory the tool will run in. */
  cwd: string;
  /** Active permission mode. */
  mode: PermissionMode;
}

/** The gate's decision. `deny`/`ask` carry a model-facing message; deny is a
 *  conversation, not a wall — the message returns as the tool_result. */
export interface PermissionDecision {
  effect: PermissionEffect;
  /** Which pipeline stage decided (for logging/debugging). */
  decidedBy:
    | 'hook'
    | 'deny-rule'
    | 'ask-rule'
    | 'mode'
    | 'allow-rule'
    | 'protected-path'
    | 'callback'
    | 'default';
  /** Human/model-readable reason (mandatory for deny/ask). */
  reason?: string;
  /**
   * Optional argument rewrite (e.g. a hook's `updatedInput`). When present the
   * caller executes with THIS input instead of the original.
   */
  updatedInput?: JsonObject;
}

/**
 * The permission checker callback handed to tools via ToolContext. Tools call
 * it for sub-actions (e.g. bash sub-commands, path writes) and must respect a
 * non-allow decision by returning the reason IN-BAND as an error result.
 */
export type PermissionChecker = (
  request: PermissionRequest,
) => Promise<PermissionDecision>;

/**
 * Interactive prompt seam. When the pipeline reaches `ask`, the UI implements
 * this to get a human answer. Non-interactive runs supply a policy default.
 */
export type PermissionPrompter = (
  request: PermissionRequest,
  reason: string,
) => Promise<{
  effect: 'allow' | 'deny';
  /** Persist this decision as a new rule for the rest of the session/project. */
  remember?: 'session' | 'project' | 'never';
  /** On deny, an optional reason the user typed, fed back to the model. */
  reason?: string;
}>;

// ============================================================================
// SECTION 4 — Tools
// ----------------------------------------------------------------------------
// 6 core (bash/read/write/edit/glob/grep) + task. bash is the universal action;
// edit is exact-string-replace, lint-gated with revert + 3-part error. Read-only
// tools run in parallel; writes serialize. See tools/*.ts.
// ============================================================================

/** Minimal structured logger passed through ToolContext (no console coupling). */
export interface Logger {
  debug(msg: string, meta?: JsonObject): void;
  info(msg: string, meta?: JsonObject): void;
  warn(msg: string, meta?: JsonObject): void;
  error(msg: string, meta?: JsonObject): void;
  /** Child logger with bound context (e.g. { tool: "bash" }). */
  child(bindings: JsonObject): Logger;
}

/**
 * Everything a tool needs to run, injected by the loop. Tools are pure over this
 * context — no globals — so they are testable and subagent-safe.
 */
/** Lifecycle status of one planning todo. */
export const TodoStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;
export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

/** One item on the agent's working plan (see the `todo_write` tool). */
export interface TodoItem {
  /** Imperative description of the step. */
  content: string;
  /** Where the step stands. */
  status: TodoStatus;
}

export interface ToolContext {
  /** Absolute working directory for this execution. */
  cwd: string;
  /** Permission checker for sub-actions the tool performs. */
  checkPermission: PermissionChecker;
  /** Scoped logger. */
  logger: Logger;
  /** Cancellation (Ctrl-C, timeout, parent abort). Tools MUST honor it. */
  signal: AbortSignal;
  /** Absolute paths the harness controls (for spill files, temp, etc.). */
  paths: HarnessPaths;
  /**
   * Spawn a subagent (only present when the parent has depth budget; the `task`
   * tool is withheld structurally at depth 0). Returns the subagent's summary.
   */
  spawnSubagent?: SubagentSpawner;
  /** Depth budget remaining for nested subagents (0 → cannot spawn). */
  depthRemaining: number;
  /** Environment-ish key/value the tool may read (never secrets by default). */
  env: Record<string, string>;
  /**
   * Replace the run's working todo list (the `todo_write` tool uses this). The
   * loop re-injects the current list as a `<system-reminder>` each turn to keep
   * the model on-plan. Optional — tools that don't plan ignore it.
   */
  setTodos?: (items: TodoItem[]) => void;
}

/**
 * The result of a tool execution. `ok:false` is the NORMAL failure path — it
 * becomes a `ToolResultBlock{isError:true}` and the model self-corrects. Tools
 * should almost never throw.
 */
export interface ToolResult {
  ok: boolean;
  /** Model-facing payload. String for text; blocks for rich/multimodal. */
  content: string | Array<TextBlock | ImageBlock>;
  /** True if `content` was truncated to fit a budget (spill pointer in meta). */
  truncated?: boolean;
  /**
   * Structured metadata for the harness (NOT necessarily shown to the model):
   * e.g. exit codes, byte counts, spill-file path, diff stats, files touched.
   */
  meta?: JsonObject;
  /** If the output was spilled to disk, the absolute path + preview length. */
  spill?: { path: string; totalBytes: number; previewChars: number };
}

/**
 * An executable tool. `inputSchema` is the hand-written JSON Schema advertised
 * to the model (also used for pre-execution validation of the parsed args).
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * True if the tool has no side effects and may run concurrently with other
   * read-only tools (Promise.all). Writes/bash are false → serialized.
   */
  concurrencySafe: boolean;
  /** True if the tool mutates the filesystem/system (drives plan-mode blocking). */
  mutates: boolean;
  /**
   * Optional one-line steer appended to a validation error for THIS tool, e.g.
   * pointing a confused model at a sibling tool ("to rename use `move`"). Lives
   * on the tool so generic validation carries no per-tool knowledge.
   */
  disambiguationHint?: string;
  /** Execute against validated args. Should resolve (ok:false) rather than throw. */
  execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}

/** Map-backed registry (tools/registry.ts). Kept as a type for the loop/subagents. */
export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): Tool[];
  /** Provider-facing specs for the currently-enabled tools. */
  specs(): ToolSpec[];
  /** A restricted view for subagents (subset by name). */
  subset(names: string[]): ToolRegistry;
}

/** Signature of the subagent spawner exposed on ToolContext. */
export type SubagentSpawner = (request: SubagentRequest) => Promise<SubagentResult>;

/** Request to run a child agent loop with a fresh event log. */
export interface SubagentRequest {
  /** The task/prompt for the child. */
  prompt: string;
  /** Which named agent profile / system prompt to use. */
  agentType?: string;
  /** Tool names the child may use (defaults to a safe read-only subset). */
  allowedTools?: string[];
  /** Model override; defaults to the parent's model. */
  model?: string;
  /** Depth budget for the child (parent passes depthRemaining-1). */
  depthRemaining: number;
}

/** What a subagent returns to its parent (summary-only; noise stays in child). */
export interface SubagentResult {
  ok: boolean;
  /** The final summary text the parent folds into its context. */
  summary: string;
  /** Rolled-up token usage for accounting. */
  usage: Usage;
  /** Turns the child took. */
  turns: number;
}

// ============================================================================
// SECTION 5 — Hooks
// ----------------------------------------------------------------------------
// "Events, not inheritance." External hook programs receive a JSON envelope on
// stdin and communicate by EXIT CODE: 0 = ok (parse stdout as JSON), 2 = block
// (stderr → model), other = non-blocking warning. stdout is injected into
// context ONLY for SessionStart / UserPromptSubmit / UserPromptExpansion
// (corrected claim #4). Many events can block on exit 2 — verify per-tool.
// See hooks/bus.ts.
// ============================================================================

/** The lifecycle points at which hooks fire. */
export const HookEventName = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  UserPromptExpansion: 'UserPromptExpansion',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PermissionRequest: 'PermissionRequest',
  PreCompact: 'PreCompact',
  Stop: 'Stop',
  SubagentStop: 'SubagentStop',
  Notification: 'Notification',
  SessionEnd: 'SessionEnd',
} as const;
export type HookEventName =
  (typeof HookEventName)[keyof typeof HookEventName];

/** Events whose exit-0 stdout is INJECTED into model context (whitelist). */
export const CONTEXT_INJECTING_HOOKS: readonly HookEventName[] = [
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
] as const;

/** Common envelope fields every hook payload carries. */
export interface HookEventBase {
  event: HookEventName;
  sessionId: string;
  cwd: string;
  /** Wall-clock ISO timestamp. */
  timestamp: string;
  /** Reentry guard: true while a Stop hook already forced continuation. */
  stopHookActive?: boolean;
}

export interface SessionStartHookEvent extends HookEventBase {
  event: 'SessionStart';
  /** How the session began. */
  source: 'startup' | 'resume' | 'clear';
}

export interface UserPromptHookEvent extends HookEventBase {
  event: 'UserPromptSubmit' | 'UserPromptExpansion';
  prompt: string;
}

export interface PreToolUseHookEvent extends HookEventBase {
  event: 'PreToolUse';
  toolName: string;
  input: JsonObject;
}

export interface PostToolUseHookEvent extends HookEventBase {
  event: 'PostToolUse';
  toolName: string;
  input: JsonObject;
  result: ToolResult;
}

export interface PermissionRequestHookEvent extends HookEventBase {
  event: 'PermissionRequest';
  toolName: string;
  input: JsonObject;
}

export interface PreCompactHookEvent extends HookEventBase {
  event: 'PreCompact';
  /** Estimated tokens before compaction. */
  tokensBefore: number;
}

export interface StopHookEvent extends HookEventBase {
  event: 'Stop' | 'SubagentStop';
  /** Turns taken this run. */
  turns: number;
}

export interface NotificationHookEvent extends HookEventBase {
  event: 'Notification';
  message: string;
}

export interface SessionEndHookEvent extends HookEventBase {
  event: 'SessionEnd';
  reason: 'exit' | 'error' | 'clear';
}

/** The discriminated union of hook event payloads (stdin to hook programs). */
export type HookEvent =
  | SessionStartHookEvent
  | UserPromptHookEvent
  | PreToolUseHookEvent
  | PostToolUseHookEvent
  | PermissionRequestHookEvent
  | PreCompactHookEvent
  | StopHookEvent
  | NotificationHookEvent
  | SessionEndHookEvent;

/** Normalized exit-code semantics of a hook process. */
export const HookExitKind = {
  /** exit 0 — success; stdout parsed as JSON (and injected if whitelisted). */
  Ok: 'ok',
  /** exit 2 — block; stderr is fed back to the model as the reason. */
  Block: 'block',
  /** any other code — non-blocking warning; stderr logged, execution continues. */
  Warn: 'warn',
} as const;
export type HookExitKind = (typeof HookExitKind)[keyof typeof HookExitKind];

/**
 * The structured decision a PreToolUse/PermissionRequest hook may return on
 * stdout (exit 0). `updatedInput` FULLY REPLACES the tool args — the
 * transparent-middleware seam. Absent fields mean "no opinion".
 */
export interface HookDecision {
  /** Steer the permission pipeline. */
  permission?: 'allow' | 'deny' | 'ask';
  /** Reason surfaced to the model / prompt. */
  reason?: string;
  /** Full replacement for the tool's input arguments. */
  updatedInput?: JsonObject;
  /** For Stop hooks: force the loop to continue instead of stopping. */
  continue?: boolean;
  /** Text to inject into context (only honored for whitelisted events). */
  additionalContext?: string;
}

/** The harness-side result of running one hook program. */
export interface HookResult {
  exitKind: HookExitKind;
  /** Raw exit code as returned by the process. */
  exitCode: number;
  /** Parsed structured decision (exit 0 + valid JSON stdout), if any. */
  decision?: HookDecision;
  /** Raw stdout (used verbatim for context injection on whitelisted events). */
  stdout: string;
  /** Raw stderr (fed to the model on block; logged on warn). */
  stderr: string;
  /** True if this event blocked execution (exitKind === 'block'). */
  blocked: boolean;
}

/** A configured hook: a matcher + a command to run. */
export interface HookConfig {
  event: HookEventName;
  /** Tool-name / prompt matcher (glob or regex string); empty = all. */
  matcher?: string;
  /** Shell command executed with the JSON envelope on stdin. */
  command: string;
  /** Per-hook timeout in milliseconds. */
  timeoutMs?: number;
}

// ============================================================================
// SECTION 6 — Skills
// ----------------------------------------------------------------------------
// 3-tier progressive disclosure: L1 name+description in system prompt (~60-100
// tok), L2 full SKILL.md body loaded on invocation, L3 supporting files read on
// demand. Filesystem-first, lenient YAML parse. See skills/registry.ts.
// ============================================================================

/** L1 metadata surfaced in the system prompt for every discovered skill. */
export interface SkillMeta {
  /** Directory-name-derived id. */
  name: string;
  /** One-line trigger description shown at L1. */
  description: string;
  /** Absolute path to the SKILL.md file (L2 body loaded on demand). */
  path: string;
  /** Optional tool-name allowlist this skill may use. */
  allowedTools?: string[];
}

/** A skill fully loaded to L2 (body materialized). */
export interface LoadedSkill extends SkillMeta {
  /** The full SKILL.md body injected as one message on invocation. */
  body: string;
}

// ============================================================================
// SECTION 7 — Context management
// ----------------------------------------------------------------------------
// Escalation ladder run before every model call; 4 of 5 layers make zero LLM
// calls: spill → snip → placeholder-clear(keep tool_use block) → collapse →
// LLM summary (9-section checklist). Trigger configurable ~80-85% (NOT 92%).
// Token count is tokenizer-free ceil(chars/4)+1, anchored to server usage.
// See context/count.ts, context/compact.ts.
// ============================================================================

/** The ladder rungs, cheapest first. */
export const CompactionStrategy = {
  /** Spill oversized tool outputs to disk, keep a preview + Read pointer. */
  Spill: 'spill',
  /** GC stale/old tool results outright. */
  Snip: 'snip',
  /** Replace re-fetchable tool_result content with a placeholder, KEEP the
   *  tool_use block so the model can re-run. Cheapest high-value technique. */
  PlaceholderClear: 'placeholder-clear',
  /** Non-destructive summarized overlay view (~90%). */
  Collapse: 'collapse',
  /** One LLM call → a checklist summary that replaces history. */
  Summarize: 'summarize',
} as const;
export type CompactionStrategy =
  (typeof CompactionStrategy)[keyof typeof CompactionStrategy];

/** Tunables for the context manager. */
export interface ContextBudget {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Fraction (0..1) at which auto-compaction fires. Default ~0.82. Tunable
   *  DOWN only in practice; never 1.0. Corrected from the mythical 0.92. */
  compactionThreshold: number;
  /** Tokens reserved as headroom below the window (~13K default). */
  reserveTokens: number;
  /** Char length above which a single tool output is spilled to disk (~50K). */
  spillCharThreshold: number;
  /** How many recent tool results to keep un-cleared during placeholder-clear. */
  keepRecentToolResults: number;
  /** Max consecutive failed compactions before circuit-breaking (default 3). */
  maxFailedCompactions: number;
}

/**
 * Tokenizer-free estimate anchored to the last server-reported input token
 * count. The estimator computes only the delta since `anchorTokens` were
 * measured at `anchorMessageIndex`.
 */
export interface TokenEstimate {
  /** Total estimated input tokens for the current message array. */
  estimatedTokens: number;
  /** Last server-measured input token count used as the anchor. */
  anchorTokens: number;
  /** Message index at which the anchor was taken. */
  anchorMessageIndex: number;
  /** Fraction of the effective window currently used. */
  fractionUsed: number;
  /** True once fractionUsed ≥ compactionThreshold. */
  shouldCompact: boolean;
}

/**
 * The 9-section summary contract the summarizer prompt must fill. The
 * load-bearing sections (all user messages verbatim, verbatim most-recent
 * request, security constraints verbatim) prevent task drift. Kept as a typed
 * shape so the summarizer output is validated, not free-form.
 */
export interface CompactionSummary {
  /** 1. Every user message, verbatim. */
  userMessagesVerbatim: string[];
  /** 2. Verbatim quote of the most recent user request. */
  mostRecentRequestVerbatim: string;
  /** 3. Security/permission constraints, verbatim. */
  securityConstraintsVerbatim: string[];
  /** 4. High-level task/intent. */
  intent: string;
  /** 5. Key technical facts learned (files, APIs, decisions). */
  technicalFacts: string[];
  /** 6. Files created/modified with their current state. */
  filesTouched: Array<{ path: string; state: string }>;
  /** 7. Actions already completed. */
  completed: string[];
  /** 8. Pending/next steps. */
  pending: string[];
  /** 9. Open errors/blockers to resume from. */
  openIssues: string[];
}

// ============================================================================
// SECTION 8 — Event log & sessions (the OpenHands spine)
// ----------------------------------------------------------------------------
// The ONLY durable state is an append-only Event[] (Action|Observation). The
// message array sent to the model is a PROJECTION rebuilt each turn. Compaction,
// permission-rejection, replay, subagents are all pure functions over events.
// Persisted as append-only JSONL; resume = replay. See core/events.ts,
// core/messages.ts, session/jsonl.ts.
// ============================================================================

/** Event kinds in the append-only log. */
export const EventType = {
  /** A user prompt entered the session. */
  UserMessage: 'user_message',
  /** The assistant produced text/thinking. */
  AssistantMessage: 'assistant_message',
  /** The assistant requested a tool (an Action). */
  ToolCall: 'tool_call',
  /** A tool produced a result (an Observation). */
  ToolResult: 'tool_result',
  /** A permission decision was recorded (deny/ask outcome). */
  Permission: 'permission',
  /** A compaction rewrote/collapsed history. */
  Compaction: 'compaction',
  /** A hook fired and (optionally) altered flow. */
  Hook: 'hook',
  /** Token usage snapshot from a model call. */
  Usage: 'usage',
  /** A subagent ran and returned a summary. */
  Subagent: 'subagent',
  /** An error was recorded (transport, tool, recovery action). */
  Error: 'error',
  /** Session lifecycle marker (start/end/resume). */
  Lifecycle: 'lifecycle',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Fields shared by every logged event. */
export interface EventBase {
  /** Monotonic sequence number within the session. */
  seq: number;
  type: EventType;
  /** ISO timestamp. */
  timestamp: string;
  /** Which agent produced it ("main" or a subagent id) — supports the tree. */
  agentId: string;
}

export interface UserMessageEvent extends EventBase {
  type: 'user_message';
  content: ContentBlock[];
}

export interface AssistantMessageEvent extends EventBase {
  type: 'assistant_message';
  content: ContentBlock[];
  stopReason: StopReason;
  model: string;
}

export interface ToolCallEvent extends EventBase {
  type: 'tool_call';
  toolUseId: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResultEvent extends EventBase {
  type: 'tool_result';
  toolUseId: string;
  result: ToolResult;
}

export interface PermissionEvent extends EventBase {
  type: 'permission';
  decision: PermissionDecision;
  request: PermissionRequest;
}

export interface CompactionEvent extends EventBase {
  type: 'compaction';
  strategy: CompactionStrategy;
  tokensBefore: number;
  tokensAfter: number;
  /** The summary produced (only for the Summarize strategy). */
  summary?: CompactionSummary;
}

export interface HookFiredEvent extends EventBase {
  type: 'hook';
  hookEvent: HookEventName;
  result: HookResult;
}

export interface UsageEvent extends EventBase {
  type: 'usage';
  usage: Usage;
  model: string;
}

export interface SubagentEvent extends EventBase {
  type: 'subagent';
  request: SubagentRequest;
  result: SubagentResult;
}

export interface ErrorEvent extends EventBase {
  type: 'error';
  code: string;
  message: string;
  /** What the recovery layer did in response. */
  recovery?: string;
}

export interface LifecycleEvent extends EventBase {
  type: 'lifecycle';
  phase: 'start' | 'end' | 'resume';
  /** Absolute working directory at session start; restored on resume so relative
   *  tool paths bind to the original project, not wherever resume is run. */
  cwd?: string;
}

/** The append-only event union — the harness's durable spine. */
export type AgentEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionEvent
  | CompactionEvent
  | HookFiredEvent
  | UsageEvent
  | SubagentEvent
  | ErrorEvent
  | LifecycleEvent;

/** One line of the persisted JSONL transcript (session/jsonl.ts). */
export interface TranscriptEntry {
  /** Schema version for forward-compat migration. */
  v: number;
  sessionId: string;
  event: AgentEvent;
}

/** In-memory session state derived from (and persisted as) the event log. */
export interface Session {
  id: string;
  /** Absolute path to the JSONL transcript file. */
  transcriptPath: string;
  cwd: string;
  /** The append-only log; messages are projected from this. */
  events: AgentEvent[];
  /** Rolling token/usage totals for the session. */
  totalUsage: Usage;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// SECTION 9 — Agent loop
// ----------------------------------------------------------------------------
// Plain while-loop over the event log. Continue while last assistant turn had
// tool_use; stop on zero tool_use or maxTurns. See core/loop.ts.
// ============================================================================

/** Why the loop stopped (surfaced to the caller/UI). */
export const LoopStopReason = {
  /** Assistant turn had no tool calls → natural completion. */
  NoToolUse: 'no_tool_use',
  /** Hit the maxTurns cap. */
  MaxTurns: 'max_turns',
  /** Hit the token budget. */
  TokenBudget: 'token_budget',
  /** Aborted (Ctrl-C / signal). */
  Aborted: 'aborted',
  /** A stop condition callback requested termination. */
  StopCondition: 'stop_condition',
  /** Detected a stuck loop (same tool call repeated with no progress). */
  Loop: 'loop',
  /** Compaction could not free enough context (circuit-broken). */
  ContextExhausted: 'context_exhausted',
  /** Unrecoverable error after retries. */
  Error: 'error',
} as const;
export type LoopStopReason =
  (typeof LoopStopReason)[keyof typeof LoopStopReason];

/** Options controlling one run of the agent loop. */
export interface AgentLoopOptions {
  /** Hard cap on model turns before forced stop. */
  maxTurns: number;
  /** Optional cap on total tokens (input+output) across the run. */
  tokenBudget?: number;
  /** Model id and per-call knobs. */
  model: string;
  maxTokens: number;
  /** Model context window in tokens; forwarded as Ollama `num_ctx`. */
  contextWindow?: number;
  temperature?: number;
  /** System prompt for the run. */
  system?: SystemPrompt;
  /** Permission posture. */
  permissionMode: PermissionMode;
  /** Depth budget for subagents this run may spawn (0 = none). */
  maxSubagentDepth: number;
  /** Whether the active model advertises native tool-calling. When true but the
   *  model never emits a native call and stalls, the loop warns once that the
   *  endpoint may be ignoring the `tools` param. */
  nativeTools?: boolean;
  /** Fallback model id used after N consecutive 529s. */
  fallbackModel?: string;
  /** Retry/backoff policy for transport errors. */
  retry: RetryPolicy;
  /** Cancellation for the whole run. */
  signal?: AbortSignal;
  /**
   * Optional early-stop predicate evaluated after each turn. Returning true
   * terminates with LoopStopReason.StopCondition.
   */
  stopWhen?: (session: Session) => boolean;
}

/** Backoff policy honoring provider Retry-After. */
export interface RetryPolicy {
  /** Max attempts per model call before giving up. */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: number;
  /** Cap on any single backoff delay. */
  maxDelayMs: number;
  /** Add random jitter to backoff. */
  jitter: boolean;
  /** Consecutive 529s before switching to `fallbackModel`. */
  overloadedSwitchThreshold: number;
  /** Escalated output cap applied after a max_tokens stop. */
  maxTokensEscalation: number;
}

/** The result of a completed loop run. */
export interface AgentRunResult {
  stopReason: LoopStopReason;
  /** Number of model turns executed. */
  turns: number;
  /** Final assistant text (the last assistant message's concatenated text). */
  finalText: string;
  /** Rolled-up usage for the run. */
  usage: Usage;
  /** The session (event log) after the run. */
  session: Session;
}

// ============================================================================
// SECTION 10 — Configuration
// ----------------------------------------------------------------------------
// Loaded from layered settings (managed > cli > local > project > user). Fully
// static/serializable. See config/*.ts.
// ============================================================================

/** Credentials/endpoint for one provider backend. */
export interface ProviderConfig {
  /** Unique name for this entry (referenced by models and --provider). */
  id: string;
  /**
   * Adapter dialect this backend speaks: "ollama" | "openai" (more to come).
   * Defaults to `id`, so `{id:"ollama"}` and `{id:"openai"}` just work while
   * `{id:"deepseek", type:"openai"}` names a custom entry using the
   * OpenAI-compatible adapter.
   */
  type?: string;
  /** Base URL override (e.g. local Ollama, an OpenAI-compatible gateway). */
  baseUrl?: string;
  /** API key or the name of the env var holding it (`env:ANTHROPIC_API_KEY`). */
  apiKey?: string;
  /** Extra headers merged into every request (e.g. OpenRouter HTTP-Referer). */
  headers?: Record<string, string>;
  /**
   * When true, this is the provider Raven uses by default (no `--provider`
   * needed). Flip `active` between entries to switch local ↔ API. If several
   * are marked active the FIRST wins; `--provider` always overrides.
   */
  active?: boolean;
  /**
   * Default model for THIS provider, chosen when no `--model` is given and the
   * global `defaultModel` isn't one of this provider's models. Lets local and
   * API modes each keep their own sensible default.
   */
  defaultModel?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  /**
   * Streaming inactivity window in ms: abort a chat request when the
   * connection produces no bytes for this long (resets on every chunk).
   * Distinct from `timeoutMs` (discovery/one-shot requests) — a short
   * discovery timeout must not choke a slow-loading local model.
   */
  idleTimeoutMs?: number;
}

/** A named model entry binding an id to a provider + capabilities. */
export interface ModelConfig {
  /** Logical name used in config/CLI (e.g. "opus", "local-qwen"). */
  name: string;
  /** Provider adapter id. */
  provider: string;
  /** Wire model id passed to the provider (e.g. "claude-opus-4-...", "qwen2.5"). */
  modelId: string;
  /** Capability profile for this model (drives loop/context/tool-call paths). */
  profile: CapabilityProfile;
  /** Default output token cap. */
  maxTokens?: number;
  /** Default sampling temperature. */
  temperature?: number;
}

/** Absolute paths the harness reads/writes. */
export interface HarnessPaths {
  /** Project root (usually cwd). */
  root: string;
  /** Directory for session transcripts (JSONL). */
  sessions: string;
  /** Directory for spilled tool outputs. */
  spill: string;
  /** Directory scanned for skills. */
  skills: string;
  /** Log output directory. */
  logs: string;
  /** Config file locations by layer, most-specific last. */
  configFiles: string[];
}

/** The fully-resolved harness configuration. */
export interface Config {
  /** Backends by id. */
  providers: ProviderConfig[];
  /** Named models. */
  models: ModelConfig[];
  /** Default model name for the main loop. */
  defaultModel: string;
  /** Fallback model name for overload recovery. */
  fallbackModel?: string;
  /** Model name used for compaction summaries (may be cheaper/smaller). */
  summarizerModel?: string;
  /** Starting permission mode. */
  permissionMode: PermissionMode;
  /** Layered permission rules. */
  permissions: PermissionRuleSet;
  /** Absolute filesystem paths that may NEVER be written (checked before allow):
   *  .git, .ssh, .npmrc, the harness config dir, etc. */
  protectedPaths: string[];
  /** Configured hooks. */
  hooks: HookConfig[];
  /** Context-management tunables. */
  context: ContextBudget;
  /** Loop retry policy defaults. */
  retry: RetryPolicy;
  /** Default subagent depth cap (bounded nesting; default 1–2, max 5). */
  maxSubagentDepth: number;
  /** Filesystem paths. */
  paths: HarnessPaths;
  /** Log verbosity. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// SECTION 11 — Error recovery
// ----------------------------------------------------------------------------
// Tool errors are DATA (is_error:true), not exceptions. Transport errors get
// bounded backoff honoring retry_after; 529→fallback; max_tokens→escalate cap;
// circuit-break after N failed compactions. Optional Reflexion retry buffer.
// See core/recovery.ts.
// ============================================================================

/** Classification of an error for the recovery layer. */
export const ErrorClass = {
  /** Recoverable transport overload (HTTP 529 / overloaded_error). */
  Overloaded: 'overloaded',
  /** Rate limited (HTTP 429) with a Retry-After. */
  RateLimited: 'rate_limited',
  /** Output truncated by max_tokens → escalate cap and continue. */
  MaxTokens: 'max_tokens',
  /** Context window exceeded → force compaction then retry. */
  ContextOverflow: 'context_overflow',
  /** Transient network/timeout error → backoff retry. */
  Network: 'network',
  /** Provider content filter / refusal → surface, do not retry blindly. */
  Filtered: 'filtered',
  /** Unrecoverable (auth, malformed request, 4xx) → fail the run. */
  Fatal: 'fatal',
} as const;
export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

/** The action the recovery layer decided to take. */
export const RecoveryAction = {
  Retry: 'retry',
  RetryWithBackoff: 'retry_with_backoff',
  SwitchToFallback: 'switch_to_fallback',
  EscalateMaxTokens: 'escalate_max_tokens',
  ForceCompaction: 'force_compaction',
  Abort: 'abort',
} as const;
export type RecoveryAction =
  (typeof RecoveryAction)[keyof typeof RecoveryAction];

/** A normalized harness error carrying recovery guidance. */
export interface HarnessError {
  class: ErrorClass;
  message: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  /** Attempt number that produced this error (for backoff/circuit-break). */
  attempt: number;
  /** The recommended next action. */
  action: RecoveryAction;
}

/**
 * Optional Reflexion buffer: a bounded (1–3 slot) list of verbal self-critiques
 * prepended on retry of an autonomous task. Pure prompt engineering.
 */
export interface ReflexionBuffer {
  /** Most-recent-first critiques; capped length. */
  critiques: string[];
  /** Max slots (1–3). */
  capacity: number;
}
