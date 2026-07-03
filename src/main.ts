/**
 * main.ts — Raven CLI entrypoint (slice 1). Zero-config startup: load partial
 * config → discover local models → resolve the effective config → print the
 * banner → run one prompt through the agent loop against a local Ollama model.
 *
 * The interactive REPL, permissions UI, and persistence arrive in later slices;
 * slice 1 accepts the prompt as an argument or on stdin and streams the run.
 *
 * Run:  node --experimental-strip-types src/main.ts "your task"
 *   or: echo "your task" | node --experimental-strip-types src/main.ts
 */

import { randomUUID } from 'node:crypto';
import { createOllamaProvider } from './providers/ollama.ts';
import { loadConfig } from './config/load.ts';
import { resolveConfig, StartupError } from './config/bootstrap.ts';
import { createLogger } from './config/logger.ts';
import { createRegistry } from './tools/registry.ts';
import { bashTool, SHELL_NAME } from './tools/bash.ts';
import { readTool } from './tools/read.ts';
import { writeTool } from './tools/write.ts';
import { editTool } from './tools/edit.ts';
import { globTool } from './tools/glob.ts';
import { grepTool } from './tools/grep.ts';
import {
  createTranscriptWriter,
  listSessions,
  loadSession,
  transcriptPathFor,
} from './session/jsonl.ts';
import { runAgentLoop } from './core/loop.ts';
import { recordLifecycle, recordUserMessage } from './core/events.ts';
import type { LoopDeps } from './core/loop.ts';
import type { LogLevel } from './config/logger.ts';
import type {
  AgentLoopOptions,
  PermissionChecker,
  PermissionMode,
  ProviderConfig,
  Session,
  StreamDelta,
  Tool,
  ToolResult,
} from './contracts.ts';

interface ParsedArgs {
  prompt?: string;
  model?: string;
  provider?: string;
  cwd: string;
  mode: PermissionMode;
  maxTurns: number;
  help: boolean;
  /** undefined = fresh session; '' = resume latest; id = resume that session. */
  resume?: string;
  /** Requested Ollama context window (num_ctx); default caps below model max. */
  numCtx?: number;
}

/**
 * Default requested context window. We do NOT request the model's full window by
 * default: allocating a large KV cache (e.g. 32K for a 7B) is a severe
 * latency/memory cliff on modest hardware, while Ollama's own default (~4K)
 * silently truncates. 8K is a safe middle ground; raise with --num-ctx.
 */
const DEFAULT_NUM_CTX = 8192;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    cwd: process.cwd(),
    mode: 'default',
    maxTurns: 12,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '-p':
      case '--prompt':
        parsed.prompt = argv[++i];
        break;
      case '--model':
        parsed.model = argv[++i];
        break;
      case '--provider':
        parsed.provider = argv[++i];
        break;
      case '--cwd':
        parsed.cwd = argv[++i] ?? parsed.cwd;
        break;
      case '--max-turns':
        parsed.maxTurns = Number(argv[++i]) || parsed.maxTurns;
        break;
      case '--num-ctx':
        parsed.numCtx = Number(argv[++i]) || undefined;
        break;
      case '--yolo':
      case '--bypass':
        parsed.mode = 'bypass';
        break;
      case '--plan':
        parsed.mode = 'plan';
        break;
      case '--resume': {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          parsed.resume = next;
          i += 1;
        } else {
          parsed.resume = '';
        }
        break;
      }
      default:
        if (!arg.startsWith('-')) positional.push(arg);
        break;
    }
  }
  if (!parsed.prompt && positional.length > 0) {
    parsed.prompt = positional.join(' ');
  }
  return parsed;
}

