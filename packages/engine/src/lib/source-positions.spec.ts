import { renderVersion } from './assemble';
import { defaultHelpers } from './helpers';
import { annotateSourcePositions, parseSourceAttribute } from './source-positions';
import type { EngineId, RenderContext } from './types';

const annotate = (source: string, engine: EngineId = 'jinja2') =>
  annotateSourcePositions(source, engine, 'body');

/** `data-ff-src` values in order, for compact expectations. */
const positions = (html: string) =>
  [...html.matchAll(/data-ff-src="([^"]*)"/g)].map((m) => m[1]);

const strip = (html: string) => html.replace(/ data-ff-src="[^"]*"/g, '');

describe('annotateSourcePositions', () => {
  it('inserts the position right after the tag name, 1-based', () => {
    expect(annotate('<div class="a">\n  <p>x</p>\n</div>')).toBe(
      '<div data-ff-src="body:1:1" class="a">\n  <p data-ff-src="body:2:3">x</p>\n</div>',
    );
  });

  it('names the file it annotates', () => {
    expect(annotateSourcePositions('<span>1</span>', 'liquid', 'footer')).toBe(
      '<span data-ff-src="footer:1:1">1</span>',
    );
  });

  it('counts CRLF and lone CR as one line break, like Monaco', () => {
    expect(positions(annotate('<a>\r\n<b>\r<i>\n  <u>'))).toEqual([
      'body:1:1',
      'body:2:1',
      'body:3:1',
      'body:4:3',
    ]);
  });

  it('handles void, self-closing and multi-line tags', () => {
    expect(annotate('<br><img src="x.png"/>\n<input\n  type="text"\n  value="a">')).toBe(
      '<br data-ff-src="body:1:1"><img data-ff-src="body:1:5" src="x.png"/>\n<input data-ff-src="body:2:1"\n  type="text"\n  value="a">',
    );
  });

  it('never looks inside attribute values', () => {
    const source = `<a title="1 > 0 <b>" data-x='<i>'>go</a><p>`;
    expect(positions(annotate(source))).toEqual(['body:1:1', 'body:1:41']);
    expect(strip(annotate(source))).toBe(source);
  });

  it('annotates a tag split by template tags without touching them', () => {
    const source = '<div {% if x > 1 %}class="a"{% endif %}><span {{ attrs }}>';
    expect(annotate(source)).toBe(
      '<div data-ff-src="body:1:1" {% if x > 1 %}class="a"{% endif %}><span data-ff-src="body:1:41" {{ attrs }}>',
    );
  });

  it('skips closing tags, doctype, comments and tags with the attribute already', () => {
    expect(
      annotate('<!doctype html><!-- <div> --></div><![CDATA[<b>]]><p data-ff-src="body:9:9">'),
    ).toBe('<!doctype html><!-- <div> --></div><![CDATA[<b>]]><p data-ff-src="body:9:9">');
  });

  it('skips tags whose name comes from template syntax', () => {
    expect(annotate('<h{{ level }}>T</h{{ level }}><{{ tag }}>')).toBe(
      '<h{{ level }}>T</h{{ level }}><{{ tag }}>',
    );
  });

  it('skips the content of script, style, textarea and title', () => {
    const source =
      '<script>if (a <b) document.write("<div>")</script><style>a<b{}</style><textarea><p></textarea><title><i></title><em>';
    const at = (tag: string) => `body:1:${source.indexOf(tag) + 1}`;
    expect(positions(annotate(source))).toEqual([
      'body:1:1',
      at('<style>'),
      at('<textarea>'),
      at('<title>'),
      at('<em>'),
    ]);
    expect(annotate(source)).toContain('document.write("<div>")');
    expect(annotate(source)).toContain(`<textarea data-ff-src="${at('<textarea>')}"><p></textarea>`);
  });

  it('skips markup inside Jinja2 expressions, statements, comments and raw blocks', () => {
    const source =
      '{{ "}}<b>" }}{% set s = "<i>" %}{# <u> #}{% raw %}<s>{% endraw %}{%- verbatim -%}<q>{% endverbatim %}<p>';
    expect(annotate(source)).toBe(
      source.replace('<p>', `<p data-ff-src="body:1:${source.indexOf('<p>') + 1}">`),
    );
  });

  it('skips blocks whose output is captured or filtered as a string', () => {
    const jinja = '{% set block %}<b>{% set inner %}<i>{% endset %}</b>{% endset %}{% filter upper %}<u>{% endfilter %}<p>';
    expect(positions(annotate(jinja))).toEqual(['body:1:101']);
    const liquid = '{% capture x %}<b>{% endcapture %}{% comment %}<i>{% endcomment %}{% raw %}<u>{% endraw %}{% # it\'s <s> %}<p>';
    expect(positions(annotate(liquid, 'liquid'))).toEqual([`body:1:${liquid.indexOf('<p>') + 1}`]);
  });

  it('skips Handlebars comments, triple stashes and raw blocks', () => {
    const source =
      '{{!-- <a> }} --}}{{! <b> }}{{{ "<i>" }}}{{t "<u>"}}{{{{raw}}}}<s>{{x}}{{{{/raw}}}}<p>';
    expect(positions(annotate(source, 'handlebars'))).toEqual([
      `body:1:${source.indexOf('<p>') + 1}`,
    ]);
  });

  it('treats `{%` as text in Handlebars and `{#` as text in Liquid', () => {
    expect(positions(annotate('{% <a> %}', 'handlebars'))).toEqual(['body:1:4']);
    expect(positions(annotate('{# <a> #}', 'liquid'))).toEqual(['body:1:4']);
  });

  it('reads its own attribute back', () => {
    expect(parseSourceAttribute('header:3:7')).toEqual({ file: 'header', line: 3, column: 7 });
    expect(parseSourceAttribute('body:0:1')).toBeNull();
    expect(parseSourceAttribute('nav:1:1')).toBeNull();
    expect(parseSourceAttribute(null)).toBeNull();
  });
});

