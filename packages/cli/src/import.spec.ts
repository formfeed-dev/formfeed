import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { run, type ProgramContext } from './commands';

// `formfeed import pdfmonkey|jsreport`: the conversions are the engine's (tested there); these tests
// cover the I/O around them: PDFMonkey's API, the export zip and writing template folders.

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
