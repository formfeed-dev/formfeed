import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { starterDocument } from '@formfeed/engine';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { run, type ProgramContext } from './commands';

// Word templates in the CLI (spec 22 §7): template folders with template.docx, pull and push of the
// document, offline validation and snapshots, local fill with conversion through the API, pdf convert.

const starter = starterDocument('jinja2');
const DOCX = starter.bytes;
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A Word document of one paragraph per text. */
function docx(...paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
  });
}

const template = {
  id: 'tpl_offer',
  slug: 'offer',
  name: 'Offer',
  description: null,
  kind: 'docx',
  engine: 'jinja2',
  tags: ['sales'],
  published_version: 2,
  latest_version: 2,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
};
const version = {
  id: 'v2',
  number: 2,
  status: 'published',
  checksum: 'chk2',
  change_note: null,
  created_at: '2026-09-08T00:00:00Z',
  published_at: '2026-09-08T00:00:00Z',
  html: '',
  css: '',
  head: '',
  settings: { locale: 'de-DE' },
  sample_data: starter.sampleData,
  data_schema: null,
  i18n: null,
  source_file: { sha256: sha(DOCX), bytes: DOCX.length, format: 'docx' },
};

interface Call {
  method: string;
  url: string;
  path: string;
  body: unknown;
}

