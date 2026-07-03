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
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentEvent,
  HarnessPaths,
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

/** Create a transcript writer for a session, ensuring the directory exists. */
export function createTranscriptWriter(
  transcriptPath: string,
  sessionId: string,
): TranscriptWriter {
  mkdirSync(dirname(transcriptPath), { recursive: true });
  let writtenCount = 0;
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
      appendFileSync(transcriptPath, batch, 'utf8');
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
  return {
    id,
    transcriptPath,
    cwd,
    events,
    totalUsage: sumUsage(events),
    createdAt,
    updatedAt,
  };
}

/** Load and rebuild a Session from a transcript file. */
export function loadSession(transcriptPath: string, cwd: string): Session {
  const raw = readFileSync(transcriptPath, 'utf8');
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // skip a corrupt trailing/partial line (crash-safety)
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
