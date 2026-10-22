<div align="center">

# 🐦‍⬛ Raven

**A Claude Code-style coding agent in plain TypeScript with zero dependencies.**
Runs on local models through Ollama, or on any OpenAI-compatible API.

[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/raghav9780/raven?style=social)](https://github.com/raghav9780/raven/stargazers)

</div>

<!-- TODO: demo GIF — record with `vhs` or `asciinema` + `agg`, save as docs/demo.gif -->
<!-- ![Raven demo](docs/demo.gif) -->

```text
Raven  qwen2.5-coder:7b (ollama)

› create a hello.py that prints the first 10 fibonacci numbers, then run it

⏺ write(hello.py)
  ✓ Created hello.py (6 lines, 142 bytes).

⏺ bash(python hello.py)
  ✓ 0 1 1 2 3 5 8 13 21 34

Created hello.py and ran it — it prints the first 10 Fibonacci numbers.
```

---

## Why Raven?

Most agent harnesses are large, depend on many packages, and assume a frontier
cloud model. Raven takes a different approach:

- **🪶 Zero npm dependencies.** It uses only `fetch` and Node built-ins. Node runs
  the `.ts` files directly, so there's no build step. The whole harness is about
  11K lines you can read in a weekend.
- **🏠 Local-first.** Raven finds your installed Ollama models at startup and reads
  each model's context window and tool support from the backend. No model name is
  hardcoded.
- **🛟 Works with small models.** 7B models often break the tool-calling format.
  Raven handles this:
  - recovers tool calls written as text, with JSON repair
  - converts stringified arguments (`"5000"` → `5000`)
  - checks tool inputs against each tool's schema
  - stops repeated identical calls
  - nudges the model when it describes an action instead of doing it
- **🔐 A real permission model.** Rules are checked deny-first. Bash commands are
  split on `&&`, `;` and `|` so a safe prefix can't approve a dangerous command.
  Protected paths (`.git`, `.ssh`, `.env`, …) are blocked. Common read-only
  commands run without a prompt.
- **📜 Sessions are an append-only event log.** Every session is saved as JSONL,
  so you can resume it later and audit what happened. Context compaction rewrites
  only the messages sent to the model, never the log.
- **🔌 One adapter covers many providers.** The OpenAI-compatible adapter works with
  OpenAI, DeepSeek, Groq, OpenRouter, Cerebras, LM Studio, vLLM, llama.cpp, and the
  OpenAI-compatible endpoints of Anthropic and Gemini.

## Quickstart

**Requirements:** Node.js ≥ 22.18 and [Ollama](https://ollama.com) (or an API key
for a cloud provider).

```bash
# 1. get a tools-capable local model
ollama pull qwen2.5-coder:7b

# 2. clone and link the global `raven` command
git clone https://github.com/raghav9780/raven.git
cd raven
npm link

# 3. run it in any project
cd ~/my-project
raven
```

There's nothing to configure. Raven finds your models, picks one, and remembers
your choice.

> **Windows without npm:** put the repo folder on your `PATH` and use `raven.cmd`.

### One-shot mode

```bash
raven "add a .gitignore for a Node project"
echo "summarize what src/ does" | raven
```

## Using a cloud API

Copy `raven.config.example.json` to `raven.config.json` (it's gitignored, so your
providers and grants stay local), then mark the provider you want as `active`:

```jsonc
{
  "providers": [
    { "id": "ollama", "active": false },
    {
      "id": "deepseek",
      "active": true,
      "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY",
      "defaultModel": "deepseek-chat"
    }
  ]
}
```

Put the key in a `.env` file (gitignored and loaded automatically). Raven never
writes keys to disk:

```bash
cp .env.example .env   # then fill in DEEPSEEK_API_KEY=...
```

To switch providers for a single run, use `raven --provider deepseek`. Inside the
REPL, use `/provider`. See **[docs/CONFIG.md](docs/CONFIG.md)** for the full
schema, layering rules, and more provider examples.

## Tools

| Tool | What it does |
|---|---|
| `read` | Read a file, with line windowing and truncation |
| `write` | Create or overwrite a file |
| `edit` | Replace an exact string, with a whitespace-tolerant fallback and a uniqueness check. JSON edits are syntax-checked and reverted if invalid |
| `move` | Rename or move a file. Refuses to move the project directory or a folder into itself |
| `glob` | Find files by pattern, or list a directory |
| `grep` | Regex search across files |
| `bash` | Run shell commands (PowerShell on Windows, `sh` elsewhere) with timeout and abort |
| `todo_write` | Track a step-by-step plan; Raven shows it to the model again each turn |

## REPL

| Command | |
|---|---|
| `/model [name]` | Pick or switch the model (arrow-key picker) |
| `/provider [id]` | Switch between configured providers |
| `/mode [name]` | `default` · `acceptEdits` · `plan` · `bypass` |
| `/plan` | Toggle plan mode (blocks tools that change files) |
| `/permissions` | Show the active allow/deny/ask rules |
| `/config` | Show the model, provider, working directory, and context size |
| `/resume` | Pick a saved session to resume |
| `/rename [name]` | Name the current session |
| `/clear` | Start a fresh session |
| `/exit` | Quit (Ctrl+D also works) |

**Keys:** `↑/↓` history · `\` + Enter or Alt+Enter for a newline · **Esc** stops
the running turn · pasted text stays as written and isn't submitted line by line.

## CLI flags

```text
-p, --prompt <text>   run one task headless and exit
--model <id>          model override
--provider <id>       provider override
--pick                choose the model with arrow keys at startup
--resume [id]         resume a session (latest if no id)
--plan                plan mode: block tools that change files
--yolo, --bypass      allow everything (deny rules still apply)
--max-turns <n>       turn cap (default 12)
--num-ctx <n>         requested context window (default min(model, 8192))
--cwd <dir>           working directory
```

## How it works

```text
                ┌──────────────────────────────────────────────┐
  you ──▶ REPL ─▶  agent loop (core/loop.ts)                   │
                │   1. rebuild messages from the event log     │
                │   2. compact them at ~82% of the window      │
                │   3. call provider ──▶ Ollama / OpenAI API   │
                │   4. no native call? recover one from text   │
                │   5. for each tool call:                     │
                │        permission gate ─▶ validate ─▶ run    │
                │   6. add results to the log, loop again      │
                └──────────────────────┬───────────────────────┘
                                       ▼
                        .raven/sessions/<id>.jsonl
                     (append-only, resumable by replay)
```

**Design principles:**

1. **The event log is the source of truth.** The message array is rebuilt from it
   every turn. This keeps compaction, resume, and auditing simple, because each
   one just reads the log.
2. **Errors are returned as data.** A failed tool returns `ok:false`, and the
   model sees the error and corrects itself on the next turn. The loop almost
   never throws.
3. **A denial is a message.** When the permission gate blocks a call, it tells the
   model why instead of aborting the run.
4. **Nothing is hardcoded.** Models, context windows, and capabilities come from
   the backend at startup.

**Permission gate.** For each call, the first step that matches decides:

1. Deny rules
2. Protected paths
3. Ask rules
4. Known-safe bash commands (allowed in every mode)
5. Mode: `bypass` allows everything; `plan` blocks tools that change files
6. Dangerous bash commands (always ask)
7. `acceptEdits` mode (allows file writes and edits)
8. Read-only tools
9. Allow rules
10. Ask you

### Project layout

```text
src/
  main.ts            CLI entry: config → discovery → wiring → REPL or one-shot
  contracts.ts       every shared type (types only)
  core/              loop, events, message projection, compaction, recovery, text tool-call parser
  providers/         ollama (NDJSON), openai-compatible (SSE), idle watchdog
  tools/             the 8 tools + schema validation + registry
  permissions/       gate, bash matching, path safety
  session/           JSONL persistence, replay, session list
  config/            layered config, .env loading, model discovery, AGENTS.md rules
  ui/                REPL, multiline line editor, arrow-key picker, rendering
```

Project rules from `AGENTS.md` / `CLAUDE.md` in your repo are added to the system
prompt automatically. They're treated as data, so text in them can't grant
permissions.

## Roadmap

- [x] Agent loop, live model discovery, Ollama provider
- [x] Full tool set, JSONL sessions, resume
- [x] Permission gate, REPL, model/provider/session pickers
- [x] Automatic context compaction, retry with backoff, loop guards
- [x] OpenAI-compatible provider
- [ ] Subagents (`task` tool with depth limit)
- [ ] Skills (load instructions only when needed)
- [ ] LLM-written summary as a compaction step
- [ ] Native Anthropic provider (thinking + prompt caching)
- [ ] Eval harness

## Contributing

Issues and PRs are welcome. The code follows a few strict rules:

- **No runtime dependencies.** Only `fetch` and Node built-ins.
- **TypeScript must be erasable** so Node can run it directly. That means no
  `enum`, no `namespace`, no parameter properties, no decorators. Use
  `import type`, and write `.ts` extensions in imports.
- **Shared types live in `src/contracts.ts`.** Modules import only from that file
  and from other modules' public exports.
- **Tools and the permission gate return errors.** They never throw.

Run the type check over the source:

```bash
node --experimental-strip-types --check src/main.ts
```

## License

[MIT](LICENSE) © raghav9780
