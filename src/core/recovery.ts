/**
 * recovery.ts — bounded, deterministic recovery helpers for the agent loop:
 * exponential backoff for transient provider errors, an abort-aware sleep, a
 * repeat-fingerprint loop detector, and a narration detector. Kept out of the
 * loop body so the policy is testable and named-constant-driven.
 */

import type { RetryPolicy, ToolUseBlock } from '../contracts.ts';

/** True if the error looks transient (the provider marked it retryable). */
export function isRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { retryable?: unknown }).retryable === true
  );
}

/** Exponential backoff (ms) for `attempt` (1-based), capped, honoring a provider
 *  Retry-After when present, with optional jitter. */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterSeconds?: number,
): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  return policy.jitter ? Math.floor(capped * (0.5 + Math.random() * 0.5)) : capped;
}

/** Sleep `ms`, resolving early (not rejecting) if `signal` aborts — so a pending
 *  backoff never blocks Ctrl+C. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A stable fingerprint of a turn's tool calls, to detect a stuck loop. */
export function toolFingerprint(toolUses: ToolUseBlock[]): string {
  return toolUses
    .map((t) => `${t.name}:${JSON.stringify(t.input)}`)
    .join('|');
}

/**
 * True if the assistant text reads like the model DESCRIBING an action it hasn't
 * taken ("I'll read…", "let me run…", "sure, here's how…") rather than a final
 * answer — used to nudge a weak model to actually emit the tool call.
 */
export function looksLikeNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return /^(sure|okay|ok|alright|here('s| is)|let me|i(\s|')?(ll|'ll| will| am going to| can| should)|now i|first,? i|to (do|create|write|read|run|make))\b/i.test(
    t,
  );
}

/**
 * True if the assistant text DEFERS — asks the user to make a trivial choice or
 * supply a value the agent could pick itself ("please provide the name…",
 * "would you like…"), or ends on a question — instead of just acting. Paired with
 * a no-tool-call turn on an actionable task, it's a stall to nudge past.
 */
export function looksLikeDeferral(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return (
    /\b(please (provide|specify|give me|tell me|confirm|let me know)|provide me|could you|would you like|do you want|shall i|which (one|file|name|option)|what (name|should|would|do you)|let me know|if you('d| would| want)|once you('ve| have)|waiting for (you|your)|need you to)\b/i.test(
      t,
    ) || /\?\s*$/.test(t)
  );
}

/**
 * True if the assistant text asserts the task SUCCEEDED (past-tense "done" /
 * "renamed" / "created" / "fixed" …). Paired with a preceding failed tool result
 * it flags a hallucinated success the loop should reject rather than accept.
 */
export function looksLikeSuccessClaim(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return /\b(done|completed|successful(ly)?|has been|have been|is now|are now|renamed|moved|created|deleted|removed|updated|edited|written|saved|fixed|added|replaced)\b/i.test(
    t,
  );
}
