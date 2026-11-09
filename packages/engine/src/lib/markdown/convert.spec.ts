import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  imageAllowed,
  linkAllowed,
  markdownFragment,
  markdownToHtml,
} from './convert';
import { KEPT_CLOSE, KEPT_OPEN, KeptHtmlCollector } from './kept';
import { MARKDOWN_CONVERTER } from './settings';

const NBSP = String.fromCharCode(0xa0);

const doc = async (
  text: string,
  html: 'safe' | 'allow' = 'safe',
  breaks = false,
) => (await markdownToHtml(text, { html, breaks })).html;
/** The document without its wrapper and line breaks, for comparing markup. */
const body = async (text: string, html: 'safe' | 'allow' = 'safe') =>
  (await doc(text, html))
    .replace(/^<div class="ff-markdown">\n/, '')
    .replace(/<\/div>\n$/, '')
    .replace(/\n/g, '');

// --- what a `safe` document may hold -------------------------------------------------------------

/** Every element markdown-it, its footnotes and our rules write, and the tags `safe` keeps. */
const ELEMENTS = new Set(
  'div p h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code em strong s a img hr br table thead tbody tr th td input section sup sub kbd mark u ins del small'.split(
    ' ',
  ),
);
const ATTRIBUTES = new Set(
  'id class href src alt title style type disabled checked start'.split(' '),
);
const STYLES = /^(?:text-align:(?:left|center|right)|break-after:page)$/;

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * What a `safe` conversion of anything may produce: no element but these, no attribute but these,
 * no event handler, and no link or picture whose address is outside decision 3's lists.
 */
function problemsOf(html: string): string[] {
  const problems: string[] = [];
  for (const tag of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
    const name = tag[2]!.toLowerCase();
    if (!ELEMENTS.has(name)) problems.push(`element ${name}`);
    if (tag[1]) continue;
    for (const attribute of tag[3]!.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const key = attribute[1]!.toLowerCase();
      const value = decode(attribute[2] ?? '');
      if (!ATTRIBUTES.has(key)) problems.push(`attribute ${key} on ${name}`);
      if (key === 'href' && !linkAllowed(value)) problems.push(`href ${value}`);
      if (key === 'src' && !imageAllowed(value)) problems.push(`src ${value}`);
      if (key === 'style' && !STYLES.test(value))
        problems.push(`style ${value}`);
    }
  }
  return problems;
}

describe('the parser', () => {
  it('is the release the converter names', () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require.resolve('markdown-it/package.json'), 'utf8'),
    ) as { version: string };
    expect(MARKDOWN_CONVERTER.version).toBe(manifest.version);
  });
});

