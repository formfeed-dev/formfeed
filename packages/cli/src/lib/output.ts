import type { Diagnostic } from '@formfeed/engine';
import { CliError, exitCodeFor } from './errors';
import { Progress, colorEnabled, createStyle, formatElapsed, paintLine, unicodeSupported, type Style, type Terminal } from './ui';

export interface Printer {
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Colours for stdout and stderr; plain unless the stream is a terminal. */
  style: Style;
  errStyle: Style;
  /** stderr when it is a terminal: where the live progress line is drawn. */
  terminal: Terminal | null;
  unicode: boolean;
}

/** Injected streams (tests, embedding) are never terminals: they get plain text and no live line. */
export function printer(
  json: boolean,
  streams: { out?: (t: string) => void; err?: (t: string) => void } = {},
  env: NodeJS.ProcessEnv = process.env,
): Printer {
  const style = createStyle(!json && !streams.out && colorEnabled(env, Boolean(process.stdout.isTTY)));
  const errStyle = createStyle(!streams.err && colorEnabled(env, Boolean(process.stderr.isTTY)));
  const terminal: Terminal | null =
    !streams.err && process.stderr.isTTY && env['TERM'] !== 'dumb' && !env['CI']
      ? { write: (t) => void process.stderr.write(t), get columns() { return process.stderr.columns; } }
      : null;
  return {
    json,
    out: streams.out ?? ((t) => process.stdout.write(paintLine(style, t) + '\n')),
    err: streams.err ?? ((t) => process.stderr.write(paintLine(errStyle, t) + '\n')),
    style,
    errStyle,
    terminal,
    unicode: unicodeSupported(env),
  };
}

/** `--json` prints the data as one JSON document; otherwise the human lines. */
export function emit(p: Printer, data: unknown, human: () => string[]): void {
  if (p.json) p.out(JSON.stringify(data, null, 2));
  else for (const line of human()) p.out(line);
}

/**
 * A loop over items whose results should be seen as they happen: the human line of an item is
 * printed when the item is done, a live line on the terminal names the one in progress, and
 * `--json` still gets one document at the end (`finish`).
 */
export interface Run<T> {
  /** Starts the next item: `label` is its name, `doing` what happens to it (`publishing`). */
  step(label: string, doing: string): void;
  update(doing: string): void;
  /** Records an item's result and prints its lines now. */
  done(result: T, lines: string[]): void;
  /** Prints the JSON document, or the closing summary line. */
  finish(data: unknown, summary?: string): void;
  /** Removes the live line; call in `finally`, so an error is not printed behind a spinner. */
  stop(): void;
  results: T[];
}

export function startRun<T>(p: Printer, total: number): Run<T> {
  const progress = new Progress({ terminal: p.terminal, style: p.errStyle, unicode: p.unicode, total });
  const results: T[] = [];
  return {
    results,
    step: (label, doing) => progress.step(label, doing),
    update: (doing) => progress.update(doing),
    done(result, lines) {
      results.push(result);
      progress.advance();
      if (p.json) return;
      progress.clear();
      for (const line of lines) p.out(line);
    },
    finish(data, summary) {
      progress.stop();
      if (p.json) p.out(JSON.stringify(data, null, 2));
      else if (summary && total > 1) p.out(p.style.dim(`${summary} in ${formatElapsed(progress.elapsed())}`));
    },
    stop: () => progress.stop(),
  };
}

export function table(rows: string[][], header?: string[]): string[] {
  const all = header ? [header, ...rows] : rows;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length))) ?? [];
  const fmt = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return lines;
}

/** One finding per line; Word and PowerPoint findings name the part and paragraph instead of a line. */
export function formatDiagnostic(file: string, d: Diagnostic & { part?: string; paragraph?: number }): string {
  const tag = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn ' : 'info ';
  const at = d.part ? `${file} › ${d.part}${d.paragraph ? ` ¶${d.paragraph}` : ''}` : `${file}:${d.range.start.line}:${d.range.start.column}`;
  return `${tag}  ${at}  ${d.message}  [${d.code}]`;
}

/** Reports an error the documented way and returns the exit code to use. */
export function reportError(p: Printer, error: unknown): number {
  const code = exitCodeFor(error);
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof CliError ? error.details : (error as { problem?: unknown }).problem;
  if (p.json) p.out(JSON.stringify({ ok: false, error: message, exit_code: code, details: details ?? null }, null, 2));
  else {
    p.err(`error: ${message}`);
    if (details && typeof details === 'object' && 'issues' in (details as object))
      for (const issue of (details as { issues: Array<{ path?: string; message: string }> }).issues)
        p.err(`  ${issue.path ? issue.path + ': ' : ''}${issue.message}`);
  }
  return code;
}
