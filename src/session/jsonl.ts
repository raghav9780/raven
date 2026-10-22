/**
 * jsonl.ts — durable, append-only session transcript (one JSON line per event)
 * and resume-by-replay. Because the event log is the spine, persistence is just
 * "append each new event" and resume is "fold the lines back into a Session" —
 * no special-casing.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { MAIN_AGENT } from '../core/events.ts';
import type {
  AgentEvent,
  HarnessPaths,
  MetaEvent,
  Session,
  TranscriptEntry,
  Usage,
} from '../contracts.ts';

/** Current transcript schema version (bump on breaking event-shape changes). */
const SCHEMA_VERSION = 1;

/** Absolute path of the transcript file for a session id. */
export function transcriptPathFor(paths: HarnessPaths, sessionId: string): string {
  return join(paths.sessions, `${sessionId}.jsonl`);
}

/** Sum usage across all usage events (used when rebuilding a session). */
function sumUsage(events: AgentEvent[]): Usage {
  const total: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  };
  for (const event of events) {
    if (event.type === 'usage') {
      total.inputTokens += event.usage.inputTokens;
      total.outputTokens += event.usage.outputTokens;
      total.cachedTokens =
        (total.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0);
      total.cacheCreationTokens =
        (total.cacheCreationTokens ?? 0) + (event.usage.cacheCreationTokens ?? 0);
      total.reasoningTokens =
        (total.reasoningTokens ?? 0) + (event.usage.reasoningTokens ?? 0);
    }
  }
  return total;
}

/**
 * A writer that appends only the not-yet-persisted tail of a session's event
 * log. Call `persist(session)` as often as you like; it tracks how many events
 * it has already written and appends the rest atomically (line-buffered).
 */
export interface TranscriptWriter {
  persist(session: Session): void;
  /** Count of events written so far. */
  written(): number;
}

/**
 * Create a transcript writer for a session, ensuring the directory exists.
 * `alreadyWritten` is the number of events already on disk — pass
 * `session.events.length` when RESUMING so the writer only appends the new tail
 * (otherwise it would re-append the entire prior history, corrupting the log).
 */
export function createTranscriptWriter(
  transcriptPath: string,
  sessionId: string,
  alreadyWritten = 0,
): TranscriptWriter {
  mkdirSync(dirname(transcriptPath), { recursive: true });
  let writtenCount = alreadyWritten;
  return {
    persist(session: Session): void {
      if (session.events.length <= writtenCount) return;
      let batch = '';
      for (let i = writtenCount; i < session.events.length; i += 1) {
        const entry: TranscriptEntry = {
          v: SCHEMA_VERSION,
          sessionId,
          event: session.events[i],
        };
        batch += `${JSON.stringify(entry)}\n`;
      }
      try {
        appendFileSync(transcriptPath, batch, 'utf8');
      } catch (err) {
        // The transcript file/dir can disappear mid-session (e.g. the working
        // directory was moved). Recreate the directory and retry once rather
        // than letting a persistence failure crash the whole REPL — losing
        // history is bad, but crashing the user's session mid-turn is worse.
        if ((err as { code?: string }).code === 'ENOENT') {
          mkdirSync(dirname(transcriptPath), { recursive: true });
          appendFileSync(transcriptPath, batch, 'utf8');
        } else {
          throw err;
        }
      }
      writtenCount = session.events.length;
    },
    written: () => writtenCount,
  };
}

/** Fold transcript entries back into a Session (pure). */
export function replay(
  entries: TranscriptEntry[],
  transcriptPath: string,
  cwd: string,
): Session {
  const events = entries.map((entry) => entry.event);
  const id = entries.length > 0 ? entries[0].sessionId : 'unknown';
  const createdAt = events.length > 0 ? events[0].timestamp : new Date().toISOString();
  const updatedAt =
    events.length > 0 ? events[events.length - 1].timestamp : createdAt;
  // The latest `meta` event carrying a name wins (append-only rename).
  let name: string | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'meta' && e.name) {
      name = e.name;
      break;
    }
  }
  return {
    id,
    transcriptPath,
    cwd,
    events,
    totalUsage: sumUsage(events),
    ...(name ? { name } : {}),
    createdAt,
    updatedAt,
  };
}

