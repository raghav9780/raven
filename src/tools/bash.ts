/**
 * bash.ts — the universal action. Runs a shell command via child_process.spawn
 * with cancellation (AbortSignal), a timeout, and output-size capping to protect
 * the context window.
 *
 * Shell selection is platform-aware: PowerShell on Windows, `/bin/sh` elsewhere.
 * The permission gate (slice 3) is invoked through `ctx.checkPermission`; in
 * slice 1 the injected checker is permissive, so bash runs after an allow.
 */

import { spawn } from 'node:child_process';
import type { JsonObject, Tool, ToolContext, ToolResult } from '../contracts.ts';

/** Default per-call timeout (ms), returned-output cap, and in-memory capture cap. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
/** Hard ceiling on bytes buffered per stream so a flood can't OOM the process. */
const MAX_CAPTURE_CHARS = MAX_OUTPUT_CHARS * 8;

const isWindows = process.platform === 'win32';
/** The concrete shell this tool drives — surfaced to the model so it uses the
 *  right idioms (PowerShell on Windows, POSIX sh elsewhere). */
export const SHELL_NAME = isWindows ? 'PowerShell' : '/bin/sh';

function shellInvocation(command: string): { file: string; args: string[] } {
  if (isWindows) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/** Terminate the child AND its descendants. Node's `kill()` on Windows only
 *  reaches the top process (powershell.exe), orphaning anything it spawned. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      // best-effort
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  const head = text.slice(0, MAX_OUTPUT_CHARS);
  return {
    text: `${head}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`,
    truncated: true,
  };
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    `Run a shell command via ${SHELL_NAME} for building, testing, git, installing, ` +
    'or running scripts, and return its combined stdout/stderr and exit code. ' +
    'For file work use the dedicated tools instead (read/write/edit/glob/grep) — ' +
    `do NOT use bash to read, write, list, or search files. Use ${SHELL_NAME} syntax` +
    (isWindows ? ' and Windows paths (backslashes, e.g. D:\\dir).' : ' (POSIX).'),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  concurrencySafe: false,
  mutates: true,

  execute(args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command.trim().length === 0) {
      return Promise.resolve({ ok: false, content: 'No command provided.' });
    }
    const timeoutMs =
      typeof args.timeout === 'number' && args.timeout > 0
        ? args.timeout
        : DEFAULT_TIMEOUT_MS;

    const { file, args: shellArgs } = shellInvocation(command);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(file, shellArgs, {
        cwd: ctx.cwd,
        env: { ...process.env, ...ctx.env },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      // `finish` references `timer`/`onAbort` (declared below) only when called,
      // which is always after setup completes — so the forward refs are safe.
      function finish(result: ToolResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(result);
      }

      const timer = setTimeout(() => {
        killTree(child.pid);
        const { text } = capOutput(stdout + stderr);
        finish({
          ok: false,
          content: `Command timed out after ${timeoutMs}ms.\n${text}`,
          meta: { timedOut: true },
        });
      }, timeoutMs);

      const onAbort = (): void => {
        killTree(child.pid);
        finish({ ok: false, content: 'Command aborted.', meta: { aborted: true } });
      };

      // Bounded capture: stop appending past MAX_CAPTURE_CHARS so a flood can't
      // exhaust memory (the returned content is separately capped by capOutput).
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString('utf8');
      });
      // Attach `error` BEFORE the pre-aborted fast path so a spawn failure never
      // becomes an uncaught 'error' event.
      child.on('error', (err: Error) => {
        finish({ ok: false, content: `Failed to start command: ${err.message}` });
      });
      child.on('close', (code: number | null) => {
        const combined = stdout + (stderr ? `\n${stderr}` : '');
        const { text, truncated } = capOutput(combined.trim());
        const exitCode = code ?? -1;
        finish({
          ok: exitCode === 0,
          content: text.length > 0 ? text : `(no output; exit code ${exitCode})`,
          truncated,
          meta: { exitCode },
        });
      });

      if (ctx.signal.aborted) {
        onAbort();
        return;
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  },
};