describe('GitHub Flavored Markdown', () => {
  it('converts the constructs', async () => {
    expect(
      await body('# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`.'),
    ).toBe(
      '<h1 id="title" class="ff-h1">Title</h1><p>Some <strong>bold</strong>, <em>em</em>, <s>gone</s> and <code>code</code>.</p>',
    );
    expect(await body('- one\n- two\n\n1. first\n2. second\n\n3. third')).toBe(
      '<ul><li>one</li><li>two</li></ul><ol><li><p>first</p></li><li><p>second</p></li><li><p>third</p></li></ol>',
    );
    expect(
      await body(
        '> quoted\n\n---\n\n```js\nconst a = 1 < 2;\n```\n\n    indented',
      ),
    ).toBe(
      '<blockquote><p>quoted</p></blockquote><hr><pre><code class="language-js">const a = 1 &lt; 2;</code></pre><pre><code>indented</code></pre>',
    );
  });

  it('writes tables with their alignment', async () => {
    expect(await body('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')).toBe(
      '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr></tbody></table>',
    );
  });

  it('links addresses and e-mail addresses, but not every word with a dot', async () => {
    expect(
      await body(
        'See https://example.test/a and max@example.test, not README.md.',
      ),
    ).toBe(
      '<p>See <a href="https://example.test/a">https://example.test/a</a> and <a href="mailto:max@example.test">max@example.test</a>, not README.md.</p>',
    );
  });

  it('writes footnotes, with ids of their own in each fragment', async () => {
    const text = 'Text[^1].\n\n[^1]: The note.';
    const html = await body(text);
    expect(html).toContain(
      '<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>',
    );
    expect(html).toContain(
      '<li id="fn1" class="footnote-item"><p>The note. <a href="#fnref1" class="footnote-backref">',
    );
    const fragment = markdownFragment(text, { html: 'allow' });
    const id = /href="#fn-([a-z0-9]+)-1"/.exec(fragment)?.[1];
    expect(id).toBeTruthy();
    expect(fragment).toContain(`id="fn-${id}-1"`);
    expect(
      markdownFragment('Other[^1].\n\n[^1]: Another.', { html: 'allow' }),
    ).not.toContain(`fn-${id}-1`);
  });

  it('breaks lines where asked', async () => {
    expect(await doc('one\ntwo')).toContain('<p>one\ntwo</p>');
    expect(await doc('one\ntwo', 'safe', true)).toContain(
      '<p>one<br>\ntwo</p>',
    );
    expect(await doc('one  \ntwo\\\nthree')).toContain(
      '<p>one<br>\ntwo<br>\nthree</p>',
    );
  });

  it('wraps a document, and leaves a fragment as it is', async () => {
    expect(await doc('Text')).toBe(
      '<div class="ff-markdown">\n<p>Text</p>\n</div>\n',
    );
    expect(markdownFragment('Text', { html: 'allow' })).toBe('<p>Text</p>\n');
  });
});

describe('task lists', () => {
  it('writes a disabled checkbox, as GitHub does, with GitHub’s classes', async () => {
    expect(await body('- [ ] open\n- [x] done\n- [X] also\n- plain')).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> open</li><li class="task-list-item"><input type="checkbox" disabled checked> done</li><li class="task-list-item"><input type="checkbox" disabled checked> also</li><li>plain</li></ul>',
    );
  });

  it('nests, numbers and takes an empty task', async () => {
    const html = await body('1. [ ] first\n   - [x] nested\n2. [ ]');
    expect(html).toContain(
      '<ol class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> first',
    );
    expect(html).toContain(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> nested</li></ul>',
    );
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled> </li>',
    );
  });

  it('only at the start of an item', async () => {
    expect(
      await body('[ ] not a list\n\n- a [ ] in the middle\n- [x]no space'),
    ).toBe(
      '<p>[ ] not a list</p><ul><li>a [ ] in the middle</li><li>[x]no space</li></ul>',
    );
  });
});

describe('empty table cells', () => {
  it('get a no-break space, for which Chromium writes a cell (PDF/UA-1 rule 7.2-43)', async () => {
    const html = await body('| a |   |\n|---|---|\n|   | b |');
    expect(html).toContain(`<th>a</th><th>${NBSP}</th>`);
    expect(html).toContain(`<td>${NBSP}</td><td>b</td>`);
  });

  it('in a fragment too', () => {
    expect(
      markdownFragment('| a |\n|---|\n|   |', { html: 'allow' }),
    ).toContain(`<td>${NBSP}</td>`);
  });
});

describe('page breaks', () => {
  it('at a line that is \\newpage, \\pagebreak or <!-- pagebreak -->', async () => {
    const html = await body(
      'One\n\n\\newpage\n\nTwo\n\n\\pagebreak\n\nThree\n\n<!-- pagebreak -->\n\nFour\n\n<!--PageBreak-->',
    );
    expect(
      html.match(/<div class="page-break" style="break-after:page"><\/div>/g),
    ).toHaveLength(4);
    expect(html).toContain('<p>One</p><div class="page-break"');
  });

  it('ends a paragraph, a quote and a list without a blank line', async () => {
    expect(await body('Before\n\\newpage\nAfter')).toBe(
      '<p>Before</p><div class="page-break" style="break-after:page"></div><p>After</p>',
    );
    expect(await body('> quoted\n\\newpage')).toBe(
      '<blockquote><p>quoted</p></blockquote><div class="page-break" style="break-after:page"></div>',
    );
    expect(await body('- item\n\\newpage')).toContain(
      '</ul><div class="page-break"',
    );
  });

  it('not inside a line, in code or written differently', async () => {
    expect(
      await body(
        'Use \\newpage here\n\n    \\newpage\n\n\\newpage now\n\n\\NewPage',
      ),
    ).toBe(
      '<p>Use \\newpage here</p><pre><code>\\newpage</code></pre><p>\\newpage now</p><p>\\NewPage</p>',
    );
  });

  it('in both modes and in a fragment', async () => {
    expect(await body('<!-- pagebreak -->', 'allow')).toBe(
      '<div class="page-break" style="break-after:page"></div>',
    );
    expect(
      markdownFragment('a\n\n\\newpage\n\nb', { html: 'allow' }),
    ).toContain('<div class="page-break"');
  });
});

