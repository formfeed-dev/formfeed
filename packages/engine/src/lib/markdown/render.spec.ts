import { describe, expect, it } from 'vitest';
import { emptyBrand } from '../brand';
import { RenderLimitError } from '../errors';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import type { MarkdownSource } from './render';
import { renderMarkdown } from './render';
import { documentTheme } from './themes/document';

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  locale: 'en-GB',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
  assetBaseUrl: 'https://cdn.formfeed.test/a/ws1',
  ...overrides,
});

const render = (
  source: MarkdownSource,
  data: unknown = {},
  overrides: Partial<RenderContext> = {},
) => renderMarkdown(source, data, context(overrides));

/** What the converter wrote inside its wrapper. */
const bodyOf = (document: string) =>
  /<div class="ff-markdown">\n([\s\S]*)<\/div>\n/.exec(document)?.[1] ?? '';

describe('renderMarkdown without an engine', () => {
  it('assembles a document with the theme after the brand variables and the reset', async () => {
    const brand = {
      ...emptyBrand(),
      colors: { primary: '#0a7a5c' },
      fonts: { heading: 'Fennlor Serif', body: null },
    };
    const { document } = await render(
      {
        markdown: '# Report\n\nText.',
        settings: { locale: 'de-DE', markdown: { css: 'h1 { color: red; }' } },
      },
      {},
      { brand },
    );
    expect(document).toContain('<html lang="de-DE">');
    expect(document).toContain(
      '<base href="https://cdn.formfeed.test/a/ws1/">',
    );
    expect(document).toContain('<title>Report</title>');
    const order = [
      'data-formfeed="brand"',
      'data-formfeed="reset"',
      'data-formfeed="markdown"',
      'data-formfeed="template"',
    ].map((s) => document.indexOf(s));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(document).toContain(
      `<style data-formfeed="markdown">${documentTheme}</style>`,
    );
    expect(document).toContain(
      '<style data-formfeed="template">h1 { color: red; }</style>',
    );
    expect(document).toContain(
      '<div class="ff-markdown">\n<h1 id="report" class="ff-h1">Report</h1>',
    );
  });

  it('`none` leaves the theme out; a stylesheet cannot close its element', async () => {
    const { document } = await render({
      markdown: 'Text',
      settings: {
        markdown: { theme: 'none', css: 'p{}</style><script>x()</script>' },
      },
    });
    expect(document).not.toContain('data-formfeed="markdown"');
    expect(document).toContain(
      '<style data-formfeed="template">p{}<\\/style><script>x()</script></style>',
    );
    // every style element closes once, so the script stays text of the stylesheet
    expect(document.split('</style').length - 1).toBe(
      document.match(/<style/g)?.length,
    );
  });

  it('takes the title from the settings, else the front matter, else the first heading', async () => {
    const text =
      '---\ntitle: From the front matter\nauthor: Erika Mustermann\nkeywords: [a, b]\n---\n# From the heading';
    const fromSettings = await render({
      markdown: text,
      settings: {
        pdf: { metadata: { title: 'From the settings', subject: 'Set' } },
      },
    });
    expect(fromSettings.title).toBe('From the settings');
    expect(fromSettings.metadata).toEqual({
      author: 'Erika Mustermann',
      subject: 'Set',
      keywords: 'a, b',
    });
    expect((await render({ markdown: text })).title).toBe(
      'From the front matter',
    );
    expect((await render({ markdown: '# From the heading' })).title).toBe(
      'From the heading',
    );
    const none = await render({ markdown: 'No heading' });
    expect(none.title).toBeUndefined();
    expect(none.document).not.toContain('<title>');
  });

  it('leaves the header, the footer and the metadata as written', async () => {
    const result = await render({
      markdown: 'Text',
      settings: {
        header: { html: '<span>{{ x }}</span>' },
        footer: { html: '<span class="pageNumber"></span>' },
        pdf: { metadata: { title: 'Tom &amp; Jerry {{ x }}' } },
      },
    });
    expect(result.headerHtml).toBe('<span>{{ x }}</span>');
    expect(result.footerHtml).toBe('<span class="pageNumber"></span>');
    expect(result.title).toBe('Tom &amp; Jerry {{ x }}');
  });

  it('shows raw HTML as text by default, and writes it with allow', async () => {
    const markdown = 'A <span onclick="x()">tag</span>\n\n<script>x()</script>';
    const safe = await render({ markdown });
    expect(bodyOf(safe.document)).toContain(
      'A &lt;span onclick=&quot;x()&quot;&gt;tag&lt;/span&gt;',
    );
    expect(safe.document).not.toContain('<script>x()');
    const allow = await render({
      markdown,
      settings: { markdown: { html: 'allow' } },
    });
    expect(allow.document).toContain('<span onclick="x()">tag</span>');
    expect(allow.document).toContain('<script>x()</script>');
  });

  it('holds the conversion to the render’s limits', async () => {
    await expect(
      renderMarkdown(
        { markdown: 'Text' },
        {},
        context(),
        'print',
        {},
        async (text, options) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          const { markdownToHtml } = await import('./convert');
          return markdownToHtml(text, options);
        },
      ).then(
        () => 'rendered',
        (e: unknown) => e,
      ),
    ).resolves.toBe('rendered');
    const late = renderMarkdown(
      { markdown: 'Text' },
      {},
      context({ limits: { ms: 20, outputBytes: 1e6, includeDepth: 8 } }),
      'print',
      {},
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { html: '<div class="ff-markdown"></div>', frontMatter: {} };
      },
    );
    await expect(late).rejects.toMatchObject({
      name: 'RenderLimitError',
      limit: 'ms',
    });
    await expect(
      render(
        { markdown: 'word '.repeat(2000) },
        {},
        { limits: { ms: 5000, outputBytes: 4096, includeDepth: 8 } },
      ),
    ).rejects.toBeInstanceOf(RenderLimitError);
  });
});

