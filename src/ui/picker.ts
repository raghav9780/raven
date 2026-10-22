/**
 * picker.ts — a zero-dependency interactive list selector (↑/↓/Enter, Esc/Ctrl+C
 * to cancel) built on node:readline keypress + raw mode. Used for choosing a
 * model at startup and via /model. Restores the terminal (raw mode + cursor) on
 * every exit path and erases its own region so only the outcome remains.
 *
 * Non-TTY safe: returns the default selection without touching raw mode (which
 * throws on a non-TTY), so scripted/piped runs never break.
 */

import { emitKeypressEvents } from 'node:readline';
import { C, paint } from './render.ts';

/** Minimal shape of a readline keypress descriptor (node:readline). */
interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export interface PickOptions<T> {
  /** Heading shown above the list. */
  title?: string;
  /** Render one item to a single-line label. */
  render: (item: T, index: number) => string;
  /** Initially highlighted index (default 0). */
  selected?: number;
}

/**
 * Present `items` and resolve the chosen one (or null if cancelled / empty).
 */
export function pick<T>(items: T[], opts: PickOptions<T>): Promise<T | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (items.length === 0) return Promise.resolve(null);
  const start = Math.min(Math.max(opts.selected ?? 0, 0), items.length - 1);
  if (!stdin.isTTY) return Promise.resolve(items[start] ?? null);

  return new Promise<T | null>((resolve) => {
    let index = start;
    let rendered = 0;
    const title = opts.title ?? 'Select';

    const draw = (): void => {
      if (rendered > 0) stdout.write(`\x1b[${rendered}A`); // back to top of region
      let lines = 0;
      const line = (s: string): void => {
        stdout.write(`\x1b[2K${s}\n`); // clear line, then write
        lines += 1;
      };
      line(paint(title, C.bold));
      items.forEach((item, i) => {
        const label = opts.render(item, i);
        line(
          i === index
            ? paint(`❯ ${label}`, C.cyan)
            : `  ${paint(label, C.dim)}`,
        );
      });
      line(paint('↑/↓ move · Enter select · Esc cancel', C.gray));
      rendered = lines;
    };

    const restore = (): void => {
      stdin.removeListener('keypress', onKey);
      try {
        if (stdin.isTTY) stdin.setRawMode(false);
      } catch {
        // ignore
      }
      // Pause the stream so we hand back a deterministic state: whoever runs
      // next (the line editor's next read, via withPicker.resume) re-arms raw
      // mode + listeners itself. Leaving it flowing let the editor and the
      // readline keypress decoder contend for stdin (the freeze).
      stdin.pause();
      stdout.write('\x1b[?25h'); // show cursor
    };

    const finish = (result: T | null): void => {
      restore();
      if (rendered > 0) {
        stdout.write(`\x1b[${rendered}A\x1b[0J`); // erase the whole picker region
      }
      resolve(result);
    };

    const onKey = (_str: string | undefined, key: Key | undefined): void => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + items.length) % items.length;
        draw();
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % items.length;
        draw();
      } else if (key.name === 'return' || key.name === 'enter') {
        finish(items[index]);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
      }
    };

    emitKeypressEvents(stdin);
    try {
      stdin.setRawMode(true);
    } catch {
      // extremely rare; fall back to the default
      resolve(items[start] ?? null);
      return;
    }
    stdin.resume();
    stdout.write('\x1b[?25l'); // hide cursor
    draw();
    stdin.on('keypress', onKey);
  });
}