describe('headings', () => {
  it('are closed up in the tags and keep the size written in a class', async () => {
    const html = await body(
      '## A\n\n#### B\n\n##### C\n\n## D\n\n# E\n\n### F\n\nSetext\n======\n\nTwo\n---',
    );
    expect(
      [...html.matchAll(/<(h\d) id="[^"]*" class="(ff-h\d)">/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual([
      'h1 ff-h2',
      'h2 ff-h4',
      'h3 ff-h5',
      'h1 ff-h2',
      'h1 ff-h1',
      'h2 ff-h3',
      'h1 ff-h1',
      'h2 ff-h2',
    ]);
    expect(html).toContain('</h2>');
  });

  it('get ids by GitHub’s rule, so a link to one works inside the PDF', async () => {
    const ids = (
      await body(
        [
          '## Setup',
          '[see](#setup)',
          '## Hello, World!',
          '## Ünïcödé Straße',
          '## 日本語の見出し',
          '## Привет мир',
          '## C++ & C#',
          '## A  B',
          '## Emoji 🚀 launch',
          '## The `x.y` call',
          '## snake_case and kebab-case',
          '## Setup',
          '## Setup',
          '## Setup-1',
          '## 🚀',
        ].join('\n\n'),
      )
    ).match(/(?:id|href)="[^"]*"/g);
    expect(ids).toEqual([
      'id="setup"',
      'href="#setup"',
      'id="hello-world"',
      'id="ünïcödé-straße"',
      'id="日本語の見出し"',
      'id="привет-мир"',
      'id="c--c"',
      'id="a--b"',
      'id="emoji--launch"',
      'id="the-xy-call"',
      'id="snake_case-and-kebab-case"',
      'id="setup-1"',
      'id="setup-2"',
      'id="setup-1-1"',
    ]);
  });

  it('name a document by the first one that has text', async () => {
    expect(
      (
        await markdownToHtml(
          'Intro\n\n#\n\n## Hello *world* & `code`\n\n# Later',
          { html: 'safe' },
        )
      ).heading,
    ).toBe('Hello world & code');
    expect(
      (await markdownToHtml('# 🚀 Launch', { html: 'safe' })).heading,
    ).toBe('🚀 Launch');
    expect(
      (await markdownToHtml('No heading at all', { html: 'safe' })).heading,
    ).toBeUndefined();
    expect(
      (await markdownToHtml('# Tom &amp; Jerry', { html: 'safe' })).heading,
    ).toBe('Tom & Jerry');
  });

  it('stay as written in a fragment, without ids', () => {
    expect(markdownFragment('## A\n\n#### B', { html: 'allow' })).toBe(
      '<h2>A</h2>\n<h4>B</h4>\n',
    );
  });
});