function fakeApi() {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const rendered = { id: 'rnd_pdf', status: 'succeeded', output: 'pdf', page_count: 1, units: 1, download_url: 'https://cdn.test/o/offer.pdf' };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      path: url.pathname + url.search,
      body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (url.hostname === 'cdn.test') return new Response(PDF, { status: 200 });
    if (call.path.startsWith('/v1/files')) return json({ data: [], next_cursor: null });
    if (call.path === '/v1/templates' && call.method === 'GET') return json({ data: [template], next_cursor: null });
    if (call.path === '/v1/templates' && call.method === 'POST') return json({ ...template, slug: 'new-offer', published_version: null, latest_version: 1 }, 201);
    if (call.path === '/v1/templates/offer') return json(template);
    if (call.path === '/v1/templates/new-offer') return json({ code: 'template_not_found', title: 'Not found', status: 404 }, 404);
    if (call.path === '/v1/templates/new-offer/versions/latest') return json({ ...version, number: 1, status: 'draft', checksum: 'new1' });
    if (call.path === '/v1/templates/offer/versions/published' || call.path === '/v1/templates/offer/versions/latest') return json(version);
    if (call.path === '/v1/templates/offer/versions/2/file')
      return new Response(DOCX, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    if (call.path === '/v1/templates/offer/versions' && call.method === 'POST') return json({ ...version, number: 3, status: 'draft', checksum: 'chk3' }, 201);
    if (call.path === '/v1/renders/rnd_offer') return json({ ...rendered, id: 'rnd_offer', output: 'docx' });
    if (call.path === '/v1/renders/rnd_offer/input')
      return json({
        render_id: 'rnd_offer',
        environment: 'live',
        created_at: '2026-09-16T10:00:00Z',
        template: { id: 'tpl_offer', slug: 'offer', version: 2 },
        data: { ...starter.sampleData, customer: { name: 'Olvarest GmbH' } },
        locale: 'de-DE',
        options: {},
      });
    if (call.path === '/v1/pdf/convert' && call.method === 'POST') return json(rendered);
    if (call.path === '/v1/renders' && call.method === 'POST') return json({ ...rendered, id: 'rnd_docx', output: 'docx', download_url: 'https://cdn.test/o/offer.docx' }, 201);
    return json({ code: 'not_found', title: 'Not found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('formfeed CLI: Word and PowerPoint templates', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;
  let api: ReturnType<typeof fakeApi>;
  const tplDir = () => join(dir, 'templates', 'offer');
  const posts = (path: string) => api.calls.filter((c) => c.method === 'POST' && c.path === path);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-office-'));
    out = [];
    err = [];
    api = fakeApi();
    ctx = { cwd: dir, env: { FORMFEED_CONFIG_DIR: join(dir, 'user'), FORMFEED_API_KEY: 'ff_test_k' }, fetch: api.fetchImpl, out: (t) => out.push(t), err: (t) => err.push(t) };
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('pulls the document of the pulled version, validates it offline and pushes nothing unchanged', async () => {
    expect(await run(['templates', 'pull'], ctx), err.join('\n')).toBe(0);
    expect(new Uint8Array(readFileSync(join(tplDir(), 'template.docx')))).toEqual(DOCX);
    expect(existsSync(join(tplDir(), 'template.html'))).toBe(false);
    expect(JSON.parse(readFileSync(join(tplDir(), 'template.json'), 'utf8'))).toMatchObject({ kind: 'docx' });
    const state = JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8'));
    expect(state.templates.offer).toMatchObject({ checksum: 'chk2', fileSha256: sha(DOCX) });

    out = [];
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out.join('\n')).toContain('1 template(s) valid');

    out = [];
    expect(await run(['templates', 'push', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ slug: 'offer', status: 'unchanged' }]);

    out = [];
    expect(await run(['templates', 'diff', 'offer'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('offer: no changes against v2');
  });

  it('pulls the data of a render of a Word template and snapshots its filled XML', async () => {
    await run(['templates', 'pull'], ctx);
    expect(await run(['renders', 'pull', 'rnd_offer', '--as', 'olvarest', '--no-redact', '--snapshot'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(join(tplDir(), 'data', 'olvarest.json'), 'utf8'))).toMatchObject({ customer: { name: 'Olvarest GmbH' } });
    const snapshot = readFileSync(join(tplDir(), 'tests', '__snapshots__', 'olvarest.xml'), 'utf8');
    expect(snapshot).toContain('Olvarest GmbH');
  });

  it('pushes a data change as JSON and a new document as multipart', async () => {
    await run(['templates', 'pull'], ctx);
    writeFileSync(join(tplDir(), 'data', 'default.json'), JSON.stringify({ ...starter.sampleData, extra: 1 }));
    expect(await run(['templates', 'push', 'offer'], ctx), err.join('\n')).toBe(0);
    const dataOnly = posts('/v1/templates/offer/versions')[0]!;
    expect(dataOnly.body).not.toBeInstanceOf(FormData);
    expect(dataOnly.body).toMatchObject({ sample_data: { extra: 1 }, base_checksum: 'chk2' });
    expect(dataOnly.body).not.toHaveProperty('html');

    const changed = docx('{{ customer.name }} signs here');
    writeFileSync(join(tplDir(), 'template.docx'), changed);
    out = [];
    expect(await run(['templates', 'diff', 'offer'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('offer/template.docx: differs from the document of v2');
    expect(await run(['templates', 'push', 'offer', '--publish'], ctx), err.join('\n')).toBe(0);
    const form = posts('/v1/templates/offer/versions')[1]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('publish')).toBe('true');
    expect(form.get('base_checksum')).toBe('chk3');
    expect(JSON.parse(String(form.get('sample_data')))).toMatchObject({ extra: 1 });
    const file = form.get('file') as File;
    expect(file.name).toBe('offer.docx');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(changed);
  });

  it('creates a Word template on its first push', async () => {
    const folder = join(dir, 'templates', 'new-offer');
    await run(['templates', 'pull'], ctx);
    rmSync(folder, { recursive: true, force: true });
    // a copy of the pulled folder under a new slug
    mkdirSync(folder, { recursive: true });
    for (const name of ['template.docx', 'template.json', 'settings.json']) writeFileSync(join(folder, name), readFileSync(join(tplDir(), name)));
    expect(await run(['templates', 'push', 'new-offer'], ctx), err.join('\n')).toBe(0);
    const form = posts('/v1/templates')[0]!.body as FormData;
    expect(form.get('kind')).toBe('docx');
    expect(form.get('slug')).toBe('new-offer');
    expect(form.get('tags')).toBe('["sales"]');
    expect((form.get('file') as File).size).toBe(DOCX.length);
  });

  it('reports problems per part and paragraph and refuses a folder with two sources', async () => {
    await run(['templates', 'pull'], ctx);
    writeFileSync(join(tplDir(), 'template.docx'), docx('Hello', '{{ customer.name | nope }}'));
    expect(await run(['validate'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/error\s+offer\/template\.docx › word\/document\.xml ¶2 .*nope/);

    writeFileSync(join(tplDir(), 'template.html'), '<p>x</p>');
    err = [];
    expect(await run(['validate', 'offer'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('holds template.html and template.docx');
  });

  it('fills the document locally, with its QR code, and converts it through the API for PDF', async () => {
    await run(['templates', 'pull'], ctx);
    expect(await run(['render', 'offer', '--output', 'docx'], ctx), err.join('\n')).toBe(0);
    expect(posts('/v1/pdf/convert')).toHaveLength(0);
    expect(posts('/v1/renders')).toHaveLength(0);
    const filled = unzipSync(new Uint8Array(readFileSync(join(dir, 'offer.docx'))));
    const document = strFromU8(filled['word/document.xml']!);
    expect(document).toContain(String((starter.sampleData as { customer: { name: string } }).customer.name));
    expect(document).not.toContain('{{');
    // the starter's QR code, drawn by resvg as on the render-worker
    expect(Object.keys(filled).some((name) => /^word\/media\/formfeed\d+\.png$/.test(name))).toBe(true);
    expect(out.join('\n')).toContain('filled locally');

    // a Word template renders to Word unless its settings or --output say PDF
    expect(await run(['render', 'offer', '--output', 'pdf', '--out', 'out/offer.pdf'], ctx), err.join('\n')).toBe(0);
    const convert = posts('/v1/pdf/convert')[0]!;
    const form = convert.body as FormData;
    expect((form.get('file') as File).name).toBe('offer.docx');
    expect(JSON.parse(String(form.get('meta')))).toEqual({ source: 'formfeed render', template: 'offer' });
    expect(new Uint8Array(readFileSync(join(dir, 'out', 'offer.pdf')))).toEqual(PDF);

    err = [];
    expect(await run(['render', 'offer', '--output', 'png'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('renders to docx or pdf');

    expect(await run(['render', 'offer', '--remote', '--output', 'docx', '--out', 'remote.docx'], ctx), err.join('\n')).toBe(0);
    expect(posts('/v1/renders')[0]?.body).toMatchObject({ template: 'offer', output: 'docx' });
    expect(existsSync(join(dir, 'remote.docx'))).toBe(true);
  });

  it('snapshots the filled XML and fails on a changed document', async () => {
    await run(['templates', 'pull'], ctx);
    const snapshot = join(tplDir(), 'tests', '__snapshots__', 'default.xml');
    expect(await run(['test', '--update-snapshots'], ctx), out.join('\n')).toBe(0);
    const text = readFileSync(snapshot, 'utf8');
    expect(text).toMatch(/^--- word\/document\.xml ---\n/);
    expect(text).toMatch(/\n {2,}<w:t[^>]*>[^<]+<\/w:t>\n/);

    out = [];
    expect(await run(['test', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, results: [{ slug: 'offer', data: 'default', status: 'passed' }] });

    writeFileSync(join(tplDir(), 'template.docx'), docx('Offer for {{ customer.name }}'));
    out = [];
    expect(await run(['test'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/\+ .*Offer for /);
  });

  it('pdf convert uploads a file or names a render, and refuses anything else', async () => {
    const sheet = join(dir, 'report.xlsx');
    writeFileSync(sheet, new Uint8Array([1, 2, 3]));
    expect(await run(['pdf', 'convert', 'report.xlsx', '--landscape', '--page-ranges', '1-2'], ctx), err.join('\n')).toBe(0);
    const form = posts('/v1/pdf/convert')[0]!.body as FormData;
    expect((form.get('file') as File).name).toBe('report.xlsx');
    expect(form.get('landscape')).toBe('true');
    expect(form.get('page_ranges')).toBe('1-2');
    expect(form.get('filename')).toBe('report.pdf');
    expect(new Uint8Array(readFileSync(join(dir, 'report.pdf')))).toEqual(PDF);

    expect(await run(['pdf', 'convert', 'rnd_docx1', '--no-download', '--json'], ctx)).toBe(0);
    expect(posts('/v1/pdf/convert')[1]!.body).toMatchObject({ source: 'rnd_docx1', filename: 'rnd_docx1.pdf' });
    expect(existsSync(join(dir, 'rnd_docx1.pdf'))).toBe(false);

    expect(await run(['pdf', 'convert', 'missing.docx'], ctx)).toBe(2);
    expect(await run(['pdf', 'convert', 'report.xlsx', '--page-ranges', 'all'], ctx)).toBe(2);
  });

  it('dev lists the findings and shows the converted true render', async () => {
    await run(['templates', 'pull'], ctx);
    let server: { url: string; close(): Promise<void> } | null = null;
    expect(await run(['dev', 'offer', '--port', '0'], { ...ctx, onServer: (s) => (server = s) })).toBe(0);
    const base = server!.url;
    try {
      const state = await (await fetch(base + '/api/state')).json();
      expect(state).toMatchObject({ slug: 'offer', kind: 'docx', office: true, trueRender: true, diagnostics: [] });
      const page = await (await fetch(base + '/preview')).text();
      expect(page).toContain('There is no local preview of Word documents');
      const rendered = await (await fetch(base + '/api/render', { method: 'POST', body: '{}' })).json();
      expect(rendered).toMatchObject({ id: 'rnd_pdf', download_url: 'https://cdn.test/o/offer.pdf' });
      expect(posts('/v1/pdf/convert')).toHaveLength(1);
    } finally {
      await server!.close();
    }
  });
});