const HELP = `Raven — zero-dependency local-first coding agent (slice 1)

Usage:
  node --experimental-strip-types src/main.ts [options] "your task"
  echo "your task" | node --experimental-strip-types src/main.ts

Options:
  -p, --prompt <text>   Task prompt (else positional args or stdin)
  --model <id>          Model id override (else first discovered)
  --provider <id>       Provider id (default: ollama)
  --cwd <dir>           Working directory (default: process cwd)
  --max-turns <n>       Max model turns (default: 12)
  --num-ctx <n>         Requested context window (default: min(model, 8192))
  --plan                Plan mode: block mutating tools
  --yolo, --bypass      Bypass mode: auto-allow everything
  --resume [id]         Resume a saved session (latest if no id given)
  -h, --help            Show this help

Tools: bash, read, write, edit, glob, grep. Sessions are saved under
.raven/sessions and can be resumed with --resume.
`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

/** Wrap a tool so its call + result are echoed to stdout for visibility. */
function withDisplay(tool: Tool): Tool {
  return {
    ...tool,
    async execute(args, ctx): Promise<ToolResult> {
      const preview = JSON.stringify(args).slice(0, 160);
      process.stdout.write(`\n\x1b[36m⏺ ${tool.name}(${preview})\x1b[0m\n`);
      const result = await tool.execute(args, ctx);
      const body =
        typeof result.content === 'string'
          ? result.content
          : '[structured content]';
      const status = result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      process.stdout.write(`  ${status} ${body.slice(0, 500)}\n\n`);
      return result;
    },
  };
}