describe('front matter', () => {
  const read = (text: string) => markdownToHtml(text, { html: 'safe' });

  it('is removed, and fills the metadata', async () => {
    const result = await read(
      '---\ntitle: "Tom &amp; Jerry"\nauthor: Erika Mustermann\nsubject: Report\nkeywords: [pdf, markdown]\nlayout: post\nnested: { a: 1 }\n---\n# Heading\n',
    );
    expect(result.frontMatter).toEqual({
      title: 'Tom & Jerry',
      author: 'Erika Mustermann',
      subject: 'Report',
      keywords: 'pdf, markdown',
    });
    expect(result.html).toBe(
      '<div class="ff-markdown">\n<h1 id="heading" class="ff-h1">Heading</h1>\n</div>\n',
    );
  });

  it('with CRLF, a byte order mark, a closing ... and numbers', async () => {
    expect(
      (await read('---\r\ntitle: Windows\r\n---\r\nText')).frontMatter,
    ).toEqual({ title: 'Windows' });
    expect(
      (
        await read(
          `${String.fromCharCode(0xfeff)}---\ntitle: Marked\n---\nText`,
        )
      ).frontMatter,
    ).toEqual({ title: 'Marked' });
    expect(
      (await read('---\ntitle: 2026\nkeywords: q3\n...\nText')).frontMatter,
    ).toEqual({ title: '2026', keywords: 'q3' });
  });

  it('that is no YAML mapping stays Markdown', async () => {
    const setext = await read('---\nTitle\n---\nText');
    expect(setext.frontMatter).toEqual({});
    expect(setext.html).toContain('<hr>');
    expect(setext.html).toContain('<h1 id="title" class="ff-h2">Title</h1>');
    for (const text of [
      '---\n- a\n- b\n---\nText',
      '---\ntitle: [unclosed\n---\nText',
      '---\ntitle: no end\n\nText',
    ])
      expect((await read(text)).frontMatter, text).toEqual({});
    expect((await read('Text\n\n---\ntitle: late\n---\n')).frontMatter).toEqual(
      {},
    );
  });

  it('is never read in a fragment', () => {
    expect(
      markdownFragment('---\ntitle: x\n---\nText', { html: 'allow' }),
    ).toBe('<hr>\n<h2>title: x</h2>\n<p>Text</p>\n');
  });
});

describe('addresses (decision 3)', () => {
  it('a link keeps its text and loses the link outside the list', async () => {
    expect(
      await body(
        '[web](https://example.test) [mail](mailto:a@example.test) [phone](tel:+49000) [file](docs/a.pdf) [part](#setup) [ftp](ftp://example.test) [sms](sms:+49000) [image](data:image/png;base64,AA)',
      ),
    ).toBe(
      '<p><a href="https://example.test">web</a> <a href="mailto:a@example.test">mail</a> <a href="tel:+49000">phone</a> <a href="docs/a.pdf">file</a> <a href="#setup">part</a> ftp sms image</p>',
    );
  });

  it('a picture keeps the web, the file library and five types of data', async () => {
    const html = await body(
      '![a](https://example.test/a.png) ![b](logo.png) ![c](data:image/png;base64,AA) ![d](data:image/jpeg;base64,AA) ![e](data:image/gif;base64,AA) ![f](data:image/webp;base64,AA) ![g](data:image/svg+xml;base64,AA) ![*h* text](ftp://example.test/h.png)',
    );
    expect(html.match(/<img /g)).toHaveLength(7);
    expect(html).toContain(' h text</p>');
  });

  it('scripts, local files and data that is no picture stay the text that was written', async () => {
    expect(
      await body(
        '[a](javascript:alert(1)) ![b](vbscript:msgbox) [c](file:///etc/passwd) [d](data:text/html,x)',
      ),
    ).toBe(
      '<p>[a](javascript:alert(1)) ![b](vbscript:msgbox) [c](file:///etc/passwd) [d](data:text/html,x)</p>',
    );
  });

  it('the same in allow, where only raw HTML is written as it stands', async () => {
    expect(
      await body(
        '[a](javascript:alert(1)) [ftp](ftp://x.test) <a href="ftp://x.test">raw</a>',
        'allow',
      ),
    ).toBe(
      '<p>[a](javascript:alert(1)) ftp <a href="ftp://x.test">raw</a></p>',
    );
  });

  it('decides as a browser reads the scheme', () => {
    expect(linkAllowed('JAVASCRIPT:alert(1)')).toBe(false);
    expect(linkAllowed(' java\tscript:alert(1)')).toBe(false);
    expect(linkAllowed('java%09script:alert(1)')).toBe(true); // no scheme at all: a relative address
    expect(linkAllowed('//example.test/a')).toBe(true);
    expect(linkAllowed('')).toBe(false);
    expect(imageAllowed('data:image/svg+xml,%3Csvg%3E')).toBe(true);
    expect(imageAllowed('data:image/svg+xmlx,')).toBe(false);
    expect(imageAllowed('mailto:a@example.test')).toBe(false);
  });
});

