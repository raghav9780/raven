/**
 * input.ts — a small raw-mode line editor for the REPL prompt, giving a clean
 * Claude-Code-style input: Enter submits, Shift/Alt+Enter inserts a newline, and
 * a PASTE (even multi-line) is inserted as literal text instead of firing a
 * submit per line. node:readline has none of this — it treats every `\n` as
 * Enter, so pasting a multi-line block auto-submits each line. We enable the
 * terminal's bracketed-paste mode and drive the buffer ourselves.
 *
 * Structure (kept testable): two PURE cores —
 *   - parseChunk(): raw bytes → high-level Key events (handles escape sequences
 *     and bracketed paste, tolerant of sequences split across chunks).
 *   - applyKey():  (buffer state, Key) → new state + optional action.
 * The IO layer (raw mode, render, history) wraps them. Non-TTY input never
 * touches this file — the REPL keeps its readline path for pipes/scripts.
 */

/** A logical key/edit event produced by parseChunk. */
export type Key =
  | { type: 'text'; value: string } // printable input (or pasted block)
  | { type: 'submit' } // Enter
  | { type: 'newline' } // Shift/Alt+Enter → insert '\n'
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'kill' } // Ctrl+U — clear the whole buffer
  | { type: 'interrupt' } // Ctrl+C
  | { type: 'eof' }; // Ctrl+D on an empty buffer

