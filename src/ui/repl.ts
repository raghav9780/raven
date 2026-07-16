/**
 * repl.ts — the interactive terminal chat (Claude Code-style). A persistent
 * prompt loop: read a line → slash-command or run an agent turn → stream output
 * → return to the prompt with full context retained. Provides the interactive
 * PermissionPrompter for the gate, Ctrl+C interrupt (double = exit), and slash
 * commands. Built on node:readline + raw ANSI only (no external UI libs).
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { C, SPINNER_FRAMES, paint, permissionPreview } from './render.ts';
import { pick } from './picker.ts';
import { runAgentLoop } from '../core/loop.ts';
import { recordLifecycle, recordUserMessage } from '../core/events.ts';
import { createTranscriptWriter, transcriptPathFor, listSessions } from '../session/jsonl.ts';
import type { LoopDeps } from '../core/loop.ts';
import type { GateState } from '../permissions/gate.ts';
import type {
  AgentLoopOptions,
  CapabilityProfile,
  HarnessPaths,
  Logger,
  ModelProvider,
  PermissionChecker,
  PermissionMode,
  PermissionPrompter,
  RetryPolicy,
  Session,
  StreamDelta,
  ToolRegistry,
} from '../contracts.ts';

/** Everything the REPL needs, assembled by main. */
export interface ReplContext {
  session: Session;
  writer: ReturnType<typeof createTranscriptWriter>;
  gateState: GateState;
  makeChecker: (prompter: PermissionPrompter) => PermissionChecker;
  provider: ModelProvider;
  registry: ToolRegistry;
  logger: Logger;
  paths: HarnessPaths;
  retry: RetryPolicy;
  systemPrompt: string;
  maxTurns: number;
  numCtxCap: number;
  runtime: { model: string; profile: CapabilityProfile; requestedCtx: number };
  discovered: string[];
}

const HELP = `Commands:
  /help              show this help
  /model [name]      list local models, or switch to <name>
  /mode [name]       show/set permission mode (default|acceptEdits|plan|bypass)
  /plan              toggle plan mode
  /permissions       show active allow/deny/ask rules
  /config            show model, provider, cwd, context
  /clear             start a fresh session (keeps model + mode)
  /resume            list resumable sessions
  /compact           (context compaction — arrives in a later slice)
  /exit, /quit       leave (Ctrl+D also exits)
Type anything else to talk to the agent. Ctrl+C interrupts a running turn.`;

