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
import { createLineEditor, INPUT_EOF } from './input.ts';
import type { AbortWatch } from './input.ts';
import { runAgentLoop } from '../core/loop.ts';
import { recordLifecycle, recordMeta, recordUserMessage } from '../core/events.ts';
import {
  createTranscriptWriter,
  transcriptPathFor,
  listSessionSummaries,
  loadSession,
  renameSession,
} from '../session/jsonl.ts';
import type { SessionSummary } from '../session/jsonl.ts';
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

/** A switchable provider entry for the `/provider` picker: the built adapter
 *  plus the model it defaults to (each provider keeps its own default). */
export interface ProviderChoice {
  id: string;
  provider: ModelProvider;
  defaultModel?: string;
}

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
  /** All providers declared in config, for the `/provider` picker. */
  providers: ProviderChoice[];
}

const HELP = `Commands:
  /help              show this help
  /model [name]      list local models, or switch to <name>
  /provider [id]     list configured providers, or switch to <id> (↑/↓ then Enter)
  /mode [name]       show/set permission mode (default|acceptEdits|plan|bypass)
  /plan              toggle plan mode
  /permissions       show active allow/deny/ask rules
  /config            show model, provider, cwd, context
  /clear             start a fresh session (keeps model + mode)
  /resume            pick a saved session to resume (↑/↓ then Enter)
  /rename [name]     name the current session, or pick one to rename
  /compact           (context compaction — arrives in a later slice)
  /exit, /quit       leave (Ctrl+D also exits)
Type anything else to talk to the agent.
Newline in the prompt: end a line with \\ then Enter, or press Alt+Enter.
Stop a running turn: press Esc (or Ctrl+C).`;

/** Upper bound (ms) on any network model-discovery call made from the REPL. */
const DISCOVERY_MS = 6000;