/** Editor buffer: the text and the cursor index (0..text.length). */
export interface Buffer {
  text: string;
  cursor: number;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Clean a pasted block before it enters the buffer. Terminals (notably Windows
 * Terminal) send line breaks inside a paste as `\r\n` or a lone `\r`; inserted
 * literally, a `\r` makes the terminal snap the cursor to column 0 mid-render
 * (garbled text) and desyncs the pure `layout()` from the real screen (the box
 * then overlaps the transcript). Normalize newlines to `\n` and drop other C0
 * control chars and DEL, keeping only `\n` (0x0A). Tabs are expanded to spaces
 * because `layout()` counts one column per char while a terminal renders a tab
 * up to 8 wide — a literal tab would desync the framed box on a pasted code
 * block. Expanding keeps display and layout in agreement.
 */
const PASTE_TAB = '    '; // 4 spaces
export function sanitizePaste(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, PASTE_TAB)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Longest k (< marker.length) such that `s` ends with marker.slice(0, k). */
function partialSuffixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Turn a raw input chunk into Key events. `pending` carries an incomplete
 * escape/paste sequence from a previous chunk; the returned `pending` carries
 * any new incomplete tail. Printable runs are coalesced into one `text` key.
 */
export function parseChunk(
  pending: string,
  chunk: string,
  inPaste: boolean,
): { keys: Key[]; pending: string; inPaste: boolean } {
  let s = pending + chunk;
  const keys: Key[] = [];
  let text = '';
  const flush = (): void => {
    if (text.length > 0) {
      keys.push({ type: 'text', value: text });
      text = '';
    }
  };

  let i = 0;
  while (i < s.length) {
    // Inside a bracketed paste: accumulate literally until the end marker.
    if (inPaste) {
      const end = s.indexOf(PASTE_END, i);
      if (end === -1) {
        // No end marker yet. Emit everything except a possible PARTIAL end
        // marker at the tail (which could complete on the next chunk); hold
        // that partial in `pending` and stay in paste mode.
        let hold = partialSuffixLen(s.slice(i), PASTE_END);
        // If not holding a partial marker but the tail is a lone CR, hold it:
        // it may be the '\r' of a '\r\n' split across chunks, which would
        // otherwise sanitize to two separate newlines. (PASTE_END has no CR, so
        // this never conflicts with marker detection.)
        if (hold === 0 && s.endsWith('\r')) hold = 1;
        text += sanitizePaste(s.slice(i, s.length - hold));
        flush();
        return { keys, pending: s.slice(s.length - hold), inPaste: true };
      }
      text += sanitizePaste(s.slice(i, end));
      i = end + PASTE_END.length;
      inPaste = false;
      continue;
    }

    const ch = s[i];

    // A lone ESC may begin a sequence that's split across chunks — if it's at
    // the very end, hold it as pending and wait for more bytes.
    if (ch === '\x1b') {
      const rest = s.slice(i);
      if (PASTE_START.startsWith(rest) && rest.length < PASTE_START.length) {
        flush();
        return { keys, pending: rest, inPaste };
      }
      if (rest.startsWith(PASTE_START)) {
        flush();
        inPaste = true;
        i += PASTE_START.length;
        continue;
      }
      // Alt+Enter → newline.
      if (rest[1] === '\r' || rest[1] === '\n') {
        flush();
        keys.push({ type: 'newline' });
        i += 2;
        continue;
      }
      // CSI sequences: ESC [ ...
      if (rest[1] === '[') {
        const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
        if (!m) {
          // Incomplete CSI at end of buffer → wait for more.
          if (i + rest.length === s.length) {
            flush();
            return { keys, pending: rest, inPaste };
          }
          i += 1; // malformed; skip the ESC
          continue;
        }
        flush();
        const [seq, params, final] = m;
        keys.push(csiToKey(params, final));
        i += seq.length;
        continue;
      }
      // Lone ESC (or unhandled) — drop it.
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      flush();
      keys.push({ type: 'submit' });
      i += 1;
      // Swallow a paired \r\n so it doesn't submit twice.
      if (ch === '\r' && s[i] === '\n') i += 1;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      flush();
      keys.push({ type: 'backspace' });
      i += 1;
      continue;
    }
    if (ch === '\x03') {
      flush();
      keys.push({ type: 'interrupt' });
      i += 1;
      continue;
    }
    if (ch === '\x04') {
      flush();
      keys.push({ type: 'eof' });
      i += 1;
      continue;
    }
    if (ch === '\x15') {
      flush();
      keys.push({ type: 'kill' });
      i += 1;
      continue;
    }
    if (ch === '\x01') {
      flush();
      keys.push({ type: 'home' });
      i += 1;
      continue;
    }
    if (ch === '\x05') {
      flush();
      keys.push({ type: 'end' });
      i += 1;
      continue;
    }
    // Other control chars (tab, etc.) are ignored; printable chars accumulate.
    if (ch >= ' ') text += ch;
    i += 1;
  }
  flush();
  s = '';
  return { keys, pending: '', inPaste };
}

/** Map a CSI sequence (params + final letter) to a Key. */
function csiToKey(params: string, final: string): Key {
  switch (final) {
    case 'A':
      return { type: 'up' };
    case 'B':
      return { type: 'down' };
    case 'C':
      return { type: 'right' };
    case 'D':
      return { type: 'left' };
    case 'H':
      return { type: 'home' };
    case 'F':
      return { type: 'end' };
    case 'u':
      // Kitty/modifyOtherKeys: `13;2u` = Shift+Enter → newline.
      if (params === '13;2' || params === '13;5') return { type: 'newline' };
      return { type: 'text', value: '' };
    case '~':
      if (params === '1' || params === '7') return { type: 'home' };
      if (params === '4' || params === '8') return { type: 'end' };
      if (params === '3') return { type: 'delete' };
      return { type: 'text', value: '' };
    default:
      return { type: 'text', value: '' };
  }
}

/** Visible length of a string, ignoring ANSI SGR color codes. */
export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export interface Layout {
  /** Row (0-based, from the prompt line) where the cursor sits. */
  cursorRow: number;
  /** Column (0-based) where the cursor sits. */
  cursorCol: number;
  /** Row index of the last row the content occupies. */
  endRow: number;
}

/**
 * Compute where the cursor lands and how many rows the input occupies, given a
 * prompt width, the buffer text (may contain '\n'), the cursor index, and the
 * terminal width. Logical newlines re-indent to the prompt width; a line longer
 * than the terminal wraps to column 0. Pure + width-aware so it can be tested
 * without a terminal.
 */
export function layout(
  promptWidth: number,
  text: string,
  cursor: number,
  width: number,
): Layout {
  const w = Math.max(1, width);
  let row = 0;
  let col = promptWidth;
  let cursorRow = 0;
  let cursorCol = promptWidth;
  for (let j = 0; j <= text.length; j += 1) {
    // A printable char about to overflow the line wraps to the next row, col 0.
    if (j < text.length && text[j] !== '\n' && col >= w) {
      row += 1;
      col = 0;
    }
    if (j === cursor) {
      cursorRow = row;
      cursorCol = col;
    }
    if (j === text.length) break;
    if (text[j] === '\n') {
      row += 1;
      col = promptWidth; // continuation lines align under the prompt
    } else {
      col += 1;
    }
  }
  return { cursorRow, cursorCol, endRow: row };
}

/** Apply one key to the buffer; returns the new buffer and an optional action. */
export function applyKey(
  buf: Buffer,
  key: Key,
): { buf: Buffer; action?: 'submit' | 'interrupt' | 'eof' | 'history-prev' | 'history-next' } {
  const { text, cursor } = buf;
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  switch (key.type) {
    case 'text':
      if (key.value.length === 0) return { buf };
      return { buf: { text: before + key.value + after, cursor: cursor + key.value.length } };
    case 'newline':
      return { buf: { text: `${before}\n${after}`, cursor: cursor + 1 } };
    case 'submit':
      // Backslash-continuation: a trailing "\" immediately before the cursor
      // turns Enter into a newline instead of a submit. This is the universal
      // fallback for terminals that send Shift+Enter as a plain Enter (most of
      // them, incl. Windows Terminal by default), where the two are otherwise
      // indistinguishable. Removes the "\" and inserts "\n" (net cursor 0).
      if (before.endsWith('\\')) {
        return { buf: { text: `${before.slice(0, -1)}\n${after}`, cursor } };
      }
      return { buf, action: 'submit' };
    case 'backspace':
      if (cursor === 0) return { buf };
      return { buf: { text: text.slice(0, cursor - 1) + after, cursor: cursor - 1 } };
    case 'delete':
      if (cursor >= text.length) return { buf };
      return { buf: { text: before + text.slice(cursor + 1), cursor } };
    case 'left':
      return { buf: { text, cursor: Math.max(0, cursor - 1) } };
    case 'right':
      return { buf: { text, cursor: Math.min(text.length, cursor + 1) } };
    case 'home':
      return { buf: { text, cursor: 0 } };
    case 'end':
      return { buf: { text, cursor: text.length } };
    case 'kill':
      return { buf: { text: '', cursor: 0 } };
    case 'up':
      return { buf, action: 'history-prev' };
    case 'down':
      return { buf, action: 'history-next' };
    case 'interrupt':
      return { buf, action: 'interrupt' };
    case 'eof':
      return { buf, action: 'eof' };
    default:
      return { buf };
  }
}

// ── IO layer ─────────────────────────────────────────────────────────────────

/** Sentinel resolved when the input stream reaches EOF (Ctrl+D on empty). */
export const INPUT_EOF = '\x00__EOF__';

/** Options for a single `read`. */
export interface ReadOptions {
  /**
   * Draw the input inside a bottom-anchored frame: a horizontal rule above and
   * below, plus a dim hint line. Used for the main REPL prompt; inline
   * sub-prompts (permission reason, rename) leave this off for a plain line.
   */
  frame?: boolean;
  /** Dim hint shown under the frame (e.g. "↑/↓ history · Shift+Enter newline"). */
  hint?: string;
}

/**
 * A live keyboard watch for Esc / Ctrl+C, used to abort a running turn. Owns raw
 * mode while active. `suspend`/`resume` let a nested interactive prompt take over
 * stdin without this watch also consuming those keys; `stop` tears it down.
 */
export interface AbortWatch {
  /** Remove the key listener (a nested prompt is taking stdin). Idempotent. */
  suspend(): void;
  /** Re-enable raw mode and the key listener after a suspend. Idempotent. */
  resume(): void;
  /** Tear down: remove the listener and drop raw mode. Idempotent. */
  stop(): void;
}

export interface LineEditor {
  /** Prompt for one logical line (may span newlines); resolves on submit. */
  read(promptText: string, opts?: ReadOptions): Promise<string>;
  /**
   * Watch the keyboard for Esc / Ctrl+C and invoke `onAbort` on either. Used
   * between reads (while a turn runs) to implement "press Esc to stop". Returns
   * an {@link AbortWatch} the caller stops when the turn ends. No-op (all methods
   * present, inert) on a non-TTY stream.
   */
  watchAbort(onAbort: () => void): AbortWatch;
  /**
   * Release stdin so a nested interactive reader (the arrow-key picker) can own
   * it: drop raw/paste mode and pause the stream. Call before `pick()`; pair
   * with {@link resume}. Idempotent. No-op on a non-TTY stream.
   */
  suspend(): void;
  /** Reclaim stdin after the nested reader is done (the next `read()` re-arms
   *  raw mode + listeners). Idempotent. No-op on a non-TTY stream. */
  resume(): void;
  /** Restore the terminal (raw mode off, paste mode off). Idempotent. */
  close(): void;
}

/**
 * A raw-mode multiline line editor over stdin/stdout. Enter submits;
 * Shift/Alt+Enter inserts a newline; a paste (even multi-line) is inserted as
 * literal text without submitting. `onInterrupt` handles Ctrl+C (return 'exit'
 * to resolve the read as EOF, 'continue' to clear the line and keep editing).
 */
export function createLineEditor(deps: {
  onInterrupt: () => 'exit' | 'continue';
  history: string[];
}): LineEditor {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let closed = false;

  const termWidth = (): number =>
    typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : 80;

  function close(): void {
    if (closed) return;
    closed = true;
    stdout.write('\x1b[?2004l'); // disable bracketed paste
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
  }

  function watchAbort(onAbort: () => void): AbortWatch {
    if (!stdin.isTTY) return { suspend() {}, resume() {}, stop() {} };
    const onKey = (chunk: string): void => {
      // A lone ESC is a stop; multi-byte `\x1b[…` sequences (arrows etc.) are
      // ignored so they don't false-trigger. Ctrl+C anywhere in the chunk stops.
      const isEsc = chunk === '\x1b' || chunk === '\x1b\x1b';
      if (isEsc || chunk.includes('\x03')) onAbort();
    };
    let stopped = false;
    const resume = (): void => {
      if (stopped) return; // a stopped watch stays stopped
      try {
        stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.removeListener('data', onKey); // idempotent: never double-attach
      stdin.on('data', onKey);
    };
    const suspend = (): void => void stdin.removeListener('data', onKey);
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      suspend();
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    };
    resume();
    return { suspend, resume, stop };
  }

  /** Wrap text in ANSI "dim" without disturbing other attributes. */
  const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`;
  /** Truncate plain text to at most n visible chars. */
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

  function read(promptText: string, opts?: ReadOptions): Promise<string> {
    return new Promise<string>((resolve) => {
      const promptWidth = visibleLen(promptText);
      const frame = opts?.frame ?? false;
      const hintText = opts?.hint ?? '';
      let buf: Buffer = { text: '', cursor: 0 };
      let pending = '';
      let inPaste = false;
      let lastCursorRow = 0; // where the terminal cursor sits, rows below start
      let histIndex = deps.history.length; // points past the end (current draft)
      let draft = '';

      stdout.write('\x1b[?2004h'); // enable bracketed paste
      try {
        if (stdin.isTTY) stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.resume();
      stdin.setEncoding('utf8');

      const indentFor = (): string => ' '.repeat(promptWidth);

      // Plain (inline sub-prompt) render: prompt + text, no frame.
      const renderPlain = (): void => {
        const width = termWidth();
        if (lastCursorRow > 0) stdout.write(`\x1b[${lastCursorRow}A`);
        stdout.write('\r\x1b[0J');
        const shown = buf.text.split('\n').join(`\n${indentFor()}`);
        stdout.write(promptText + shown);
        const l = layout(promptWidth, buf.text, buf.cursor, width);
        const up = l.endRow - l.cursorRow;
        if (up > 0) stdout.write(`\x1b[${up}A`);
        stdout.write('\r');
        if (l.cursorCol > 0) stdout.write(`\x1b[${l.cursorCol}C`);
        lastCursorRow = l.cursorRow;
      };

      // Framed render: a rule above and below the input plus a dim hint line, a
      // bottom-anchored box redrawn in place on every keystroke.
      const renderFramed = (): void => {
        const width = termWidth();
        const l = layout(promptWidth, buf.text, buf.cursor, width);
        // Jump to the top of the previously-drawn block and clear it.
        if (lastCursorRow > 0) stdout.write(`\x1b[${lastCursorRow}A`);
        stdout.write('\r\x1b[0J');
        // One short of full width: a rule filling the last column would trip the
        // terminal's auto-wrap and add a phantom row, desyncing the cursor math.
        const ruleW = Math.max(1, width - 1);
        const rule = dim('─'.repeat(ruleW));
        const shown = buf.text.split('\n').join(`\n${indentFor()}`);
        const hint = hintText ? dim(clip(hintText, ruleW)) : '';
        // top rule ⏎ prompt+text ⏎ bottom rule [⏎ hint]. '\n' is CRLF under the
        // terminal's output post-processing, so continuation lines reset to col 0.
        let block = `${rule}\n${promptText}${shown}\n${rule}`;
        if (hint) block += `\n${hint}`;
        stdout.write(block);
        // Block rows (0-based): 0 = top rule; 1..inputRows = input; then bottom
        // rule; then optional hint. Reposition the cursor into the input region.
        const inputRows = l.endRow + 1;
        const bottomRow = 1 + inputRows + (hint ? 1 : 0);
        const targetRow = 1 + l.cursorRow;
        const up = bottomRow - targetRow;
        if (up > 0) stdout.write(`\x1b[${up}A`);
        stdout.write('\r');
        if (l.cursorCol > 0) stdout.write(`\x1b[${l.cursorCol}C`);
        lastCursorRow = targetRow;
      };

      const render = (): void => (frame ? renderFramed() : renderPlain());

      const finish = (value: string): void => {
        stdin.removeListener('data', onData);
        if (frame) {
          // Erase the whole framed block, then leave just the submitted line in
          // scrollback (or nothing on EOF) so history stays clean.
          if (lastCursorRow > 0) stdout.write(`\x1b[${lastCursorRow}A`);
          stdout.write('\r\x1b[0J');
          if (value !== INPUT_EOF) {
            const shown = buf.text.split('\n').join(`\n${indentFor()}`);
            stdout.write(`${promptText}${shown}\n`);
          }
        } else {
          // Move to end of content and drop to a fresh line.
          const l = layout(promptWidth, buf.text, buf.text.length, termWidth());
          const down = l.endRow - lastCursorRow;
          if (down > 0) stdout.write(`\x1b[${down}B`);
          stdout.write('\r\n');
        }
        // Drop raw/paste mode when a read ends. The editor owns raw mode both
        // while reading and, between reads, via watchAbort (which re-enables it
        // during a running turn to watch for Esc/Ctrl+C). Ending a read leaves it
        // off until the next read() or watchAbort().
        stdout.write('\x1b[?2004l');
        try {
          if (stdin.isTTY) stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      const onData = (chunk: string): void => {
        const r = parseChunk(pending, chunk, inPaste);
        pending = r.pending;
        inPaste = r.inPaste;
        for (const key of r.keys) {
          const res = applyKey(buf, key);
          buf = res.buf;
          if (res.action === 'submit') {
            finish(buf.text);
            return;
          }
          if (res.action === 'eof') {
            if (buf.text.length === 0) {
              finish(INPUT_EOF);
              return;
            }
            continue; // Ctrl+D with text is ignored
          }
          if (res.action === 'interrupt') {
            const decision = deps.onInterrupt();
            if (decision === 'exit') {
              finish(INPUT_EOF);
              return;
            }
            buf = { text: '', cursor: 0 };
            continue;
          }
          if (res.action === 'history-prev') {
            if (histIndex > 0) {
              if (histIndex === deps.history.length) draft = buf.text;
              histIndex -= 1;
              buf = { text: deps.history[histIndex], cursor: deps.history[histIndex].length };
            }
            continue;
          }
          if (res.action === 'history-next') {
            if (histIndex < deps.history.length) {
              histIndex += 1;
              const t = histIndex === deps.history.length ? draft : deps.history[histIndex];
              buf = { text: t, cursor: t.length };
            }
            continue;
          }
        }
        render();
      };

      render();
      stdin.on('data', onData);
    });
  }

  /** Hand stdin to a nested reader (the picker): drop raw/paste mode, pause. */
  function suspend(): void {
    if (!stdin.isTTY) return;
    stdout.write('\x1b[?2004l'); // disable bracketed paste
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    stdin.pause();
  }

  /** Reclaim stdin after the nested reader; the next read() re-arms the rest. */
  function resume(): void {
    if (!stdin.isTTY) return;
    stdin.resume();
  }

  return { read, watchAbort, suspend, resume, close };
}
