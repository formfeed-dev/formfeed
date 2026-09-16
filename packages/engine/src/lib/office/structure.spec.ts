import { describe, expect, it } from 'vitest';
import { getEngine } from '../engines';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import { applyStructure, blockRole } from './structure';
import { normaliseTags } from './tags';
import { createNonce, fromTemplateOutput, toTemplateSource } from './template-text';
import { assertWellFormed, tokenize } from './xml';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (body: string) => `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (...paragraphs: string[]) => `<w:tc><w:tcPr/>${paragraphs.join('')}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;
const PART = 'word/document.xml';

const ctx: RenderContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
  mode: 'office',
};

const items = { items: [{ name: 'Beratung', qty: 2 }, { name: 'Test & Abnahme', qty: 5 }], paid: false };

async function fill(xml: string, data: unknown = items, engine: EngineId = 'jinja2') {
  const structured = applyStructure(xml, PART);
  const { template, diagnostics } = normaliseTags(toTemplateSource(structured.xml, 'wordprocessing', createNonce()), PART);
  const e = getEngine(engine);
  const out = await e.render(e.compile(template.source), data, ctx);
  const filled = fromTemplateOutput(out, template);
  assertWellFormed(tokenize(filled.xml));
  return { xml: filled.xml, diagnostics: [...structured.diagnostics, ...diagnostics] };
}

const texts = (xml: string) => [...xml.matchAll(/<w:p>|<w:p\/>|<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => (m[0].startsWith('<w:p') ? '¶' : m[1]));

describe('paragraph loops', () => {
  it('repeat the paragraphs between the tags and leave no empty paragraphs behind', async () => {
    const xml = doc(p('Positionen:') + p('{% for item in items %}') + p('{{ item.name }}: {{ item.qty }}') + p('{% endfor %}') + p('Ende'));
    const { xml: filled, diagnostics } = await fill(xml);
    expect(diagnostics).toEqual([]);
    expect(texts(filled)).toEqual(['¶', 'Positionen:', '¶', 'Beratung: 2', '¶', 'Test &amp; Abnahme: 5', '¶', 'Ende']);
    expect(filled).not.toContain('ff:tag');
  });

  it('work in all three engines', async () => {
    const bodies: Record<EngineId, string> = {
      jinja2: p('{% for item in items %}') + p('{{ item.name }}') + p('{% endfor %}'),
      liquid: p('{% for item in items %}') + p('{{ item.name }}') + p('{% endfor %}'),
      handlebars: p('{{#each items}}') + p('{{name}}') + p('{{/each}}'),
    };
    for (const engine of Object.keys(bodies) as EngineId[]) {
      const { xml } = await fill(doc(bodies[engine]), items, engine);
      expect(texts(xml), engine).toEqual(['¶', 'Beratung', '¶', 'Test &amp; Abnahme']);
    }
  });

  it('handle conditions with an else paragraph', async () => {
    const xml = doc(p('{% if paid %}') + p('Bezahlt') + p('{% else %}') + p('Offen') + p('{% endif %}'));
    expect(texts((await fill(xml)).xml)).toEqual(['¶', 'Offen']);
  });

  it('leave inline block tags inside their paragraph', async () => {
    const xml = doc(p('Status: {% if paid %}bezahlt{% else %}offen{% endif %}'));
    expect(texts((await fill(xml)).xml)).toEqual(['¶', 'Status: offen']);
  });

  it('keep a paragraph with other content, such as a drawing, and do not treat it as structural', () => {
    const withDrawing = `<w:p><w:r><w:t>{% for item in items %}</w:t></w:r><w:r><w:drawing/></w:r></w:p>`;
    expect(applyStructure(doc(withDrawing), PART).xml).not.toContain('ff:tag');
  });
});

describe('table row loops', () => {
  it('repeat the rows between the tag rows and drop the tag rows', async () => {
    const xml = doc(
      table(
        row(cell(p('Artikel')), cell(p('Menge'))),
        row(cell(p('{% for item in items %}')), cell(p(''))),
        row(cell(p('{{ item.name }}')), cell(p('{{ item.qty }}'))),
        row(cell(p('{% endfor %}')), cell('<w:p/>')),
      ) + p(''),
    );
    const { xml: filled, diagnostics } = await fill(xml);
    expect(diagnostics).toEqual([]);
    expect(filled.match(/<w:tr>/g)).toHaveLength(3);
    // (the empty paragraph after the table is the one Word always writes there)
    expect(texts(filled).filter((t) => t !== '¶' && t !== '')).toEqual(['Artikel', 'Menge', 'Beratung', '2', 'Test &amp; Abnahme', '5']);
  });

  it('keep a row whose other cells have content, and keep a paragraph in every cell', async () => {
    const xml = doc(
      table(
        row(cell(p('{% if paid %}'), p('bezahlt'), p('{% endif %}')), cell(p('Status'))),
        row(cell(p('{% if paid %}')), cell(p('x'))),
      ) + p(''),
    );
    const structured = applyStructure(xml, PART);
    // the first cell keeps its middle paragraph; the second row's first cell gets an empty paragraph
    expect(structured.xml.match(/<w:tr>/g)).toHaveLength(2);
    expect(structured.xml).toContain('<w:tc><w:tcPr/><ff:tag>{% if paid %}</ff:tag><w:p/></w:tc>');
    // the if in the second row has no endif in the same place
    expect(structured.diagnostics).toEqual([]);
  });

  it('report a block whose tags sit in different places', () => {
    const xml = doc(p('{% for item in items %}') + table(row(cell(p('{{ item.name }}'), p('{% endfor %}')), cell(p('x')))) + p(''));
    const { diagnostics } = applyStructure(xml, PART);
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'office-block-unbalanced', severity: 'error', paragraph: 3 })]);
  });
});

describe('section breaks', () => {
  it('keep a paragraph that carries a section break, outside the loop', async () => {
    const sectPr = '<w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr>';
    const xml = doc(
      p('{% for item in items %}') +
        p('{{ item.name }}') +
        `<w:p>${sectPr}<w:r><w:t>{% endfor %}</w:t></w:r></w:p>` +
        p('Nach dem Umbruch'),
    );
    const { xml: filled } = await fill(xml);
    // one section break, after both items
    expect(filled.match(/w:type w:val="nextPage"/g)).toHaveLength(1);
    expect(texts(filled)).toEqual(['¶', 'Beratung', '¶', 'Test &amp; Abnahme', '¶', '¶', 'Nach dem Umbruch']);
  });
});

describe('blockRole', () => {
  it('classifies the tags of the three engines', () => {
    expect(blockRole('{% for x in y %}')).toEqual({ role: 'open', keyword: 'for' });
    expect(blockRole('{%- endfor -%}')).toEqual({ role: 'close', keyword: 'for' });
    expect(blockRole('{% elif a %}')).toEqual({ role: 'middle', keyword: 'elif' });
    expect(blockRole('{% set x = 1 %}')).toEqual({ role: 'single', keyword: 'set' });
    expect(blockRole('{# note #}')).toEqual({ role: 'single', keyword: 'comment' });
    expect(blockRole('{{#each items}}')).toEqual({ role: 'open', keyword: 'each' });
    expect(blockRole('{{/each}}')).toEqual({ role: 'close', keyword: 'each' });
    expect(blockRole('{{else}}')).toEqual({ role: 'middle', keyword: 'else' });
    expect(blockRole('{{ item.name }}')).toBeNull();
    expect(blockRole('{% if a %}x{% endif %}')).toBeNull();
    expect(blockRole('text {% if a %}')).toBeNull();
  });
});
