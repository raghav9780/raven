/**
 * rules.ts — load a project's agent-instructions file (AGENTS.md / CLAUDE.md /
 * .raven/rules.md) so per-project conventions steer the model. The content is
 * treated as DATA appended to the system prompt (the caller wraps it with a
 * clause telling the model to ignore any embedded attempt to change the harness
 * rules or grant itself permissions).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Candidate rule files, in precedence order (first found wins). */
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.raven/rules.md', '.cursorrules'];
/** Cap so a huge rules file can't dominate the context window. */
const MAX_CHARS = 12_000;

/** Load the first project-rules file found under `cwd`, capped, or null. */
export function loadProjectRules(cwd: string): string | null {
  for (const name of RULE_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf8').trim();
      if (content.length > 0) {
        return content.length > MAX_CHARS
          ? `${content.slice(0, MAX_CHARS)}\n…[project rules truncated]`
          : content;
      }
    } catch {
      // unreadable → try the next candidate
    }
  }
  return null;
}