export async function startRepl(ctx: ReplContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let session = ctx.session;
  let writer = ctx.writer;
  let busy = false;
  let turnAbort: AbortController | null = null;
  let lastSigint = 0;
  let pendingResolve: ((line: string) => void) | null = null;
  const lineQueue: string[] = [];
  let inputClosed = false;
  const EOF = '\x00__EOF__';

  const out = (s: string): void => void process.stdout.write(s);

  /**
   * Prompt for a line; resolves on the next Enter. Buffers lines that arrive
   * while nothing is waiting (a fast pipe fires many `line` events before the
   * loop re-arms), so piped/scripted input isn't dropped. Resolves EOF once the
   * input stream has closed and the queue is drained.
   */
  function question(promptText: string): Promise<string> {
    return new Promise((resolve) => {
      const queued = lineQueue.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      if (inputClosed) {
        resolve(EOF);
        return;
      }
      pendingResolve = resolve;
      rl.setPrompt(promptText);
      rl.prompt();
    });
  }

  rl.on('line', (line) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on('SIGINT', () => {
    if (busy && turnAbort) {
      turnAbort.abort();
      out(paint('\n^C interrupting…\n', C.yellow));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 1500) {
      out('\n');
      rl.close();
      return;
    }
    lastSigint = now;
    out(paint('\n(press Ctrl+C again to exit)\n', C.dim));
    rl.prompt();
  });

  // ── interactive permission prompter ──────────────────────────────────────
  const prompter: PermissionPrompter = async (request, reason) => {
    out(`\n${paint('● permission required', C.yellow)}  ${paint(reason, C.dim)}\n`);
    out(`${permissionPreview(request)}\n`);
    const answer = (
      await question(
        paint('  [y]es  [n]o  [a]lways·session  [A]lways·project › ', C.bold),
      )
    ).trim();
    if (answer === 'a') return { effect: 'allow', remember: 'session' };
    if (answer === 'A') return { effect: 'allow', remember: 'project' };
    if (/^y(es)?$/i.test(answer) || answer === '') return { effect: 'allow' };
    const denyReason = answer.replace(/^n(o)?\b/i, '').trim();
    return { effect: 'deny', reason: denyReason.length > 0 ? denyReason : undefined };
  };

  const checkPermission = ctx.makeChecker(prompter);

  // ── streaming render (spinner until first token, then stream text) ────────
  let gotOutput = false;
  let spinnerFrame = 0;
  const spinner = setInterval(() => {
    if (busy && !gotOutput) {
      out(`\r${paint(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] + ' thinking…', C.dim)}`);
      spinnerFrame += 1;
    }
  }, 90);
  spinner.unref?.();

  const clearSpinner = (): void => {
    if (!gotOutput) {
      out('\r\x1b[K'); // erase the spinner line
      gotOutput = true;
    }
  };

  // The model is producing output — stop the spinner, but print NOTHING raw
  // (a text-encoded tool call must not reach the screen; prose comes via
  // onAssistantText after recovery).
  const onDelta = (_delta: StreamDelta): void => {
    clearSpinner();
  };

  // Reconciled assistant prose for a turn (post-recovery). This is the only path
  // that prints assistant text to the terminal.
  const onAssistantText = (text: string): void => {
    clearSpinner();
    out(`${text}\n`);
  };

  function loopOptions(signal: AbortSignal): AgentLoopOptions {
    return {
      maxTurns: ctx.maxTurns,
      model: ctx.runtime.model,
      maxTokens: ctx.runtime.profile.maxOutputTokens,
      contextWindow: ctx.runtime.requestedCtx,
      system: { text: ctx.systemPrompt },
      permissionMode: ctx.gateState.mode,
      maxSubagentDepth: 0,
      nativeTools: ctx.runtime.profile.nativeTools,
      retry: ctx.retry,
      signal,
    };
  }

  async function runTurn(input: string): Promise<void> {
    recordUserMessage(session, [{ type: 'text', text: input }]);
    writer.persist(session);
    turnAbort = new AbortController();
    busy = true;
    gotOutput = false;
    const deps: LoopDeps = {
      provider: ctx.provider,
      registry: ctx.registry,
      checkPermission,
      logger: ctx.logger,
      paths: ctx.paths,
      onDelta,
      onAssistantText,
      onNotice: (text) => { clearSpinner(); out(paint(`${text}\n`, C.dim)); },
      persist: writer.persist,
    };
    try {
      const result = await runAgentLoop(session, loopOptions(turnAbort.signal), deps);
      writer.persist(session);
      if (!gotOutput) out('\r\x1b[K');
      out(
        `\n${paint(
          `── ${result.stopReason} · ${result.turns} turn(s) · ` +
            `${result.usage.inputTokens}→${result.usage.outputTokens} tok ──`,
          C.dim,
        )}\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(paint(`\n! turn failed: ${message}\n`, C.red));
    } finally {
      busy = false;
      turnAbort = null;
    }
  }

  /** Switch the active model: re-derive its profile + requested context. */
  async function applyModel(id: string): Promise<void> {
    ctx.runtime.model = id;
    ctx.runtime.profile = ctx.provider.describeModel
      ? await ctx.provider.describeModel(id)
      : ctx.provider.capabilities(id);
    ctx.runtime.requestedCtx = Math.min(
      ctx.runtime.profile.contextWindow,
      ctx.numCtxCap,
    );
    out(
      paint(
        `model → ${id} (ctx ${ctx.runtime.requestedCtx}/${ctx.runtime.profile.contextWindow}, ` +
          `${ctx.runtime.profile.nativeTools ? 'native tools' : ctx.runtime.profile.toolCallFormat})\n`,
        C.dim,
      ),
    );
  }

  // ── slash commands ────────────────────────────────────────────────────────
  async function slash(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help':
        out(`${HELP}\n`);
        return true;
      case 'exit':
      case 'quit':
        return false;
      case 'clear': {
        const id = randomUUID();
        const now = new Date().toISOString();
        session = {
          id,
          transcriptPath: transcriptPathFor(ctx.paths, id),
          cwd: ctx.paths.root,
          events: [],
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        };
        writer = createTranscriptWriter(session.transcriptPath, session.id);
        recordLifecycle(session, 'start', session.cwd);
        writer.persist(session);
        out(paint('cleared — new session\n', C.dim));
        return true;
      }
      case 'model': {
        if (arg) {
          if (!ctx.discovered.includes(arg)) {
            out(paint(`unknown model "${arg}". Run /model to pick.\n`, C.red));
            return true;
          }
          await applyModel(arg);
          return true;
        }
        // No arg → interactive arrow-key picker. Pause readline so Enter goes to
        // the picker, not the line reader; resume + re-prompt afterward.
        rl.pause();
        const chosen = await pick(ctx.discovered, {
          title: 'Select a model  (↑/↓ then Enter, Esc to keep current)',
          selected: Math.max(ctx.discovered.indexOf(ctx.runtime.model), 0),
          render: (m) => (m === ctx.runtime.model ? `${m}  (current)` : m),
        });
        rl.resume();
        if (chosen && chosen !== ctx.runtime.model) await applyModel(chosen);
        else out(paint('model unchanged\n', C.dim));
        return true;
      }
      case 'mode': {
        const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];
        if (!arg) {
          out(`mode: ${paint(ctx.gateState.mode, C.yellow)}\n`);
          return true;
        }
        if (!modes.includes(arg as PermissionMode)) {
          out(paint(`unknown mode. one of: ${modes.join(', ')}\n`, C.red));
          return true;
        }
        ctx.gateState.mode = arg as PermissionMode;
        out(paint(`mode → ${arg}\n`, C.dim));
        return true;
      }
      case 'plan':
        ctx.gateState.mode = ctx.gateState.mode === 'plan' ? 'default' : 'plan';
        out(paint(`mode → ${ctx.gateState.mode}\n`, C.dim));
        return true;
      case 'permissions':
        out(`mode: ${paint(ctx.gateState.mode, C.yellow)}\n`);
        out(`allow: ${ctx.gateState.rules.allow.join(', ') || '(none)'}\n`);
        out(`deny:  ${ctx.gateState.rules.deny.join(', ') || '(none)'}\n`);
        out(`ask:   ${ctx.gateState.rules.ask.join(', ') || '(none)'}\n`);
        return true;
      case 'config':
        out(`model:    ${ctx.runtime.model} (${ctx.provider.id})\n`);
        out(`context:  ${ctx.runtime.requestedCtx}/${ctx.runtime.profile.contextWindow}\n`);
        out(`cwd:      ${ctx.paths.root}\n`);
        out(`session:  ${session.id}\n`);
        return true;
      case 'resume': {
        const ids = listSessions(ctx.paths).slice(0, 10);
        out(ids.length ? `${ids.join('\n')}\n` : 'no saved sessions\n');
        out(paint('restart with:  --resume <id>\n', C.dim));
        return true;
      }
      case 'compact':
        out(paint('context compaction arrives in a later slice.\n', C.dim));
        return true;
      default:
        out(paint(`unknown command /${cmd} — /help for commands\n`, C.red));
        return true;
    }
  }

  // ── banner + main loop ────────────────────────────────────────────────────
  out(
    `\n${paint('Raven', C.bold)} — interactive session. ${paint('/help', C.cyan)} for commands, ` +
      `Ctrl+C to interrupt, Ctrl+D to exit.\n`,
  );

  let running = true;
  rl.on('close', () => {
    inputClosed = true;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(EOF);
    }
  });

  while (running) {
    const line = (await question(paint('› ', C.green))).trim();
    if (line === EOF) break;
    if (line.length === 0) continue;
    if (line.startsWith('/')) {
      const keepGoing = await slash(line);
      if (!keepGoing) break;
      continue;
    }
    out('\n');
    await runTurn(line);
  }

  clearInterval(spinner);
  rl.close();
  out(paint('bye.\n', C.dim));
}
