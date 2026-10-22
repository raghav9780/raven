/**
 * gate.ts — the single permission choke point. Deny-first pipeline (first match
 * wins), evaluated for every tool call:
 *
 *   deny rules → protected path → ask rules → mode(bypass/plan/acceptEdits) →
 *   dangerous-bash → read-only auto-allow → allow rules → interactive callback
 *
 * `ask`/dangerous/callback are resolved INSIDE the gate (it calls the prompter
 * and returns a concrete allow/deny) so the loop only ever sees allow or deny.
 * Deny returns a model-facing reason — a denial is a conversation, not a wall.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { isProtected } from './paths.ts';
import { isDangerous, isKnownSafeCommand, matchBashRule } from './bash-match.ts';
import { globToRegExp } from '../tools/glob.ts';
import type {
  PermissionChecker,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionPrompter,
} from '../contracts.ts';

/** Mutable gate state (the mode + rules can change at runtime via slash commands). */
export interface GateState {
  rules: PermissionRuleSet;
  mode: PermissionMode;
  cwd: string;
  protectedPaths: string[];
}

/** Injected behavior the gate needs but doesn't own. */
export interface GateDeps {
  /** Interactive prompt (REPL) or a policy default (headless). */
  prompter: PermissionPrompter;
  /** Whether a tool mutates state (drives plan-mode blocking). */
  isMutating: (toolName: string) => boolean;
  /** Whether a tool is read-only (auto-allowed by default). */
  isReadOnly: (toolName: string) => boolean;
  /** Persist a new allow-rule to project config (for "always allow (project)"). */
  persistRule?: (rule: string) => void;
}

function decision(
  effect: PermissionDecision['effect'],
  decidedBy: PermissionDecision['decidedBy'],
  reason?: string,
): PermissionDecision {
  return reason ? { effect, decidedBy, reason } : { effect, decidedBy };
}

/** Parse a rule like `Bash(git status)` / `Write(src/**)` / `Read` into parts. */
function parseRule(rule: string): { tool: string; spec?: string } | null {
  const m = rule.match(/^([A-Za-z_][\w-]*)(?:\(([\s\S]*)\))?$/);
  if (!m) return null;
  return { tool: m[1].toLowerCase(), spec: m[2] };
}

/**
 * Named tool groups for "always allow" grants. A grant earned on ONE
 * file-mutation tool should cover the whole category, so building a project
 * doesn't re-prompt as the model alternates write → edit → move. Data-driven
 * (no scenario knowledge); a group rule is written as `Filewrite(<glob>)`.
 */
const TOOL_GROUPS: Record<string, readonly string[]> = {
  filewrite: ['write', 'edit', 'move'],
};

/** Input keys that carry a filesystem path, across all tools. */
const PATH_ARGS = ['path', 'source', 'destination'] as const;

