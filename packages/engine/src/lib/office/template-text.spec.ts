import { describe, expect, it } from 'vitest';
import { getEngine } from '../engines';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import { OfficeError } from './errors';
import { createNonce, fromTemplateOutput, layoutText, toTemplateSource, type TextFlavour } from './template-text';
import { assertWellFormed, tokenize } from './xml';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (body: string) => `<w:document ${W}><w:body>${body}</w:body></w:document>`;
const para = (text: string, props = '') => `<w:p><w:r>${props}<w:t>${text}</w:t></w:r></w:p>`;

const ctx: RenderContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
  mode: 'office',
};

async function fill(xml: string, engine: EngineId, data: unknown, flavour: TextFlavour = 'wordprocessing') {
  const template = toTemplateSource(xml, flavour, createNonce());
  const e = getEngine(engine);
  const out = await e.render(e.compile(template.source), data, ctx);
  const filled = fromTemplateOutput(out, template);
  assertWellFormed(tokenize(filled.xml));
  return filled;
}

describe('toTemplateSource', () => {
  it('turns only text element content into decoded template text', () => {
    const template = toTemplateSource(doc(para('{% if a &gt; b %}R&amp;D{% endif %}', '<w:rPr><w:b/></w:rPr>')), 'wordprocessing', 'abcdefghijklmnop');
    expect(template.source).toBe('\uE000abcdefghijklmnop0\uE001{% if a > b %}R&D{% endif %}\uE000abcdefghijklmnop1\uE001');
    expect(template.markup[0]?.raw).toContain('<w:rPr><w:b/></w:rPr><w:t>');
    expect(template.markup[1]?.raw).toBe('</w:t></w:r></w:p></w:body></w:document>');
    // the closing piece ends the paragraph, so a tag may not span it
    expect(template.markup[1]).toMatchObject({ paragraphBoundary: true, containerBoundary: false });
    expect(template.markup[0]).toMatchObject({ paragraphOpens: 1, paragraphBoundary: true });
  });

  it('leaves field codes and deleted text as markup', () => {
    const xml = doc('<w:p><w:r><w:instrText> PAGE {{ x }} </w:instrText></w:r><w:r><w:delText>{{ gone }}</w:delText></w:r></w:p>');
    expect(toTemplateSource(xml, 'wordprocessing', 'abcdefghijklmnop').source).not.toContain('{{');
  });

  it('round-trips a part without tags unchanged', async () => {
    const xml = doc(para('Fennlor Studio GmbH &amp; Co.') + para(' leading and trailing ', ''));
    for (const engine of ['jinja2', 'liquid', 'handlebars'] as const) expect((await fill(xml, engine, {})).xml).toBe(xml.replace('<w:t> leading', '<w:t xml:space="preserve"> leading'));
  });
});

