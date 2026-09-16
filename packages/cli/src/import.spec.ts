import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { run, type ProgramContext } from './commands';

// `formfeed import apitemplate|pdfmonkey|jsreport`: the conversions are the engine's (tested there); these tests
// cover the I/O around them: apitemplate.io's and PDFMonkey's APIs, the export zip and writing template folders.

const pdfmonkeyTemplate = {
  id: 'pm-1',
  identifier: 'Order confirmation',
  edition_mode: 'code',
  output_type: 'pdf',
  body: '<h1>{{ order.id }}</h1><p>{{ order.date | date: "%d.%m.%Y" }}</p>',
  scss_style: '$accent: #c00;\nh1 { color: $accent; }',
  sample_data: '{"order": {"id": "A-1", "date": "2026-09-10"}}',
  settings: { paper_format: 'letter', margin: { top: 15 } },
};

function pdfmonkeyApi() {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, auth });
    if (auth !== 'Bearer sk_pm') return json({ errors: [{ detail: 'unauthorized' }] }, 401);
    if (url.includes('/document_template_cards?'))
      return json({ document_template_cards: [{ id: 'pm-1', identifier: 'Order confirmation', edition_mode: 'code' }, { id: 'pm-2', identifier: 'Builder', edition_mode: 'builder' }], meta: { current_page: 1, total_pages: 1 } });
    if (url.endsWith('/document_templates/pm-1')) return json({ document_template: pdfmonkeyTemplate });
    return json({ errors: [] }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function apitemplateApi() {
  const calls: Array<{ url: string; key: string | null }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const templates: Record<string, Record<string, unknown>> = {
    'aaa111': { status: 'success', template_id: 'aaa111', body: '<h1>{{ project.name }}</h1>', css: 'h1 { color: red }', settings: JSON.stringify({ paper_size: 'A4', margin_top: '20' }), sample_json: '{"project": {"name": "Solar"}}' },
    'bbb222': { status: 'success', template_id: 'bbb222', body: '<p>{{ total }}</p>', css: '', settings: '' },
    'ccc333': { status: 'success', template_id: 'ccc333', body: '', css: '', settings: '' },
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = new Headers(init?.headers).get('x-api-key');
    calls.push({ url, key });
    if (key !== 'at_key') return json({ status: 'error', message: 'Invalid API key' }, 403);
    if (url.includes('/v2/list-templates?'))
      return json({
        status: 'success',
        templates: [
          { template_id: 'aaa111', name: 'overview-MDS', format: 'PDF', group_name: 'MDS' },
          { template_id: 'bbb222', name: 'overview MDS', format: 'PDF', group_name: 'MDS' },
          { template_id: 'ccc333', name: 'broken', format: 'PDF', group_name: 'solario' },
          { template_id: 'ddd444', name: 'social card', format: 'JPEG', group_name: 'MDS' },
        ],
      });
    const id = /get-template\?template_id=(\w+)/.exec(url)?.[1] ?? '';
    return templates[id] ? json(templates[id]) : json({ status: 'error', message: 'Template not found' }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('formfeed import', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-import-'));
    out = [];
    err = [];
    ctx = { cwd: dir, env: { FORMFEED_CONFIG_DIR: join(dir, 'user') }, out: (t) => out.push(t), err: (t) => err.push(t) };
    await run(['init'], ctx);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('imports the code templates of a PDFMonkey workspace into template folders', async () => {
    const api = pdfmonkeyApi();
    const code = await run(['import', 'pdfmonkey', '--key', 'sk_pm', '--workspace-id', 'ws-9', '--json'], { ...ctx, fetch: api.fetchImpl });
    expect(code, err.join('\n')).toBe(0);
    // the Builder template is skipped, the code template read by id
    expect(api.calls.map((c) => c.url)).toEqual([
      'https://api.pdfmonkey.io/api/v1/document_template_cards?q[workspace_id]=ws-9&q[folders]=all&page=1',
      'https://api.pdfmonkey.io/api/v1/document_templates/pm-1',
    ]);
    const [result] = JSON.parse(out.at(-1) ?? '[]') as Array<{ slug: string; engine: string; errors: unknown[] }>;
    expect(result).toMatchObject({ slug: 'order-confirmation', engine: 'liquid', errors: [] });
    const tplDir = join(dir, 'templates', 'order-confirmation');
    expect(readFileSync(join(tplDir, 'template.html'), 'utf8')).toContain('date: "dd.MM.yyyy"');
    // compiled by `sass` when one resolves from the project, converted without it otherwise
    const css = readFileSync(join(tplDir, 'style.css'), 'utf8');
    expect(css.replace(/\s+/g, ' ')).toContain('h1 { color: #c00; }');
    expect(css).not.toContain('$accent');
    expect(JSON.parse(readFileSync(join(tplDir, 'template.json'), 'utf8'))).toMatchObject({ engine: 'liquid', tags: ['imported', 'pdfmonkey'] });
    expect(await run(['validate', 'order-confirmation'], ctx), out.join('\n')).toBe(0);
  });

  it('needs a PDFMonkey key and reports a rejected one as an auth failure', async () => {
    expect(await run(['import', 'pdfmonkey', '--template', 'pm-1'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('PDFMONKEY_API_KEY');
    const api = pdfmonkeyApi();
    expect(await run(['import', 'pdfmonkey', '--template', 'pm-1'], { ...ctx, fetch: api.fetchImpl, env: { ...ctx.env, PDFMONKEY_API_KEY: 'wrong' } })).toBe(3);
  });

  it('reads the PDF templates of an apitemplate.io group with the API key', async () => {
    const api = apitemplateApi();
    const code = await run(['import', 'apitemplate', '--group', 'mds', '--source-region', 'de', '--json'], {
      ...ctx,
      fetch: api.fetchImpl,
      env: { ...ctx.env, APITEMPLATE_API_KEY: 'at_key' },
    });
    expect(code, err.join('\n')).toBe(0);
    // the JPEG layer design is not read; both hosts are the region's
    expect(api.calls.map((c) => c.url)).toEqual([
      'https://rest-de.apitemplate.io/v2/list-templates?limit=300&offset=0',
      'https://rest-de.apitemplate.io/v2/get-template?template_id=aaa111',
      'https://rest-de.apitemplate.io/v2/get-template?template_id=bbb222',
    ]);
    const report = JSON.parse(out.at(-1) ?? '{}') as { imported: Array<{ slug: string; template_id: string }>; failed: unknown[] };
    // both names give the slug overview-mds; the second gets its own folder
    expect(report.imported.map((r) => [r.slug, r.template_id])).toEqual([
      ['overview-mds', 'aaa111'],
      ['overview-mds-2', 'bbb222'],
    ]);
    const tplDir = join(dir, 'templates', 'overview-mds');
    expect(readFileSync(join(tplDir, 'template.html'), 'utf8')).toBe('<h1>{{ project.name }}</h1>');
    expect(JSON.parse(readFileSync(join(tplDir, 'settings.json'), 'utf8'))).toMatchObject({ paper: { format: 'A4' }, margin: { top: '20px' } });
    expect(JSON.parse(readFileSync(join(tplDir, 'template.json'), 'utf8'))).toMatchObject({ name: 'overview-MDS', engine: 'jinja2', tags: ['imported', 'apitemplate'] });
    expect(JSON.parse(readFileSync(join(tplDir, 'data', 'default.json'), 'utf8'))).toEqual({ project: { name: 'Solar' } });
    expect(await run(['validate', 'overview-mds'], ctx), out.join('\n')).toBe(0);
  });

  it('reports apitemplate.io templates without HTML and fails when nothing was imported', async () => {
    const api = apitemplateApi();
    const withKey = { ...ctx, fetch: api.fetchImpl };
    expect(await run(['import', 'apitemplate', '--key', 'at_key', '--template', 'aaa111', 'ccc333', 'zzz999'], withKey), err.join('\n')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Imported overview-MDS (jinja2)');
    expect(text).toMatch(/failed broken \(ccc333\): apitemplate\.io returned no HTML/);
    expect(text).toMatch(/failed zzz999 \(zzz999\): apitemplate\.io: Template not found/);
    expect(existsSync(join(dir, 'templates', 'broken'))).toBe(false);
    expect(await run(['import', 'apitemplate', '--key', 'at_key', '--template', 'ccc333'], withKey)).toBe(1);
  });

  it('needs an apitemplate.io key, a selection and a known region', async () => {
    expect(await run(['import', 'apitemplate', '--all'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('APITEMPLATE_API_KEY');
    expect(await run(['import', 'apitemplate', '--key', 'at_key'], ctx)).toBe(2);
    expect(await run(['import', 'apitemplate', '--key', 'at_key', '--all', '--source-region', 'mars'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('Unknown apitemplate.io region "mars"');
    expect(await run(['import', 'apitemplate', '--all', '--html', 'body.html'], ctx)).toBe(2);
    const api = apitemplateApi();
    expect(await run(['import', 'apitemplate', '--all', '--key', 'wrong'], { ...ctx, fetch: api.fetchImpl })).toBe(3);
    expect(err.join('\n')).toContain('Invalid API key');
    expect(api.calls).toHaveLength(1);
  });

  it('imports the Handlebars chrome-pdf templates of a jsreport export', async () => {
    const entity = (e: Record<string, unknown>) => strToU8(JSON.stringify(e));
    const zip = zipSync({
      'metadata.json': strToU8(JSON.stringify({ reporterVersion: '4.7.0' })),
      'templates/receipt-t1.json': entity({
        _id: 't1',
        shortid: 'T1',
        name: 'receipt',
        engine: 'handlebars',
        recipe: 'chrome-pdf',
        content: '<h1>{{number}}</h1>',
        chrome: { format: 'A5', marginTop: '1cm' },
        data: { shortid: 'D1' },
      }),
      'templates/sheet-t2.json': entity({ _id: 't2', shortid: 'T2', name: 'sheet', engine: 'handlebars', recipe: 'html-to-xlsx', content: '<table></table>' }),
      'data/receipt data-d1.json': entity({ _id: 'd1', shortid: 'D1', name: 'receipt data', dataJson: '{"number": "R-1"}' }),
    });
    writeFileSync(join(dir, 'export.jsrexport'), zip);
    expect(await run(['import', 'jsreport', 'export.jsrexport', '--json'], ctx), err.join('\n')).toBe(0);
    const results = JSON.parse(out.at(-1) ?? '[]') as Array<{ slug: string; engine: string }>;
    expect(results.map((r) => r.slug)).toEqual(['receipt']);
    const tplDir = join(dir, 'templates', 'receipt');
    expect(readFileSync(join(tplDir, 'template.html'), 'utf8')).toBe('<h1>{{number}}</h1>');
    expect(JSON.parse(readFileSync(join(tplDir, 'data', 'default.json'), 'utf8'))).toEqual({ number: 'R-1' });
    expect(JSON.parse(readFileSync(join(tplDir, 'settings.json'), 'utf8'))).toMatchObject({ paper: { format: 'A5' }, margin: { top: '1cm' } });

    writeFileSync(join(dir, 'broken.jsrexport'), 'not a zip');
    expect(await run(['import', 'jsreport', 'broken.jsrexport'], ctx)).toBe(2);
  });
});