/** Every non-empty path-like argument of a request. */
function requestPaths(request: PermissionRequest): string[] {
  return PATH_ARGS.map((key) => request.input[key]).filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

/** Does one path satisfy a path-rule spec? Absolute specs match the resolved
 *  absolute path; relative specs match the path relative to cwd. */
function pathMatchesSpec(path: string, spec: string, cwd: string): boolean {
  const abs = resolve(cwd, path);
  const target = isAbsolute(spec) ? abs : relative(cwd, abs);
  const normalized = target.split('\\').join('/');
  try {
    return globToRegExp(spec).test(normalized);
  } catch {
    return normalized === spec;
  }
}

function ruleMatches(rule: string, request: PermissionRequest, cwd: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  const requestTool = request.toolName.toLowerCase();
  const group = TOOL_GROUPS[parsed.tool];
  // A group rule (e.g. `Filewrite(...)`) matches any member tool; a plain rule
  // must name the exact tool.
  if (group ? !group.includes(requestTool) : parsed.tool !== requestTool) {
    return false;
  }
  if (parsed.spec === undefined) return true; // whole-tool / whole-group rule
  if (requestTool === 'bash') {
    const command =
      typeof request.input.command === 'string' ? request.input.command : '';
    return matchBashRule(command, parsed.spec);
  }
  // Every path the call touches must be covered — otherwise a move from inside
  // an allowed tree could send a file anywhere without a prompt.
  const paths = requestPaths(request);
  if (paths.length === 0) return false;
  return paths.every((p) => pathMatchesSpec(p, parsed.spec as string, cwd));
}

/** Create the permission checker over mutable `state`. */
export function createGate(state: GateState, deps: GateDeps): PermissionChecker {
  async function promptAndResolve(
    request: PermissionRequest,
    reason: string,
    decidedBy: PermissionDecision['decidedBy'],
  ): Promise<PermissionDecision> {
    const answer = await deps.prompter(request, reason);
    if (answer.effect === 'allow') {
      if (answer.remember === 'session' || answer.remember === 'project') {
        const rule = ruleFor(request, state.cwd);
        if (!state.rules.allow.includes(rule)) state.rules.allow.push(rule);
        if (answer.remember === 'project') deps.persistRule?.(rule);
      }
      return decision('allow', decidedBy);
    }
    return decision('deny', decidedBy, answer.reason ?? 'User denied the action.');
  }

  return async function check(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const { toolName, input } = request;
    const command = typeof input.command === 'string' ? input.command : undefined;
    // Every path-like argument the call touches — `path` for most tools,
    // `source`/`destination` for move — so none can bypass the protected check.
    const targetPaths = PATH_ARGS.map((key) => input[key]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );

    // 1. deny rules (monotonic — a deny beats everything).
    for (const rule of state.rules.deny) {
      if (ruleMatches(rule, request, state.cwd)) {
        return decision('deny', 'deny-rule', `Denied by rule: ${rule}`);
      }
    }

    // 2. protected path — never read/write .git/.ssh/.env/credentials/config.
    const protectedTarget = targetPaths.find((p) =>
      isProtected(p, state.protectedPaths, state.cwd),
    );
    if (protectedTarget) {
      return decision(
        'deny',
        'protected-path',
        `"${protectedTarget}" is a protected path and cannot be accessed by tools.`,
      );
    }

    // 3. ask rules — explicit confirmation, in every mode incl. bypass.
    for (const rule of state.rules.ask) {
      if (ruleMatches(rule, request, state.cwd)) {
        return promptAndResolve(request, `Rule requires confirmation: ${rule}`, 'ask-rule');
      }
    }

    // 3b. Known read-only bash commands (ls/cat/git status/grep/…) auto-approve
    // in every mode — inspection shouldn't prompt, and reads are fine in plan.
    if (command && isKnownSafeCommand(command)) {
      return decision('allow', 'default');
    }

    // 4a. bypass — allow everything past deny/protected/ask.
    if (state.mode === 'bypass') return decision('allow', 'mode');

    // 4b. plan — block anything that mutates.
    if (state.mode === 'plan' && deps.isMutating(toolName)) {
      return decision(
        'deny',
        'mode',
        'Plan mode: mutating tools are blocked. Propose an approach instead.',
      );
    }

    // 5. dangerous bash — force a prompt (except under bypass, handled above).
    if (command) {
      const danger = isDangerous(command);
      if (danger.danger) {
        return promptAndResolve(
          request,
          `Potentially destructive command (${danger.reason}): ${command}`,
          'callback',
        );
      }
    }

    // 6. acceptEdits — auto-approve file writes/edits.
    if (state.mode === 'acceptEdits' && (toolName === 'write' || toolName === 'edit')) {
      return decision('allow', 'mode');
    }

    // 7. read-only tools — auto-allowed by default.
    if (deps.isReadOnly(toolName)) return decision('allow', 'default');

    // 8. allow rules.
    for (const rule of state.rules.allow) {
      if (ruleMatches(rule, request, state.cwd)) return decision('allow', 'allow-rule');
    }

    // 9. interactive callback (human, or headless policy default).
    const reason = command
      ? `Run command: ${command}`
      : targetPaths.length > 0
        ? `${toolName} → ${targetPaths.join(' → ')}`
        : `Use tool "${toolName}"`;
    return promptAndResolve(request, reason, 'callback');
  };
}

/**
 * Build a persistable allow-rule from a request ("always allow" choice).
 * - bash → the exact command (`Bash(git status)`), kept narrow.
 * - a file-mutation tool (write/edit/move) → the whole `Filewrite` group scoped
 *   to the project dir (`Filewrite(<cwd>/**)`), so approving one file change
 *   covers subsequent write/edit/move calls INSIDE the project without
 *   re-prompting — while staying bounded to this project's tree.
 * - anything else → a plain whole-tool rule.
 */
function ruleFor(request: PermissionRequest, cwd: string): string {
  if (request.toolName === 'bash' && typeof request.input.command === 'string') {
    return `Bash(${request.input.command})`;
  }
  const groupName = Object.keys(TOOL_GROUPS).find((g) =>
    TOOL_GROUPS[g].includes(request.toolName.toLowerCase()),
  );
  if (groupName) {
    const scope = `${cwd.split('\\').join('/').replace(/\/+$/, '')}/**`;
    const label = groupName.charAt(0).toUpperCase() + groupName.slice(1);
    return `${label}(${scope})`;
  }
  const tool = request.toolName.charAt(0).toUpperCase() + request.toolName.slice(1);
  return tool;
}