describe('raw HTML in safe', () => {
  it('keeps a few formatting tags without attributes, closed in the same paragraph', async () => {
    expect(
      await body(
        'H<sub>2</sub>O, E = mc<SUP>2</SUP>, <kbd>Ctrl</kbd>+<kbd>C</kbd>, <u>u</u> <ins>i</ins> <del>d</del> <s>s</s> <small>m</small> <mark>k</mark><sup >1</sup >',
      ),
    ).toBe(
      '<p>H<sub>2</sub>O, E = mc<sup>2</sup>, <kbd>Ctrl</kbd>+<kbd>C</kbd>, <u>u</u> <ins>i</ins> <del>d</del> <s>s</s> <small>m</small> <mark>k</mark><sup>1</sup></p>',
    );
  });

  it('keeps <br> in every spelling, in a table cell too', async () => {
    expect(await body('a<br>b<br/>c<br />d<BR>e')).toBe(
      '<p>a<br>b<br>c<br>d<br>e</p>',
    );
    expect(await body('| a<br>b |\n|---|\n| c |')).toContain('<th>a<br>b</th>');
    expect(await body('<br>')).toBe('<br>');
  });

  it('shows a kept tag as text when it is not closed, or closes nothing', async () => {
    expect(await body('<u>open\n\nnext paragraph')).toBe(
      '<p>&lt;u&gt;open</p><p>next paragraph</p>',
    );
    expect(await body('stray</sup> <u><s>x</u></s>')).toBe(
      '<p>stray&lt;/sup&gt; <u>&lt;s&gt;x</u>&lt;/s&gt;</p>',
    );
    expect(await body('<sup class="x">1</sup> <sup/>')).toBe(
      '<p>&lt;sup class=&quot;x&quot;&gt;1&lt;/sup&gt; &lt;sup/&gt;</p>',
    );
  });

  it('removes comments', async () => {
    expect(await body('a <!-- inline --> b\n\n<!-- block -->\n\nc')).toBe(
      '<p>a  b</p><p>c</p>',
    );
  });

  it('shows the rest as text, block and inline', async () => {
    expect(await body('<div align="center">\n  **Title**\n</div>')).toBe(
      '<p class="ff-raw">&lt;div align=&quot;center&quot;&gt;<br>  **Title**<br>&lt;/div&gt;</p>',
    );
    expect(await body('Text <span class="x">s</span>')).toBe(
      '<p>Text &lt;span class=&quot;x&quot;&gt;s&lt;/span&gt;</p>',
    );
  });

  const payloads = [
    '<script>alert(1)</script>',
    'text <script>alert(1)</script> text',
    '<img src=x onerror=alert(1)>',
    'text <img src="x" onerror="alert(1)"> text',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload=alert(1)>',
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example"></iframe>',
    '<sup onclick="alert(1)">1</sup>',
    '<u>unclosed',
    '<!-- --><script>alert(1)</script>',
    '<!--> <script>alert(1)</script> -->',
    '<!-- a --!> <img src=x onerror=alert(1)> -->',
    '<a href="javascript:alert(1)">x</a>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<details open ontoggle=alert(1)>',
    '<object data="javascript:alert(1)"></object>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel=stylesheet href=https://evil.example/x.css>',
    '<form action=https://evil.example><input name=x></form>',
    '[a](javascript:alert(1))',
    '[a](JaVaScRiPt:alert(1))',
    '[a](<java\tscript:alert(1)>)',
    '[a](&#106;avascript:alert(1))',
    '[a](&#x6A;avascript&colon;alert(1))',
    '[a](vbscript:msgbox)',
    '[a](data:text/html,<script>alert(1)</script>)',
    '![a](data:text/html;base64,PHNjcmlwdD4=)',
    '![a](javascript:alert(1))',
    '<javascript:alert(1)>',
    '[a][r]\n\n[r]: javascript:alert(1)',
    '[a](file:///etc/passwd)',
    '[a](https://example.test "x\\" onmouseover=\\"alert(1)")',
    '![a" onerror="alert(1)](logo.png)',
    '```"><script>alert(1)</script>\ncode\n```',
  ];

  it.each(payloads)('runs nothing of %j', async (payload) => {
    for (const text of [
      payload,
      `Before\n\n${payload}\n\nAfter`,
      `- ${payload}`,
      `| ${payload.replace(/\n/g, ' ')} |\n|---|`,
      `> ${payload}`,
    ]) {
      expect(problemsOf(await doc(text)), text).toEqual([]);
      expect(
        problemsOf(markdownFragment(text, { html: 'safe' })),
        text,
      ).toEqual([]);
    }
  });

  it('shows what it does not run', async () => {
    expect(await body('<script>alert(1)</script>')).toBe(
      '<p class="ff-raw">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(await body('A <img src=x onerror=alert(1)> picture')).toBe(
      '<p>A &lt;img src=x onerror=alert(1)&gt; picture</p>',
    );
  });
});

