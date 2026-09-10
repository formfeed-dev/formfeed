/** Minimal line diff (LCS) for `templates diff` and `push --dry-run`; templates are small. */
export interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
}

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) {
    // too large for the table: report as whole-file replacement
    return [...x.map((t) => ({ kind: '-' as const, text: t })), ...y.map((t) => ({ kind: '+' as const, text: t }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: ' ', text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: '-', text: x[i++]! });
    else out.push({ kind: '+', text: y[j++]! });
  }
  while (i < n) out.push({ kind: '-', text: x[i++]! });
  while (j < m) out.push({ kind: '+', text: y[j++]! });
  return out;
}

/** Unified-style hunks with `context` unchanged lines around each change. */
export function formatDiff(file: string, a: string, b: string, context = 2, labels: [string, string] = ['remote', 'local']): string[] {
  const lines = diffLines(a, b);
  if (lines.every((l) => l.kind === ' ')) return [];
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind !== ' ') for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep.add(k);
  });
  const out = [`--- ${file} (${labels[0]})`, `+++ ${file} (${labels[1]})`];
  let last = -2;
  lines.forEach((l, idx) => {
    if (!keep.has(idx)) return;
    if (idx !== last + 1) out.push('@@');
    out.push(`${l.kind} ${l.text}`);
    last = idx;
  });
  return out;
}
