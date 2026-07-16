/**
 * watchdog.ts — shared streaming idle watchdog for provider adapters (ADR-0032).
 *
 * Wraps an AbortController that fires after `idleMs` of inactivity; the adapter
 * calls `resetIdle()` on every received chunk, so a slow-but-alive stream is
 * never cut off — only a dead socket is. Merged with the caller's AbortSignal
 * (a pre-aborted signal trips immediately); `idleFired()` lets the adapter
 * distinguish a watchdog abort (retryable network error) from a user cancel
 * (clean end). `cleanup()` clears the timer and detaches the listener; call it
 * in a `finally`, then `abort()` so an abandoned generator also cancels the
 * underlying request.
 */

/**
 * Human-useful message for a transport error. Node's fetch (undici) reports a
 * bare "fetch failed" and hides the real reason (ENOTFOUND, ECONNREFUSED, TLS
 * failure…) in `error.cause` — surface it so network failures are diagnosable.
 */
export function describeTransportError(err: unknown): string {
  const e = err as {
    message?: string;
    cause?: { message?: string; code?: string };
  };
  const base = e?.message ?? String(err);
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause && !base.includes(cause) ? `${base} (${cause})` : base;
}

export interface IdleWatchdog {
  /** Pass this to fetch(); aborts on caller cancel OR idle expiry. */
  signal: AbortSignal;
  /** Restart the inactivity window — call on every sign of life. */
  resetIdle: () => void;
  /** True when the abort came from idle expiry (not the caller). */
  idleFired: () => boolean;
  /** Clear the timer and detach the caller-signal listener. */
  cleanup: () => void;
  /** Abort the request (used post-cleanup to cancel an abandoned stream). */
  abort: () => void;
}

/** Create an idle watchdog merged with an optional caller signal. */
export function createIdleWatchdog(
  callerSignal: AbortSignal | undefined,
  idleMs: number,
): IdleWatchdog {
  const controller = new AbortController();
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const resetIdle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, idleMs);
  };
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  // An already-aborted signal never fires its abort event — trip immediately.
  if (callerSignal?.aborted) controller.abort();
  resetIdle();

  return {
    signal: controller.signal,
    resetIdle,
    idleFired: () => fired,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
    abort: () => controller.abort(),
  };
}
