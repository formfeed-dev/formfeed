import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../limits';
import { markdownFragment, markdownToHtml } from './convert';
import { MARKDOWN_LIMITS } from './settings';

/**
 * The inputs step 1 of plan 29 made to be slow (§2), each at the cap of a Markdown source, converted
 * within the engine's time limit. marked 18.0.11 held a CPU for seconds on 20 kB of some of them and
 * overflowed the stack on others; markdown-it grew linearly on every one, and the rules of ours on
 * top must not change that: step 1's first prototype was quadratic through one rule alone.
 *
 * Measured as the CPU time of the conversion, not the time on the clock: the engine's tests run
 * many files side by side, and beside them the clock gave `brackets` 8 s where it takes 2 s alone.
 * What the render-worker's one CPU spends on a conversion is its CPU time.
 */

const CAP = MARKDOWN_LIMITS.textBytes;

/** Milliseconds of CPU this process has spent, its own threads and the collector's included. */
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const fill = (unit: string, n: number) =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

const report = `# Quarterly report

The **third quarter** closed with revenue of 1.2 million, *up 14 %* on the year. See [the notes](#notes) and
the [figures online](https://example.test/q3).

## Highlights

- New customers in three regions
- [x] Migration finished
- [ ] Audit scheduled

| Region | Revenue | Change |
| :----- | ------: | -----: |
| North  |   480 k |   +12 % |
| South  |   410 k |         |

> Growth came from the new plans.

\`\`\`json
{ "quarter": 3, "growth": 0.14 }
\`\`\`

Footnotes help too.[^1]

[^1]: Unaudited figures.
`;

const generators: Record<string, () => string> = {
  prose: () => fill(`${report}\n\n`, CAP),
  'quote-depth': () => `${'> '.repeat((CAP - 2) / 2)}x\n`,
  'list-depth': () => {
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; ; i++) {
      const line = `${'  '.repeat(i % 1500)}- x`;
      if (size + line.length + 1 > CAP) break;
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join('\n');
  },
  'link-nest': () => `${'['.repeat(CAP / 2)}${']'.repeat(CAP / 2)}`,
  'emph-nest': () =>
    `${'*'.repeat((CAP - 2) / 2)}a${'*'.repeat((CAP - 2) / 2)}`,
  'stars-open': () => fill('*a ', CAP),
  'stars-run': () => '*'.repeat(CAP),
  'emphasis-mix': () => fill('*a**b***c _d__e___f ', CAP),
  'underscore-open': () => fill('_a ', CAP),
  brackets: () => '['.repeat(CAP),
  'link-open': () => fill('[a](', CAP),
  'image-open': () => fill('![a](', CAP),
  'backtick-open': () => fill('`a ', CAP),
  'backtick-runs': () => {
    let s = '';
    for (let i = 1; s.length < CAP; i++) s += `${'`'.repeat((i % 300) + 1)}a `;
    return s.slice(0, CAP);
  },
  lt: () => '<'.repeat(CAP),
  'tag-open': () => fill('<a ', CAP),
  'tag-kept': () => fill('<sup>a ', CAP),
  'tag-kept-closing': () =>
    `${fill('<sup>a ', CAP / 2)}${fill('</sub>', CAP / 2)}`,
  'comment-open': () => fill('<!--', CAP),
  'html-blocks': () => fill('<div>\n', CAP),
  'page-breaks': () => fill('\\newpage\n', CAP),
  'table-wide': () => {
    const cols = 2000;
    const row = (cell: string) => `|${` ${cell} |`.repeat(cols)}`;
    return [row('a'), row('-'), ...Array(120).fill(row(''))].join('\n');
  },
  'table-rows': () => `| a | b |\n| - | - |\n${fill('| c |   |\n', CAP - 20)}`,
  pipes: () => '|'.repeat(CAP),
  refdefs: () => {
    const k = Math.floor(CAP / 48);
    let s = '';
    for (let i = 0; i < k; i++) s += `[r${i}]: https://a.example/${i}\n`;
    for (let i = 0; i < k; i++) s += `[x][r${i}] `;
    return s;
  },
  'autolink-run': () => fill('https://a.example ', CAP),
  'url-run': () => `https://a.example/${'a'.repeat(CAP - 18)}`,
  entities: () => fill('&#', CAP),
  escapes: () => fill('\\*', CAP),
  'hard-breaks': () => fill('a  \n', CAP),
  setext: () => fill('a\n=\n', CAP),
  headings: () => fill('## Setup\n', CAP),
  'task-items': () => fill('- [ ] a\n', CAP),
  'long-line': () => fill('word ', CAP),
  'footnote-refs': () => `${fill('[^a] ', CAP - 13)}\n\n[^a]: note\n`,
  'front-matter': () =>
    `---\n${fill('k: v\n', 60 * 1024)}---\n${fill('word ', CAP - 61 * 1024)}`,
};

describe('slow inputs at the cap', () => {
  // A document in `safe` does every rule a fragment does and more (front matter, headings, raw
  // tags), so it is the one timed; the helper's fragment differs only in what it leaves out.
  for (const [name, generate] of Object.entries(generators)) {
    it(`${name} converts within the time limit`, async () => {
      const text = generate();
      expect(text.length).toBeLessThanOrEqual(CAP);
      const startedAt = cpuMs();
      const { html } = await markdownToHtml(text, { html: 'safe' });
      expect(cpuMs() - startedAt).toBeLessThan(defaultLimits.ms);
      expect(html.length).toBeGreaterThan(0);
    }, 30_000);
  }

  it('a fragment as well', () => {
    const startedAt = cpuMs();
    markdownFragment(generators['brackets']!(), { html: 'allow' });
    expect(cpuMs() - startedAt).toBeLessThan(defaultLimits.ms);
  }, 30_000);
});
