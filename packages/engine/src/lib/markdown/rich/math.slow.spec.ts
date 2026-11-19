import { describe, expect, it } from 'vitest';
import { MarkdownSyntaxError, RenderLimitError } from '../../errors';
import { defaultLimits } from '../../limits';
import { markdownToHtml } from '../convert';
import { MARKDOWN_LIMITS, utf8Bytes } from '../settings';
import { richMarkdown } from './index';

/**
 * Formulas made to be slow (plan 33, steps 1 and 3), at the cap of a Markdown source, within the
 * engine's time limit. The rules: step 1's shapes for the dollar rules, on which the plugin they are
 * modelled on grew linearly but for a `$$` never closed (41 s at 300 kB), and the shapes that make a
 * rule look ahead again and again. The typesetter: KaTeX's most expensive formulas of 4 kB, as many
 * as the document's 256 kB of TeX hold; its text mode grows faster than its input, which is what that
 * budget is for. A document past a limit fails, which is an answer too; what is timed is the time
 * to it.
 *
 * Measured as the CPU time of the conversion, as `convert.slow.spec.ts` measures.
 */

const CAP = MARKDOWN_LIMITS.textBytes;
const rich = richMarkdown();

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
const fill = (unit: string, n: number) =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** Converts with formulas on; the HTML's length, or the name of the limit it stopped at. */
async function timed(text: string): Promise<{ ms: number; outcome: string }> {
  const startedAt = cpuMs();
  const outcome = await markdownToHtml(text, {
    html: 'safe',
    math: true,
    rich,
  }).then(
    ({ html }) => `${html.length} characters`,
    (e: unknown) => {
      if (e instanceof MarkdownSyntaxError) return `refused: ${e.message}`;
      if (e instanceof RenderLimitError) return `limit: ${e.message}`;
      throw e;
    },
  );
  return { ms: cpuMs() - startedAt, outcome };
}

/** The rules' shapes, each a whole document at the cap. */
const RULES: Record<string, () => string> = {
  // step 1's
  '$a repeated': () => fill('$a ', CAP),
  '$ then text': () => `$${fill('a b ', CAP - 1)}`,
  '$` never closed': () => `$\`${fill('a b ', CAP - 2)}`,
  '\\$ repeated': () => fill('\\$', CAP),
  '$5 and $10': () => fill('$5 and $10 ', CAP),
  '$$ lines': () => fill('$$\n', CAP),
  '$x$ repeated': () => fill('$x$ ', CAP),
  '$$ never closed': () => `$$\n${fill('a b\n', CAP - 3)}`,
  // what makes a rule look ahead once per opener
  '$` repeated': () => fill('$`a ', CAP),
  '$` and ` repeated': () => fill('$`a` ', CAP),
  'escaped dollars after $': () => `$a${fill('\\$', CAP - 2)}`,
  'backslashes before $': () => `$a${fill('\\', CAP - 3)}$`,
  '$ then spaces': () => fill('$ ', CAP),
  '$$ text lines': () => fill('$$ a\n', CAP),
  '$$x$$ lines': () => fill('$$x$$\n', CAP),
  '$$ in a list': () => `- $$\n${fill('  a\n', CAP - 5)}`,
  '$$ in quotes': () => fill('> $$\n', CAP),
  'dollar runs': () => fill('$$$ ', CAP),
  mixed: () => fill('$a $`b $$ \\$ $5 `$ $$c$$ ', CAP),
  'one paragraph of formulas over lines': () => fill('$x\ny$ ', CAP),
  'math fences': () => fill('```math\nx\n```\n', CAP),
  'math fences never closed': () => `\`\`\`math\n${fill('x\n', CAP - 9)}`,
};

/** A formula of `bytes` of TeX at most, of the shape `unit` repeated. */
const formulaOf = (unit: string, bytes = MARKDOWN_LIMITS.formulaBytes) =>
  unit.repeat(Math.floor(bytes / utf8Bytes(unit)));

/** KaTeX's most expensive formulas of 4 kB, measured in step 3; each fills a document's budget. */
const TYPESET: Record<string, string> = {
  'text words': `\\text{${'word '.repeat(800)}}`,
  'mathrm words': `\\mathrm{${'word '.repeat(800)}}`,
  'a+': formulaOf('a+'),
  'matrix 30 by 30': `\\begin{matrix}${Array.from({ length: 30 }, () => Array(30).fill('a').join('&')).join('\\\\')}\\end{matrix}`,
  integrals: formulaOf('\\int_0^1 f(x)\\,dx'),
  aligned: `\\begin{aligned}${formulaOf('a&=b\\\\', 4000)}\\end{aligned}`,
  cases: `\\begin{cases}${formulaOf('a&b\\\\', 4000)}\\end{cases}`,
  sums: formulaOf('\\sum_{i=1}^{n}'),
  'operator names': formulaOf('\\operatorname{foo}'),
  'nested sqrt': `${'\\sqrt{'.repeat(300)}x${'}'.repeat(300)}`,
  'nested fractions': `${'\\frac{'.repeat(200)}1${'}{2}'.repeat(200)}`,
  'nested superscripts': `${'x^{'.repeat(300)}y${'}'.repeat(300)}`,
  'left right': `${'\\left('.repeat(250)}x${'\\right)'.repeat(250)}`,
  unicode: formulaOf('∑∫√π'),
  accents: formulaOf('\\hat{\\tilde{\\bar{x}}}'),
  arrows: formulaOf('\\xrightarrow{abc}'),
  // 900 expansions, under KaTeX's `maxExpand` of 1,000 a formula
  'macro definitions': `\\gdef\\z{zz}${formulaOf('\\z', 1800)}`,
};

describe('slow formulas at the cap', () => {
  for (const [name, generate] of Object.entries(RULES)) {
    it(`${name} is read within the time limit`, async () => {
      const text = generate();
      expect(text.length).toBeLessThanOrEqual(CAP);
      const { ms } = await timed(text);
      expect(ms).toBeLessThan(defaultLimits.ms);
    }, 30_000);
  }

  for (const [name, tex] of Object.entries(TYPESET)) {
    it(`${name}: a document’s budget of it is typeset within the time limit`, async () => {
      expect(utf8Bytes(tex)).toBeLessThanOrEqual(MARKDOWN_LIMITS.formulaBytes);
      // as many display formulas as the budget holds, which a document of 1 MB has room for
      const count = Math.floor(MARKDOWN_LIMITS.mathBytes / utf8Bytes(tex));
      const text = Array.from({ length: count }, () => `$$\n${tex}\n$$`).join(
        '\n\n',
      );
      expect(text.length).toBeLessThanOrEqual(CAP);
      const { ms, outcome } = await timed(text);
      expect(ms).toBeLessThan(defaultLimits.ms);
      // a typesetter's error would mean the shape measured nothing
      expect(outcome).not.toMatch(/^refused/);
    }, 30_000);
  }
});
