import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import common from 'highlight.js/lib/common';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_HIGHLIGHTER, MARKDOWN_LIMITS } from '../settings';
import {
  HIGHLIGHT_LANGUAGES,
  HIGHLIGHTER_VERSION,
  codeHighlighter,
  highlightLanguage,
} from './code';

const { highlightBytes, highlightBlockBytes, highlightLineLength } =
  MARKDOWN_LIMITS;

/** Code of `bytes` bytes in lines of `width` characters, the line breaks counted. */
const codeOf = (bytes: number, width = 79) => {
  const line = `${'x'.repeat(width - 1)}\n`;
  return (
    line.repeat(Math.floor(bytes / line.length)) +
    'x'.repeat(bytes % line.length)
  );
};

describe('the highlighter', () => {
  it('is the release the version names', () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require.resolve('highlight.js/package.json'), 'utf8'),
    ) as { version: string };
    expect(MARKDOWN_HIGHLIGHTER.version).toBe(manifest.version);
    expect(HIGHLIGHTER_VERSION).toBe(manifest.version);
  });

  it('takes highlight.js’s common set without plaintext, and Dockerfile and nginx', () => {
    // a release that adds to the common set fails here, so the new language gets its slow inputs
    const expected = [
      ...common.listLanguages().filter((name) => name !== 'plaintext'),
      'dockerfile',
      'nginx',
    ].sort();
    expect([...HIGHLIGHT_LANGUAGES].sort()).toEqual(expected);
    expect(HIGHLIGHT_LANGUAGES).toHaveLength(37);
  });

  it('knows a language by its name or an alias, in any case', () => {
    expect(highlightLanguage('typescript')).toBe('typescript');
    for (const [alias, name] of [
      ['ts', 'typescript'],
      ['TS', 'typescript'],
      ['tsx', 'typescript'],
      ['js', 'javascript'],
      ['py', 'python'],
      ['sh', 'bash'],
      ['zsh', 'bash'],
      ['console', 'shell'],
      ['yml', 'yaml'],
      ['toml', 'ini'],
      ['html', 'xml'],
      ['svg', 'xml'],
      ['docker', 'dockerfile'],
      ['golang', 'go'],
      ['cs', 'csharp'],
      ['c++', 'cpp'],
      ['rs', 'rust'],
      ['rb', 'ruby'],
      ['md', 'markdown'],
    ])
      expect(highlightLanguage(alias!), alias).toBe(name);
  });

  it('guesses nothing: no name, plain text and names it does not take print plain', () => {
    for (const name of [
      '',
      'plaintext',
      'text',
      'txt',
      'math',
      'mermaid',
      'jinja2',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ])
      expect(highlightLanguage(name), name).toBeNull();
    const code = codeHighlighter();
    expect(code('const a = 1;', 'text')).toBeNull();
    expect(code('const a = 1;', 'constructor')).toBeNull();
  });

  it('writes highlight.js’s classes around escaped text', () => {
    expect(codeHighlighter()('const a = 1 < 2;', 'ts')).toBe(
      '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span> &lt; <span class="hljs-number">2</span>;',
    );
  });

  it('escapes whatever the code holds, in every language', () => {
    const hostile =
      '</code></pre><script>alert(1)</script><img src=x onerror=alert(1)> & "q" \'s\'';
    for (const language of HIGHLIGHT_LANGUAGES) {
      const html = codeHighlighter()(hostile, language);
      expect(html, language).not.toBeNull();
      // nothing but the highlighter's spans is markup: a token's, or an embedded language's
      const markup = html!.replace(
        /<span class="(?:hljs-[a-z_ -]+|language-[a-z0-9-]+)">|<\/span>/g,
        '',
      );
      expect(markup, language).not.toMatch(/[<>]/);
      expect(markup, language).toContain('&lt;script&gt;');
    }
  });
});

describe('the caps (decision 3)', () => {
  it('a block up to highlightBlockBytes is coloured, one byte more prints plain', () => {
    expect(codeHighlighter()(codeOf(highlightBlockBytes), 'ts')).not.toBeNull();
    expect(codeHighlighter()(codeOf(highlightBlockBytes + 1), 'ts')).toBeNull();
    // counted in UTF-8: a character of two bytes takes two
    expect(
      codeHighlighter()('ü'.repeat(highlightBlockBytes / 2 + 1), 'ts'),
    ).toBeNull();
  });

  it('a line up to highlightLineLength characters is coloured, one more prints the block plain', () => {
    const at = `a\n${'x'.repeat(highlightLineLength)}\nb`;
    const over = `a\n${'x'.repeat(highlightLineLength + 1)}\nb`;
    expect(codeHighlighter()(at, 'yaml')).not.toBeNull();
    expect(codeHighlighter()(over, 'yaml')).toBeNull();
    expect(
      codeHighlighter()('x'.repeat(highlightLineLength + 1), 'yaml'),
    ).toBeNull();
  });

  it('a document colours its first highlightBytes, then every block after prints plain', () => {
    const code = codeHighlighter();
    const block = codeOf(highlightBytes / 4);
    for (let i = 0; i < 4; i++)
      expect(code(block, 'ts'), `block ${i}`).not.toBeNull();
    // the budget is spent: even a small block after it prints plain, so a document prints the same
    // whatever its blocks' sizes after that point
    expect(code('const a = 1;', 'ts')).toBeNull();
    // a block that would cross the budget ends it too: 240 kB, then 20 kB more
    const crossing = codeHighlighter();
    for (let i = 0; i < 3; i++)
      expect(crossing(codeOf(80 * 1024), 'ts'), `block ${i}`).not.toBeNull();
    expect(crossing(codeOf(20 * 1024), 'ts')).toBeNull();
    expect(crossing('a', 'ts')).toBeNull();
  });

  it('a block that prints plain for its size or lines does not count', () => {
    const code = codeHighlighter();
    expect(code(codeOf(highlightBlockBytes + 1), 'ts')).toBeNull();
    for (let i = 0; i < 4; i++)
      expect(
        code(codeOf(highlightBytes / 4), 'ts'),
        `block ${i}`,
      ).not.toBeNull();
  });

  it('counts per document: every highlighter has its own budget', () => {
    const first = codeHighlighter();
    for (let i = 0; i < 4; i++)
      expect(
        first(codeOf(highlightBytes / 4), 'ts'),
        `block ${i}`,
      ).not.toBeNull();
    expect(first('a', 'ts')).toBeNull();
    expect(codeHighlighter()('a', 'ts')).not.toBeNull();
  });

  it('colours the same text the same way, whatever ran before', () => {
    const text = 'def f(x):\n    return f"{x}"  # c\n';
    const once = codeHighlighter()(text, 'python');
    codeHighlighter()(codeOf(50_000), 'markdown');
    expect(codeHighlighter()(text, 'python')).toBe(once);
  });
});