describe('annotated templates render the same document', () => {
  const partials: Record<string, string> = {
    row: '<tr class="row"><td class="cell">{{ line.name }}</td></tr>',
    'row.hbs': '<tr class="row"><td class="cell">{{name}}</td></tr>',
  };
  const ctx: RenderContext = {
    locale: 'en',
    timezone: 'UTC',
    currency: 'EUR',
    partials: (name) => partials[name] ?? partials[name.replace(/\.(html|liquid|hbs)$/, '')],
    helpers: defaultHelpers(),
    limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
  };
  const data = {
    title: 'Invoice <2026>',
    paid: true,
    lines: [
      { name: 'Widget', qty: 2 },
      { name: 'Gadget "pro"', qty: 1 },
    ],
  };

  const sources: Record<EngineId, { html: string; header: string }> = {
    jinja2: {
      html: `<!doctype html>
{# a comment with <div> #}
{% macro cell(value, cls="cell") -%}
  <td class="{{ cls }}">{{ value }}</td>
{%- endmacro %}
<table class="table" data-note="a > b">
  {% for line in lines %}
  <tr class="row {% if loop.first %}first{% endif %}" {% if line.qty > 1 %}data-many{% endif %}>
    {{ cell(line.name) }}<td
      class="cell qty">{{ line.qty }}</td>
  </tr>
  {% endfor %}
  {% for line in lines %}{% include "row" %}{% endfor %}
</table>
{% set block %}<b>{{ title }}</b>{% endset %}
<p>{{ block | length }} {{ block | e }}</p>
{% filter upper %}<i>shout</i>{% endfilter %}
{% raw %}<em>{{ not rendered }}</em>{% endraw %}
<h{{ 1 + 1 }}>{{ title }}</h2>
<script>var s = "<div>{{ title }}</div>";</script>
<textarea><p>{{ title }}</p></textarea>
{% if paid %}<span class="paid">Paid</span>{% else %}<span>Open</span>{% endif %}
<img src="logo.png"/><br>`,
    header: '<div class="head">{{ title }}</div>\r\n<span class="pageNumber"></span>',
  },
    liquid: {
      html: `<!doctype html>
{% comment %}<div>commented</div>{% endcomment %}
<table class="table">
  {% for line in lines %}
  <tr class="row {% if forloop.first %}first{% endif %}"{% if line.qty > 1 %} data-many{% endif %}>
    <td class="cell">{{ line.name }}</td><td
      class="cell qty">{{ line.qty }}</td>
  </tr>
  {% endfor %}
  {% for line in lines %}{% render "row", line: line %}{% endfor %}
</table>
{% capture block %}<b>{{ title }}</b>{% endcapture %}
<p>{{ block | size }} {{ block | escape }}</p>
{% raw %}<em>{{ not rendered }}</em>{% endraw %}
{% # it's an inline comment with <div> %}
<style>td > b { color: red }</style>
{%- if paid -%}<span class="paid">Paid</span>{%- else -%}<span>Open</span>{%- endif -%}
<img src="logo.png"/><br>`,
    header: '<div class="head">{{ title }}</div>\n<span class="pageNumber"></span>',
  },
    handlebars: {
      html: `<!doctype html>
{{!-- a comment with <div> --}}
{{#*inline "cell"}}<td class="cell">{{value}}</td>{{/inline}}
<table class="table">
  {{#each lines}}
  <tr class="row {{#if @first}}first{{/if}}">
    {{> cell value=name}}<td
      class="cell qty">{{qty}}</td>
  </tr>
  {{/each}}
  {{#each lines}}{{> row.hbs}}{{/each}}
</table>
{{{"<b>triple</b>"}}}
<p title="{{title}}">{{title}}</p>
{{#if paid}}
  <span class="paid">Paid</span>
{{else}}
  <span>Open</span>
{{/if}}
<img src="logo.png"/><br>`,
    header: '<div class="head">{{title}}</div>\n<span class="pageNumber"></span>',
  },
  };

  for (const engine of ['jinja2', 'liquid', 'handlebars'] as const) {
    it(`${engine}: only the attributes differ`, async () => {
      const { html, header } = sources[engine];
      const render = (body: string, head: string) =>
        renderVersion(
          { engine, html: body, css: 'td{}', settings: { header: { html: head } } },
          data,
          ctx,
          'preview',
        );
      const plain = await render(html, header);
      const annotated = await render(
        annotateSourcePositions(html, engine, 'body'),
        annotateSourcePositions(header, engine, 'header'),
      );
      expect(positions(annotated.document).length).toBeGreaterThan(8);
      expect(positions(annotated.headerHtml ?? '')).toEqual(['header:1:1', 'header:2:1']);
      expect(strip(annotated.document)).toBe(plain.document);
      expect(strip(annotated.headerHtml ?? '')).toBe(plain.headerHtml);
      // no attribute leaked into text, where it would show escaped
      expect(annotated.document).not.toMatch(/data-ff-src=&|DATA-FF-SRC/);
    });
  }

  it('points every row of a loop at the loop body', async () => {
    const html = '<table>\n{% for line in lines %}\n  <tr class="row"><td class="cell">{{ line.name }}</td></tr>\n{% endfor %}\n</table>';
    const out = await renderVersion(
      { engine: 'jinja2', html: annotateSourcePositions(html, 'jinja2', 'body') },
      data,
      ctx,
      'preview',
    );
    expect(positions(out.document)).toEqual([
      'body:1:1',
      'body:3:3',
      'body:3:19',
      'body:3:3',
      'body:3:19',
    ]);
  });
});
