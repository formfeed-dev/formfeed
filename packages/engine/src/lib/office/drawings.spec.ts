import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { defaultHelpers, officeUnsupportedHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import { imageSize, svgSize, textWidthEmu, toEmu, type OfficeImageHost } from './drawings';
import { OfficeTemplateError, analyzeOffice, renderOffice } from './render';
import { assertWellFormed, tokenize } from './xml';
import { readText, readZip } from './zip';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417"/></w:sectPr>';

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
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}${sect}</w:body></w:document>`),
    ...extra,
  });
}

/** The first bytes of a PNG, enough for its size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function host(): OfficeImageHost & { toPng: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async (url: string) => {
      if (url.includes('missing')) throw new Error('HTTP 404');
      return { bytes: png(400, 200), contentType: 'image/png' };
    }),
    toPng: vi.fn(async (_input: unknown, size?: { width: number; height: number }) => png(size?.width ?? 10, size?.height ?? 10)),
  };
}

const document = (bytes: Uint8Array) => readText(readZip(bytes).get('word/document.xml')!);

describe('office drawings', () => {
  it('turns a QR code into an inline picture in a run of its own, with media, relationship and type', async () => {
    const images = host();
    const result = await renderOffice(docx(p('Zahlen: {{ qrcode(url, { size: 120 }) }} bitte')), {
      engine: 'jinja2',
      data: { url: 'https://example.test/pay' },
      context,
      images,
    });
    const archive = readZip(result.bytes);
    const xml = document(result.bytes);
    assertWellFormed(tokenize(xml));
    // the text before and after keeps its run properties; the picture has them too
    expect(xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Zahlen: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:drawing>');
    expect(xml).toContain('</w:drawing></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> bitte</w:t></w:r>');
    // 120 px at 96 dpi
    expect(xml).toContain('<wp:extent cx="1143000" cy="1143000"/>');
    expect(xml).toContain('r:embed="rIdFormfeed1"');
    // drawn at twice its size
    expect(images.toPng).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/svg+xml' }), { width: 240, height: 240 });
    expect(readText(archive.get('word/_rels/document.xml.rels')!)).toContain('Id="rIdFormfeed1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/formfeed1.png"');
    expect(archive.get('word/media/formfeed1.png')).toBeDefined();
    expect(readText(archive.get('[Content_Types].xml')!)).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(result.warnings).toEqual([]);
  });

  it('shares a picture a loop repeats and numbers every copy', async () => {
    const images = host();
    const body = p('{% for item in items %}') + p('{{ barcode(sku) }} {{ item }}') + p('{% endfor %}');
    const result = await renderOffice(docx(body), { engine: 'jinja2', data: { sku: '4006381333931', items: [1, 2, 3] }, context, images });
    const xml = document(result.bytes);
    expect(xml.match(/<w:drawing>/g)).toHaveLength(3);
    expect(images.toPng).toHaveBeenCalledTimes(1);
    expect([...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(readZip(result.bytes).entries.filter((e) => e.name.startsWith('word/media/'))).toHaveLength(1);
  });

  it('places PNG data URLs without a host, keeps the aspect and the text width, and warns about the rest', async () => {
    const wide = `data:image/png;base64,${base64(png(4000, 1000))}`;
    const result = await renderOffice(
      docx(p('{{ image(logo, { width: "40mm" }) }}') + p('{{ image(wide) }}') + p('{{ image("https://cdn.example.test/x.png") }}')),
      { engine: 'jinja2', data: { logo: `data:image/png;base64,${base64(png(200, 100))}`, wide }, context },
    );
    const xml = document(result.bytes);
    // 40 mm wide, half as high
    expect(xml).toContain('<wp:extent cx="1440000" cy="720000"/>');
    // 4000 px would overflow the page: the text width of the section (A4 minus 2.5 cm margins)
    const width = (11906 - 2 * 1417) * 635;
    expect(xml).toContain(`<wp:extent cx="${width}" cy="${Math.round(width / 4)}"/>`);
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
    expect(result.warnings).toEqual([expect.stringContaining('https://cdn.example.test/x.png')]);
  });

  it('turns an image that cannot be loaded into a warning, and a page break into a break', async () => {
    const result = await renderOffice(docx(p('{{ image("https://example.test/missing.png") }}Weiter{{ pageBreak() }}Ende')), {
      engine: 'jinja2',
      data: {},
      context,
      images: host(),
    });
    const xml = document(result.bytes);
    expect(xml).not.toContain('<w:drawing>');
    expect(xml).toContain('<w:r><w:rPr><w:b/></w:rPr><w:br w:type="page"/></w:r>');
    expect(xml).toContain('>Weiter</w:t>');
    expect(result.warnings).toEqual([expect.stringContaining('HTTP 404')]);
  });

  it('works in every engine', async () => {
    const tags: Record<EngineId, string> = {
      jinja2: "{{ qrcode('x') }}",
      liquid: "{{ 'x' | qrcode }}",
      handlebars: "{{qrcode 'x'}}",
    };
    for (const [engine, tag] of Object.entries(tags) as Array<[EngineId, string]>) {
      const result = await renderOffice(docx(p(tag)), { engine, data: {}, context, images: host() });
      expect(document(result.bytes), engine).toContain('<w:drawing>');
    }
  });

  it('refuses charts and Markdown', async () => {
    await expect(renderOffice(docx(p("{{ chart({ type: 'bar', values: [1] }) }}")), { engine: 'jinja2', data: {}, context })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'unsupported-in-office' })],
    });
    await expect(renderOffice(docx(p('{{ note | markdown }}')), { engine: 'jinja2', data: { note: '*x*' }, context })).rejects.toBeInstanceOf(
      OfficeTemplateError,
    );
    const analysis = analyzeOffice(docx(p('Text') + p("{{ chart({ type: 'bar' }) }}")), { engine: 'jinja2' });
    expect(analysis.diagnostics).toEqual([expect.objectContaining({ code: 'unsupported-in-office', paragraph: 2 })]);
  });

  it('stops at 50 pictures', async () => {
    const body = p('{% for i in range(51) %}{{ qrcode(i) }}{% endfor %}');
    await expect(renderOffice(docx(body), { engine: 'jinja2', data: {}, context, images: host() })).rejects.toMatchObject({
      code: 'office_document_too_large',
    });
  });

  it('adds to relationships the part already has and keeps their ids', async () => {
    const rels =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFormfeed1" Type="t" Target="styles.xml"/></Relationships>';
    const result = await renderOffice(docx(p("{{ qrcode('x') }}"), { 'word/_rels/document.xml.rels': strToU8(rels) }), {
      engine: 'jinja2',
      data: {},
      context,
      images: host(),
    });
    const out = readText(readZip(result.bytes).get('word/_rels/document.xml.rels')!);
    expect(out).toContain('Id="rIdFormfeed1" Type="t"');
    expect(out).toContain('Id="rIdFormfeed2"');
    expect(document(result.bytes)).toContain('r:embed="rIdFormfeed2"');
  });
});

describe('helpers in office mode', () => {
  it('handles or refuses every helper that returns HTML', () => {
    const handled = new Set(['image', 'pageBreak', 'nl2br', 'safe']);
    const html = [...defaultHelpers().definitions.values()].filter((d) => d.html).map((d) => d.name);
    expect(html.filter((name) => !handled.has(name) && !officeUnsupportedHelpers.has(name))).toEqual([]);
  });
});

describe('drawing sizes', () => {
  it('reads units and natural sizes', () => {
    expect(toEmu(96)).toBe(914400);
    expect(toEmu('1in')).toBe(914400);
    expect(toEmu('25.4mm')).toBe(914400);
    expect(toEmu('72pt')).toBe(914400);
    expect(toEmu('50%')).toBeNull();
    expect(toEmu(0)).toBeNull();
    expect(imageSize(png(300, 120), 'image/png')).toEqual({ width: 300, height: 120 });
    expect(svgSize('<svg xmlns="x" width="160" height="160" viewBox="0 0 41 41">')).toEqual({ width: 160, height: 160 });
    expect(svgSize('<svg viewBox="0 0 200 50">')).toEqual({ width: 200, height: 50 });
    expect(svgSize('<svg width="100" viewBox="0 0 200 50">')).toEqual({ width: 100, height: 25 });
    expect(textWidthEmu('<w:body/>')).toBe(16 * 360000);
  });
});
