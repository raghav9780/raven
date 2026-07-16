# Raven configuration

Raven is **zero-config by default**: run `raven`, it discovers your local Ollama
models, picks one, and persists the choice. Everything below is optional
override.

## Where config lives (layered, most-specific wins)

| Layer | Path | Purpose |
|---|---|---|
| 1. User | `~/.raven/config.json` (`C:\Users\<you>\.raven\config.json`) | Personal defaults. **Auto-written** by the bootstrap on first run (and merged, never wiped, when the default model changes). |
| 2. Project (hidden) | `<project>/.raven/config.json` | Per-project overrides you don't want committed. |
| 3. Project (visible) | `<project>/raven.config.json` | Per-project overrides in plain sight — the file to edit. |

Layers are shallow-merged in that order, so a field in `raven.config.json`
overrides the same field in the user config. Arrays replace wholesale (they are
not concatenated).

The "auto-configure Ollama" logic itself is code, not a script:
`src/config/load.ts` (file loading) and `src/config/bootstrap.ts` (live model
discovery → default selection → capability profiling → persistence).

## Full schema

```jsonc
{
  // Model to use when none is passed via --model. Must exist for the chosen
  // provider (discovered live, or declared in `models` below).
  "defaultModel": "qwen2.5-coder:7b",

  // Provider backends. The entry marked `"active": true` is the default —
  // flip it to switch local ↔ API mode. `--provider <id>` overrides per run.
  "providers": [
    {
      "id": "ollama",                   // local Ollama; baseUrl defaults to
                                        // $OLLAMA_HOST or http://localhost:11434
      "active": true,                   // ← the local/API toggle
      "defaultModel": "qwen2.5-coder:7b"  // per-provider default (no --model needed)
    },
    {
      "id": "petroit",                  // any name you like
      "active": false,                  // set true (and ollama false) for API mode
      "type": "openai",                 // adapter dialect: "ollama" | "openai"
                                        // (defaults to id — so custom names need it)
      "baseUrl": "https://ollama.petroit.ai",  // "/v1" is appended when missing
      "apiKey": "env:PETROIT_API_KEY",  // "env:VAR" reads the environment/.env —
                                        // NEVER put a raw key in this file
      "defaultModel": "qwen2.5-coder:max-8k",
      "headers": { "x-extra": "..." },  // optional extra request headers
      "timeoutMs": 15000,               // discovery/one-shot request timeout
      "idleTimeoutMs": 120000           // streaming stall watchdog (ADR-0032)
    }
  ],

  // Optional model declarations. Needed only when a provider can't enumerate
  // models (no /models endpoint), or to override a model's capability profile
  // (e.g. pin a smaller context window). Declared profiles win over discovery.
  "models": [
    {
      "name": "qwen-32b",               // the name you type after --model
      "provider": "petroit",
      "modelId": "qwen2.5-coder:32b",   // wire id sent to the API
      "profile": {
        "nativeTools": true,
        "contextWindow": 32768,
        "maxOutputTokens": 4096,
        "supportsStreaming": true,
        "supportsVision": false,
        "supportsThinking": false,
        "supportsPromptCache": false,
        "toolCallFormat": "native"
      }
    }
  ],

  "permissionMode": "default",          // default | acceptEdits | plan | bypassPermissions
  "permissions": { "allow": [], "deny": [], "ask": [] },
  "protectedPaths": [],                 // extra never-touch paths
  "logLevel": "info",                   // debug | info | warn | error
  "maxSubagentDepth": 0
}
```

## The OpenAI-compatible adapter (`type: "openai"`)

One adapter covers every service speaking `/v1/chat/completions`:
OpenAI, DeepSeek, Groq, OpenRouter, Together, Mistral, LM Studio, vLLM,
llama.cpp server, authenticated Ollama gateways — and the OpenAI-compat
endpoints of Anthropic and Gemini. Examples:

```jsonc
{ "id": "deepseek",  "type": "openai", "baseUrl": "https://api.deepseek.com",   "apiKey": "env:DEEPSEEK_API_KEY" }
{ "id": "openai",                       /* baseUrl defaults to api.openai.com */ "apiKey": "env:OPENAI_API_KEY" }
{ "id": "groq",      "type": "openai", "baseUrl": "https://api.groq.com/openai", "apiKey": "env:GROQ_API_KEY" }
{ "id": "anthropic", "type": "openai", "baseUrl": "https://api.anthropic.com",  "apiKey": "env:ANTHROPIC_API_KEY" }
```

Run against one with:

```
raven --provider petroit --model qwen2.5-coder:32b
```

Model discovery uses `GET {base}/models` when the service supports it;
otherwise declare the models in the `models` array (see above) and Raven works
without discovery.

## Switching local ↔ API mode

Three ways, in precedence order:

1. **Per run:** `raven --provider petroit` (beats everything).
2. **Config toggle:** flip `"active": true` between provider entries in
   `raven.config.json` — that's the persistent switch.
3. Nothing set → `ollama`.

Each provider's own `defaultModel` is used in its mode, so you never need
`--model` after switching.

## Secrets (`.env`)

`apiKey` supports `env:VAR_NAME` indirection — the key is read from the
environment at startup and never written to disk by Raven.

Raven auto-loads a **`.env` file** (zero-dependency, no dotenv package) from
the working directory, then `~/.raven/.env`. Real environment variables always
win over `.env` values. Format:

```
# comment
PETROIT_API_KEY=xxxx-xxxx
OPENAI_API_KEY="quoted values ok"
```

`.env` is gitignored; `.env.example` is the committed template. A shell export
(`$env:VAR = "..."` / `setx`) works too and takes precedence.