const engines: Array<{
  engine: EngineId;
  value: string;
  helper: (call: string) => string;
  nl2br: string;
  chart: string;
  safeHelper: string;
  markdown: (options?: string) => string;
}> = [
  {
    engine: 'jinja2',
    value: '{{ name }}',
    helper: (call) => `{{ ${call} }}`,
    nl2br: '{{ address | nl2br }}',
    chart:
      "{{ chart({ type: 'bar', labels: ['a'], values: [1], alt: 'One bar' }) }}",
    safeHelper: '{{ markup | safe }}',
    markdown: (options) =>
      `{{ notes | markdown${options ? `(${options})` : ''} }}`,
  },
  {
    engine: 'liquid',
    value: '{{ name | escape }}',
    helper: (call) => `{{ ${call} }}`,
    nl2br: '{{ address | nl2br }}',
    chart:
      "{{ '' | chart: type: 'bar', labels: labels, values: values, alt: 'One bar' }}",
    safeHelper: '{{ markup | safe }}',
    markdown: (options) =>
      `{{ notes | markdown${options ? `: ${options.replace(/[{}]/g, '').trim()}` : ''} }}`,
  },
  {
    engine: 'handlebars',
    value: '{{name}}',
    helper: (call) => `{{${call}}}`,
    nl2br: '{{nl2br address}}',
    chart: "{{chart type='bar' labels=labels values=values alt='One bar'}}",
    safeHelper: '{{safe markup}}',
    markdown: (options) =>
      `{{markdown notes${options ? ` ${options.replace(/[{}]/g, '').replace(/: /g, '=').trim()}` : ''}}}`,
  },
];

const data = {
  name: 'Tom & <Jerry>',
  address: 'Musterstraße 1\n12345 Musterstadt',
  markup: '**bold** <em>raw</em>',
  notes: 'Paid with *thanks*. <span>raw</span>',
  labels: ['a'],
  values: [1],
  report: { title: 'Q3 & more' },
};

