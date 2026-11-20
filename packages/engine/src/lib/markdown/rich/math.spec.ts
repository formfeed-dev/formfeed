import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MarkdownSyntaxError, RenderLimitError } from '../../errors';
import { defaultLimits } from '../../limits';
import { markdownToHtml, type MarkdownConvertOptions } from '../convert';
import { MARKDOWN_LIMITS, MARKDOWN_MATH } from '../settings';
import { KATEX_VERSION, richMarkdown } from './index';

const rich = richMarkdown();
const convert = async (
  text: string,
  options: Partial<MarkdownConvertOptions> = {},
) =>
  (await markdownToHtml(text, { html: 'safe', math: true, rich, ...options }))
    .html;

/** The formulas of a document as their names say them, in order. */
const formulas = (html: string) =>
  [
    ...html.matchAll(/<span class="katex" role="img" aria-label="([^"]*)">/g),
  ].map((m) => m[1]);

/** The error a conversion fails with. */
const failure = async (text: string) => {
  const e = await convert(text).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(e instanceof MarkdownSyntaxError))
    throw new Error(`expected a MarkdownSyntaxError, got ${String(e)}`);
  return { line: e.line, part: e.part, message: e.message };
};

describe('the typesetter', () => {
  it('is the release the version names', () => {
    const require = createRequire(import.meta.url);
    const katexDir = require
      .resolve('katex')
      .replace(/dist[\\/]katex\.js$/, '');
    const manifest = JSON.parse(
      readFileSync(`${katexDir}package.json`, 'utf8'),
    ) as { version: string };
    expect(MARKDOWN_MATH.version).toBe(manifest.version);
    expect(KATEX_VERSION).toBe(manifest.version);
  });
});

