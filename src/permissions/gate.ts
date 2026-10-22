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

/** The path a request targets, per tool (move carries `source`, not `path`). */
function requestPath(request: PermissionRequest): string {
  const { input } = request;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.source === 'string') return input.source; // move
  return '';
}

function ruleMatches(rule: string, request: PermissionRequest): boolean {
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
  const path = requestPath(request);
  if (path.length === 0) return false;
  const normalized = path.split('\\').join('/');
  try {
    return globToRegExp(parsed.spec).test(normalized);
  } catch {
    return normalized === parsed.spec;
  }
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
    const path = typeof input.path === 'string' ? input.path : undefined;
    const command = typeof input.command === 'string' ? input.command : undefined;

    // 1. deny rules (monotonic — a deny beats everything).
    for (const rule of state.rules.deny) {
      if (ruleMatches(rule, request)) {
        return decision('deny', 'deny-rule', `Denied by rule: ${rule}`);
      }
    }

    // 2. protected path — never read/write .git/.ssh/.env/credentials/config.
    if (path && isProtected(path, state.protectedPaths, state.cwd)) {
      return decision(
        'deny',
        'protected-path',
        `"${path}" is a protected path and cannot be accessed by tools.`,
      );
    }

    // 3. ask rules — explicit confirmation, in every mode incl. bypass.
    for (const rule of state.rules.ask) {
      if (ruleMatches(rule, request)) {
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
      if (ruleMatches(rule, request)) return decision('allow', 'allow-rule');
    }

    // 9. interactive callback (human, or headless policy default).
    const reason = command
      ? `Run command: ${command}`
      : path
        ? `${toolName} → ${path}`
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
