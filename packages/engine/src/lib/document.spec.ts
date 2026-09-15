import {
  assembleDocument,
  fontFaceCss,
  mergeSettings,
  printReset,
  renderVersion,
} from './assemble';
import { defaultHelpers } from './helpers';
import { flowDocument, pagedDocument } from './preview';
import { inferSchema, schemaPaths } from './schema';
import type { RenderContext } from './types';

describe('inferSchema', () => {
  it('infers objects, arrays with unions, formats and examples', () => {
    const schema = inferSchema({
      invoice: {
        number: '2026-1',
        date: '2026-09-07',
        total: 12.5,
        paid: false,
        customer: { email: 'a@b.co' },
      },
      lines: [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 2, note: 'x' },
      ],
      tags: [],
      nothing: null,
    });
    expect(schema.$schema).toContain('2020-12');
    expect(schema.properties?.['invoice']?.properties?.['date']?.format).toBe(
      'date',
    );
    expect(schema.properties?.['invoice']?.properties?.['total']?.type).toBe(
      'number',
    );
    expect(schema.properties?.['invoice']?.properties?.['paid']?.type).toBe(
      'boolean',
    );
    expect(
      schema.properties?.['invoice']?.properties?.['customer']?.properties?.[
        'email'
      ]?.format,
    ).toBe('email');
    const lines = schema.properties?.['lines'];
    expect(lines?.type).toBe('array');
    expect(Object.keys(lines?.items?.properties ?? {})).toEqual([
      'sku',
      'qty',
      'note',
    ]);
    expect(lines?.items?.required).toEqual(['sku', 'qty']);
    expect(lines?.items?.properties?.['qty']?.type).toBe('integer');
    expect(schema.properties?.['tags']?.items).toBeUndefined();
    expect(schema.properties?.['nothing']?.type).toBe('null');
    const paths = schemaPaths(schema).map((p) => p.path.join('.'));
    expect(paths).toContain('lines.[].note');
    expect(paths).toContain('invoice.customer.email');
  });
});

describe('settings and assembly', () => {
  it('merges settings deeply with defaults and null removals', () => {
    const s = mergeSettings(
      { paper: { landscape: true }, header: { html: '<b>h</b>' } },
      { header: null, margin: { top: '5mm' } },
    );
    expect(s.paper).toEqual({
      format: 'A4',
      width: null,
      height: null,
      unit: 'mm',
      landscape: true,
    });
    expect(s.header).toBeNull();
    expect(s.margin?.top).toBe('5mm');
    expect(s.margin?.left).toBe('15mm');
  });

  it('emits the print reset with @page from the settings', () => {
    const css = printReset(
      mergeSettings({
        paper: { format: 'Letter', landscape: true },
        margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' },
      }),
    );
    expect(css).toContain(
      '@page { size: Letter landscape; margin: 1in 1in 1in 1in; }',
    );
    expect(css).toContain('thead { display: table-header-group; }');
    expect(
      printReset(mergeSettings({ paper: { width: '80mm', height: '200mm' } })),
    ).toContain('size: 80mm 200mm');
    expect(printReset({}, 'image')).not.toContain('@page');
  });

  it('assembles a complete document', () => {
    const doc = assembleDocument({
      html: '<main>x</main>',
      css: 'main{color:red}',
      head: '<link rel="stylesheet" href="x.css">',
      settings: { locale: 'de-DE' },
      assetBaseUrl: 'https://cdn.formfeed.test/a/ws',
      mode: 'preview',
      title: 'Rechnung <1>',
    });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<html lang="de-DE">');
    expect(doc).toContain('<base href="https://cdn.formfeed.test/a/ws/">');
    expect(doc).toContain('<title>Rechnung &lt;1&gt;</title>');
    expect(doc).toContain('<link rel="stylesheet" href="x.css">');
    expect(doc).toContain(
      '<style data-formfeed="template">main{color:red}</style>',
    );
    expect(doc).toContain(
      '<body class="formfeed-body formfeed-pdf formfeed-preview">',
    );
  });

  it('renders body, header, footer and title with the same engine', async () => {
    const ctx: RenderContext = {
      locale: 'en',
      timezone: 'UTC',
      currency: 'EUR',
      partials: () => undefined,
      helpers: defaultHelpers(),
      limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
    };
    const out = await renderVersion(
      {
        engine: 'liquid',
        html: '<h1>{{ invoice.number }}</h1>',
        css: 'h1{font-size:2em}',
        settings: {
          locale: 'de-DE',
          header: { html: '<div>{{ company }}</div>', height: '10mm' },
          footer: { html: '<span class="pageNumber"></span>' },
          pdf: { metadata: { title: 'Rechnung {{ invoice.number }}' } },
        },
      },
      { invoice: { number: '42' }, company: 'Fennlor' },
      ctx,
    );
    expect(out.document).toContain('<h1>42</h1>');
    expect(out.document).toContain('lang="de-DE"');
    expect(out.headerHtml).toBe('<div>Fennlor</div>');
    expect(out.footerHtml).toBe('<span class="pageNumber"></span>');
    expect(out.title).toBe('Rechnung 42');
    expect(out.settings.locale).toBe('de-DE');
  });
});

