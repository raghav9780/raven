/**
 * bash-match.ts — the defenses that make Bash allow-rules non-exploitable. A
 * naive `command.startsWith(rule)` is defeated by `safe && evil`, `ls *` vs
 * `lsof`, and `timeout evil`. So we: (1) operator-split into subcommands and
 * require EVERY subcommand to match, (2) strip leading wrappers before matching,
 * (3) match with word-boundary-aware wildcards, and separately (4) flag
 * dangerous commands so the gate can force a prompt.
 */

/** Command wrappers stripped before matching (they can hide the real command). */
const WRAPPERS = new Set([
  'time',
  'timeout',
  'nice',
  'nohup',
  'stdbuf',
  'ionice',
  'env',
  'xargs',
]);

/** Dangerous command patterns → a human-readable reason. (Type inferred so the
 *  first TS annotation in this file sits on an `export` line — otherwise
 *  `node --check` misdetects the module as CommonJS and skips type-stripping.) */
const DANGER = [
  { re: /\brm\s+(?:-\S*\s+)*-\S*[rf]\S*[rf]\S*/, reason: 'recursive/forced rm' },
  { re: /\brm\s+-[rf]\b[\s\S]*\s\/(?:\s|$)/, reason: 'rm targeting /' },
  { re: /\bgit\s+push\b[\s\S]*(?:--force\b|-f\b)/, reason: 'git force-push' },
  { re: /\b(?:mkfs|fdisk|dd)\b/, reason: 'raw disk operation' },
  { re: /:\s*\(\s*\)\s*\{[\s\S]*\}\s*;/, reason: 'fork bomb' },
  { re: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, reason: 'pipe download to shell' },
  { re: /\bchmod\s+-R\s+0*777\b/, reason: 'recursive chmod 777' },
  { re: />\s*\/dev\/(?:sd|nvme|disk|hd)/, reason: 'write to raw device' },
  { re: /\bsudo\b/, reason: 'sudo (privilege escalation)' },
  { re: /\bRemove-Item\b[\s\S]*-Recurse[\s\S]*-Force/i, reason: 'PowerShell recursive force remove' },
  // Bulk move/copy/delete of EVERYTHING via a bare `*` (not `*.ext`). This is
  // how a whole project — including the running session — gets relocated or
  // wiped in one command. `(?<![.\w])\*(?![.\w])` isolates a standalone `*`.
  {
    re: /\b(?:mv|cp|move-item|copy-item|move|copy|robocopy)\b[\s\S]*(?<![.\w])\*(?![.\w*])/i,
    reason: 'bulk move/copy of ALL items in the folder (bare * wildcard)',
  },
  {
    re: /\b(?:rm|del|erase|remove-item|ri|rd)\b[\s\S]*(?<![.\w])\*(?![.\w*])/i,
    reason: 'bulk delete of ALL items in the folder (bare * wildcard)',
  },
];

/** Split a shell command on control operators, respecting quotes. */
export function splitCommands(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && next === '&') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' && next === '|') {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Remove leading wrapper commands (and their obvious option/number args). */
export function stripWrappers(subcommand: string): string {
  let tokens = subcommand.trim().split(/\s+/);
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const head = tokens[0];
    if (WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      changed = true;
      // drop a following option (-n 5, -o0) or bare number/duration (10, 5s)
      while (
        tokens.length > 0 &&
        (tokens[0].startsWith('-') || /^\d+[a-z]?$/.test(tokens[0]))
      ) {
        tokens = tokens.slice(1);
      }
    }
  }
  return tokens.join(' ');
}

/**
 * Match one already-stripped subcommand against a rule specifier. A trailing `*`
 * is a prefix match INCLUDING the character before it, which gives word-boundary
 * safety for free: `ls *` → prefix `"ls "` matches `ls -la` but NOT `lsof`, and
 * `npm run test:*` → prefix `"npm run test:"` matches `npm run test:unit`.
 */
