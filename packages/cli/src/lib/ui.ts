/**
 * What the terminal shows beyond plain lines: colours, symbols and the live progress line. All of
 * it is off unless the stream is a terminal, so pipes, CI logs, `--json` and tests see plain text.
 * Dependency-free on purpose: the bundle inlines what it imports.
 */

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (text: string) => (enabled && text ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  return { enabled, bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

export const plain = createStyle(false);

/** https://no-color.org and the FORCE_COLOR convention; otherwise colour only on a terminal. */
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env['NO_COLOR']) return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false';
  return isTTY && env['TERM'] !== 'dumb';
}

/** The legacy Windows console draws boxes for braille and check marks; Windows Terminal and VS Code do not. */
export function unicodeSupported(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return env['TERM'] !== 'linux';
  return Boolean(env['WT_SESSION']) || env['TERM_PROGRAM'] === 'vscode' || Boolean(env['TERM']);
}

const GOOD = /^(published|uploaded|replaced|created|updated|pulled|succeeded|passed|written|approved)$/;
const QUIET = /^(unchanged|ignored)$/;
const NOTE = /^(draft|modified|new|no-snapshot|queued|processing)$/;
const BAD = /^(failed|error|conflict)$/;

/**
 * Colours for a finished output line: the tag of a finding, the status word of a result, the rule
 * under a table header and the trailing `[code]`. Works on the text, so commands keep building
 * plain lines and scripts reading a pipe see exactly those.
 */
export function paintLine(style: Style, line: string): string {
  if (!style.enabled || !line) return line;
  if (/^[- ]+$/.test(line) && line.includes('--')) return style.dim(line);
  let text = line.replace(/(\s)(\[[a-z0-9_.-]+\])$/i, (_m, space: string, code: string) => space + style.dim(code));
  const tag = /^(error|warn |info )(\s)/.exec(text);
  if (tag) {
    const paint = tag[1] === 'error' ? style.red : tag[1] === 'warn ' ? style.yellow : style.cyan;
    return paint(tag[1]!) + text.slice(tag[1]!.length);
  }
  if (/^error: /.test(text)) return style.red('error:') + text.slice(6);
  if (/^warning: /.test(text)) return style.yellow('warning:') + text.slice(8);
  if (/^\s+(warning|breaking change)\b/.test(text)) return style.yellow(text);
  // status words stand alone: not part of a slug (`new-offer`), a path or a file name
  text = text.replace(/(?<![\w./\\-])([a-z-]+)(?![\w./\\-])/g, (word) =>
    GOOD.test(word) ? style.green(word) : BAD.test(word) ? style.red(word) : NOTE.test(word) ? style.yellow(word) : QUIET.test(word) ? style.dim(word) : word,
  );
  return text;
}

export interface Terminal {
  write(text: string): void;
  columns?: number;
}

export interface ProgressOptions {
  /** Where the live line goes: stderr when it is a terminal, else null and nothing is drawn. */
  terminal: Terminal | null;
  style: Style;
  unicode: boolean;
  total: number;
  now?: () => number;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];
/** After this long one request is slower than any healthy answer; say what the CLI is doing about it. */
const SLOW_AFTER_MS = 10_000;

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/**
 * One live line for a loop over items: a spinner, the position, what is happening and for how
 * long. It is redrawn in place and erased before anything else is printed, so it never ends up
 * in the scrollback or between result lines.
 */
export class Progress {
  private index = 0;
  private label = '';
  private doing = '';
  private since = 0;
  private frame = 0;
  private drawn = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly started: number;
  private readonly now: () => number;

  constructor(private readonly options: ProgressOptions) {
    this.now = options.now ?? Date.now;
    this.started = this.now();
  }

  /** An item is finished, with or without a live line of its own (an unchanged one has none). */
  advance(): void {
    this.index += 1;
  }

  /** Shows the item now in progress. */
  step(label: string, doing: string): void {
    this.label = label;
    this.doing = doing;
    this.since = this.now();
    if (!this.options.terminal) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.draw(), 80);
      this.timer.unref?.();
    }
    this.draw();
  }

  /** Changes what the current item is doing (`uploading`, `waiting for the render`). */
  update(doing: string): void {
    this.doing = doing;
    if (this.options.terminal) this.draw();
  }

  /** The line as drawn now, without the cursor control; exported through here for tests. */
  line(): string {
    const { style, unicode, total } = this.options;
    const frames = unicode ? FRAMES : ASCII_FRAMES;
    const waited = this.now() - this.since;
    const position = total > 1 ? `${String(Math.min(this.index + 1, total)).padStart(String(total).length)}/${total} ` : '';
    const slow = waited >= SLOW_AFTER_MS ? style.yellow(`  the API has not answered yet; Ctrl+C stops, finished items are kept`) : '';
    const sep = unicode ? '·' : '-';
    return `${style.cyan(frames[this.frame % frames.length]!)} ${style.dim(position)}${style.bold(this.label)} ${style.dim(`${sep} ${this.doing} ${formatElapsed(waited)}`)}${slow}`;
  }

  /** Erases the live line so ordinary output can follow; the next tick draws it again. */
  clear(): void {
    if (this.drawn) this.options.terminal?.write('\r\x1b[2K');
    this.drawn = false;
  }

  /** Ends the live line for good. Safe to call twice, and must run when the loop throws. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  elapsed(): number {
    return this.now() - this.started;
  }

  private draw(): void {
    const terminal = this.options.terminal;
    if (!terminal) return;
    this.frame += 1;
    terminal.write(`\r\x1b[2K${truncate(this.line(), terminal.columns ?? 80)}`);
    this.drawn = true;
  }
}

/** Cuts to the terminal width without counting escape sequences, so the line never wraps (a wrapped line cannot be erased). */
export function truncate(text: string, columns: number): string {
  const limit = Math.max(10, columns - 1);
  let visible = 0;
  let out = '';
  let cut = false;
  // eslint-disable-next-line no-control-regex
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    const chars = [...part];
    if (visible + chars.length > limit) {
      out += chars.slice(0, Math.max(0, limit - visible - 1)).join('') + '…';
      cut = true;
      break;
    }
    out += part;
    visible += chars.length;
  }
  return cut ? `${out}\x1b[0m` : out;
}

/** `14 published, 5 unchanged`: the statuses of a run in the order they first appeared. */
export function tally(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
}
