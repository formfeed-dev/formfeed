import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import { documentFonts, fontDiagnostics } from './fonts';
import { makeIdsUnique } from './ids';
import { OfficeTemplateError, renderOffice } from './render';
import { dropTaggedFallbacks } from './structure';
import { assertWellFormed, tokenize } from './xml';
import { readText, readZip } from './zip';

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const p = (text: string, attrs = '') => `<w:p${attrs}><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const context: RenderContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
};

function docx(body: string, extra: Zippable = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    'word/media/image1.png': new Uint8Array([137, 80, 78, 71]),
    ...extra,
  });
}

function pptx(slide: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p"/>'),
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${slide}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  });
}

const document = async (bytes: Uint8Array) => readText(readZip(bytes).get('word/document.xml')!);
const data = { customer: { name: 'Olvarest GmbH' }, items: [{ name: 'Beratung' }, { name: 'Test & Abnahme' }] };

describe('renderOffice', () => {
  it('fills a Word template in every engine and keeps the other parts byte for byte', async () => {
    const bodies: Record<EngineId, string> = {
      jinja2: p('Kunde: {{ cust') + p('{% for item in items %}') + p('{{ item.name }}') + p('{% endfor %}'),
      liquid: p('Kunde: {{ cust') + p('{% for item in items %}') + p('{{ item.name }}') + p('{% endfor %}'),
      handlebars: p('Kunde: {{ cust') + p('{{#each items}}') + p('{{name}}') + p('{{/each}}'),
    };
    for (const engine of Object.keys(bodies) as EngineId[]) {
      // the first paragraph's tag is completed in the next run, as Word splits it
      const body = bodies[engine].replace('{{ cust</w:t></w:r></w:p>', '{{ cust</w:t></w:r><w:r><w:t>omer.name }}</w:t></w:r></w:p>');
      const input = docx(body);
      const result = await renderOffice(input, { engine, data, context });
      expect(result.format).toBe('docx');
      const xml = await document(result.bytes);
      expect(xml, engine).toContain('Kunde: Olvarest GmbH');
      expect(xml, engine).toContain('>Beratung<');
      expect(xml, engine).toContain('>Test &amp; Abnahme<');
      expect(xml, engine).not.toContain('{');
      assertWellFormed(tokenize(xml));
      expect(readZip(result.bytes).get('word/media/image1.png')!.raw).toEqual(readZip(input).get('word/media/image1.png')!.raw);
    }
  });

  it('returns the file unchanged when it has no tags', async () => {
    const input = docx(p('Nur Text'));
    expect((await renderOffice(input, { engine: 'jinja2', data: {}, context })).bytes).toBe(input);
  });

  it('refuses templates it cannot fill, naming the part and paragraph', async () => {
    const split = docx(p('{{ customer') + p('.name }}'));
    await expect(renderOffice(split, { engine: 'jinja2', data, context })).rejects.toMatchObject({
      name: 'OfficeTemplateError',
      part: 'word/document.xml',
      diagnostics: [expect.objectContaining({ code: 'office-tag-spans-elements', paragraph: 1 })],
    });
    const include = docx(p("{% include 'footer' %}"));
    await expect(renderOffice(include, { engine: 'jinja2', data, context })).rejects.toBeInstanceOf(OfficeTemplateError);
    await expect(renderOffice(include, { engine: 'jinja2', data, context })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'unsupported-in-office' })],
    });
  });

  it('refuses what is not a Word or PowerPoint file', async () => {
    const odt = zipSync({ mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }] });
    await expect(renderOffice(odt, { engine: 'jinja2', data, context })).rejects.toMatchObject({ code: 'file_type_unsupported' });
  });

  it('warns when data contained characters a document cannot hold', async () => {
    const result = await renderOffice(docx(p('{{ note }}')), { engine: 'jinja2', data: { note: 'a\u0001b' }, context });
    expect(result.warnings).toEqual([expect.stringContaining('Removed 1 character')]);
  });

  it('fills PowerPoint slides, loops over paragraphs and keeps line breaks per run', async () => {
    const slide =
      '<a:p><a:r><a:rPr b="1"/><a:t>{{ customer.name }}</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>{% for item in items %}</a:t></a:r></a:p>' +
      '<a:p><a:r><a:rPr i="1"/><a:t>{{ item.name }}</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>{% endfor %}</a:t></a:r></a:p>';
    const result = await renderOffice(pptx(slide), { engine: 'liquid', data, context });
    expect(result.format).toBe('pptx');
    const xml = readText(readZip(result.bytes).get('ppt/slides/slide1.xml')!);
    expect(xml).toContain('<a:rPr b="1"/><a:t>Olvarest GmbH</a:t>');
    expect(xml.match(/<a:rPr i="1"\/>/g)).toHaveLength(2);
    expect(xml).not.toContain('{%');
  });
});

describe('makeIdsUnique', () => {
  it('renumbers drawing ids, bookmarks and paragraph ids that loops copied', () => {
    const drawing = (id: number) => `<w:drawing><wp:inline><wp:docPr id="${id}" name="Bild"/><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Bild"/></pic:nvPicPr></pic:pic></wp:inline></w:drawing>`;
    const copy = `<w:p w14:paraId="1A2B3C4D" w14:textId="77777777"><w:bookmarkStart w:id="0" w:name="Position"/><w:r>${drawing(5)}</w:r><w:bookmarkEnd w:id="0"/></w:p>`;
    const xml = `<w:document ${W}><w:body>${copy}${copy}${copy}</w:body></w:document>`;
    const out = makeIdsUnique(xml);
    assertWellFormed(tokenize(out));
    expect([...out.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1])).toEqual(['5', '6', '8']);
    expect([...out.matchAll(/<pic:cNvPr id="(\d+)"/g)].map((m) => m[1])).toEqual(['5', '7', '9']);
    expect([...out.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual([
      '0:Position',
      '1:Position_2',
      '2:Position_3',
    ]);
    expect([...out.matchAll(/<w:bookmarkEnd w:id="(\d+)"/g)].map((m) => m[1])).toEqual(['0', '1', '2']);
    expect(out.match(/w14:paraId/g)).toHaveLength(1);
    expect(out.match(/w14:textId/g)).toHaveLength(1);
  });

  it('leaves a part without copies untouched', () => {
    const xml = `<w:document ${W}><w:body>${p('a', ' w14:paraId="1"')}${p('b', ' w14:paraId="2"')}</w:body></w:document>`;
    expect(makeIdsUnique(xml)).toBe(xml);
  });
});