const SYSTEM_PROMPT = `You are Raven, an autonomous coding agent running in a terminal.
You have tools: "bash" (runs commands via ${SHELL_NAME} in the working directory)
and "read" (read a file). IMPORTANT: the shell is ${SHELL_NAME} — use ${SHELL_NAME}
syntax and OS-native paths (${
  SHELL_NAME === 'PowerShell'
    ? 'e.g. Set-Content/Get-Content, backslash paths like D:\\dir\\file'
    : 'POSIX sh, forward-slash paths'
}). Use tools to accomplish the user's task one step at a time. Prefer small,
verifiable actions. When the task is complete, reply with a short plain-text
summary and NO further tool calls (that ends your turn).`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const partial = loadConfig(args.cwd);
  const providerCfg: ProviderConfig =
    partial.providers?.find((p) => p.id === (args.provider ?? 'ollama')) ??
    { id: args.provider ?? 'ollama' };
  const providers = { ollama: createOllamaProvider(providerCfg) };

  let resolved;
  try {
    resolved = await resolveConfig(partial, providers, {
      cwd: args.cwd,
      provider: args.provider,
      model: args.model,
      permissionMode: args.mode,
    });
  } catch (err) {
    if (err instanceof StartupError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { config, model, profile, discovered } = resolved;

  // Requested context window (num_ctx) — capped below the model max by default
  // to avoid the large-KV-cache latency cliff; override with --num-ctx.
  const requestedCtx = args.numCtx ?? Math.min(profile.contextWindow, DEFAULT_NUM_CTX);

  // Banner
  process.stdout.write(
    `\n\x1b[1mRaven\x1b[0m  model=\x1b[35m${model.modelId}\x1b[0m ` +
      `provider=${model.provider} mode=${config.permissionMode} ` +
      `ctx=${requestedCtx}/${profile.contextWindow} tools=${profile.nativeTools ? 'native' : profile.toolCallFormat}\n` +
      `cwd=${config.paths.root}\n` +
      `discovered ${discovered.length} model(s): ${discovered.join(', ')}\n\n`,
  );

  // Acquire the prompt.
  let prompt = args.prompt;
  if (!prompt) {
    if (!process.stdin.isTTY) {
      prompt = (await readStdin()).trim();
    }
  }
  if (!prompt) {
    process.stdout.write(
      'No prompt given. The interactive REPL arrives in a later slice.\n' +
        'Pass one:  node --experimental-strip-types src/main.ts "list the files here"\n',
    );
    return;
  }

  const logger = createLogger((config.logLevel as LogLevel) ?? 'info');
  const registry = createRegistry([
    withDisplay(bashTool),
    withDisplay(readTool),
    withDisplay(writeTool),
    withDisplay(editTool),
    withDisplay(globTool),
    withDisplay(grepTool),
  ]);

  const abort = new AbortController();
  process.on('SIGINT', () => {
    process.stdout.write('\n\x1b[33m^C — aborting…\x1b[0m\n');
    abort.abort();
  });

  const checkPermission: PermissionChecker = async (request) => {
    if (config.permissionMode === 'plan') {
      const tool = registry.get(request.toolName);
      if (tool?.mutates) {
        return {
          effect: 'deny',
          decidedBy: 'mode',
          reason: 'Plan mode: mutating tools are blocked. Propose an approach instead.',
        };
      }
    }
    // Slice 1: no interactive gate yet — allow (the real gate lands in slice 3).
    return { effect: 'allow', decidedBy: 'default' };
  };

  let session: Session;
  let alreadyWritten = 0;
  if (args.resume !== undefined) {
    const id = args.resume || listSessions(config.paths)[0];
    if (!id) {
      process.stdout.write('No saved sessions to resume.\n');
      return;
    }
    const transcriptPath = transcriptPathFor(config.paths, id);
    try {
      session = loadSession(transcriptPath, config.paths.root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Could not load session "${id}": ${message}\n`);
      process.exitCode = 1;
      return;
    }
    // Restore the original working directory so relative tool paths bind to the
    // project the session was created in, not wherever resume is run.
    const startEvent = session.events.find(
      (e): e is Extract<typeof e, { type: 'lifecycle' }> =>
        e.type === 'lifecycle' && e.phase === 'start' && typeof e.cwd === 'string',
    );
    if (startEvent?.cwd && startEvent.cwd !== session.cwd) {
      process.stdout.write(
        `\x1b[33mnote: restoring original working dir ${startEvent.cwd} ` +
          `(resume was run from ${session.cwd})\x1b[0m\n`,
      );
      session.cwd = startEvent.cwd;
    }
    alreadyWritten = session.events.length;
    process.stdout.write(
      `\x1b[2mresumed session ${session.id} — ${session.events.length} prior events\x1b[0m\n`,
    );
  } else {
    const now = new Date().toISOString();
    const id = randomUUID();
    session = {
      id,
      transcriptPath: transcriptPathFor(config.paths, id),
      cwd: config.paths.root,
      events: [],
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      updatedAt: now,
    };
    recordLifecycle(session, 'start', session.cwd);
  }

  const writer = createTranscriptWriter(
    session.transcriptPath,
    session.id,
    alreadyWritten,
  );
  recordUserMessage(session, [{ type: 'text', text: prompt }]);
  writer.persist(session);

  const onDelta = (delta: StreamDelta): void => {
    if (delta.type === 'text-delta') process.stdout.write(delta.text);
  };

  const loopOptions: AgentLoopOptions = {
    maxTurns: args.maxTurns,
    model: model.modelId,
    maxTokens: profile.maxOutputTokens,
    contextWindow: requestedCtx,
    system: { text: SYSTEM_PROMPT },
    permissionMode: config.permissionMode,
    maxSubagentDepth: 0,
    retry: config.retry,
    signal: abort.signal,
  };

  const deps: LoopDeps = {
    provider: providers.ollama,
    registry,
    checkPermission,
    logger,
    paths: config.paths,
    onDelta,
    persist: writer.persist,
  };

  const result = await runAgentLoop(session, loopOptions, deps);
  writer.persist(session);

  process.stdout.write(
    `\n\n\x1b[2m── done (${result.stopReason}) · ${result.turns} turn(s) · ` +
      `${result.usage.inputTokens}→${result.usage.outputTokens} tokens ──\x1b[0m\n` +
      `\x1b[2msession ${session.id} · resume with: --resume ${session.id}\x1b[0m\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