describe.each(engines)('renderMarkdown with $engine', (e) => {
  const source = (
    markdown: string,
    settings?: MarkdownSource['settings'],
  ): MarkdownSource => ({ markdown, engine: e.engine, settings });

  it('renders the text over the data before it reads it as Markdown, escaped values as text', async () => {
    const { document } = await render(
      source(`# Report for ${e.value}\n\n- ${e.value}`),
      data,
    );
    const body = bodyOf(document);
    expect(body).toContain(
      '<h1 id="report-for-tom--jerry" class="ff-h1">Report for Tom &amp; &lt;Jerry&gt;</h1>',
    );
    expect(body).toContain('<li>Tom &amp; &lt;Jerry&gt;</li>');
  });

  it('keeps the HTML its helpers write, in safe too, and shows the value of safe as Markdown', async () => {
    const pageBreak = e.helper(
      e.engine === 'handlebars'
        ? 'pageBreak'
        : e.engine === 'liquid'
          ? "'' | pageBreak"
          : 'pageBreak()',
    );
    const { document } = await renderMarkdown(
      source(`${e.nl2br}\n\n${e.chart}\n\n${pageBreak}\n\n${e.safeHelper}`),
      data,
      context(),
      'print',
      { vendor: { chartJs: { src: 'https://cdn.formfeed.test/chart.js' } } },
    );
    const body = bodyOf(document);
    expect(body).toContain('<p>Musterstraße 1<br>\n12345 Musterstadt</p>');
    expect(body).toContain('<canvas');
    expect(body).toContain(
      '<div class="page-break" style="break-after:page"></div>',
    );
    expect(body).toContain(
      '<p><strong>bold</strong> &lt;em&gt;raw&lt;/em&gt;</p>',
    );
    // the chart's scripts follow the canvas into the document
    expect(document).toContain('data-formfeed="charts"');
  });

  it('converts with the markdown helper as the document does, unless told otherwise', async () => {
    const safe = bodyOf((await render(source(e.markdown()), data)).document);
    expect(safe).toContain(
      '<p>Paid with <em>thanks</em>. &lt;span&gt;raw&lt;/span&gt;</p>',
    );
    const allowed = bodyOf(
      (await render(source(e.markdown("{ html: 'allow' }")), data)).document,
    );
    expect(allowed).toContain(
      '<p>Paid with <em>thanks</em>. <span>raw</span></p>',
    );
    const document = bodyOf(
      (
        await render(
          source(e.markdown(), { markdown: { html: 'allow' } }),
          data,
        )
      ).document,
    );
    expect(document).toContain('<span>raw</span>');
  });

  it('renders the header, the footer and the metadata, which the PDF takes as text', async () => {
    const result = await render(
      source('---\nauthor: ' + e.value + '\n---\nText', {
        header: { html: `<span>${e.value}</span>` },
        pdf: { metadata: { title: e.value } },
      }),
      data,
    );
    expect(result.headerHtml).toBe('<span>Tom &amp; &lt;Jerry&gt;</span>');
    expect(result.title).toBe('Tom & <Jerry>');
    expect(result.metadata).toEqual({ author: 'Tom & <Jerry>' });
    expect(result.document).toContain('<title>Tom &amp; &lt;Jerry&gt;</title>');
  });

  it('cannot be made to show a helper’s HTML by data that forges its placeholder', async () => {
    const forged = {
      ...data,
      name: `${String.fromCharCode(0xe004)}0000000000000000:0${String.fromCharCode(0xe005)}`,
    };
    const { document } = await render(
      source(`${e.nl2br}\n\n${e.value}`),
      forged,
    );
    expect(bodyOf(document).match(/Musterstraße/g)).toHaveLength(1);
  });
});