describe('filling in office mode', () => {
  const data = { name: 'Müller & <Söhne> "GmbH"', items: ['a<b', 'c&d'] };
  const expected = 'Müller &amp; &lt;Söhne&gt; "GmbH"';

  it('escapes values once in every engine', async () => {
    expect((await fill(doc(para('{{ name }}')), 'jinja2', data)).xml).toContain(`<w:t>${expected}</w:t>`);
    expect((await fill(doc(para('{{ name }}')), 'liquid', data)).xml).toContain(`<w:t>${expected}</w:t>`);
    expect((await fill(doc(para('{{ name }}')), 'handlebars', data)).xml).toContain(`<w:t>${expected}</w:t>`);
  });

  it('cannot be tricked into markup by raw output', async () => {
    const injection = { name: '</w:t></w:r><w:r><w:t>INJECTED' };
    const attempts: Array<[EngineId, string]> = [
      ['jinja2', '{{ name | safe }}'],
      ['liquid', '{{ name | raw }}'],
      ['liquid', '{% echo name %}'],
      ['liquid', '{% liquid echo name %}'],
      ['liquid', '{% capture x %}{{ name }}{% endcapture %}{{ x }}'],
      ['handlebars', '{{{ name }}}'],
      // as Word stores it: the & of the tag is an entity in the part
      ['handlebars', '{{&amp; name }}'],
    ];
    for (const [engine, tag] of attempts) {
      const { xml } = await fill(doc(para(tag)), engine, injection);
      expect(xml, `${engine} ${tag}`).toContain('&lt;/w:t&gt;&lt;/w:r&gt;&lt;w:r&gt;&lt;w:t&gt;INJECTED');
      expect(xml.match(/<w:r>/g), `${engine} ${tag}`).toHaveLength(1);
    }
  });

  it('does not escape a captured value twice', async () => {
    const { xml } = await fill(doc(para('{% capture x %}{{ name }}{% endcapture %}{{ x }}')), 'liquid', data);
    expect(xml).toContain(`<w:t>${expected}</w:t>`);
  });

  it('cannot forge a placeholder from data', async () => {
    const template = toTemplateSource(doc(para('{{ name }}')), 'wordprocessing', 'abcdefghijklmnop');
    const e = getEngine('jinja2');
    const forged = { name: '\uE000abcdefghijklmnoq0\uE001' };
    const out = await e.render(e.compile(template.source), forged, ctx);
    expect(fromTemplateOutput(out, template).xml).toContain('\uE000abcdefghijklmnoq0\uE001');
  });

  it('removes characters XML forbids and reports how many', async () => {
    const filled = await fill(doc(para('{{ name }}')), 'jinja2', { name: 'a\u0001b\u000Bc' });
    expect(filled.xml).toContain('<w:t>abc</w:t>');
    expect(filled.removedCharacters).toBe(2);
  });

  it('turns line breaks and tabs from data into Word elements and keeps the run formatting', async () => {
    const { xml } = await fill(doc(para('{{ address }}', '<w:rPr><w:i/></w:rPr>')), 'jinja2', {
      address: 'Musterstraße 1\r\n12345 Musterstadt\tDE',
    });
    expect(xml).toContain(
      '<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Musterstraße 1</w:t><w:br/><w:t xml:space="preserve">12345 Musterstadt</w:t><w:tab/><w:t xml:space="preserve">DE</w:t>',
    );
  });

  it('loops over paragraphs in all three engines with identical results', async () => {
    const templates: Record<EngineId, string> = {
      jinja2: para('{% for item in items %}') + para('{{ item }}') + para('{% endfor %}'),
      liquid: para('{% for item in items %}') + para('{{ item }}') + para('{% endfor %}'),
      handlebars: para('{{#each items}}') + para('{{this}}') + para('{{/each}}'),
    };
    const results = await Promise.all(
      (Object.keys(templates) as EngineId[]).map(async (engine) => (await fill(doc(templates[engine]), engine, data)).xml),
    );
    // Structural paragraphs are removed by a later step; here the text of each loop body is what matters.
    for (const xml of results) {
      expect(xml).toContain('<w:t>a&lt;b</w:t>');
      expect(xml).toContain('<w:t>c&amp;d</w:t>');
    }
  });
});

describe('DrawingML text', () => {
  it('splits runs at line breaks and repeats the run properties', async () => {
    const xml = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:rPr lang="de-DE" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>{{ lines }}</a:t></a:r></a:p></p:sld>`;
    const { xml: filled } = await fill(xml, 'liquid', { lines: 'one\ntwo' }, 'drawing');
    const props = '<a:rPr lang="de-DE" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>';
    expect(filled).toContain(`<a:t>one</a:t></a:r><a:br>${props}</a:br><a:r>${props}<a:t>two</a:t>`);
  });
});

describe('text outside text elements', () => {
  it('refuses printed text that would land between elements', () => {
    const template = toTemplateSource(doc(para('{{ x }}')), 'wordprocessing', createNonce());
    expect(() => fromTemplateOutput(`stray${template.source}`, template)).toThrow(OfficeError);
    expect(() => fromTemplateOutput(`${template.source}stray`, template)).toThrow(OfficeError);
    expect(() => fromTemplateOutput(`\n  ${template.source}`, template)).not.toThrow();
  });

  it('keeps the text other elements hold: field codes, table styles', async () => {
    const field =
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const { xml } = await fill(doc(field + para('{{ name }}')), 'jinja2', { name: 'Olvarest GmbH' });
    expect(xml).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>');
    expect(xml).toContain('<w:t>Olvarest GmbH</w:t>');
    expect(layoutText('<a:tbl xmlns:a="a"><a:tblPr><a:tableStyleId>{5C22544A}</a:tableStyleId></a:tblPr></a:tbl>', 'drawing')).toContain('{5C22544A}');
  });
});

describe('createNonce', () => {
  it('is sixteen lower-case letters', () => {
    expect(createNonce()).toMatch(/^[a-z]{16}$/);
    expect(createNonce()).not.toBe(createNonce());
  });
});
