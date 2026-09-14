import { getEngine } from '../engines';
import { defaultHelpers } from '../helpers';
import { defaultLimits } from '../limits';
import type { RenderContext } from '../types';
import { helperNames, importJsreport, jsreportTemplates, readJsreportExport } from './jsreport';

const ctx: RenderContext = {
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: defaultLimits,
  assetBaseUrl: 'https://cdn.example.com/assets',
};

const b64 = (text: string) => btoa(text);

/** An unzipped .jsrexport: one JSON file per entity, plus metadata. */
function exportFiles(): Record<string, string> {
  const entity = (collection: string, e: Record<string, unknown>) => [`${collection}/${e['name']}-${e['_id']}.json`, JSON.stringify(e)];
  return Object.fromEntries([
    ['metadata.json', JSON.stringify({ reporterVersion: '4.7.0', importExportVersion: '2', storeProvider: 'fs' })],
    entity('folders', { _id: 'f1', shortid: 'F1', name: 'invoices' }),
    entity('templates', {
      _id: 't1',
      shortid: 'T1',
      name: 'invoice',
      folder: { shortid: 'F1' },
      engine: 'handlebars',
      recipe: 'chrome-pdf',
      content: [
        '<style>{{asset "invoices/base.css" "utf8"}}</style>',
        '<img src="{{asset "logo.png" "dataURI"}}">',
        '<h1>{{number}}</h1>',
        '{{childTemplate "invoices/lines"}}',
        '<p>{{formatMoney total}}</p>',
        '<script>const data = {{toJS this}};</script>',
      ].join('\n'),
      helpers: 'function formatMoney(v) { return v.toFixed(2) }\nconst shout = (s) => s.toUpperCase()',
      chrome: {
        format: 'A4',
        landscape: true,
        marginTop: '2cm',
        marginBottom: '15mm',
        displayHeaderFooter: true,
        footerTemplate: '<div style="font-size:8px">{{number}} <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
        printBackground: true,
        waitForJS: true,
      },
      data: { shortid: 'D1' },
      pdfMeta: { title: 'Invoice', author: 'Fennlor' },
      scripts: [{ shortid: 'S1' }],
    }),
    entity('templates', { _id: 't2', shortid: 'T2', name: 'lines', folder: { shortid: 'F1' }, engine: 'handlebars', recipe: 'html', content: '<ul>{{#each lines}}<li>{{this}}</li>{{/each}}</ul>' }),
    entity('templates', { _id: 't3', shortid: 'T3', name: 'legacy', engine: 'jsrender', recipe: 'xlsx', content: '{{:number}}' }),
    entity('data', { _id: 'd1', shortid: 'D1', name: 'invoice data', dataJson: JSON.stringify({ number: 'R-7', total: 12.5, lines: ['a', 'b'] }) }),
    entity('assets', { _id: 'a1', shortid: 'A1', name: 'base.css', folder: { shortid: 'F1' }, content: b64('h1 { color: navy }') }),
    entity('assets', { _id: 'a2', shortid: 'A2', name: 'logo.png', content: { type: 'Buffer', data: [137, 80, 78, 71] } }),
    entity('scripts', { _id: 's1', shortid: 'S1', name: 'load', content: 'async function beforeRender(req) {}' }),
    ['versions/whatever.json', '{}'],
  ]);
}

describe('jsreport importer', () => {
  it('reads an export and lists its templates with folder paths', () => {
    const bundle = readJsreportExport(exportFiles());
    expect(bundle.version).toBe('4.7.0');
    expect(jsreportTemplates(bundle).map((t) => t.path)).toEqual(['invoices/invoice', 'invoices/lines', 'legacy']);
    expect(() => readJsreportExport({ 'metadata.json': '{}' })).toThrow(/jsreport export/);
  });

  it('imports a Handlebars chrome-pdf template with assets, child templates, data and settings', async () => {
    const bundle = readJsreportExport(exportFiles());
    const result = importJsreport(bundle, 'invoices/invoice');
    expect(result.source).toBe('jsreport');
    expect(result.engine).toBe('handlebars');
    expect(result.kind).toBe('pdf');
    expect(result.settings.paper).toEqual({ format: 'A4', landscape: true });
    expect(result.settings.margin).toEqual({ top: '2cm', bottom: '15mm' });
    expect(result.settings.footer?.html).toContain('<span class="pageNumber"></span>');
    expect(result.settings.printBackground).toBe(true);
    expect(result.settings.pdf?.metadata).toEqual({ title: 'Invoice', author: 'Fennlor' });
    expect(result.sampleData).toEqual({ number: 'R-7', total: 12.5, lines: ['a', 'b'] });
    expect(result.html).toContain('<style>h1 { color: navy }</style>');
    expect(result.html).toContain('src="data:image/png;base64,iVBORw=="');
    expect(result.html).not.toContain('childTemplate');

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['custom-helpers', 'wait-for-js', 'scripts']));
    expect(result.warnings.find((w) => w.code === 'custom-helpers')?.message).toContain('formatMoney, shout');
    // the call to the custom helper fails the render, so the analysis reports it as an error
    expect(result.errors.map((e) => e.message).join(' ')).toContain('formatMoney');

    const engine = getEngine('handlebars');
    const html = await engine.render(engine.compile(result.html.replace('<p>{{formatMoney total}}</p>', ''), {}), result.sampleData, ctx);
    expect(html).toContain('<h1>R-7</h1>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('const data = {"number":"R-7"');
  });

  it('reports engines and recipes Formfeed does not have', () => {
    const result = importJsreport(readJsreportExport(exportFiles()), 'T3');
    expect(result.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['unsupported-engine', 'unsupported-recipe']));
  });

  it('keeps large or missing assets as {{asset}} and says the library does not exist yet', () => {
    const bundle = readJsreportExport(exportFiles());
    const result = importJsreport(
      { ...bundle, templates: [{ ...bundle.templates[0], shortid: 'T1', content: '<img src="{{asset "logo.png" "dataURI"}}"><img src="{{asset "gone.png" "dataURI"}}">' }] },
      'T1',
      { inlineAssetBytes: 2 },
    );
    expect(result.html).toBe('<img src="{{asset "logo.png"}}"><img src="{{asset "gone.png"}}">');
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['asset-large', 'asset-missing']));
    // the reference resolves against the workspace library, so the file has to be uploaded there
    for (const warning of result.warnings.filter((w) => w.code.startsWith('asset-')))
      expect(warning.message).toMatch(/workspace file library/);
  });

  it('finds helper function names in a helpers script', () => {
    expect(helperNames('function a() {}\nasync function b(x) {}\nconst c = (x) => x\nlet d = function () {}\nconst notAHelper = 5')).toEqual(['a', 'b', 'c', 'd']);
  });
});