/**
 * Resolve `p`, but never wait longer than `ms` — on timeout (or rejection)
 * resolve `fallback` instead. The underlying promise is allowed to settle later
 * in the background (its result is discarded); its rejection is swallowed so it
 * never surfaces as an unhandled rejection. Used to keep slash-command model
 * discovery from ever blocking the prompt: a hung /models call froze the REPL.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

export async function startRepl(ctx: ReplContext): Promise<void> {
  let session = ctx.session;
  let writer = ctx.writer;
  let busy = false;
  let turnAbort: AbortController | null = null;
  // While a turn runs, the editor's watchAbort watches for Esc/Ctrl+C; it's
  // published here so a mid-turn interactive prompt can suspend it.
  let activeTurnWatch: AbortWatch | null = null;
  let lastSigint = 0;
  let inputClosed = false;
  const EOF = '\x00__EOF__';
  const history: string[] = [];

  const out = (s: string): void => void process.stdout.write(s);

  // Interactive terminals get the multiline line editor (Enter submits,
  // Shift/Alt+Enter inserts a newline, pastes stay literal). Pipes/scripts keep
  // node:readline, which is fine when there's no interactivity to get right.
  const useEditor = Boolean(process.stdin.isTTY);

  // Ctrl+C while idle at the prompt: first press warns, a second within 1.5s
  // exits. (During a running turn, Ctrl+C/Esc are caught by the editor's abort watch to
  // abort the turn, not here.)
  const onEditorInterrupt = (): 'exit' | 'continue' => {
    const now = Date.now();
    if (now - lastSigint < 1500) {
      out('\n');
      return 'exit';
    }
    lastSigint = now;
    out(paint('\n(press Ctrl+C again to exit)\n', C.dim));
    return 'continue';
  };

  const editor = useEditor
    ? createLineEditor({ onInterrupt: onEditorInterrupt, history })
    : null;

  // readline is only created for the non-TTY (piped) path.
  const rl = useEditor
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });
  let pendingResolve: ((line: string) => void) | null = null;
  const lineQueue: string[] = [];

  /**
   * Prompt for a line. TTY → the multiline editor. Non-TTY → readline, buffering
   * lines that arrive while nothing is waiting (a fast pipe fires many `line`
   * events before the loop re-arms). EOF once the stream closes and drains.
   */
  function question(
    promptText: string,
    opts?: { frame?: boolean; hint?: string },
  ): Promise<string> {
    if (editor) {
      return editor.read(promptText, opts).then((v) => (v === INPUT_EOF ? EOF : v));
    }
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
      rl!.setPrompt(promptText);
      rl!.prompt();
    });
  }

  rl?.on('line', (line) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  // Turn interruption. In editor mode a running turn holds raw mode (via
  // the editor's abort watch), so Ctrl+C during a turn is caught there as a `\x03` byte,
  // not SIGINT; this SIGINT handler is the fallback for the readline/piped path
  // and for the idle prompt (a second press within 1.5s exits). The busy branch
  // still fires if a SIGINT slips through outside raw mode.
  const onSignalInterrupt = (): void => {
    if (busy && turnAbort) {
      turnAbort.abort();
      out(paint('\n^C interrupting…\n', C.yellow));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 1500) {
      out('\n');
      if (rl) rl.close();
      else finishRepl();
      return;
    }
    lastSigint = now;
    out(paint('\n(press Ctrl+C again to exit)\n', C.dim));
    if (rl) rl.prompt();
  };
  if (rl) rl.on('SIGINT', onSignalInterrupt);
  else process.on('SIGINT', onSignalInterrupt);

  let stopRepl = false;
  function finishRepl(): void {
    stopRepl = true;
  }

  // ── interactive permission prompter (arrow-key selector, Claude Code style) ─
  interface PermChoice {
    label: string;
    effect: 'allow' | 'deny';
    remember?: 'session' | 'project';
    askReason?: boolean;
  }
  const PERM_CHOICES: PermChoice[] = [
    { label: 'Yes', effect: 'allow' },
    { label: 'Yes, allow for this session', effect: 'allow', remember: 'session' },
    { label: 'Yes, always allow for this project', effect: 'allow', remember: 'project' },
    { label: 'No, and tell Raven what to do differently', effect: 'deny', askReason: true },
  ];
  const prompter: PermissionPrompter = async (request, reason) => {
    out(`\n${paint('● permission required', C.yellow)}  ${paint(reason, C.dim)}\n`);
    out(`${permissionPreview(request)}\n`);
    // Without a TTY the picker can't take input and would return its default —
    // never allow-by-default in a non-interactive stream.
    if (!process.stdin.isTTY) {
      return { effect: 'deny', reason: 'no interactive terminal to confirm' };
    }
    // This prompt can fire DURING a running turn, where the editor's abort watch holds a
    // stdin watcher for Esc/Ctrl+C. Suspend it so those keys mean "decline this
    // action" here, not "abort the whole turn", and so its listener doesn't
    // fight the picker / deny-reason reader for stdin. Always restored.
    activeTurnWatch?.suspend();
    try {
      // Pause the readline reader so keystrokes go to the picker (editor mode is
      // idle between reads, so it needs no pausing).
      rl?.pause();
      const chosen = await pick(PERM_CHOICES, {
        title: 'Allow this action?',
        render: (c) => c.label,
        selected: 0,
      });
      rl?.resume();
      // Esc / Ctrl+C = deny, never allow-by-default.
      if (!chosen || chosen.effect === 'deny') {
        let denyReason: string | undefined;
        if (chosen?.askReason) {
          const typed = (
            await question(paint('  why / what instead? (Enter to skip) › ', C.dim))
          ).trim();
          if (typed.length > 0) denyReason = typed;
        }
        return { effect: 'deny', reason: denyReason };
      }
      return chosen.remember
        ? { effect: 'allow', remember: chosen.remember }
        : { effect: 'allow' };
    } finally {
      activeTurnWatch?.resume();
    }
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

  /** Persist without ever throwing out of a turn — a broken transcript must
   *  degrade to a warning, never crash the interactive session. */
  function safePersist(): void {
    try {
      writer.persist(session);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(paint(`\n! could not save session history: ${message}\n`, C.red));
    }
  }

  /**
   * Start watching for Esc / Ctrl+C to abort the current turn (Claude-style
   * "press Esc to stop"). All raw-mode/stdin management lives in the editor's
   * watchAbort; here we just wire the abort to `turnAbort` and publish the watch
   * so a mid-turn prompt can suspend it. No-op on the piped (non-TTY) path.
   */
  function startAbortWatch(): AbortWatch | null {
    if (!editor) return null;
    const watch = editor.watchAbort(() => {
      if (turnAbort && !turnAbort.signal.aborted) {
        turnAbort.abort();
        out(paint('\n■ stopped\n', C.yellow));
      }
    });
    activeTurnWatch = watch;
    return watch;
  }

  async function runTurn(input: string): Promise<void> {
    recordUserMessage(session, [{ type: 'text', text: input }]);
    safePersist();
    turnAbort = new AbortController();
    busy = true;
    gotOutput = false;
    const watch = startAbortWatch();
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
      safePersist();
      if (!gotOutput) out('\r\x1b[K');
      out(formatFooter(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(paint(`\n! turn failed: ${message}\n`, C.red));
    } finally {
      watch?.stop();
      activeTurnWatch = null;
      busy = false;
      turnAbort = null;
    }
  }

  /**
   * A quiet end-of-turn footer. On a normal completion the assistant's own
   * final text is the natural terminator, so we print nothing. A footer appears
   * only when it carries signal: an abnormal stop (error / max-turns / aborted),
   * or a multi-turn task worth summarizing. Token counts are shown only when the
   * provider actually reported them (0→0 = gateway with no usage → omit).
   */
  function formatFooter(result: {
    stopReason: string;
    turns: number;
    usage: { inputTokens: number; outputTokens: number };
  }): string {
    const abnormal = !['no_tool_use', 'end_turn'].includes(result.stopReason);
    if (!abnormal && result.turns <= 1) return '';
    const parts: string[] = [];
    if (abnormal) parts.push(result.stopReason);
    if (result.turns > 1) parts.push(`${result.turns} turns`);
    const { inputTokens: i, outputTokens: o } = result.usage;
    if (i > 0 || o > 0) parts.push(`${i}→${o} tok`);
    if (parts.length === 0) return '';
    return `\n${paint(`── ${parts.join(' · ')} ──`, C.dim)}\n`;
  }

  /** Switch the active model: re-derive its profile + requested context.
   *  describeModel may hit the network (Ollama /api/show); it is bounded by
   *  DISCOVERY_MS and falls back to synchronous capabilities so a slow/hung
   *  backend can never freeze the prompt. */
  async function applyModel(id: string): Promise<void> {
    ctx.runtime.model = id;
    ctx.runtime.profile = ctx.provider.describeModel
      ? await withTimeout(
          ctx.provider.describeModel(id),
          DISCOVERY_MS,
          ctx.provider.capabilities(id),
        )
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

  /**
   * Switch the active provider. The switch is applied IMMEDIATELY from the
   * configured default + synchronous capabilities — it never blocks the prompt
   * on a network round-trip (a hung /models call used to freeze the whole REPL).
   * The full model list (for /model) is refreshed in the BACKGROUND, bounded by
   * DISCOVERY_MS, and swapped in only if the user hasn't switched away since.
   */
  async function applyProvider(choice: ProviderChoice): Promise<void> {
    ctx.provider = choice.provider;
    const model = choice.defaultModel ?? ctx.discovered[0];
    // Seed the model list with the default so /model is usable at once; the
    // background refresh below replaces it with the live catalog when it lands.
    ctx.discovered = model ? [model] : [];
    out(paint(`provider → ${choice.id}\n`, C.dim));
    if (model) await applyModel(model);
    else out(paint('  (no default model — set defaultModel in config)\n', C.yellow));
    // Non-blocking, bounded model-list refresh for /model. Fire-and-forget:
    // failures/timeouts are ignored, and a stale result is dropped if the
    // provider changed again before it arrived.
    if (choice.provider.listModels) {
      void withTimeout(choice.provider.listModels(), DISCOVERY_MS, null).then(
        (listed) => {
          if (listed && ctx.provider.id === choice.id) {
            ctx.discovered = listed.map((m) => m.modelId);
          }
        },
      );
    }
  }

  /** Compact "3m ago" / "2h ago" / "5d ago" from an ISO timestamp. */
  function relTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** One-line picker label for a session: name-or-first-message + meta. */
  function sessionLabel(s: SessionSummary): string {
    const title = s.name
      ? paint(s.name, C.cyan)
      : s.firstMessage
        ? s.firstMessage.slice(0, 56)
        : paint('(empty session)', C.gray);
    const marker = s.id === session.id ? paint(' • current', C.green) : '';
    return `${title}${marker}  ${paint(`${s.eventCount} events · ${relTime(s.updatedAt)}`, C.gray)}`;
  }

  /** Swap the live session for a saved one (in-place resume). */
  function resumeSession(id: string): void {
    let loaded;
    try {
      loaded = loadSession(transcriptPathFor(ctx.paths, id), ctx.paths.root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(paint(`could not load session: ${message}\n`, C.red));
      return;
    }
    session = loaded;
    writer = createTranscriptWriter(session.transcriptPath, session.id, session.events.length);
    recordLifecycle(session, 'resume', session.cwd);
    safePersist();
    const label = session.name ?? id.slice(0, 8);
    out(paint(`resumed "${label}" — ${session.events.length} prior events\n`, C.dim));
  }

  /**
   * Run an arrow-key picker with stdin correctly handed over and reclaimed.
   * On the TTY path the old `rl?.pause()` was a dead no-op (rl is null), so
   * nothing relinquished stdin from the line editor to the picker — the source
   * of the terminal freeze on /model, /provider, /resume, /rename. This suspends
   * the editor (and any live turn abort-watch) around the picker, then restores.
   */
  async function withPicker<T>(fn: () => Promise<T>): Promise<T> {
    activeTurnWatch?.suspend();
    editor?.suspend();
    rl?.pause();
    try {
      return await fn();
    } finally {
      rl?.resume();
      editor?.resume();
      activeTurnWatch?.resume();
    }
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
        // No arg → interactive arrow-key picker. withPicker hands stdin from the
        // line editor to the picker and reclaims it (the freeze fix).
        const chosen = await withPicker(() =>
          pick(ctx.discovered, {
            title: 'Select a model  (↑/↓ then Enter, Esc to keep current)',
            selected: Math.max(ctx.discovered.indexOf(ctx.runtime.model), 0),
            render: (m) => (m === ctx.runtime.model ? `${m}  (current)` : m),
          }),
        );
        if (chosen && chosen !== ctx.runtime.model) await applyModel(chosen);
        else out(paint('model unchanged\n', C.dim));
        return true;
      }
      case 'provider': {
        const choices = ctx.providers;
        if (choices.length <= 1) {
          out(
            paint(
              `only one provider configured (${ctx.provider.id}). ` +
                `Add more in raven.config.json.\n`,
              C.dim,
            ),
          );
          return true;
        }
        // With an id arg → switch directly.
        if (arg) {
          const match = choices.find((c) => c.id === arg);
          if (!match) {
            out(
              paint(
                `unknown provider "${arg}". Configured: ` +
                  `${choices.map((c) => c.id).join(', ')}\n`,
                C.red,
              ),
            );
            return true;
          }
          if (match.id === ctx.provider.id) {
            out(paint('provider unchanged\n', C.dim));
            return true;
          }
          await applyProvider(match);
          return true;
        }
        // No arg → interactive arrow-key picker (stdin handed over by withPicker).
        const chosen = await withPicker(() =>
          pick(choices, {
            title: 'Select a provider  (↑/↓ then Enter, Esc to keep current)',
            selected: Math.max(
              choices.findIndex((c) => c.id === ctx.provider.id),
              0,
            ),
            render: (c) => {
              const dm = c.defaultModel ? paint(`  · ${c.defaultModel}`, C.gray) : '';
              const cur = c.id === ctx.provider.id ? paint('  (current)', C.green) : '';
              return `${c.id}${dm}${cur}`;
            },
          }),
        );
        if (chosen && chosen.id !== ctx.provider.id) await applyProvider(chosen);
        else out(paint('provider unchanged\n', C.dim));
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
        const summaries = listSessionSummaries(ctx.paths, 20);
        if (summaries.length === 0) {
          out('no saved sessions\n');
          return true;
        }
        const chosen = await withPicker(() =>
          pick(summaries, {
            title: 'Resume a session  (↑/↓ then Enter, Esc to cancel)',
            render: (s) => sessionLabel(s),
            selected: 0,
          }),
        );
        if (!chosen) {
          out(paint('cancelled\n', C.dim));
          return true;
        }
        resumeSession(chosen.id);
        return true;
      }
      case 'rename': {
        // With a name arg → rename the CURRENT session immediately.
        if (arg) {
          recordMeta(session, arg);
          safePersist();
          out(paint(`renamed current session → "${arg}"\n`, C.dim));
          return true;
        }
        // No arg → pick any session, then prompt for its new name.
        const summaries = listSessionSummaries(ctx.paths, 20);
        if (summaries.length === 0) {
          out('no saved sessions\n');
          return true;
        }
        const chosen = await withPicker(() =>
          pick(summaries, {
            title: 'Rename which session?  (↑/↓ then Enter, Esc to cancel)',
            render: (s) => sessionLabel(s),
            selected: 0,
          }),
        );
        if (!chosen) {
          out(paint('cancelled\n', C.dim));
          return true;
        }
        const name = (await question(paint('  new name › ', C.cyan))).trim();
        if (name === EOF || name.length === 0) {
          out(paint('cancelled — no name given\n', C.dim));
          return true;
        }
        // The current session is renamed via the live log; others via a direct
        // append (so the active writer's write count stays consistent).
        if (chosen.id === session.id) {
          recordMeta(session, name);
          safePersist();
        } else {
          renameSession(ctx.paths, chosen.id, name);
        }
        out(paint(`renamed → "${name}"\n`, C.dim));
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

  rl?.on('close', () => {
    inputClosed = true;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(EOF);
    }
  });

  while (!stopRepl) {
    const raw = await question(paint('› ', C.green), {
      frame: true,
      hint: '↑/↓ history · \\+Enter or Alt+Enter newline · /help · Ctrl+C exit',
    });
    if (raw === EOF) break;
    const line = raw.trim();
    if (line.length === 0) continue;
    history.push(line); // remember for ↑/↓ recall
    if (line.startsWith('/')) {
      const keepGoing = await slash(line);
      if (!keepGoing) break;
      continue;
    }
    out('\n');
    await runTurn(line);
  }

  clearInterval(spinner);
  editor?.close();
  rl?.close();
  out(paint('bye.\n', C.dim));
}
