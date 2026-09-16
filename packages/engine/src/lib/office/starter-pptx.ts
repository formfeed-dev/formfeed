import type { EngineId } from '../types';
import { starterSampleData, starterTags } from './starter';
import { escapeText } from './xml';
import { writeZip } from './zip';

/**
 * A Formfeed starter PowerPoint file (spec 22 §6): one 16:9 slide with the offer's title, a
 * paragraph loop, a table whose middle row repeats, and a box that becomes a QR code. Written from
 * scratch (master, layout and theme are ours), so PowerPoint and LibreOffice open it as it is.
 */

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CM = 360000;
const FONT = 'Carlito';
const ACCENT = '0F766E';

const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

const run = (text: string, size: number, options: { bold?: boolean; color?: string } = {}) =>
  `<a:r><a:rPr lang="en-GB" sz="${size * 100}"${options.bold ? ' b="1"' : ''} dirty="0">` +
  `${options.color ? `<a:solidFill><a:srgbClr val="${options.color}"/></a:solidFill>` : ''}<a:latin typeface="${FONT}"/></a:rPr>` +
  `<a:t>${escapeText(text)}</a:t></a:r>`;

const para = (text: string, size: number, options: { bold?: boolean; color?: string } = {}) =>
  `<a:p>${run(text, size, options)}</a:p>`;

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function cell(text: string, header: boolean): string {
  const fill = header ? `<a:solidFill><a:srgbClr val="${ACCENT}"/></a:solidFill>` : '<a:noFill/>';
  const line = `<a:lnB w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:lnB>`;
  return (
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(text, 14, header ? { bold: true, color: 'FFFFFF' } : {})}</a:txBody>` +
    `<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${line}${fill}</a:tcPr></a:tc>`
  );
}

const tableRow = (a: string, b: string, header = false) => `<a:tr h="${Math.round(0.9 * CM)}">${cell(a, header)}${cell(b, header)}</a:tr>`;

function table(id: number, x: number, y: number, rows: string): string {
  const widths = [14 * CM, 6 * CM];
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Lines"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${widths[0]! + widths[1]!}" cy="${Math.round(3.6 * CM)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>` +
    `<a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function theme(): string {
  const scheme = (name: string, color: string) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`;
  const fill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;
  const line = `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return (
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Formfeed"><a:themeElements>` +
    `<a:clrScheme name="Formfeed">${scheme('dk1', '000000')}${scheme('lt1', 'FFFFFF')}${scheme('dk2', '1F2937')}${scheme('lt2', 'F3F4F6')}` +
    `${scheme('accent1', ACCENT)}${scheme('accent2', 'F59E0B')}${scheme('accent3', '2563EB')}${scheme('accent4', 'DC2626')}${scheme('accent5', '7C3AED')}${scheme('accent6', '059669')}` +
    `${scheme('hlink', '2563EB')}${scheme('folHlink', '7C3AED')}</a:clrScheme>` +
    `<a:fontScheme name="Formfeed"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Formfeed"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
  );
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const rels = (entries: Array<[string, string, string]>) =>
  xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
      .join('')}</Relationships>`,
  );

/** The starter presentation for an engine, with the sample data that fills it. */
export function starterPresentation(engine: EngineId): { bytes: Uint8Array; sampleData: Record<string, unknown> } {
  const t = starterTags(engine);
  const slide = [
    textBox(2, 'Title', 1.5 * CM, 1 * CM, 22 * CM, 2 * CM, para(`Offer ${t.number}`, 32, { bold: true, color: ACCENT })),
    textBox(3, 'Customer', 1.5 * CM, 3 * CM, 22 * CM, 1.2 * CM, para(`For ${t.customer}, ${t.date}`, 18)),
    table(
      4,
      1.5 * CM,
      5 * CM,
      tableRow('Item', 'Amount', true) + tableRow(t.loopOpen, '') + tableRow(t.line, t.lineTotal) + tableRow(t.loopClose, '') + tableRow('Total', t.total),
    ),
    textBox(5, 'Code', 25 * CM, 5 * CM, 6 * CM, 6 * CM, para(t.codeFit, 12)),
    textBox(
      6,
      'Note',
      1.5 * CM,
      15 * CM,
      22 * CM,
      2.5 * CM,
      para(t.ifOpen, 14) + para(t.note, 14) + para(t.ifClose, 14) + para('A tag alone in a paragraph or table row repeats or hides it; a box holding only a code becomes the code.', 11, { color: '6B7280' }),
    ),
  ].join('');

  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
          '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
          '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
          '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
          '</Types>',
      ),
    ],
    ['_rels/.rels', rels([['rId1', `${REL}/officeDocument`, 'ppt/presentation.xml']])],
    [
      'ppt/presentation.xml',
      xml(
        `<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
          `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
      ),
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      rels([
        ['rId1', `${REL}/slideMaster`, 'slideMasters/slideMaster1.xml'],
        ['rId2', `${REL}/slide`, 'slides/slide1.xml'],
        ['rId3', `${REL}/theme`, 'theme/theme1.xml'],
      ]),
    ],
    [
      'ppt/slideMasters/slideMaster1.xml',
      xml(
        `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld>` +
          `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
          `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
      ),
    ],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        ['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'],
        ['rId2', `${REL}/theme`, '../theme/theme1.xml'],
      ]),
    ],
    [
      'ppt/slideLayouts/slideLayout1.xml',
      xml(
        `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      ),
    ],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', `${REL}/slideMaster`, '../slideMasters/slideMaster1.xml']])],
    [
      'ppt/slides/slide1.xml',
      xml(`<p:sld ${NS}><p:cSld><p:spTree>${emptyTree}${slide}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`),
    ],
    ['ppt/slides/_rels/slide1.xml.rels', rels([['rId1', `${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml']])],
    ['ppt/theme/theme1.xml', xml(theme())],
  ];
  const encoder = new TextEncoder();
  return {
    bytes: writeZip(files.map(([name, text]) => ({ name, data: encoder.encode(text) }))),
    sampleData: starterSampleData(),
  };
}
