import { emptyBrand, type BrandContext } from './brand';
import { engineIds, engines } from './engines';
import { defaultHelpers } from './helpers';
import {
  mergeSampleData,
  mergeSnippetCss,
  mergeSnippetI18n,
  partialInclude,
  snippets,
  snippetsFor,
  snippetText,
} from './snippets';
import type { RenderContext } from './types';

const ctx = (
  engine: string,
  brand: BrandContext,
  i18n: RenderContext['i18n'] = {},
  locale = 'en-GB',
): RenderContext => ({
  locale,
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
  i18n,
  assetBaseUrl: engine,
  brand,
});

const fullBrand: BrandContext = {
  ...emptyBrand(),
  version: 3,
  name: 'Acme GmbH',
  colors: { primary: '#0f766e' },
  logo: { primary: 'https://cdn.example/logo.svg', inverse: null, mark: null },
  legal_footer: 'Acme GmbH · Musterstraße 1 · 10115 Berlin',
};

const stripTabstops = snippetText;

describe('snippet library', () => {
  it('compiles and renders every snippet in every engine with its own sample data', async () => {
    for (const engine of engineIds) {
      for (const snippet of snippetsFor(engine)) {
        const tpl = engines[engine].compile(stripTabstops(snippet.code), {
          name: snippet.id,
        });
        for (const brand of [emptyBrand(), fullBrand]) {
          const out = await engines[engine].render(
            tpl,
            snippet.sampleData ?? {},
            ctx(engine, brand, snippet.i18n),
          );
          const label = `${engine}/${snippet.id}/brand ${brand.version}`;
          expect(out, label).not.toMatch(/undefined|null|None/);
          expect(out.length, label).toBeGreaterThan(10);
          // every `t` key has a text, so no key name reaches the document
          for (const key of Object.keys(snippet.i18n?.['en'] ?? {}))
            expect(out, `${label} ${key}`).not.toContain(key);
        }
      }
    }
  });

  it('renders the brand kit where a block uses it', async () => {
    for (const engine of engineIds) {
      const render = async (id: string, brand: BrandContext) => {
        const snippet = snippetsFor(engine).find((s) => s.id === id)!;
        const tpl = engines[engine].compile(stripTabstops(snippet.code), { name: id });
        return engines[engine].render(tpl, {}, ctx(engine, brand));
      };
      expect(await render('letterhead', fullBrand), engine).toContain(
        'src="https://cdn.example/logo.svg"',
      );
      expect(
        await render('letterhead', { ...fullBrand, logo: emptyBrand().logo }),
        engine,
      ).toContain('<strong class="name">Acme GmbH</strong>');
      expect(await render('legal-footer', fullBrand), engine).toContain(
        '10115 Berlin',
      );
    }
  });

  it('labels blocks in English and German with the same keys the source uses', async () => {
    for (const snippet of snippets) {
      const used = [
        ...snippet.source.jinja2.matchAll(/t\('([^']+)'/g),
      ].map((m) => m[1]);
      if (!used.length) {
        expect(snippet.i18n, snippet.id).toBeUndefined();
        continue;
      }
      for (const language of ['en', 'de'])
        expect(Object.keys(snippet.i18n?.[language] ?? {}).sort(), `${snippet.id} ${language}`).toEqual(
          [...new Set(used)].sort(),
        );
    }
    for (const engine of engineIds) {
      const table = snippetsFor(engine).find((s) => s.id === 'totals')!;
      const tpl = engines[engine].compile(stripTabstops(table.code), { name: 'totals' });
      const out = await engines[engine].render(
        tpl,
        table.sampleData ?? {},
        ctx(engine, emptyBrand(), table.i18n, 'de-DE'),
      );
      expect(out, engine).toContain('Netto');
      expect(out, engine).toContain('USt. 19 %');
    }
  });

  it('merges label texts into the languages a template uses, keeping its own', () => {
    const extra = { en: { a: 'A', b: 'B' }, de: { a: 'Ä', b: 'Bé' }, fr: { a: 'À' } };
    expect(mergeSnippetI18n(undefined, extra, 'en')).toEqual({ en: extra.en });
    expect(mergeSnippetI18n({ 'de-DE': { x: '1' } }, extra, 'en-GB')).toEqual({
      'de-DE': { x: '1' },
      en: extra.en,
      de: extra.de,
    });
    expect(mergeSnippetI18n({ de: { a: 'eigen' } }, extra, 'de-DE')).toEqual({
      de: { a: 'eigen', b: 'Bé' },
      en: extra.en,
    });
    expect(mergeSnippetI18n({ en: {} }, undefined, 'de')).toEqual({ en: {} });
  });

  it('analyses clean against its sample data', () => {
    for (const engine of engineIds) {
      for (const snippet of snippetsFor(engine)) {
        const a = engines[engine].analyze(stripTabstops(snippet.code), {
          sampleData: snippet.sampleData ?? {},
        });
        expect(
          a.diagnostics.filter((d) => d.severity === 'error'),
          `${engine}/${snippet.id}`,
        ).toEqual([]);
      }
    }
  });

  it('keeps header and footer blocks self-styled and body blocks styled by their CSS', () => {
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
    for (const snippet of snippets) {
      if (snippet.target) {
        // Chromium renders header and footer templates without the page's stylesheet
        expect(snippet.css, snippet.id).toBeUndefined();
        continue;
      }
      const classes = new Set(
        [...snippet.source.jinja2.matchAll(/class="([^"]+)"/g)].flatMap((m) =>
          (m[1] ?? '').split(/\s+/),
        ),
      );
      // part of the print reset
      classes.delete('page-break');
      classes.delete('avoid-break');
      for (const name of classes)
        expect(snippet.css ?? '', `${snippet.id} .${name}`).toContain(`.${name}`);
    }
  });

  it('marks footers and page breaks as PDF only', () => {
    for (const snippet of snippets) {
      const paged =
        Boolean(snippet.target) || /page-break|avoid-break/.test(snippet.source.jinja2);
      if (paged) expect(snippet.kinds, snippet.id).toEqual(['pdf']);
      else expect([undefined, ['pdf']], snippet.id).toContainEqual(snippet.kinds);
    }
  });

  it('shows its sample values in every engine', async () => {
    // one value per data-driven block; data only a helper consumes (QR code, chart config) is left out
    const visible: Record<string, string[]> = {
      'window-address': ['Hauptstraße 5', 'Musterstraße 1'],
      'reference-block': ['K-1042', '2026-0042', '13/09/2026'],
      'invoice-heading': ['Invoice 2026-0042', '01/09/2026', '30/09/2026'],
      'invoice-table': ['Consulting', 'Implementation', '2,200.00'],
      totals: ['3,760.40', 'VAT 19 %'],
      'payment-terms': ['3,760.40', '13/10/2026', 'DE02120300000000202051'],
      'reverse-charge-note': ['ATU12345678'],
      'address-block': ['Musterstraße 1'],
      'page-footer': ['hello@acme.example', 'Page'],
      'cover-page': ['Quarterly report'],
      signature: ['Erika Mustermann'],
      'epc-qr': ['Scan to pay'],
      chart: ['Revenue per quarter'],
      'kpi-cards': ['New customers', '€ 61,600', '−0.4 pt on Q2'],
    };
    for (const snippet of snippets.filter((s) => s.sampleData))
      expect(Object.keys(visible), `${snippet.id} needs visible values`).toContain(snippet.id);
    for (const engine of engineIds) {
      for (const snippet of snippetsFor(engine).filter((s) => visible[s.id])) {
        const tpl = engines[engine].compile(stripTabstops(snippet.code), { name: snippet.id });
        const out = await engines[engine].render(
          tpl,
          snippet.sampleData ?? {},
          ctx(engine, emptyBrand(), snippet.i18n),
        );
        for (const value of visible[snippet.id] ?? [])
          expect(out, `${engine}/${snippet.id}`).toContain(value);
      }
    }
  });

  it('turns snippet code into the text that renders', () => {
    expect(snippetText('<div>$1</div>${2:x}$0')).toBe('<div></div>x');
  });

  it('writes partial includes the analyzer and the gateway recognise', () => {
    for (const engine of engineIds) {
      const line = partialInclude(engine, 'letter-head')!;
      expect(engines[engine].analyze(line).includes.map((i) => i.name), engine).toEqual([
        'letter-head',
      ]);
      expect(partialInclude(engine, "it's"), engine).toBeUndefined();
    }
    expect(partialInclude('handlebars', 'two words')).toBeUndefined();
  });

  it('merges snippet CSS rule by rule', () => {
    const snippetCss = '.a { color: red; }\n.a th, .a td { padding: 0; }';
    expect(mergeSnippetCss('', snippetCss)).toBe(`${snippetCss}\n`);
    // the template's own `.a` stays and the missing rule is added
    expect(mergeSnippetCss('.a { color: blue; }', snippetCss)).toBe(
      '.a { color: blue; }\n\n.a th, .a td { padding: 0; }\n',
    );
    // selector lists match regardless of spacing; comments and @import do not count
    const styled = '@import url(x.css);\n/* .b {} */\n.a {}\n.a th,\n  .a td {}';
    expect(mergeSnippetCss(styled, snippetCss)).toBe(styled);
    // a class that merely starts with the same text is a different selector
    expect(mergeSnippetCss('.ab { x: 1 }', '.a { y: 2 }')).toBe(
      '.ab { x: 1 }\n\n.a { y: 2 }\n',
    );
    expect(mergeSnippetCss('.a {}', undefined)).toBe('.a {}');
  });

  it('merges sample data without overwriting existing values', () => {
    const merged = mergeSampleData(
      { invoice: { number: '1', lines: [{ a: 1 }] }, keep: true },
      {
        invoice: { number: 'x', total: 5, lines: [] },
        customer: { name: 'n' },
      },
    ) as Record<string, unknown>;
    expect(merged).toEqual({
      invoice: { number: '1', lines: [{ a: 1 }], total: 5 },
      keep: true,
      customer: { name: 'n' },
    });
    expect(mergeSampleData(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeSampleData({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});