/** Load and rebuild a Session from a transcript file. Tolerates a corrupt/partial
 *  LAST line (a crash mid-append), but treats a corrupt line anywhere earlier as
 *  a hard error — silently dropping a mid-file event would orphan a tool_use and
 *  yield an invalid conversation on replay. */
export function loadSession(transcriptPath: string, cwd: string): Session {
  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const entries: TranscriptEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      entries.push(JSON.parse(lines[i].trim()) as TranscriptEntry);
    } catch (err) {
      if (i === lines.length - 1) break; // partial final line from a crash — ok
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Corrupt transcript ${transcriptPath} at line ${i + 1}: ${message}`,
      );
    }
  }
  return replay(entries, transcriptPath, cwd);
}

/** List saved session ids, most-recently-modified first. */
export function listSessions(paths: HarnessPaths): string[] {
  if (!existsSync(paths.sessions)) return [];
  return readdirSync(paths.sessions)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({
      id: name.slice(0, -'.jsonl'.length),
      mtime: statSync(join(paths.sessions, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.id);
}

/** Display metadata for the resume picker. */
export interface SessionSummary {
  id: string;
  /** User-given name, if any. */
  name?: string;
  /** First user message (truncated), used as a label when unnamed. */
  firstMessage: string;
  /** Number of events (a rough "size"). */
  eventCount: number;
  updatedAt: string;
}

/** First user message text in a transcript's events (for a readable label). */
function firstUserText(events: AgentEvent[]): string {
  for (const e of events) {
    if (e.type === 'user_message') {
      const text = e.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 0) return text;
    }
  }
  return '';
}

/**
 * Summaries for the most-recent sessions (default 20), newest first. Each
 * transcript is loaded tolerantly; an unreadable one is skipped rather than
 * breaking the whole list.
 */
export function listSessionSummaries(
  paths: HarnessPaths,
  limit = 20,
): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const id of listSessions(paths).slice(0, limit)) {
    try {
      const session = loadSession(transcriptPathFor(paths, id), paths.root);
      out.push({
        id,
        ...(session.name ? { name: session.name } : {}),
        firstMessage: firstUserText(session.events),
        eventCount: session.events.length,
        updatedAt: session.updatedAt,
      });
    } catch {
      // skip a corrupt/unreadable transcript
    }
  }
  return out;
}

/** Append a `meta` event renaming a session (works whether or not it's loaded). */
export function renameSession(
  paths: HarnessPaths,
  id: string,
  name: string,
): void {
  const path = transcriptPathFor(paths, id);
  if (!existsSync(path)) throw new Error(`No such session: ${id}`);
  const raw = readFileSync(path, 'utf8');
  const seq = raw.split('\n').filter((l) => l.trim().length > 0).length;
  const event: MetaEvent = {
    seq,
    type: 'meta',
    timestamp: new Date().toISOString(),
    agentId: MAIN_AGENT,
    name,
  };
  const entry: TranscriptEntry = { v: SCHEMA_VERSION, sessionId: id, event };
  const line = `${JSON.stringify(entry)}\n`;
  // The writer always terminates a line with '\n', so a file that doesn't end
  // in one is torn from a crashed append. Appending our meta line after that
  // partial line would push the torn line mid-file, where replay treats it as a
  // hard corruption error. Truncate the torn tail first, then append cleanly.
  if (raw.length > 0 && !raw.endsWith('\n')) {
    const keep = raw.slice(0, raw.lastIndexOf('\n') + 1);
    writeFileSync(path, `${keep}${line}`, 'utf8');
  } else {
    appendFileSync(path, line, 'utf8');
  }
}