describe('paged preview document', () => {
  it('guards selector queries before Paged.js loads, so an unusable stylesheet cannot blank the preview', () => {
    const doc = pagedDocument(
      { document: assembleDocument({ html: '<p>x</p>' }), settings: {}, kind: 'pdf' },
      { pagedScriptUrl: 'https://app.example/vendor/pagedjs/paged.polyfill.min.js' },
    );
    const guard = doc.indexOf('DocumentFragment.prototype.querySelectorAll');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(doc.indexOf('paged.polyfill.min.js'));
  });

  it('puts its styles and scripts before the template head, which may end the head early with text', () => {
    const document = assembleDocument({ html: '<p>x</p>', head: 'stray text' });
    const draft = { document, headerHtml: '<div>h</div>', settings: {}, kind: 'pdf' as const };
    const paged = pagedDocument(draft, { pagedScriptUrl: 'https://app.example/paged.js' });
    expect(paged.indexOf('data-formfeed="paged"')).toBeGreaterThan(paged.indexOf('name="viewport"'));
    expect(paged.indexOf('data-formfeed="paged"')).toBeLessThan(paged.indexOf('stray text'));
    expect(paged.indexOf('https://app.example/paged.js')).toBeLessThan(paged.indexOf('stray text'));
    const flow = flowDocument(draft);
    expect(flow.indexOf('data-formfeed="preview"')).toBeLessThan(flow.indexOf('stray text'));
  });
});

describe('assembly extras (fonts, charts, tailwind)', () => {
  const fonts = [
    { family: 'Inter', weight: 400, format: 'woff2' as const, url: 'https://s.example/inter.woff2' },
    { family: 'Fraunces', weight: 700, style: 'italic' as const, format: 'ttf' as const, url: 'https://s.example/f.ttf' },
  ];

  it('injects @font-face only for families the template references', () => {
    const css = fontFaceCss(fonts, 'body { font-family: "inter", sans-serif }');
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('format("woff2")');
    expect(css).not.toContain('Fraunces');
    expect(fontFaceCss(fonts, 'nothing')).toBe('');
    expect(fontFaceCss(undefined, 'Inter')).toBe('');
    const doc = assembleDocument({ html: '<p>x</p>', css: 'p { font-family: Fraunces }', fonts });
    expect(doc).toContain('data-formfeed="fonts"');
    expect(doc).toContain('font-style: italic');
    expect(doc).toContain('format("truetype")');
  });

  it('adds Chart.js and the init script only when a chart is placed', () => {
    const vendor = { chartJs: { src: 'https://app.example/vendor/chart.js' } };
    const plain = assembleDocument({ html: '<p>x</p>', vendor });
    expect(plain).not.toContain('vendor/chart.js');
    const withChart = assembleDocument({
      html: '<canvas data-ff-chart="{}"></canvas>',
      vendor,
    });
    expect(withChart).toContain('<script src="https://app.example/vendor/chart.js"></script>');
    expect(withChart).toContain('canvas[data-ff-chart]');
    const inline = assembleDocument({
      html: '<canvas data-ff-chart="{}"></canvas>',
      vendor: { chartJs: { inline: 'window.Chart=1' } },
    });
    expect(inline).toContain('<script>window.Chart=1</script>');
  });

  it('uses compiled Tailwind CSS in the worker and the browser build in the preview', () => {
    const settings = { tailwind: true };
    const worker = assembleDocument({ html: '<p class="p-4">x</p>', settings, extraCss: '.p-4{padding:1rem}' });
    expect(worker).toContain('<style data-formfeed="tailwind">.p-4{padding:1rem}</style>');
    expect(worker).not.toContain('<script src');
    const preview = assembleDocument({ html: '<p class="p-4">x</p>', settings, vendor: { tailwind: { src: '/vendor/tailwind.js' } } });
    expect(preview).toContain('<script src="/vendor/tailwind.js"></script>');
    const off = assembleDocument({ html: '<p>x</p>', vendor: { tailwind: { src: '/vendor/tailwind.js' } } });
    expect(off).not.toContain('/vendor/tailwind.js');
  });

  it('returns the inline CSS header and footer templates need', async () => {
    const ctx: RenderContext = {
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      partials: () => undefined,
      helpers: defaultHelpers(),
      limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
    };
    const rendered = await renderVersion(
      {
        engine: 'jinja2',
        html: '<p>{{ a }}</p>',
        settings: { header: { html: '<span style="font-family: Inter">{{ a }}</span>' } },
      },
      { a: 'x' },
      ctx,
      'print',
      { fonts, extraCss: '.x{}' },
    );
    expect(rendered.inlineCss).toContain('font-family: "Inter"');
    expect(rendered.inlineCss).toContain('.x{}');
    expect(rendered.document).toContain('.x{}');
  });
});
