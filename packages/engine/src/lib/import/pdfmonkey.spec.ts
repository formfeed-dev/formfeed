import { getEngine } from '../engines';
import { defaultHelpers } from '../helpers';
import { defaultLimits } from '../limits';
import type { RenderContext } from '../types';
import { importPdfmonkey, strftimeToDateFns } from './pdfmonkey';
import { convertScss } from './scss';

const ctx: RenderContext = {
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: defaultLimits,
};

async function render(html: string, data: unknown): Promise<string> {
  const engine = getEngine('liquid');
  return engine.render(engine.compile(html, {}), data, ctx);
}

describe('PDFMonkey importer', () => {
  it('converts strftime formats to date-fns tokens', () => {
    expect(strftimeToDateFns('%d.%m.%Y').format).toBe('dd.MM.yyyy');
    expect(strftimeToDateFns('%-d %B %Y, %H:%M').format).toBe('d MMMM yyyy, HH:mm');
    // letters outside directives are quoted, as date-fns reads every letter as a token
    expect(strftimeToDateFns('%d de %B').format).toBe("dd' de 'MMMM");
    expect(strftimeToDateFns('%F %T').format).toBe('yyyy-MM-dd HH:mm:ss');
    expect(strftimeToDateFns('%Q').unmapped).toEqual(['%Q']);
  });

  it('imports a code template: settings, sample data and a body that renders like PDFMonkey', async () => {
    const result = importPdfmonkey({
      document_template: {
        identifier: 'Invoice',
        edition_mode: 'code',
        output_type: 'pdf',
        body: [
          '<h1>Invoice {{ invoice.number }}</h1>',
          '<p>{{ invoice.date | date: "%d.%m.%Y" }}</p>',
          '<p>{{ invoice.issued_at | in_time_zone: "Europe/Berlin" | date: "%H:%M" }}</p>',
          '<p>{{ invoice.total | with_delimiter, delimiter: ".", separator: ",", precision: 2 }}</p>',
          '{% assign rows = invoice.lines | slice_by: 2 %}{% for row in rows %}<i>{{ row | size }}</i>{% endfor %}',
          '<p>{{ invoice.lines | where_exp: "l", "l.qty > 1" | size }}</p>',
        ].join('\n'),
        scss_style: 'h1 { color: red; }',
        sample_data: JSON.stringify({ invoice: { number: 'R-1', date: '2026-09-10', issued_at: '2026-09-10T10:00:00Z', total: 1234.5, lines: [{ qty: 1 }, { qty: 2 }, { qty: 3 }] } }),
        settings: {
          paper_format: 'a4',
          orientation: 'landscape',
          margin: { top: 20, right: null, bottom: '15', left: undefined },
          footer: { left: 'Fennlor', center: '', right: 'Page [page] of [topage]' },
        },
      },
    });
    expect(result.source).toBe('pdfmonkey');
    expect(result.engine).toBe('liquid');
    expect(result.slug).toBe('invoice');
    expect(result.errors).toEqual([]);
    expect(result.settings.paper).toEqual({ format: 'A4', landscape: true });
    expect(result.settings.margin).toEqual({ top: '20mm', right: '10mm', bottom: '15mm', left: '10mm' });
    expect(result.settings.footer?.html).toContain('Page <span class="pageNumber"></span> of <span class="totalPages"></span>');
    expect(result.css).toBe('h1 { color: red; }');

    const html = await render(result.html, result.sampleData);
    expect(html).toContain('<p>10.09.2026</p>');
    expect(html).toContain('<p>12:00</p>'); // 10:00 UTC in Berlin summer time
    expect(html).toContain('<p>1.234,50</p>');
    expect(html).toContain('<i>2</i><i>1</i>');
    expect(html).toContain('<p>2</p>');
  });

  it('inlines snippets and partials and reports the ones it cannot find', async () => {
    const result = importPdfmonkey(
      {
        identifier: 'With snippets',
        body: [
          "{% load_snippets 'address', 'missing' %}",
          "{% partial 'line' %}<li>{{ item }}</li>{% endpartial %}",
          "{% include 'address', who: customer.name %}",
          "<ul>{% for item in items %}{% include 'line' %}{% endfor %}</ul>",
          "{% include 'missing' %}",
        ].join('\n'),
        sample_data: { customer: { name: 'Ada' }, items: ['a', 'b'] },
      },
      { snippets: { address: '<address>{{ who }}</address>' } },
    );
    expect(result.html).not.toContain('load_snippets');
    expect(result.html).not.toContain('endpartial');
    expect(result.errors.map((e) => e.code)).toContain('snippet-missing');
    const html = await render(result.html.replace(/\{%-?\s*include 'missing'\s*-?%\}/, ''), result.sampleData);
    expect(html).toContain('<address>Ada</address>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('reports filters without an equivalent once, with guidance, and Ruby integer division', () => {
    const result = importPdfmonkey({
      identifier: 'Filters',
      body: '<p>{{ names | to_sentence }}</p>\n<p>{{ cents | divided_by: 100 }}</p>',
      sample_data: '{"names": ["a"], "cents": 150}',
    });
    const filterErrors = result.errors.filter((e) => e.line === 1);
    expect(filterErrors.map((e) => e.code)).toEqual(['pdfmonkey-filter']);
    expect(filterErrors[0]?.message).toContain('join');
    expect(result.warnings.find((w) => w.code === 'integer-division')?.line).toBe(2);
  });

  it('switches Tailwind mode on, maps image templates and reports JavaScript features', () => {
    const result = importPdfmonkey({
      identifier: 'Card',
      output_type: 'image',
      body: '<script src="https://pdfmonkey-resources.s3.amazonaws.com/js/tailwindcss-4.js"></script>\n<div class="p-4">{{ title }}</div>\n<script>render($docPayload)</script>',
      settings: { transparent_background: true, inject_javascript: true },
    });
    expect(result.kind).toBe('image');
    expect(result.settings.tailwind).toBe(true);
    expect(result.html).not.toContain('tailwindcss-4.js');
    expect(result.settings.image).toMatchObject({ width: 1200, height: 630, transparent: true });
    expect(result.warnings.map((w) => w.code)).toContain('inject-javascript');
  });

  it('rejects Builder templates and falls back to the draft of an unpublished template', () => {
    expect(importPdfmonkey({ identifier: 'B', edition_mode: 'builder', body: '' }).errors[0]?.code).toBe('builder-template');
    const draft = importPdfmonkey({ identifier: 'D', body: '', body_draft: '<p>draft</p>' });
    expect(draft.html).toBe('<p>draft</p>');
    expect(draft.changes.join(' ')).toContain('draft');
  });
});

describe('SCSS conversion', () => {
  it('substitutes top-level variables and removes line comments without a compiler', () => {
    const result = convertScss('// brand\n$primary: #0a7;\n$primary-dark: #064;\nh1 { color: $primary; }\nh2 { color: $primary-dark; }');
    expect(result.css).toContain('h1 { color: #0a7; }');
    expect(result.css).toContain('h2 { color: #064; }');
    expect(result.css).not.toContain('$');
    expect(result.css).not.toContain('//');
    expect(result.warnings).toEqual([]);
  });

  it('reports what needs a compiler, and uses one when given', () => {
    const scss = '@mixin box { padding: 1rem; }\n.card { @include box; }';
    expect(convertScss(scss).warnings.map((w) => w.code)).toContain('scss-needs-compiler');
    const compiled = convertScss(scss, () => '.card { padding: 1rem; }');
    expect(compiled.css).toBe('.card { padding: 1rem; }');
    expect(compiled.changes).toEqual(['SCSS compiled to CSS']);
    // plain CSS passes untouched
    expect(convertScss('a { color: red }').css).toBe('a { color: red }');
  });
});