function matchOne(subcommand: string, specifier: string): boolean {
  const cmd = subcommand.trim().replace(/\s+/g, ' ');
  const spec = specifier.trim();
  if (spec.endsWith('*')) {
    return cmd.startsWith(spec.slice(0, -1));
  }
  return cmd === spec;
}

/**
 * True only if EVERY subcommand of `command` independently matches `specifier`.
 * `Bash(git status)` therefore does NOT authorize `git status && rm -rf .`.
 */
export function matchBashRule(command: string, specifier: string): boolean {
  const subs = splitCommands(command);
  if (subs.length === 0) return false;
  return subs.every((sub) => matchOne(stripWrappers(sub), specifier));
}

/** Flag a command as dangerous, with a reason. Tested against the FULL command
 *  so pipe-spanning patterns (e.g. `curl … | sh`) aren't lost to the split. */
export function isDangerous(command: string): { danger: boolean; reason?: string } {
  for (const { re, reason } of DANGER) {
    if (re.test(command)) return { danger: true, reason };
  }
  return { danger: false };
}

/** Simple commands that only READ and can be auto-approved (POSIX + Windows). */
const SAFE_SIMPLE = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'which',
  'where', 'whoami', 'hostname', 'date', 'echo', 'printf', 'stat', 'file',
  'tree', 'du', 'df', 'uname', 'env', 'printenv', 'basename', 'dirname',
  'realpath', 'true', 'false', 'sleep', 'clear',
]);
/** Read-only git subcommands. */
const SAFE_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag', 'ls-files',
  'rev-parse', 'describe', 'blame', 'shortlog',
]);
/** Read-only PowerShell cmdlets (lower-cased). */
const SAFE_PS = new Set([
  'get-childitem', 'get-content', 'get-location', 'get-item', 'test-path',
  'select-string', 'measure-object', 'get-command', 'get-process', 'where-object',
  'select-object', 'sort-object', 'format-table', 'format-list', 'out-string',
]);

/** Strip a shell-invocation wrapper (`bash -c "…"`, `powershell -Command "…"`,
 *  `cmd /c "…"`) and return the INNER command so it can't hide behind the
 *  wrapper name. Returns the input unchanged when there's no such wrapper. */
export function unwrapShell(subcommand: string): string {
  const m = subcommand
    .trim()
    .match(/^(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\b[\s\S]*?\s(?:-l?c|-command|\/c|\/k)\s+([\s\S]+)$/i);
  if (!m) return subcommand;
  let inner = m[1].trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

function isOneSafe(sub: string): boolean {
  const cmd = unwrapShell(sub).trim();
  if (cmd.length === 0) return false;
  // Any redirection makes it a potential write — not auto-safe.
  if (/[<>]/.test(cmd)) return false;
  const tokens = cmd.split(/\s+/);
  const head = (tokens[0] ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/^.*[\\/]/, ''); // basename
  if (SAFE_SIMPLE.has(head)) return true;
  if (SAFE_PS.has(head)) return true;
  if (head === 'git') {
    return SAFE_GIT.has((tokens[1] ?? '').toLowerCase());
  }
  if (head === 'find' || head === 'fd') {
    return !/-exec|-execdir|-delete|-ok/.test(cmd);
  }
  if (head === 'grep' || head === 'rg' || head === 'egrep' || head === 'fgrep') {
    return true; // grep reads
  }
  return false;
}

/**
 * True when EVERY subcommand of `command` is a known read-only command that can
 * be auto-approved (ls/cat/git status/grep/…). Wrappers are unwrapped and any
 * redirection or unlisted command makes the whole thing non-safe.
 */
export function isKnownSafeCommand(command: string): boolean {
  if (isDangerous(command).danger) return false;
  const subs = splitCommands(command);
  if (subs.length === 0) return false;
  return subs.every((sub) => isOneSafe(stripWrappers(sub)));
}
