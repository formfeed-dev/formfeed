import type { Diagnostic } from '@formfeed/engine';
import { CliError, exitCodeFor } from './errors';

export interface Printer {
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

export function printer(json: boolean, streams: { out?: (t: string) => void; err?: (t: string) => void } = {}): Printer {
  return {
    json,
    out: streams.out ?? ((t) => process.stdout.write(t + '\n')),
    err: streams.err ?? ((t) => process.stderr.write(t + '\n')),
  };
}

/** `--json` prints the data as one JSON document; otherwise the human lines. */
export function emit(p: Printer, data: unknown, human: () => string[]): void {
  if (p.json) p.out(JSON.stringify(data, null, 2));
  else for (const line of human()) p.out(line);
}

export function table(rows: string[][], header?: string[]): string[] {
  const all = header ? [header, ...rows] : rows;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length))) ?? [];
  const fmt = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));
  return lines;
}

export function formatDiagnostic(file: string, d: Diagnostic): string {
  const tag = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn ' : 'info ';
  return `${tag}  ${file}:${d.range.start.line}:${d.range.start.column}  ${d.message}  [${d.code}]`;
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