describe('math in a document (plan 33, decisions 5 to 7)', () => {
  it('reads GitHub’s four forms', async () => {
    const html = await convert(
      [
        'Inline $E=mc^2$ and $`\\sqrt{3}`$.',
        '',
        '$$',
        '\\int_0^1 x\\,dx',
        '$$',
        '',
        '$$a^2+b^2=c^2$$',
        '',
        '```math',
        '\\frac{1}{2}',
        '```',
      ].join('\n'),
    );
    expect(formulas(html)).toEqual([
      'E=mc^2',
      '\\sqrt{3}',
      '\\int_0^1 x\\,dx',
      'a^2+b^2=c^2',
      '\\frac{1}{2}',
    ]);
    // the blocks are display math, each a paragraph of its own
    expect(
      html.match(/<p class="ff-math"><span class="katex-display">/g),
    ).toHaveLength(3);
  });

  it('marks a formula so Chromium tags it: an image named by its TeX, its HTML not hidden, no MathML', async () => {
    const html = await convert(
      'A $x < y$ here.\n\n$$\n\\begin{aligned}\na &= b \\\\\n  c &= d\n\\end{aligned}\n$$',
    );
    // the TeX on one line, escaped for the attribute
    expect(formulas(html)).toEqual([
      'x &lt; y',
      '\\begin{aligned} a &amp;= b \\\\ c &amp;= d \\end{aligned}',
    ]);
    expect(html).not.toContain('aria-hidden');
    expect(html).not.toContain('katex-mathml');
    expect(html).not.toContain('<math');
    expect(html).toContain('<span class="katex-html">');
  });

  it('leaves money alone: a $ opens before a non-space and closes after one, not before a digit', async () => {
    for (const text of [
      'It costs $5 and $10.',
      'US$20, or US$30.',
      'From $5, or $7.50 with tax.',
      'A $ sign and $ another.',
      'Between $x$5 and more.',
      'Ends with a $',
    ])
      expect(await convert(text)).toBe(await convert(text, { math: false }));
    expect(formulas(await convert('$x$, $y$ and $z$y'))).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it('reads \\$ as a dollar sign, outside a formula and inside', async () => {
    const html = await convert('A \\$ sign and $a\\$b$.');
    expect(html).toContain('<p>A $ sign and <span class="katex"');
    expect(formulas(html)).toEqual(['a\\$b']);
  });

  it('leaves $$ inside a line text, and a $$ line with more after its closing $$', async () => {
    const text = 'Inline $$x$$ stays.\n\n$$x$$ and more';
    expect(await convert(text)).toBe(await convert(text, { math: false }));
  });

  it('typesets nothing in code', async () => {
    const html = await convert('`$x$` and\n\n```\n$$\nx\n$$\n```\n\n    $y$');
    expect(formulas(html)).toEqual([]);
    expect(html).toContain('<code>$x$</code>');
  });

  it('reads formulas in lists, quotes, headings and links', async () => {
    const html = await convert(
      [
        '# The $\\alpha$ value',
        '',
        '- an item',
        '',
        '  $$',
        '  x^2',
        '  $$',
        '- next',
        '',
        '> $$',
        '> y',
        '> $$',
        '',
        '[the $z$ link](https://example.test)',
      ].join('\n'),
    );
    expect(formulas(html)).toEqual(['\\alpha', 'x^2', 'y', 'z']);
    // a heading's text and id read the TeX
    expect(html).toContain('<h1 id="the-alpha-value" class="ff-h1">The ');
    const converted = await markdownToHtml('# The $\\alpha$ value', {
      html: 'safe',
      math: true,
      rich,
    });
    expect(converted.heading).toBe('The \\alpha value');
  });

  it('is text where it was not asked for, or where the host brought no typesetter', async () => {
    const text = 'Energy $E=mc^2$\n\n$$\nx\n$$\n\n```math\ny\n```';
    const plain = await convert(text, { math: false });
    expect(plain).toContain('<p>Energy $E=mc^2$</p>');
    expect(plain).toContain(
      '<pre><code class="language-math">y\n</code></pre>',
    );
    expect(await convert(text, { rich: undefined })).toBe(plain);
    expect(formulas(plain)).toEqual([]);
  });

  it('writes nothing for an empty formula or one that only defines a macro, which later ones use', async () => {
    const html = await convert(
      '$$\n$$\n\nDefined $\\gdef\\R{\\mathbb{R}}$ here, used in $\\R^2$.',
    );
    expect(formulas(html)).toEqual(['\\R^2']);
    expect(html).not.toContain('<p class="ff-math"></p>');
  });

  it('keeps a document’s macros to that document', async () => {
    await convert('$\\gdef\\Q{q}$');
    expect((await failure('$\\Q$')).message).toBe(
      'The formula on line 1 does not parse: Undefined control sequence: \\Q',
    );
  });

  it('caps sizes and expansions as decision 7 says', async () => {
    // `maxSize` holds a rule to 10 em instead of failing
    expect(formulas(await convert('$\\rule{1000em}{1000em}$'))).toHaveLength(1);
    expect((await failure('$\\def\\a{\\a\\a}\\a$')).message).toMatch(
      /^The formula on line 1 does not parse: Too many expansions/,
    );
  });
});

describe('a formula that cannot be typeset fails the render (decision 9)', () => {
  it('names the line of an inline formula', async () => {
    expect(await failure('line one\nline two $x}$')).toEqual({
      line: 2,
      part: 'math',
      message: "The formula on line 2 does not parse: Expected 'EOF', got '}'",
    });
  });

  it('names the line inside a block, and counts front matter in', async () => {
    expect((await failure('a\n\n$$\nx\n\\frac{1}\n$$')).line).toBe(5);
    expect((await failure('```math\nx\n\ny}\n```')).line).toBe(4);
    expect(await failure('---\ntitle: T\n---\n\nText $\\foo$')).toMatchObject({
      line: 5,
      message:
        'The formula on line 5 does not parse: Undefined control sequence: \\foo',
    });
  });

  it('refuses a $$ that is never closed, naming where it opened', async () => {
    expect(await failure('a\n\n$$\nx\n\nmore text')).toEqual({
      line: 3,
      part: 'math',
      message:
        'The formula that opens with $$ on line 3 is never closed: a line that ends in $$ closes it',
    });
    // a list item ends a formula that opened in it
    expect((await failure('- $$\n  x\n\nafter $$')).line).toBe(1);
  });

  it('refuses a command KaTeX trusts only on request', async () => {
    for (const command of [
      '\\href{https://example.test}{x}',
      '\\url{https://example.test}',
      '\\includegraphics{a.png}',
      '\\htmlClass{x}{y}',
    ])
      expect((await failure(`see $${command}$`)).message).toBe(
        `The formula on line 1 uses ${command.slice(0, command.indexOf('{'))}, which a formula may not use`,
      );
  });

  it('refuses a formula nested too deeply for the typesetter’s stack, and nothing else of it', async () => {
    // KaTeX parses by descent: 2,000 groups run out of a process's stack and not of a thread's,
    // whose stack is larger, so either is right, and no other error is
    const deep = `$${'{'.repeat(2000)}x${'}'.repeat(2000)}$`;
    const outcome = await convert(deep).then(
      (html) => formulas(html).length,
      (e: unknown) => (e instanceof MarkdownSyntaxError ? e.message : e),
    );
    expect([
      1,
      'The formula on line 1 is nested too deeply to be typeset',
    ]).toContain(outcome);
  });
});

describe('the limits of a document’s formulas (decision 7, step 3)', () => {
  const { formulaBytes, formulas: most, mathBytes } = MARKDOWN_LIMITS;

  it('refuses a formula over 4 kB', async () => {
    const tex = 'x+'.repeat(formulaBytes / 2) + 'x';
    expect(await failure(`a\n\n$$\n${tex}\n$$`)).toMatchObject({
      line: 4,
      message: `The formula on line 4 is 4,097 bytes long; a formula may be at most 4,096`,
    });
    // 4 kB itself is taken
    expect(
      formulas(await convert(`$${'x+'.repeat(formulaBytes / 2 - 1)}xx$`)),
    ).toHaveLength(1);
  });

  it('refuses the 1,001st formula before any is typeset', async () => {
    const text = `${'$x$ '.repeat(most)}\n\nlast $y}$`;
    // the broken formula after the limit is never typeset: the count refuses first
    expect(await failure(text)).toEqual({
      line: 3,
      part: 'math',
      message:
        'The formula on line 3 is one more than the 1,000 a document may hold',
    });
    expect(formulas(await convert('$x$ '.repeat(most)))).toHaveLength(most);
  });

  it('refuses a document whose formulas hold more than 256 kB of TeX', async () => {
    const tex = 'x+'.repeat(2000);
    const count = Math.floor(mathBytes / tex.length);
    const text = Array.from({ length: count + 1 }, () => `$$\n${tex}\n$$`).join(
      '\n\n',
    );
    const line = count * 4 + 2;
    expect(await failure(text)).toMatchObject({
      line,
      message: `With the formula on line ${line}, the document's formulas hold more than the 256 kB of TeX a document may hold`,
    });
  });

  it('stops typesetting once the formulas’ HTML is past the render’s output limit', async () => {
    // a 4 kB formula of `a+` makes about 600 kB of HTML
    const tex = 'a+'.repeat(1500);
    const text = Array.from({ length: 60 }, () => `$$\n${tex}\n$$`).join(
      '\n\n',
    );
    const e = await convert(text).catch((error: unknown) => error);
    expect(e).toBeInstanceOf(RenderLimitError);
    expect((e as RenderLimitError).limit).toBe('outputBytes');
    expect((e as Error).message).toBe(
      `The document's formulas make more than ${defaultLimits.outputBytes / 1024 / 1024} MB of HTML, which is what a document may make`,
    );
    // half a second alone, and 6.9 s once while five projects' tests ran beside it
  }, 30_000);
});
