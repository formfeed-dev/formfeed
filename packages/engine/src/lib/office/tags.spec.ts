import { describe, expect, it } from 'vitest';
import { getEngine } from '../engines';
import { defaultHelpers } from '../helpers';
import type { RenderContext } from '../types';
import { normaliseTags, findTags, undoAutocorrect } from './tags';
import { createNonce, fromTemplateOutput, toTemplateSource } from './template-text';
import { assertWellFormed, tokenize } from './xml';

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const doc = (body: string) => `<w:document ${W}><w:body>${body}</w:body></w:document>`;
/** One paragraph whose text is spread over the given runs, as Word writes it. */
const split = (...runs: string[]) => `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;
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

function normalise(xml: string) {
  return normaliseTags(toTemplateSource(xml, 'wordprocessing', createNonce()), PART);
}

/** Fills a part the way the pipeline will: normalise, render, restore. */
async function fill(xml: string, data: unknown, engine: 'jinja2' | 'liquid' | 'handlebars' = 'jinja2') {
  const { template, diagnostics } = normalise(xml);
  const e = getEngine(engine);
  const out = await e.render(e.compile(template.source), data, ctx);
  const filled = fromTemplateOutput(out, template);
  assertWellFormed(tokenize(filled.xml));
  return { xml: filled.xml, diagnostics };
}

describe('normaliseTags', () => {
  it('merges a tag Word split across runs, keeping the first run formatting', async () => {
    // As Word stores it after typing and a spell-check pass: three runs, the first one bold.
    const xml = doc(
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello {{ cus</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:i/></w:rPr><w:t>tomer.na</w:t></w:r><w:r><w:t xml:space="preserve">me }}!</w:t></w:r></w:p>`,
    );
    const { xml: filled, diagnostics } = await fill(xml, { customer: { name: 'Olvarest GmbH' } });
    expect(diagnostics).toEqual([]);
    expect(filled).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello Olvarest GmbH!</w:t>');
    // the other runs are gone with their properties, and only the first run is left
    expect(filled).not.toContain('<w:i/>');
    expect(filled.match(/<w:r>|<w:r /g) ?? []).toHaveLength(1);
  });

  it('merges a tag split between its braces', async () => {
    const xml = doc(split('{', '{ total }', '}'));
    const { xml: filled } = await fill(xml, { total: 42 });
    expect(filled).toContain('>42<');
  });

  it('merges block tags and keeps the text around them', async () => {
    const xml = doc(split('Total: {% if p', 'aid %}paid{% end', 'if %} today'));
    const { xml: filled } = await fill(xml, { paid: true });
    expect(filled).toContain('Total: paid today');
  });

  it('undoes what autocorrect did inside a tag and says so', async () => {
    const curly = doc(split('{{ date(invoice.date, “dd.MM.yyyy”) }}'));
    const { xml: filled, diagnostics } = await fill(curly, { invoice: { date: '2026-09-16' } });
    expect(filled).toContain('16.09.2026');
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'office-tag-autocorrected', severity: 'info', part: PART, paragraph: 1 }),
    ]);
  });

  it('leaves text outside tags exactly as Word wrote it', () => {
    const xml = doc(split('Preis – 100\u00A0€ „wie gedruckt“'));
    const { template, diagnostics } = normalise(xml);
    expect(diagnostics).toEqual([]);
    expect(template.source).toContain('Preis – 100\u00A0€ „wie gedruckt“');
  });

  it('refuses to merge a tag that crosses a paragraph, a link or a field', () => {
    const acrossParagraphs = doc(split('{{ customer') + split('.name }}'));
    const acrossLink = doc(
      `<w:p><w:r><w:t>{{ customer</w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>.name }}</w:t></w:r></w:hyperlink></w:p>`,
    );
    const acrossField = doc(
      `<w:p><w:r><w:t>{{ page</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>s }}</w:t></w:r></w:p>`,
    );
    for (const xml of [acrossParagraphs, acrossLink, acrossField]) {
      const { diagnostics } = normalise(xml);
      expect(diagnostics, xml).toEqual([
        expect.objectContaining({ code: 'office-tag-spans-elements', severity: 'error', part: PART }),
      ]);
    }
  });

  it('numbers the paragraph a diagnostic belongs to', () => {
    const xml = doc(split('untouched') + split('also fine') + split('{{ a', '.b }}') + split('{{ c') + split('.d }}'));
    const { diagnostics } = normalise(xml);
    expect(diagnostics.map((d) => [d.code, d.paragraph])).toEqual([['office-tag-spans-elements', 4]]);
  });

  it('works the same in all three engines', async () => {
    const cases = [
      ['jinja2', split('{{ cust', 'omer.name }}')],
      ['liquid', split('{{ cust', 'omer.name }}')],
      ['handlebars', split('{{ cust', 'omer.name }}')],
    ] as const;
    for (const [engine, body] of cases) {
      const { xml } = await fill(doc(body), { customer: { name: 'Olvarest GmbH' } }, engine);
      expect(xml, engine).toContain('>Olvarest GmbH<');
    }
  });
});

describe('findTags', () => {
  it('finds the delimiters of the three engines, triple stash included', () => {
    expect(findTags('a {{ x }} b {% if y %} c {# note #}').map((t) => t.start)).toEqual([2, 12, 25]);
    const triple = findTags('{{{ raw }}}');
    expect(triple).toHaveLength(1);
    expect(triple[0]).toEqual({ start: 0, end: 11 });
    expect(findTags('{{ unclosed')).toEqual([]);
  });
});

describe('undoAutocorrect', () => {
  it('replaces the characters Word substitutes while typing', () => {
    expect(undoAutocorrect('{{ date(x, “short”) }}')).toBe('{{ date(x, "short") }}');
    expect(undoAutocorrect('{{ a – b }}')).toBe('{{ a - b }}');
    expect(undoAutocorrect('{%\u00A0if a\u200B %}')).toBe('{% if a %}');
    expect(undoAutocorrect("{{ 'x' }}")).toBe("{{ 'x' }}");
  });
});

describe('tags in field codes', () => {
  it('reports a tag in a field code once per paragraph and leaves the field as it is', async () => {
    const field = (code: string) =>
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const xml = doc(
      `<w:p><w:r><w:t>Page </w:t></w:r>${field(' PAGE ')}</w:p>` +
        `<w:p><w:r><w:t>{{ customer.name }}</w:t></w:r>${field(' HYPERLINK &quot;{{ offer.url }}&quot; ')}${field(' REF {{ x }} ')}</w:p>`,
    );
    const { xml: filled, diagnostics } = await fill(xml, { customer: { name: 'Olvarest GmbH' }, offer: { url: 'https://shop.example' } });
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'office-tag-in-field', part: PART, paragraph: 2, text: 'HYPERLINK "{{ offer.url }}"' }),
    ]);
    expect(filled).toContain('>Olvarest GmbH<');
    expect(filled).toContain('HYPERLINK &quot;{{ offer.url }}&quot;');
  });
});
