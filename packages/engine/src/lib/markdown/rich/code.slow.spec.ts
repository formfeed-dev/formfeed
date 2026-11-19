import { describe, expect, it } from 'vitest';
import { defaultLimits } from '../../limits';
import { markdownToHtml } from '../convert';
import { MARKDOWN_LIMITS } from '../settings';
import { HIGHLIGHT_LANGUAGES, richMarkdown } from './index';

/**
 * Code made to be slow (plan 33, step 1, §3), at the caps of decision 3, converted within the
 * engine's time limit. highlight.js's `markdown` and `yaml` grammars took 14.5 s on one line of
 * 100 kB; the line cap keeps every language linear, and the budget keeps the slowest linear one,
 * 5.7 ms a kB, to about a second and a half. A language added to the list is held here with the
 * others; a cap raised fails here first.
 *
 * Measured as the CPU time of the conversion, as `convert.slow.spec.ts` measures, because the
 * engine's tests run side by side and the clock counts the others' time too.
 */

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const fill = (unit: string, n: number) =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** Step 1's sixteen shapes of slow input, each `n` characters long. */
const SHAPES: Record<string, (n: number) => string> = {
  'unclosed "': (n) => `"${fill('a b ', n - 1)}`,
  "unclosed '": (n) => `'${fill('a b ', n - 1)}`,
  'unclosed `': (n) => `\`${fill('a ${b} ', n - 1)}`,
  'unclosed /*': (n) => `/*${fill('a * b ', n - 2)}`,
  'unclosed <!--': (n) => `<!--${fill('a - b ', n - 4)}`,
  'unclosed """': (n) => `"""${fill('a " b ', n - 3)}`,
  'nested (': (n) => fill('(', n),
  'nested {': (n) => fill('{', n),
  'nested [': (n) => fill('[', n),
  'tags <a': (n) => fill('<a ', n),
  'heredoc <<': (n) => `<<EOF\n${fill('a $b\n', n - 6)}`,
  backslashes: (n) => fill('\\', n),
  'dollars $(': (n) => fill('$(', n),
  'colons a:': (n) => fill('a: ', n),
  'hash #{': (n) => fill('#{', n),
  mixed: (n) => fill('"/*<!--`({[ ', n),
};

/** `bytes` of ASCII code in lines of `width` characters at most, ending in a line break. */
const lines = (text: string, bytes: number, width: number) => {
  let out = '';
  for (let i = 0; out.length < bytes; i += width)
    out += `${text.slice(i, i + width)}\n`;
  return `${out.slice(0, bytes - 1)}\n`;
};

/** A fence of tildes, which none of the shapes holds, so none closes it early. */
const fence = (language: string, code: string) =>
  `~~~~~ ${language}\n${code}~~~~~\n`;

const { highlightBytes, highlightBlockBytes, highlightLineLength } =
  MARKDOWN_LIMITS;

async function timed(text: string, language: string) {
  const startedAt = cpuMs();
  const { html } = await markdownToHtml(text, {
    html: 'safe',
    highlight: true,
    rich: richMarkdown(),
  });
  const ms = cpuMs() - startedAt;
  const coloured = html.split(`class="hljs language-${language}"`).length - 1;
  return { ms, coloured };
}

describe('slow code at the caps', () => {
  // every shape in every language, the budget spent on them in blocks of 16,000 bytes, in lines
  // of the longest length that is still coloured
  const size = 16_000;
  for (const language of HIGHLIGHT_LANGUAGES) {
    it(`${language}: every shape converts within the time limit`, async () => {
      const text = Object.values(SHAPES)
        .map((shape) =>
          fence(language, lines(shape(size), size, highlightLineLength)),
        )
        .join('\n');
      const { ms, coloured } = await timed(text, language);
      // all of them coloured, so the time is the highlighter's
      expect(coloured).toBe(Object.keys(SHAPES).length);
      expect(16 * size).toBeLessThanOrEqual(highlightBytes);
      expect(ms).toBeLessThan(defaultLimits.ms);
    }, 30_000);
  }

  // the slowest pairs of step 1, the whole budget in three blocks under the block cap
  const block = Math.floor(highlightBytes / 3);
  const worst: Array<[string, string, number]> = [
    ['ruby', 'nested (', 80],
    ['markdown', 'nested [', highlightLineLength],
    ['markdown', 'mixed', highlightLineLength],
    ['yaml', 'unclosed /*', highlightLineLength],
    ['yaml', 'unclosed <!--', highlightLineLength],
  ];
  for (const [language, shape, width] of worst) {
    it(`${language}, ${shape}, lines of ${width}: the whole budget within the time limit`, async () => {
      expect(block).toBeLessThanOrEqual(highlightBlockBytes);
      const code = lines(SHAPES[shape]!(block), block, width);
      const text = [code, code, code].map((c) => fence(language, c)).join('\n');
      const { ms, coloured } = await timed(text, language);
      expect(coloured).toBe(3);
      expect(ms).toBeLessThan(defaultLimits.ms);
    }, 30_000);
  }

  // The slowest code in a document at the text cap: about 1.3 s of CPU on a laptop on 2026-11-19,
  // 0.3 s with highlighting off. Beside markdown-it's slowest text instead of prose (1 MB of `[`,
  // `convert.slow.spec.ts`), which takes 2 s alone, it took 3.3 to 3.8 s: under the limit, with too
  // little room for a test on a slower machine, so that pair is a measurement, not a test.
  it('a document at the text cap: the slowest code within its prose', async () => {
    const code = lines(SHAPES['nested (']!(block), block, 80);
    const head = [code, code, code].map((c) => fence('ruby', c)).join('\n');
    const prose = fill(
      'The **third quarter** closed with revenue of 1.2 million, *up 14 %* on the year. See [the notes](#notes).\n\n',
      MARKDOWN_LIMITS.textBytes - head.length - 1,
    );
    const text = `${head}\n${prose}`;
    expect(text.length).toBeLessThanOrEqual(MARKDOWN_LIMITS.textBytes);
    const { ms, coloured } = await timed(text, 'ruby');
    expect(coloured).toBe(3);
    expect(ms).toBeLessThan(defaultLimits.ms);
  }, 30_000);
});