describe('raw HTML in allow', () => {
  it('is written as it stands', async () => {
    expect(
      await body(
        '<div class="x">\n\n**in**\n\n</div>\n\nText <span style="color:red">s</span> <!-- c -->',
        'allow',
      ),
    ).toBe(
      '<div class="x"><p><strong>in</strong></p></div><p>Text <span style="color:red">s</span> <!-- c --></p>',
    );
  });

  it('is what the helper does without options', () => {
    expect(
      markdownFragment('<script>x()</script>\n\n<b>bold</b>', {
        html: 'allow',
      }),
    ).toBe('<script>x()</script>\n<p><b>bold</b></p>\n');
  });
});

describe('a property: nothing in a safe document runs', () => {
  // a small seeded generator, so a failure names an input that fails again
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pieces = [
    '# ',
    '## ',
    '- ',
    '1. ',
    '> ',
    '- [ ] ',
    '| ',
    ' |',
    '|---|',
    '\n',
    '\n\n',
    ' ',
    '**',
    '*',
    '_',
    '~~',
    '`',
    '```',
    '[',
    ']',
    '(',
    ')',
    '![',
    '<',
    '>',
    '"',
    "'",
    '&',
    '&#106;',
    '&lt;',
    '\\',
    '[^1]',
    '[^1]: ',
    '---',
    '\\newpage',
    'text',
    'more words',
    'https://example.test',
    'javascript:alert(1)',
    'JAVASCRIPT:',
    'java\tscript:',
    'vbscript:',
    'data:text/html,',
    'data:image/png;base64,AA',
    'ftp://x.test',
    'mailto:a@example.test',
    '#anchor',
    'logo.png',
    '<script>',
    '</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<style>',
    '<iframe>',
    '<a href="javascript:x">',
    '</a>',
    '<sup>',
    '</sup>',
    '<sup class=x>',
    '<u>',
    '</u>',
    '<s>',
    '</s>',
    '<br>',
    '<br/>',
    '<!--',
    '-->',
    '<!-- c -->',
    ' onerror=',
    ' onclick="x"',
    '<div>',
    '</div>',
    '<p>',
    '<base href=x>',
    '<input autofocus onfocus=x>',
  ];
  const sample = (next: () => number) => {
    const n = 1 + Math.floor(next() * 40);
    let text = '';
    for (let i = 0; i < n; i++)
      text += pieces[Math.floor(next() * pieces.length)];
    return text;
  };

  it('over generated Markdown mixed with HTML', async () => {
    const next = random(29);
    for (let i = 0; i < 1500; i++) {
      const text = sample(next);
      expect(problemsOf(await doc(text)), text).toEqual([]);
      expect(
        problemsOf(
          markdownFragment(text, { html: 'safe', breaks: i % 2 === 0 }),
        ),
        text,
      ).toEqual([]);
    }
  });
});

