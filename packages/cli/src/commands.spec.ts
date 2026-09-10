import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type ProgramContext } from './commands';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const template = {
  id: 'tpl_1',
  slug: 'invoice',
  name: 'Invoice',
  description: null,
  kind: 'pdf',
  engine: 'jinja2',
  tags: [],
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
  html: '<h1>{{ invoice.number }}</h1>',
  css: 'h1 { color: navy }',
  head: '',
  settings: { paper: { format: 'A4' }, footer: { html: '<span class="pageNumber"></span>' } },
  sample_data: { invoice: { number: '42' } },
  data_schema: null,
  i18n: null,
};

function fakeApi() {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === '/v1/auth/device' && call.method === 'POST')
      return json(
        {
          device_code: 'device-secret-0123456789',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        },
        201,
      );
    if (call.path === '/v1/auth/device/token' && call.method === 'POST') {
      const polls = calls.filter((c) => c.path === '/v1/auth/device/token').length;
      if (polls < 2) return json({ status: 'pending', interval: 1 }, 202);
      return json({
        api_key: 'ff_live_from_device',
        workspace: { id: 'ws_1', slug: 'production', name: 'Production', region: 'eu' },
        organization: { id: 'org_1', slug: 'acme', name: 'Acme' },
      });
    }
    if (call.path === '/v1/account') return json({ workspace: { name: 'Production', slug: 'production', region: 'eu' }, organization: { name: 'Acme', slug: 'acme' }, plan: { name: 'Pro' }, units: { used: 3, included: 100 }, environment: 'test' });
    if ((call.path === '/v1/templates' || call.path.startsWith('/v1/templates?')) && call.method === 'GET') return json({ data: [template], next_cursor: null });
    if (call.path === '/v1/templates/invoice') return json(template);
    if (call.path === '/v1/templates/new-one') return json({ code: 'template_not_found', title: 'Not found', status: 404 }, 404);
    if (call.path === '/v1/templates' && call.method === 'POST') return json({ ...template, slug: 'new-one', published_version: null, latest_version: 1 }, 201);
    if (call.path === '/v1/templates/new-one/versions/latest') return json({ ...version, number: 1, status: 'draft', checksum: 'new1' });
    if (call.path === '/v1/templates/invoice/versions/published' || call.path === '/v1/templates/invoice/versions/latest') return json(version);
    if (call.path === '/v1/templates/invoice/versions' && call.method === 'POST') {
      const body = call.body as { base_checksum?: string; publish?: boolean };
      if (body.base_checksum && body.base_checksum !== 'chk2') return json({ code: 'conflict', title: 'Conflict', status: 409, detail: 'changed' }, 409);
      return json({ ...version, number: 3, status: body.publish ? 'published' : 'draft', checksum: 'chk3' }, 201);
    }
    if (call.path === '/v1/renders' && call.method === 'POST') return json({ id: 'rnd_1', status: 'succeeded', page_count: 1, units: 0, download_url: 'https://cdn.test/o/x.pdf' }, 201);
    if (call.path.startsWith('/v1/renders?') && call.method === 'GET')
      return json({ data: [{ id: 'rnd_1', status: 'succeeded', output: 'pdf', page_count: 1, units: 1, created_at: '2026-09-09T10:00:00Z', template: { id: 'tpl_1', slug: 'invoice', version: 2 } }], next_cursor: null });
    if (call.path === '/v1/renders/rnd_1/outputs' && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (String(input).startsWith('https://cdn.test/')) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    return json({ code: 'not_found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('formfeed CLI', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-cli-'));
    out = [];
    err = [];
    api = fakeApi();
    ctx = { cwd: dir, env: { FORMFEED_CONFIG_DIR: join(dir, 'user'), FORMFEED_API_KEY: 'ff_test_k' }, fetch: api.fetchImpl, out: (t) => out.push(t), err: (t) => err.push(t) };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prints help and version without side effects', async () => {
    expect(await run(['--help'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('templates');
    expect(await run(['--version'], ctx)).toBe(0);
  });

  it('needs a project for template commands (exit 2) and a key for API commands (exit 3)', async () => {
    expect(await run(['validate'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('formfeed init');
    expect(await run(['whoami'], { ...ctx, env: { FORMFEED_CONFIG_DIR: join(dir, 'user') } })).toBe(3);
  });

  it('init scaffolds a starter that validates; a bad filter fails validation with exit 1', async () => {
    expect(await run(['init', '--engine', 'liquid'], ctx)).toBe(0);
    expect(existsSync(join(dir, 'formfeed.json'))).toBe(true);
    expect(existsSync(join(dir, 'templates', 'hello', 'template.html'))).toBe(true);
    expect(await run(['validate', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, errors: 0 });

    writeFileSync(join(dir, 'templates', 'hello', 'template.html'), '<p>{{ title | nope }}</p>');
    out = [];
    expect(await run(['validate'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/error.*nope/);
  });

  it('login stores the key after checking the account; whoami reads it', async () => {
    const noKeyCtx = { ...ctx, env: { FORMFEED_CONFIG_DIR: join(dir, 'user') } };
    expect(await run(['login', '--api-key', 'ff_test_abcdefgh'], noKeyCtx), err.join('\n')).toBe(0);
    expect(readFileSync(join(dir, 'user', 'config.json'), 'utf8')).toContain('ff_test_abcdefgh');
    expect(await run(['whoami'], noKeyCtx)).toBe(0);
    expect(out.join('\n')).toContain('Acme (acme) / Production');
    expect(api.calls.filter((c) => c.path === '/v1/account')).toHaveLength(2);
  });

  it('pulls into files, pushes drafts with the base checksum, publishes and detects conflicts', async () => {
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    expect(await run(['templates', 'pull'], ctx), err.join('\n')).toBe(0);
    const tplDir = join(dir, 'templates', 'invoice');
    expect(readFileSync(join(tplDir, 'template.html'), 'utf8')).toBe(version.html);
    expect(readFileSync(join(tplDir, 'footer.html'), 'utf8')).toContain('pageNumber');
    const state = JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8'));
    expect(state.templates.invoice.checksum).toBe('chk2');

    // unchanged: nothing pushed
    out = [];
    expect(await run(['templates', 'push', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ slug: 'invoice', status: 'unchanged' }]);
    expect(api.calls.some((c) => c.path === '/v1/templates/invoice/versions' && c.method === 'POST')).toBe(false);

    // edited: draft with base_checksum, then publish
    writeFileSync(join(tplDir, 'template.html'), '<h1>{{ invoice.number }} v3</h1>');
    out = [];
    expect(await run(['templates', 'push', '--dry-run', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ slug: 'invoice', status: 'modified' }]);
    expect(await run(['templates', 'push', 'invoice', '--message', 'v3', '--publish'], ctx), err.join('\n')).toBe(0);
    const push = api.calls.find((c) => c.path === '/v1/templates/invoice/versions' && c.method === 'POST');
    expect(push?.body).toMatchObject({ html: '<h1>{{ invoice.number }} v3</h1>', base_checksum: 'chk2', change_note: 'v3', publish: true });
    expect(push?.body).toMatchObject({ settings: { footer: { html: expect.stringContaining('pageNumber') } } });

    // remote moved on: 409 unless --force
    writeFileSync(join(dir, '.formfeed', 'state.json'), JSON.stringify({ templates: { invoice: { checksum: 'stale', number: 1, status: 'draft', contentHash: 'x', syncedAt: '' } } }));
    err = [];
    expect(await run(['templates', 'push', 'invoice'], ctx)).toBe(2);
    expect(err.join('\n')).toMatch(/409|changed|Conflict/i);
    expect(await run(['templates', 'push', 'invoice', '--force'], ctx)).toBe(0);
  });

  it('creates the remote template on first push and renders through the API into a file', async () => {
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    const tplDir = join(dir, 'templates', 'new-one');
    await run(['import', 'apitemplate', '--html', writeTmp(dir, 'body.html', '<h1>{{ invoice.number }}</h1>'), '--sample', writeTmp(dir, 'sample.json', '{"invoice": {"number": 1}}'), '--slug', 'new-one', '--name', 'New one'], ctx);
    expect(existsSync(join(tplDir, 'template.json'))).toBe(true);
    expect(await run(['templates', 'push', 'new-one'], ctx), err.join('\n')).toBe(0);
    const create = api.calls.find((c) => c.path === '/v1/templates' && c.method === 'POST');
    expect(create?.body).toMatchObject({ slug: 'new-one', name: 'New one', engine: 'jinja2', kind: 'pdf' });

    expect(await run(['render', 'new-one', '--out', 'out/new-one.pdf'], ctx), err.join('\n')).toBe(0);
    const render = api.calls.find((c) => c.path === '/v1/renders');
    expect((render?.body as { html: string }).html).toContain('<h1>1</h1>');
    expect(readFileSync(join(dir, 'out', 'new-one.pdf')).length).toBe(4);
  });

  it('serves the preview and state from the dev server and closes cleanly', async () => {
    await run(['init'], ctx);
    let server: { url: string; close(): Promise<void> } | null = null;
    const code = await run(['dev', 'hello', '--port', '0'], { ...ctx, onServer: (s) => (server = s) });
    expect(code).toBe(0);
    expect(server).not.toBeNull();
    const base = server!.url;
    const shell = await (await fetch(base + '/')).text();
    expect(shell).toContain('formfeed dev');
    const preview = await (await fetch(base + '/preview?mode=flow')).text();
    expect(preview).toContain('Hello from Formfeed');
    expect(preview).toContain('body.formfeed-preview');
    const paged = await (await fetch(base + '/preview?mode=paged')).text();
    expect(paged).toContain('/vendor/pagedjs/paged.polyfill.min.js');
    const state = await (await fetch(base + '/api/state')).json();
    expect(state).toMatchObject({ slug: 'hello', dataSets: ['default'], trueRender: true, diagnostics: [] });
    const vendor = await fetch(base + '/vendor/pagedjs/paged.polyfill.min.js');
    expect(vendor.status).toBe(200);
    const rendered = await (await fetch(base + '/api/render', { method: 'POST', body: '{}' })).json();
    expect(rendered).toMatchObject({ id: 'rnd_1', status: 'succeeded' });
    await server!.close();
  });

  it('signs in through device authorisation and stores the key it receives', async () => {
    const noKeyCtx = {
      ...ctx,
      env: { FORMFEED_CONFIG_DIR: join(dir, 'user'), CI: '1' },
      wait: async () => undefined,
    };
    expect(await run(['login'], noKeyCtx), err.join(' | ')).toBe(0);
    expect(err.join(' | ')).toContain('ABCD-EFGH');
    expect(err.join(' | ')).toContain('https://app.test/device');
    expect(readFileSync(join(dir, 'user', 'config.json'), 'utf8')).toContain('ff_live_from_device');
    expect(api.calls.filter((c) => c.path === '/v1/auth/device/token')).toHaveLength(2);
    expect(out.join(' | ')).toContain('Acme');
  });

  it('lists renders and deletes their outputs', async () => {
    await run(['init'], ctx);
    expect(await run(['renders', 'list', '--json'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(out.at(-1)!).data[0]).toMatchObject({ id: 'rnd_1', status: 'succeeded' });
    expect(api.calls.some((c) => c.path.startsWith('/v1/renders?') && c.method === 'GET')).toBe(true);

    out = [];
    expect(await run(['renders', 'list', '--status', 'succeeded', '--limit', '5'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('rnd_1');
    expect(api.calls.at(-1)!.path).toContain('status=succeeded');
    expect(api.calls.at(-1)!.path).toContain('limit=5');

    out = [];
    expect(await run(['renders', 'delete-outputs', 'rnd_1'], ctx)).toBe(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/renders/rnd_1/outputs' });
  });

  it('test writes, compares and fails snapshots per data set', async () => {
    await run(['init'], ctx);
    const snapshot = join(dir, 'templates', 'hello', 'tests', '__snapshots__', 'default.html');

    // without an approved snapshot the run passes and says so
    expect(await run(['test', '--json'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, results: [{ slug: 'hello', data: 'default', status: 'no-snapshot' }] });

    out = [];
    expect(await run(['test', '--update-snapshots', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ results: [{ status: 'written' }] });
    expect(existsSync(snapshot)).toBe(true);

    out = [];
    expect(await run(['test', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, results: [{ status: 'passed' }] });

    // a changed template fails with a diff
    writeFileSync(join(dir, 'templates', 'hello', 'template.html'), '<p>Changed body</p>');
    out = [];
    expect(await run(['test'], ctx)).toBe(1);
    expect(out.join('\n')).toContain('+ <p>Changed body</p>');

    // a broken template fails before the snapshot is consulted
    writeFileSync(join(dir, 'templates', 'hello', 'template.html'), '<p>{{ title | nope }}</p>');
    out = [];
    expect(await run(['test'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/error.*nope/);
  });

  it('ci preview renders the templates changed since the base and writes a summary', async () => {
    await run(['init'], ctx);
    const git = (args: string[]) => (args[2]?.startsWith('origin/main') ? 'templates/hello/template.html\nREADME.md\n' : null);

    expect(await run(['ci', 'preview', '--json'], { ...ctx, git }), err.join('\n')).toBe(0);
    const result = JSON.parse(out.at(-1)!);
    expect(result).toMatchObject({ base: 'origin/main', templates: [{ slug: 'hello', status: 'succeeded', pages: 1 }] });
    expect(existsSync(join(dir, 'formfeed-preview', 'hello.pdf'))).toBe(true);
    const summary = readFileSync(join(dir, 'formfeed-preview.md'), 'utf8');
    expect(summary).toContain('| `hello` | default | 1 |');
    expect(api.calls.some((c) => c.path === '/v1/renders' && c.method === 'POST')).toBe(true);

    // nothing changed: no renders, summary says so
    out = [];
    const calls = api.calls.length;
    expect(await run(['ci', 'preview'], { ...ctx, git: () => 'README.md\n' })).toBe(0);
    expect(api.calls).toHaveLength(calls);
    expect(readFileSync(join(dir, 'formfeed-preview.md'), 'utf8')).toContain('No template changes');

    // a changed partial previews every template
    out = [];
    expect(await run(['ci', 'preview', '--json'], { ...ctx, git: () => 'partials/footer.html\n' })).toBe(0);
    expect(JSON.parse(out.at(-1)!).templates).toHaveLength(1);
  });
});

function writeTmp(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
