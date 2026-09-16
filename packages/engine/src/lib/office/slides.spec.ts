import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultHelpers } from '../helpers';
import type { RenderContext } from '../types';
import type { OfficeImageHost } from './drawings';
import { renderOffice } from './render';
import { layoutPictures } from './slides';
import { starterPresentation } from './starter-pptx';
import { assertWellFormed, tokenize } from './xml';
import { readText, readZip } from './zip';

const context: RenderContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
};

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const IN = 914400;

/** A text box at (1 in, 1 in), 2 in wide and 1 in high. */
const textBox = (id: number, paragraphs: string, xfrm = true) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${xfrm ? `<a:xfrm><a:off x="${IN}" y="${IN}"/><a:ext cx="${2 * IN}" cy="${IN}"/></a:xfrm>` : ''}</p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
const para = (text: string) => `<a:p><a:r><a:rPr lang="de-DE"/><a:t>${text}</a:t></a:r></a:p>`;

/** A table of one header row and the given rows, in a graphic frame. */
const tableFrame = (rows: string) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="0" y="${3 * IN}"/><a:ext cx="${4 * IN}" cy="${IN}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="${4 * IN}"/></a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const row = (text: string) => `<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</a:txBody><a:tcPr/></a:tc></a:tr>`;

function pptx(shapes: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldSz cx="${10 * IN}" cy="${5 * IN}"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(
      `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`,
    ),
  });
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const images: OfficeImageHost = {
  fetch: async () => ({ bytes: png(400, 200), contentType: 'image/png' }),
  toPng: async (_input, size) => png(size?.width ?? 10, size?.height ?? 10),
};

const slide = (bytes: Uint8Array) => readText(readZip(bytes).get('ppt/slides/slide1.xml')!);
const data = { url: 'https://example.test/offer', items: [{ name: 'Beratung' }, { name: 'Test' }], empty: [] };

describe('pictures on slides', () => {
  it('replaces a text box that holds only a code with a picture fitted into its box', async () => {
    const result = await renderOffice(pptx(textBox(2, para('{{ qrcode(url) }}'))), { engine: 'jinja2', data, context, images });
    const xml = slide(result.bytes);
    assertWellFormed(tokenize(xml));
    expect(xml).not.toContain('Text 2');
    // a square code in a 2 x 1 in box: 1 in square, centred horizontally
    expect(xml).toContain(`<a:off x="${1.5 * IN}" y="${IN}"/><a:ext cx="${IN}" cy="${IN}"/>`);
    expect(xml).toContain('<p:cNvPr id="3" name="Formfeed picture 3"');
    expect(xml).toContain('r:embed="rIdFormfeed1"');
    const archive = readZip(result.bytes);
    expect(readText(archive.get('ppt/slides/_rels/slide1.xml.rels')!)).toContain('Target="../media/formfeed1.png"');
    expect(archive.get('ppt/media/formfeed1.png')).toBeDefined();
    expect(readText(archive.get('[Content_Types].xml')!)).toContain('Extension="png"');
  });

  it('fits a picture to the width of a box that grows with its text', async () => {
    const box = textBox(2, para('{{ qrcode(url) }}')).replace('<a:bodyPr/>', '<a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr>');
    const xml = slide((await renderOffice(pptx(box), { engine: 'jinja2', data, context, images })).bytes);
    expect(xml).toContain(`<a:off x="${IN}" y="${IN}"/><a:ext cx="${2 * IN}" cy="${2 * IN}"/>`);
  });

  it('keeps the text of a box beside a picture and places the picture over it', async () => {
    const result = await renderOffice(pptx(textBox(2, para('Scan: {{ image(url, { width: 48 }) }}'))), { engine: 'jinja2', data, context, images });
    const xml = slide(result.bytes);
    expect(xml).toContain('<a:t>Scan: </a:t>');
    // after the text box; 48 px wide, half as high, centred in the box
    expect(xml.indexOf('<p:pic')).toBeGreaterThan(xml.indexOf('Text 2'));
    expect(xml).toContain(`<a:ext cx="${48 * 9525}" cy="${24 * 9525}"/>`);
  });

  it('puts a picture of a box without its own position in the middle of the slide', async () => {
    const result = await renderOffice(pptx(textBox(2, para('{{ image(url) }}'), false)), { engine: 'jinja2', data, context, images });
    // 400 x 200 px in the middle of a 10 x 5 in slide
    const cx = 400 * 9525;
    const cy = 200 * 9525;
    expect(slide(result.bytes)).toContain(`<a:off x="${(10 * IN - cx) / 2}" y="${(5 * IN - cy) / 2}"/><a:ext cx="${cx}" cy="${cy}"/>`);
  });

  it('leaves page breaks out with a warning', async () => {
    const result = await renderOffice(pptx(textBox(2, para('Eins{{ pageBreak() }}Zwei'))), { engine: 'jinja2', data, context, images });
    expect(slide(result.bytes)).toContain('<a:t>EinsZwei</a:t>');
    expect(result.warnings).toEqual(['Page breaks have no meaning on slides and were left out']);
  });

  it('lays several pictures out one below the other', () => {
    const picture = { kind: 'picture' as const, media: 'm', widthEmu: 100, heightEmu: 100, alt: '', sized: false };
    expect(layoutPictures([picture, picture], { x: 0, y: 0, cx: 100, cy: 200 })).toEqual([
      { x: 0, y: 0, cx: 100, cy: 100 },
      { x: 0, y: 100, cx: 100, cy: 100 },
    ]);
  });
});

describe('starterPresentation', () => {
  it('fills in every engine: title, table rows, note and a code in its box', async () => {
    for (const engine of ['jinja2', 'liquid', 'handlebars'] as const) {
      const starter = starterPresentation(engine);
      const result = await renderOffice(starter.bytes, { engine, data: starter.sampleData, context, images });
      const xml = slide(result.bytes);
      assertWellFormed(tokenize(xml));
      expect(xml, engine).toContain('<a:t>Offer A-2026-001</a:t>');
      expect(xml, engine).toContain('<a:t>Implementation</a:t>');
      expect(xml, engine).toContain('<a:t>Valid for 30 days.</a:t>');
      expect(xml, engine).not.toContain('{');
      // the code fills its 6 cm box
      expect(xml, engine).toContain('<a:ext cx="2160000" cy="2160000"/>');
      expect(xml.match(/<a:tr /g), engine).toHaveLength(4);
      expect(result.warnings, engine).toEqual([]);
    }
  });
});

describe('slide tables and text bodies', () => {
  it('repeats table rows and removes a table a loop left empty', async () => {
    const rows = row('{% for item in items %}') + row('{{ item.name }}') + row('{% endfor %}');
    const full = slide((await renderOffice(pptx(tableFrame(row('Name') + rows)), { engine: 'jinja2', data, context })).bytes);
    expect(full.match(/<a:tr /g)).toHaveLength(3);
    expect(full).toContain('<a:t>Test</a:t>');
    assertWellFormed(tokenize(full));

    const emptyRows = rows.replace('in items', 'in empty');
    const gone = slide((await renderOffice(pptx(tableFrame(emptyRows)), { engine: 'jinja2', data, context })).bytes);
    expect(gone).not.toContain('p:graphicFrame');
    assertWellFormed(tokenize(gone));
  });

  it('keeps a paragraph in a text body whose paragraphs were all tags', async () => {
    const result = await renderOffice(pptx(textBox(2, para('{% if false %}') + para('{% endif %}'))), { engine: 'jinja2', data, context });
    expect(slide(result.bytes)).toContain('<a:lstStyle/><a:p/></p:txBody>');
  });
});