describe('dropTaggedFallbacks', () => {
  it('removes the VML copy of a text box that holds a tag and keeps the choice', () => {
    const box = (text: string) =>
      `<mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>${p(text)}</w:txbxContent></mc:Choice><mc:Fallback><w:pict>${p(text)}</w:pict></mc:Fallback></mc:AlternateContent>`;
    const xml = `<w:document ${W}><w:body><w:p><w:r>${box('{{ name }}')}${box('plain')}</w:r></w:p></w:body></w:document>`;
    const out = dropTaggedFallbacks(xml);
    expect(out.match(/<mc:Fallback>/g)).toHaveLength(1);
    expect(out.match(/<mc:Choice/g)).toHaveLength(2);
    assertWellFormed(tokenize(out));
  });
});

describe('fonts', () => {
  const fontTable = strToU8(
    '<w:fonts xmlns:w="w"><w:font w:name="Calibri"><w:panose1 w:val="1"/></w:font><w:font w:name="Aptos"/><w:font w:name="Liberation Sans"/><w:font w:name="Corporate Sans"><w:embedRegular r:id="rId1"/></w:font></w:fonts>',
  );
  const theme = strToU8(
    '<a:theme xmlns:a="a"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="+mn-lt"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
  );

  it('lists the fonts a document uses, embedded ones marked', () => {
    const archive = readZip(docx(p('x'), { 'word/fontTable.xml': fontTable, 'word/theme/theme1.xml': theme }));
    expect(documentFonts(archive)).toEqual([
      { name: 'Aptos', embedded: false },
      { name: 'Aptos Display', embedded: false },
      { name: 'Calibri', embedded: false },
      { name: 'Corporate Sans', embedded: true },
      { name: 'Liberation Sans', embedded: false },
    ]);
  });

  it('reports what the converter replaces: info for metric-compatible fonts, a warning otherwise', () => {
    const archive = readZip(docx(p('x'), { 'word/fontTable.xml': fontTable, 'word/theme/theme1.xml': theme }));
    const diagnostics = fontDiagnostics(documentFonts(archive), ['Carlito', 'Liberation Sans']);
    expect(diagnostics.map((d) => [d.text, d.severity])).toEqual([
      ['Aptos', 'warning'],
      ['Aptos Display', 'warning'],
      ['Calibri', 'info'],
    ]);
  });
});
