import type { EngineId } from '../types';
import { escapeText } from './xml';
import { writeZip } from './zip';

/**
 * A Formfeed starter Word file (spec 22 §6): a short offer with example tags in the template's
 * language, so a new Word template can start without an upload. Plain WordprocessingML with
 * Word's built-in styles; Word, LibreOffice and the quick preview open it as it is.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** The tags of one engine: a value, a value through a helper, and a loop over the lines. */
function tags(engine: EngineId) {
  if (engine === 'handlebars')
    return {
      number: '{{offer.number}}',
      customer: '{{customer.name}}',
      date: '{{date offer.date}}',
      loopOpen: '{{#each offer.lines}}',
      line: '{{description}}',
      lineTotal: '{{money total}}',
      loopClose: '{{/each}}',
      total: '{{money offer.total}}',
      ifOpen: '{{#if offer.note}}',
      note: '{{offer.note}}',
      ifClose: '{{/if}}',
    };
  // Jinja2 and Liquid read helpers as filters the same way
  const pipe = (value: string, helper: string) => `{{ ${value} | ${helper} }}`;
  return {
    number: '{{ offer.number }}',
    customer: '{{ customer.name }}',
    date: pipe('offer.date', 'date'),
    loopOpen: '{% for line in offer.lines %}',
    line: '{{ line.description }}',
    lineTotal: pipe('line.total', 'money'),
    loopClose: '{% endfor %}',
    total: pipe('offer.total', 'money'),
    ifOpen: '{% if offer.note %}',
    note: '{{ offer.note }}',
    ifClose: '{% endif %}',
  };
}

const paragraph = (text: string, style?: string, bold = false) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${escapeText(text)}</w:t></w:r></w:p>`;

const cell = (text: string, width: number, bold = false) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraph(text, undefined, bold)}</w:tc>`;

const row = (cells: string) => `<w:tr>${cells}</w:tr>`;

/** The starter document for an engine, with the sample data that fills it. */
export function starterDocument(engine: EngineId): { bytes: Uint8Array; sampleData: Record<string, unknown> } {
  const t = tags(engine);
  const body = [
    paragraph(`Offer ${t.number}`, 'Title'),
    paragraph(`For ${t.customer}, ${t.date}`),
    paragraph('Type tags like the ones below anywhere in the document. A tag alone in a paragraph or table row repeats or hides that paragraph or row.'),
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="6500"/><w:gridCol w:w="2500"/></w:tblGrid>`,
    row(cell('Item', 6500, true) + cell('Amount', 2500, true)),
    row(cell(t.loopOpen, 6500) + cell('', 2500)),
    row(cell(t.line, 6500) + cell(t.lineTotal, 2500)),
    row(cell(t.loopClose, 6500) + cell('', 2500)),
    row(cell('Total', 6500, true) + cell(t.total, 2500, true)),
    '</w:tbl>',
    paragraph(t.ifOpen),
    paragraph(t.note),
    paragraph(t.ifClose),
    paragraph('Fennlor Studio GmbH · Musterstraße 1 · 12345 Musterstadt'),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
  ].join('');
  const encoder = new TextEncoder();
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ],
    [
      'word/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Carlito" w:hAnsi="Carlito" w:cs="Carlito"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`,
    ],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`],
  ];
  return {
    bytes: writeZip(files.map(([name, text]) => ({ name, data: encoder.encode(text) }))),
    sampleData: {
      customer: { name: 'Olvarest GmbH' },
      offer: {
        number: 'A-2026-001',
        date: '2026-09-16',
        lines: [
          { description: 'Consulting', total: 300 },
          { description: 'Implementation', total: 1200 },
        ],
        total: 1500,
        note: 'Valid for 30 days.',
      },
    },
  };
}
