/**
 * logger.ts — a minimal structured logger with no console-formatting coupling.
 * Writes one JSON object per line to stderr (so it never corrupts the streamed
 * model output on stdout), filtered by level. `child(bindings)` returns a logger
 * that merges bound context (e.g. `{ tool: "bash" }`) into every record.
 */

import type { JsonObject, Logger } from '../contracts.ts';

/** Log levels in increasing severity; used for threshold filtering. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Create a logger emitting JSONL to stderr at or above `level`.
 * @param level minimum level to emit
 * @param bindings context merged into every record
 */
export function createLogger(
  level: LogLevel = 'info',
  bindings: JsonObject = {},
): Logger {
  const threshold = LEVEL_RANK[level];

  function emit(recordLevel: LogLevel, msg: string, meta?: JsonObject): void {
    if (LEVEL_RANK[recordLevel] < threshold) return;
    const record: JsonObject = {
      t: new Date().toISOString(),
      level: recordLevel,
      msg,
      ...bindings,
      ...(meta ?? {}),
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (childBindings) =>
      createLogger(level, { ...bindings, ...childBindings }),
  };
}
