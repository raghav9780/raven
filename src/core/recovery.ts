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
 * A stall (narration or deferral) is characteristically SHORT — "I'll create
 * the file", "Please provide the song name". A long reply that delivers real
 * content is a final answer, even when it opens with "Here's…" or closes with
 * a courtesy "Would you like more details?". Nudging such an answer makes the
 * model "complete" a task that never existed — it reaches for the most recent
 * task in history and replays it (observed live: a fully-answered question got
 * nudged and the model re-ran an old file write).
 */
const STALL_MAX_LENGTH = 400;

/**
 * True if the assistant text reads like the model DESCRIBING an action it hasn't
 * taken ("I'll read…", "let me run…", "sure, here's how…") rather than a final
 * answer — used to nudge a weak model to actually emit the tool call.
 */
export function looksLikeNarration(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > STALL_MAX_LENGTH) return false;
  return /^(sure|okay|ok|alright|here('s| is)|let me|i(\s|')?(ll|'ll| will| am going to| can| should)|now i|first,? i|to (do|create|write|read|run|make))\b/i.test(
    t,
  );
}

/**
 * True if the assistant text DEFERS — asks the user to make a trivial choice or
 * supply a value the agent could pick itself ("please provide the name…",
 * "would you like…") — instead of just acting. Paired with a no-tool-call turn
 * on an actionable task, it's a stall to nudge past.
 */
export function looksLikeDeferral(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // A deferral asks the user to SUPPLY or CHOOSE something the model should
  // have defaulted. A bare trailing "?" is NOT enough — a friendly "How can I
  // help?" after a greeting is a legitimate final reply, not a stall. And in a
  // LONG reply the ask must be the OPENING (the substance), not a courtesy
  // trailer after a complete answer.
  const phrase =
    /\b(please (provide|specify|give me|tell me|confirm|let me know)|provide me|could you|would you like|do you want|shall i|which (one|file|name|option)|what (name|should|would|do you)|let me know|if you('d| would| want)|once you('ve| have)|waiting for (you|your)|need you to)\b/i.exec(
      t,
    );
  if (phrase && (t.length <= STALL_MAX_LENGTH || phrase.index < 160)) {
    return true;
  }
  // Question form that names the missing value ("What's the file name?",
  // "What should the content be?") — still a deferral when it IS the reply.
  return (
    t.length <= STALL_MAX_LENGTH &&
    /\bwhat('s| is)?( the)? \w* ?(file|path|folder|directory|name|value|text|content|url)\b.*\?\s*$/i.test(
      t,
    )
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