describe('the helpers’ HTML in a Markdown render', () => {
  const chart =
    '<canvas data-ff-chart="{&quot;type&quot;:&quot;bar&quot;}"></canvas>';
  const strong = '<strong class="x">kept</strong>';

  it('comes back as HTML in text, also in safe, and alone on its lines as a block where it is one', async () => {
    const kept = new KeptHtmlCollector();
    const a = kept.keep(chart);
    const b = kept.keep(strong);
    const block = kept.keep('<p>From the <em>markdown</em> helper</p>\n');
    const { html } = await markdownToHtml(
      `Before\n\n${a}\n\nSee ${b} here.\n\n${block}`,
      { html: 'safe', kept },
    );
    expect(html).toBe(
      `<div class="ff-markdown">\n<p>Before</p>\n<p>${chart}</p>\n<p>See ${strong} here.</p>\n<p>From the <em>markdown</em> helper</p>\n</div>\n`,
    );
  });

  it('as text inside code and attributes', async () => {
    const kept = new KeptHtmlCollector();
    const b = kept.keep(strong);
    const html = await markdownToHtml(
      `\`${b}\`\n\n\`\`\`\n${b}\n\`\`\`\n\n![${b}](logo.png "${b}") [a](https://example.test "${b}")`,
      { html: 'safe', kept },
    );
    const shown = '&lt;strong class=&quot;x&quot;&gt;kept&lt;/strong&gt;';
    expect(html.html).toContain(`<code>${shown}</code>`);
    expect(html.html).toContain(`<pre><code>${shown}\n</code></pre>`);
    expect(html.html).toContain(
      `<img src="logo.png" alt="${shown}" title="${shown}">`,
    );
    expect(html.html).toContain(
      `<a href="https://example.test" title="${shown}">a</a>`,
    );
    expect(problemsOf(html.html)).toEqual([]);
  });

  it('inside raw HTML that safe shows as text', async () => {
    const kept = new KeptHtmlCollector();
    const a = kept.keep(chart);
    expect(await body(`<div>${a}</div>`)).toBe(
      '<p class="ff-raw">&lt;div&gt;' + a + '&lt;/div&gt;</p>',
    );
    const { html } = await markdownToHtml(`<div>${a}</div>`, {
      html: 'safe',
      kept,
    });
    expect(html).toContain(
      `<p class="ff-raw">&lt;div&gt;${chart}&lt;/div&gt;</p>`,
    );
  });

  it('nowhere in an address, a title or a heading’s id', async () => {
    const kept = new KeptHtmlCollector();
    const b = kept.keep(strong);
    const result = await markdownToHtml(`# Title ${b}\n\n[a](${b})`, {
      html: 'safe',
      kept,
    });
    expect(result.html).not.toContain(kept.nonce);
    expect(result.heading).toBe('Title');
    expect(result.html).toContain('<h1 id="title" class="ff-h1">Title <strong');
  });

  it('a helper given another helper’s HTML carries it', async () => {
    const kept = new KeptHtmlCollector();
    const inner = kept.keep('<br>');
    const outer = kept.keep(`<em>a${inner}b</em>`);
    expect(kept.html[1]).toBe('<em>a<br>b</em>');
    expect(
      (await markdownToHtml(outer, { html: 'safe', kept })).html,
    ).toContain('<p><em>a<br>b</em></p>');
  });

  it('data cannot forge a placeholder', async () => {
    const kept = new KeptHtmlCollector();
    kept.keep(chart);
    const forged = `${KEPT_OPEN}0123456789abcdef:0${KEPT_CLOSE}`;
    const { html } = await markdownToHtml(
      `Data says ${forged} and ${KEPT_OPEN}${kept.nonce}:0`,
      { html: 'safe', kept },
    );
    expect(html).not.toContain('<canvas');
    expect(html).toContain(forged);
  });

  it('needs no placeholder where nothing was kept', async () => {
    expect(await body(`a ${KEPT_OPEN}x:0${KEPT_CLOSE} b`)).toBe(
      `<p>a ${KEPT_OPEN}x:0${KEPT_CLOSE} b</p>`,
    );
  });
});
