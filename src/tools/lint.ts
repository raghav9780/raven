/**
 * lint.ts — a dependency-free syntax gate for the edit tool. After an edit is
 * computed (but before it's written), reject it if it would make the file
 * unparseable, leaving the file unchanged so the model can correct it
 * (SWE-agent's edit-lint is a high-ROI tool intervention).
 *
 * Scope: JSON only. `JSON.parse` is a 100%-reliable, zero-dependency check, so
 * it catches the common and damaging "broke package.json / tsconfig / a config"
 * edit. JS/TS are deliberately FAIL-OPEN: `node --check` (even with
 * --experimental-strip-types) is NOT reliable here — it both misdetects a
 * marker-less module as CommonJS (false positive) AND fails to catch some real
 * syntax errors after stripping (false negative) — and a proper JS/TS parser
 * would be a runtime dependency, which the project forbids. A fragile gate that
 * rejects valid edits is worse than none, so we don't gate code.
 */

import { extname } from 'node:path';

/** Return a syntax-error message if `content` is invalid for `filePath`'s
 *  language, or null if it's valid or the language isn't reliably checkable. */
export function checkSyntax(filePath: string, content: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    if (content.trim().length === 0) return null; // empty file is allowed
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null; // fail-open: not reliably checkable without a parser dependency
}
