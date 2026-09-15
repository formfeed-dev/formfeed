import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type ProgramContext } from './commands';
import { forwardDelivery, type WebSocketLike } from './lib/listen';

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

const brand = {
  version: 5,
  name: 'Fennlor Studio GmbH',
  colors: { primary: '#0f766e' },
  fonts: { heading: 'Inter', body: null },
  font_size: null,
  logo: { primary: 'https://cdn.test/a/brand/org_1/primary-3f9a1c2b7d4e.svg', inverse: null, mark: null },
  legal_footer: 'Fennlor Studio GmbH · HRB 00000',
  page_defaults: { paper: { format: 'A4' } },
  updated_at: '2026-09-13T00:00:00Z',
};
const sharedPartial = {
  name: 'letterhead',
  engine: 'jinja2',
  description: null,
  version: 3,
  source: '<header>{{ brand.name }}</header>',
  created_at: '2026-09-13T00:00:00Z',
  updated_at: '2026-09-13T00:00:00Z',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const remoteFiles = [
  { id: 'fil_logo', name: 'logo.png', content_type: 'image/png', bytes: 8, sha256: sha(PNG), url: 'https://cdn.test/a/ws_1/logo.png', created_at: '2026-09-12T10:00:00Z', updated_at: '2026-09-12T10:00:00Z' },
  { id: 'fil_terms', name: 'terms.pdf', content_type: 'application/pdf', bytes: 5, sha256: 'remote-only', url: 'https://cdn.test/a/ws_1/terms.pdf', created_at: '2026-09-12T10:00:00Z', updated_at: '2026-09-12T10:00:00Z' },
];

const renderInputs: Record<string, Record<string, unknown>> = {
  rnd_abc123: {
    template: { id: 'tpl_1', slug: 'invoice', version: 1, channel: 'published' },
    data: { invoice: { number: 'INV-7' }, customer: { name: 'Jane Doe', email: 'jane@mail.test' }, total: 99.5 },
    locale: 'de-DE',
  },
  rnd_bad001: {
    template: { id: 'tpl_1', slug: 'invoice', version: 2 },
    data: { invoice: { number: 42 } },
  },
  rnd_other1: { template: { id: 'tpl_2', slug: 'receipt', version: 1 }, data: {} },
};

function fakeApi() {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined,
    };
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
        organization: { id: 'org_1', slug: 'fennlor', name: 'Fennlor' },
      });
    }
    if (call.path === '/v1/account') return json({ workspace: { name: 'Production', slug: 'production', region: 'eu' }, organization: { name: 'Fennlor', slug: 'fennlor' }, plan: { name: 'Pro' }, units: { used: 3, included: 100 }, environment: 'test' });
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
    // the workspace library: logo.png is in sync with the PNG below, terms.pdf exists only remotely
    if (call.path.startsWith('/v1/files') && call.method === 'GET')
      return json({ data: remoteFiles, next_cursor: null });
    if (call.path === '/v1/files' && call.method === 'POST') {
      const form = call.body as FormData;
      const name = String(form.get('name'));
      return json({ id: 'fil_new', name, content_type: 'image/png', bytes: 8, sha256: 'x', url: `https://cdn.test/a/ws_1/${name}`, created_at: '', updated_at: '' }, 201);
    }
    if (call.path === '/v1/files/fil_terms' && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (String(input) === 'https://cdn.test/a/ws_1/terms.pdf') return new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200 });
    // brand kit and shared partials: letterhead is at v3 remotely
    if (call.path === '/v1/brand') return json(brand);
    if (call.path === '/v1/partials' && call.method === 'GET') return json({ data: [{ ...sharedPartial, source: undefined }] });
    if (call.path === '/v1/partials/letterhead' && call.method === 'GET') return json(sharedPartial);
    if (call.path.startsWith('/v1/partials/') && call.method === 'PUT') {
      const body = call.body as { engine: string; source: string; base_version?: number };
      const name = call.path.slice('/v1/partials/'.length);
      if (name === 'letterhead') {
        if (body.base_version !== undefined && body.base_version !== 3) return json({ code: 'conflict', title: 'Conflict', status: 409, detail: 'The partial changed since the base version' }, 409);
        return json({ ...sharedPartial, engine: body.engine, source: body.source, version: 4 });
      }
      return json({ ...sharedPartial, name, engine: body.engine, source: body.source, version: 1 }, 201);
    }
    // release channels of invoice: published on v2, staging on v3; moving to v9 breaks the stored schema
    if (call.path === '/v1/templates/invoice/channels' && call.method === 'GET')
      return json({
        data: [
          { name: 'published', version: 2, canary: null, previous_version: 1, updated_at: '2026-09-13T00:00:00Z', usage_24h: [{ version: 2, renders: 5, failed: 1 }] },
          { name: 'staging', version: 3, canary: { version: 4, percent: 10 }, previous_version: null, updated_at: '2026-09-13T00:00:00Z', usage_24h: [] },
        ],
        limits: { channels: 2, canary: false },
      });
    if (call.path.startsWith('/v1/templates/invoice/channels/') && call.method === 'PUT') {
      const body = call.body as { version: number; canary?: { version: number; percent: number } | null; allow_breaking?: boolean };
      const name = call.path.split('/').at(-1);
      const breaking = [{ path: 'customer.email', pointer: '/properties/customer/properties/email', kind: 'field-became-required', breaking: true, message: '"customer.email" is now required' }];
      if (body.version === 9 && !body.allow_breaking)
        return json({ code: 'schema_breaking_change', title: 'Schema change breaks callers', status: 409, detail: `Moving channel "${name}" would break callers of the current version`, breaking, safe: [] }, 409);
      return json({ name, version: body.version, canary: body.canary ?? null, previous_version: 2, updated_at: '2026-09-13T00:00:00Z', schema_check: { source: 'stored', breaking: body.version === 9 ? breaking : [], safe: [] } });
    }
    if (/^\/v1\/templates\/invoice\/channels\/staging\/(promote|rollback)$/.test(call.path) && call.method === 'POST')
      return json({ name: 'staging', version: 4, canary: null, previous_version: 3, updated_at: '2026-09-13T00:00:00Z', schema_check: { source: 'none', breaking: [], safe: [] } });
    if (call.path.startsWith('/v1/templates/invoice/channels/staging') && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path === '/v1/templates/invoice/versions/3') return json({ ...version, number: 3, status: 'draft', checksum: 'chk3' });
    if (call.path === '/v1/renders' && call.method === 'POST') return json({ id: 'rnd_1', status: 'succeeded', page_count: 1, units: 0, download_url: 'https://cdn.test/o/x.pdf' }, 201);
    if (call.path.startsWith('/v1/renders?') && call.method === 'GET')
      return json({ data: [{ id: 'rnd_1', status: 'succeeded', output: 'pdf', page_count: 1, units: 1, created_at: '2026-09-09T10:00:00Z', template: { id: 'tpl_1', slug: 'invoice', version: 2 } }], next_cursor: null });
    if (call.path === '/v1/renders/rnd_1/outputs' && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path === '/v1/workspaces/ws_preview' && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path === '/v1/workspaces/ws_last' && call.method === 'DELETE')
      return json({ code: 'last_workspace', title: 'Last workspace', status: 409, detail: 'last one' }, 409);
    // stored render requests (spec 20 §3): abc123 succeeded on v1, bad001 failed, gone00 is past retention
    const inputMatch = /^\/v1\/renders\/(\w+)\/input$/.exec(call.path);
    if (inputMatch) {
      const renderId = inputMatch[1]!;
      if (renderId === 'rnd_gone00')
        return json({ code: 'render_input_expired', title: 'Render input expired', status: 410, detail: 'gone', request_data_retention: '24h' }, 410);
      if (renderId === 'rnd_html01') return json({ render_id: renderId, html: '<p>x</p>', environment: 'live', created_at: '' });
      const input = renderInputs[renderId];
      return input ? json({ render_id: renderId, environment: 'live', created_at: '2026-09-13T10:00:00Z', ...input }) : json({ code: 'not_found', status: 404 }, 404);
    }
    if (call.path === '/v1/renders/rnd_abc123') return json({ id: 'rnd_abc123', status: 'succeeded' });
    if (call.path === '/v1/renders/rnd_bad001') return json({ id: 'rnd_bad001', status: 'failed' });
    // listen sessions: every start is a new session with a new secret
    if (call.path === '/v1/webhooks/listen' && call.method === 'POST') {
      const n = calls.filter((c) => c.path === '/v1/webhooks/listen' && c.method === 'POST').length;
      const body = (call.body ?? {}) as { events?: string[]; live?: boolean };
      return json(
        {
          id: `ses_${n}`,
          secret: `whsec_session${n}`,
          events: body.events ?? ['render.completed', 'render.failed', 'job.completed', 'job.failed', 'quota.warning', 'quota.exceeded'],
          environments: body.live ? ['live', 'test'] : ['test'],
          expires_at: '2026-09-13T10:02:00Z',
          websocket_url: `wss://relay.test/v1/webhooks/listen/ses_${n}/connect?ticket=t${n}`,
        },
        201,
      );
    }
    if (call.path.startsWith('/v1/webhooks/listen/') && call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.path === '/v1/webhooks/events/evt_gone/resend')
      return json({ code: 'listen_session_ended', title: 'Listen session ended', status: 410, detail: 'ended' }, 410);
    if (call.path === '/v1/webhooks/events/evt_1/resend' && call.method === 'POST')
      return json({ delivery_id: 'del_9', event_id: 'evt_1', event: 'render.completed', endpoint_id: (call.body as { endpoint_id: string }).endpoint_id }, 202);
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
    expect(out.join('\n')).toContain('Fennlor (fennlor) / Production');
    expect(api.calls.filter((c) => c.path === '/v1/account')).toHaveLength(2);
  });

  it('login stores a valid key without account:read and refuses a rejected one', async () => {
    const noKeyCtx = (fetchImpl: typeof fetch) => ({ ...ctx, env: { FORMFEED_CONFIG_DIR: join(dir, 'user') }, fetch: fetchImpl });
    const answering = (status: number, code: string) =>
      (async () =>
        new Response(JSON.stringify({ code, title: code, status, detail: `answered ${status}` }), {
          status,
          headers: { 'content-type': 'application/problem+json' },
        })) as typeof fetch;

    expect(await run(['login', '--api-key', 'ff_live_renderonly'], noKeyCtx(answering(403, 'forbidden'))), err.join('\n')).toBe(0);
    expect(readFileSync(join(dir, 'user', 'config.json'), 'utf8')).toContain('ff_live_renderonly');
    expect(out.join('\n')).toContain('Signed in with a live key. It lacks the account:read scope');

    rmSync(join(dir, 'user'), { recursive: true, force: true });
    expect(await run(['login', '--api-key', 'ff_live_revoked'], noKeyCtx(answering(401, 'unauthorized')))).toBe(3);
    expect(existsSync(join(dir, 'user', 'config.json'))).toBe(false);
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

  it('pushes the partials a template includes and refuses one without a file', async () => {
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    await run(['templates', 'pull'], ctx);
    const tplDir = join(dir, 'templates', 'invoice');
    writeFileSync(join(tplDir, 'template.html'), '<h1>{{ invoice.number }}</h1>{% include "footer" %}');

    // the include has no file yet: push refuses instead of publishing a template that fails
    err = [];
    expect(await run(['templates', 'push', 'invoice'], ctx)).toBe(1);
    expect(err.join('\n')).toMatch(/includes "footer"/);

    mkdirSync(join(dir, 'partials'), { recursive: true });
    writeFileSync(join(dir, 'partials', 'footer.html'), '<footer>Fennlor</footer>');
    expect(await run(['templates', 'push', 'invoice'], ctx), err.join('\n')).toBe(0);
    const push = api.calls.findLast((c) => c.path === '/v1/templates/invoice/versions' && c.method === 'POST');
    expect(push?.body).toMatchObject({ partials: { footer: '<footer>Fennlor</footer>' } });
  });

  it('pulls the brand kit and renders, tests and previews with it', async () => {
    await run(['init'], ctx);
    writeFileSync(join(dir, 'templates', 'hello', 'template.html'), '<footer>{{ brand.legal_footer }}</footer>');

    // without brand.json the template renders with the empty kit
    expect(await run(['test', '--update-snapshots'], ctx), err.join('\n')).toBe(0);
    const snapshot = join(dir, 'templates', 'hello', 'tests', '__snapshots__', 'default.html');
    expect(readFileSync(snapshot, 'utf8')).toContain('<footer></footer>');

    expect(await run(['brand', 'pull'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, '.formfeed', 'brand.json'), 'utf8'))).toEqual(brand);
    expect(out.join('\n')).toContain('brand v5 (Fennlor Studio GmbH)');

    // the approved snapshot no longer matches: the brand is part of the output
    out = [];
    expect(await run(['test'], ctx)).toBe(1);
    expect(out.join('\n')).toContain('+ <footer>Fennlor Studio GmbH · HRB 00000</footer>');
    expect(await run(['validate'], ctx)).toBe(0);

    expect(await run(['render', 'hello', '--out', join(dir, 'hello.pdf')], ctx), err.join('\n')).toBe(0);
    const sent = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/renders')!.body as { html: string };
    expect(sent.html).toContain('<footer>Fennlor Studio GmbH · HRB 00000</footer>');
    expect(sent.html).toContain('--brand-color-primary: #0f766e;');

    let server: { url: string; close(): Promise<void> } | null = null;
    await run(['dev', 'hello', '--port', '0'], { ...ctx, onServer: (s) => (server = s) });
    expect(await (await fetch(server!.url + '/preview?mode=flow')).text()).toContain('Fennlor Studio GmbH · HRB 00000');
    await server!.close();

    // a broken kit file is a validation error, not a crash
    writeFileSync(join(dir, '.formfeed', 'brand.json'), '{');
    expect(await run(['validate'], ctx)).toBe(1);
  });

  it('pulls, lists and pushes shared partials with their remote version', async () => {
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    await run(['templates', 'pull'], ctx);

    expect(await run(['partials', 'pull', 'nope'], ctx)).toBe(2);
    expect(await run(['partials', 'pull'], ctx), err.join('\n')).toBe(0);
    const file = join(dir, 'partials', 'letterhead.html');
    expect(readFileSync(file, 'utf8')).toBe(sharedPartial.source);
    const state = JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8'));
    expect(state.sharedPartials.letterhead).toMatchObject({ version: 3, engine: 'jinja2' });
    expect(state.templates.invoice.checksum).toBe('chk2');

    out = [];
    expect(await run(['partials', 'list', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject([{ name: 'letterhead', version: 3, local: 'v3' }]);

    // a template that includes the shared partial pushes without it and without a missing-partial error
    const tplDir = join(dir, 'templates', 'invoice');
    writeFileSync(join(tplDir, 'template.html'), '{% include "letterhead" %}<h1>{{ invoice.number }}</h1>');
    expect(await run(['validate', 'invoice'], ctx), out.join('\n')).toBe(0);
    expect(await run(['templates', 'push', 'invoice'], ctx), err.join('\n')).toBe(0);
    const version = api.calls.findLast((c) => c.path === '/v1/templates/invoice/versions' && c.method === 'POST');
    expect(version?.body).not.toHaveProperty('partials');

    // unchanged partials are not pushed; an edit goes up with base_version
    out = [];
    expect(await run(['partials', 'push', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ name: 'letterhead', engine: 'jinja2', status: 'unchanged', version: 3 }]);
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);

    writeFileSync(file, '<header>{{ brand.name }} v4</header>');
    out = [];
    expect(await run(['partials', 'push', '--dry-run', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ name: 'letterhead', engine: 'jinja2', status: 'modified' }]);
    expect(await run(['partials', 'push'], ctx), err.join('\n')).toBe(0);
    expect(api.calls.findLast((c) => c.method === 'PUT')).toMatchObject({
      path: '/v1/partials/letterhead',
      body: { engine: 'jinja2', source: '<header>{{ brand.name }} v4</header>', base_version: 3 },
    });
    expect(JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8')).sharedPartials.letterhead.version).toBe(4);

    // the remote moved on since the recorded version: conflict exit code unless --force
    const stale = JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8'));
    stale.sharedPartials.letterhead.version = 2;
    stale.sharedPartials.letterhead.contentHash = 'edited';
    writeFileSync(join(dir, '.formfeed', 'state.json'), JSON.stringify(stale));
    err = [];
    expect(await run(['partials', 'push', 'letterhead'], ctx)).toBe(2);
    expect(err.join('\n')).toMatch(/changed remotely since v2/);
    expect(await run(['partials', 'push', 'letterhead', '--force'], ctx), err.join('\n')).toBe(0);
    expect(api.calls.findLast((c) => c.method === 'PUT')?.body).not.toHaveProperty('base_version');

    // a new partial is created with the engine flag; an existing remote one is not overwritten blindly
    writeFileSync(join(dir, 'partials', 'footer-note.html'), '{{ brand.legal_footer }}');
    out = [];
    expect(await run(['partials', 'push', 'footer-note', '--engine', 'liquid', '--json'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([{ name: 'footer-note', engine: 'liquid', status: 'created', version: 1 }]);
    expect(api.calls.findLast((c) => c.method === 'PUT')).toMatchObject({ path: '/v1/partials/footer-note', body: { engine: 'liquid', source: '{{ brand.legal_footer }}' } });

    const withoutLetterhead = JSON.parse(readFileSync(join(dir, '.formfeed', 'state.json'), 'utf8'));
    delete withoutLetterhead.sharedPartials.letterhead;
    writeFileSync(join(dir, '.formfeed', 'state.json'), JSON.stringify(withoutLetterhead));
    err = [];
    expect(await run(['partials', 'push', 'letterhead'], ctx)).toBe(2);
    expect(err.join('\n')).toMatch(/exists already/);
    expect(await run(['partials', 'push', 'Bad Name'], ctx)).toBe(2);
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

  it('pushes new and changed library files, pulls the missing ones and deletes by name', async () => {
    await run(['init'], ctx);
    mkdirSync(join(dir, 'files', 'brand'), { recursive: true });
    writeFileSync(join(dir, 'files', 'logo.png'), PNG); // same bytes as remote: unchanged
    writeFileSync(join(dir, 'files', 'brand', 'header.png'), PNG); // new
    writeFileSync(join(dir, 'files', 'notes.txt'), 'not an image'); // refused locally

    expect(await run(['files', 'push', '--dry-run'], ctx)).toBe(0);
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/files')).toBe(false);
    expect(out.join('\n')).toContain('brand/header.png: new (dry run)');
    expect(err.join('\n')).toContain('notes.txt: not an image or a PDF');

    out.length = 0;
    expect(await run(['files', 'push'], ctx)).toBe(0);
    const uploads = api.calls.filter((c) => c.method === 'POST' && c.path === '/v1/files');
    expect(uploads).toHaveLength(1);
    expect((uploads[0]!.body as FormData).get('name')).toBe('brand/header.png');
    expect(out.join('\n')).toContain('logo.png: unchanged');

    out.length = 0;
    expect(await run(['files', 'pull'], ctx)).toBe(0);
    expect(readFileSync(join(dir, 'files', 'terms.pdf'))).toEqual(Buffer.from([37, 80, 68, 70, 45]));
    expect(out.join('\n')).toContain('terms.pdf: pulled');

    expect(await run(['files', 'delete', 'terms.pdf'], ctx)).toBe(0);
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/files/fil_terms')).toBe(true);
    expect(await run(['files', 'delete', 'nothing.png'], ctx)).toBe(2);
  });

  it('resolves asset() against the files folder in dev and against the library for API renders', async () => {
    await run(['init'], ctx);
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'logo.png'), PNG);
    writeFileSync(join(dir, 'templates', 'hello', 'template.html'), `<img src="{{ asset('logo.png') }}">`);

    let server: { url: string; close(): Promise<void> } | null = null;
    await run(['dev', 'hello', '--port', '0'], { ...ctx, onServer: (s) => (server = s) });
    const preview = await (await fetch(server!.url + '/preview?mode=flow')).text();
    expect(preview).toContain(`${server!.url}/files/logo.png`);
    const served = await fetch(server!.url + '/files/logo.png');
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect((await fetch(server!.url + '/files/..%2Fformfeed.json')).status).toBe(404);
    await server!.close();

    expect(await run(['render', 'hello', '--output', 'webp', '--out', join(dir, 'hello.webp')], ctx)).toBe(0);
    const sent = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/renders')!.body as { html: string; output: string };
    expect(sent.output).toBe('webp');
    expect(sent.html).toContain('https://cdn.test/a/ws_1/logo.png');
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
    expect(out.join(' | ')).toContain('Fennlor');
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

  it('workspaces delete needs --yes and reports a refused last workspace', async () => {
    expect(await run(['workspaces', 'delete', 'ws_preview'], ctx)).toBe(2);
    expect(api.calls.some((c) => c.path.startsWith('/v1/workspaces'))).toBe(false);
    expect(await run(['workspaces', 'delete', 'ws_preview', '--yes'], ctx), err.join('\n')).toBe(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/workspaces/ws_preview' });
    expect(await run(['workspaces', 'delete', 'ws_last', '--yes'], ctx)).not.toBe(0);
    expect(err.join('\n')).toContain('last one');
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

  it('types writes TypeScript and Python from the project, checks for drift and reads the API outside one', async () => {
    await run(['init'], ctx);
    const hello = join(dir, 'templates', 'hello');
    writeFileSync(
      join(hello, 'schema.json'),
      JSON.stringify({ type: 'object', required: ['title'], properties: { title: { type: 'string' }, customer: { type: 'object', properties: { name: { type: 'string' } } } } }),
    );
    expect(await run(['types'], ctx), err.join('\n')).toBe(0);
    const dts = readFileSync(join(dir, 'formfeed.d.ts'), 'utf8');
    expect(dts).toContain('declare module "@formfeed/sdk"');
    expect(dts).toContain('"hello": HelloData;');
    expect(dts).toContain('title: string;');
    expect(dts).toContain('customer?: HelloCustomer;');

    // --check passes on the written file and fails once the schema moves on
    expect(await run(['types', '--check'], ctx)).toBe(0);
    writeFileSync(join(hello, 'schema.json'), JSON.stringify({ type: 'object', properties: { title: { type: 'number' } } }));
    err = [];
    expect(await run(['types', '--check'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('out of date');

    expect(await run(['types', '--lang', 'python', '--out', 'gen/templates.py'], ctx)).toBe(0);
    expect(readFileSync(join(dir, 'gen', 'templates.py'), 'utf8')).toContain('class HelloData(TypedDict):');
    expect(await run(['types', '--lang', 'go'], ctx)).toBe(2);

    // outside a project: the published versions from the API, inferred from sample data when no schema is stored
    const outside = mkdtempSync(join(tmpdir(), 'formfeed-types-'));
    try {
      out = [];
      expect(await run(['types', '--json'], { ...ctx, cwd: outside }), err.join('\n')).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ lang: 'ts', templates: [{ slug: 'invoice', origin: 'inferred', version: 2 }] });
      expect(readFileSync(join(outside, 'formfeed.d.ts'), 'utf8')).toContain('invoice?: InvoiceInvoice;');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lists and moves release channels, refuses a breaking move without --allow-breaking, and pushes to a channel', async () => {
    expect(await run(['channels', 'list', 'invoice'], ctx), err.join('\n')).toBe(0);
    expect(out.join('\n')).toMatch(/staging\s+v3\s+v4 10%/);
    expect(out.join('\n')).toContain('5 (1 failed)');

    out = [];
    expect(await run(['channels', 'set', 'invoice', 'staging', '3', '--canary', '4', '--percent', '10'], ctx), err.join('\n')).toBe(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/templates/invoice/channels/staging', body: { version: 3, canary: { version: 4, percent: 10 } } });
    expect(out.join('\n')).toContain('invoice: channel staging -> v3, canary v4 at 10%');
    expect(await run(['channels', 'set', 'invoice', 'staging', '3', '--canary', '4'], ctx)).toBe(2);

    err = [];
    expect(await run(['channels', 'set', 'invoice', 'staging', '9'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('"customer.email" is now required');
    expect(err.join('\n')).toContain('--allow-breaking');
    out = [];
    expect(await run(['channels', 'set', 'invoice', 'staging', '9', '--allow-breaking'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('breaking change (allowed): "customer.email" is now required');

    expect(await run(['channels', 'promote', 'invoice', 'staging'], ctx)).toBe(0);
    expect(await run(['channels', 'rollback', 'invoice', 'staging', '--allow-breaking'], ctx)).toBe(0);
    expect(api.calls.at(-1)).toMatchObject({ path: '/v1/templates/invoice/channels/staging/rollback', body: { allow_breaking: true } });
    expect(await run(['channels', 'delete', 'invoice', 'staging', '--force'], ctx)).toBe(0);
    expect(api.calls.at(-1)?.path).toBe('/v1/templates/invoice/channels/staging?force=true');

    // push creates the version, then points the channel at it
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    await run(['templates', 'pull'], ctx);
    writeFileSync(join(dir, 'templates', 'invoice', 'template.html'), '<h1>{{ invoice.number }} v3</h1>');
    out = [];
    expect(await run(['templates', 'push', 'invoice', '--channel', 'staging', '--json'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([expect.objectContaining({ slug: 'invoice', number: 3, channel: 'staging' })]);
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/templates/invoice/channels/staging', body: { version: 3 } });
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

/** A relay WebSocket in memory: the test plays the gateway through `message` and `drop`. */
class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number; reason?: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000, reason = ''): void {
    this.closedWith = code;
    this.fire('close', { code, reason });
  }
  message(body: unknown): void {
    this.fire('message', { data: JSON.stringify(body) });
  }
  drop(code: number, reason = ''): void {
    this.fire('close', { code, reason });
  }
  private fire(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function receiver(handler: RequestListener) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolveServer) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function recordingHandler(received: Received[], status = 200): RequestListener {
  return (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.statusCode = body.includes('"render.failed"') ? 500 : status;
      res.end('ok');
    });
  };
}

const deliveryBody = (type: string, id: string) => JSON.stringify({ id: `evt_${id}`, type, created_at: '2026-09-13T10:04:11Z', data: { id } });
const relayedHeaders = {
  'content-type': 'application/json',
  'user-agent': 'Formfeed-Webhooks/1.0',
  'webhook-id': 'evt_x',
  'webhook-timestamp': '1789293851',
  'webhook-attempt': '1',
  'webhook-signature': 't=1789293851,v1=abc',
};

describe('formfeed CLI: local webhooks and render to test (spec 20)', () => {
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
    ctx = {
      cwd: dir,
      env: { FORMFEED_CONFIG_DIR: join(dir, 'user'), FORMFEED_API_KEY: 'ff_test_k' },
      fetch: api.fetchImpl,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      wait: async () => undefined,
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pulledProject = async () => {
    await run(['init'], ctx);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    expect(await run(['templates', 'pull'], ctx), err.join('\n')).toBe(0);
    err = [];
    out = [];
    return join(dir, 'templates', 'invoice');
  };

  it('renders pull writes the data set, warns about the version and personal data, and refuses to overwrite', async () => {
    const tplDir = await pulledProject();
    expect(await run(['renders', 'pull', 'rnd_abc123'], ctx), err.join('\n')).toBe(0);
    const file = join(tplDir, 'data', 'render-abc123.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(renderInputs['rnd_abc123']!['data']);
    expect(err.join('\n')).toContain('used invoice v1, the local folder is at v2');
    expect(err.join('\n')).toContain('may contain personal data');

    expect(await run(['renders', 'pull', 'rnd_abc123'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('--force');

    // everything redacted, shape and numbers kept
    err = [];
    expect(await run(['renders', 'pull', 'rnd_abc123', '--force', '--redact'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ invoice: { number: 'AAA-0' }, customer: { name: 'Aaaa Aaa', email: 'aaaa@aaaa.aaaa' }, total: 99.5 });
    expect(err.join('\n')).not.toContain('personal data');

    // only the named paths
    out = [];
    expect(await run(['renders', 'pull', 'rnd_abc123', '--as', 'customer-only', '--redact', 'customer.*', '--json'], ctx), err.join('\n')).toBe(0);
    expect(JSON.parse(readFileSync(join(tplDir, 'data', 'customer-only.json'), 'utf8'))).toEqual({
      invoice: { number: 'INV-7' },
      customer: { name: 'Aaaa Aaa', email: 'aaaa@aaaa.aaaa' },
      total: 99.5,
    });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ template: 'invoice', version: 1, local_version: 2, data_set: 'customer-only', redacted: ['customer.*'] });

    // formfeed.json pull.redact applies without the flag; --no-redact skips it
    const config = JSON.parse(readFileSync(join(dir, 'formfeed.json'), 'utf8'));
    writeFileSync(join(dir, 'formfeed.json'), JSON.stringify({ ...config, pull: { redact: ['invoice.number'] } }));
    expect(await run(['renders', 'pull', 'rnd_abc123', '--as', 'configured'], ctx)).toBe(0);
    expect(JSON.parse(readFileSync(join(tplDir, 'data', 'configured.json'), 'utf8'))).toMatchObject({ invoice: { number: 'AAA-0' }, customer: { email: 'jane@mail.test' } });
    expect(await run(['renders', 'pull', 'rnd_abc123', '--as', 'raw', '--no-redact'], ctx)).toBe(0);
    expect(JSON.parse(readFileSync(join(tplDir, 'data', 'raw.json'), 'utf8'))).toMatchObject({ invoice: { number: 'INV-7' } });
  });

  it('renders pull explains expired inputs, ad-hoc renders and missing template folders', async () => {
    await pulledProject();
    expect(await run(['renders', 'pull', 'rnd_gone00'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('Settings → Keep render requests');
    expect(err.join('\n')).toContain('24 hours');

    err = [];
    expect(await run(['renders', 'pull', 'rnd_html01'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('not a template');

    err = [];
    expect(await run(['renders', 'pull', 'rnd_other1'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('formfeed templates pull receipt');
    expect(await run(['renders', 'pull', 'rnd_nope00'], ctx)).toBe(2);
    expect(await run(['renders', 'pull', 'rnd_abc123'], { ...ctx, cwd: tmpdir() })).toBe(2);
  });

  it('renders pull --run reproduces a failure with line and column, and --snapshot turns a good render into a test', async () => {
    const tplDir = await pulledProject();
    writeFileSync(join(tplDir, 'template.html'), '<main>\n  <h1>{{ invoice.number.toUpperCase() }}</h1>\n</main>');
    expect(await run(['validate', 'invoice'], ctx), out.join('\n')).toBe(0);

    out = [];
    expect(await run(['renders', 'pull', 'rnd_bad001', '--run'], ctx)).toBe(1);
    expect(out.join('\n')).toMatch(/error\s+invoice\/template\.html:2:36 {2}Unable to call/);
    expect(existsSync(join(tplDir, 'data', 'render-bad001.json'))).toBe(true);

    // a failed render is no reference output
    err = [];
    expect(await run(['renders', 'pull', 'rnd_bad001', '--as', 'again', '--snapshot'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('failed');
    expect(existsSync(join(tplDir, 'data', 'again.json'))).toBe(false);

    out = [];
    expect(await run(['renders', 'pull', 'rnd_abc123', '--snapshot', '--run'], ctx), err.join('\n')).toBe(0);
    const snapshot = join(tplDir, 'tests', '__snapshots__', 'render-abc123.html');
    expect(readFileSync(snapshot, 'utf8')).toContain('INV-7');
    expect(out.join('\n')).toContain('renders with render-abc123 without errors');
    out = [];
    expect(await run(['test', 'invoice', '--data', 'render-abc123', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, results: [{ data: 'render-abc123', status: 'passed' }] });
  });

  it('listen forwards deliveries, answers with the local status, records the session for resend, reconnects with a new secret and ends on Ctrl+C', async () => {
    const received: Received[] = [];
    const local = await receiver(recordingHandler(received));
    const sockets: FakeSocket[] = [];
    const controller = new AbortController();
    try {
      const listening = run(['listen', '--forward-to', `${local.url}/webhooks`, '--events', 'render.completed,render.failed'], {
        ...ctx,
        connect: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
        signal: controller.signal,
        now: () => new Date(2026, 8, 13, 12, 4, 11),
      });
      await until(() => sockets.length === 1, 'the first connection');
      expect(sockets[0]!.url).toBe('wss://relay.test/v1/webhooks/listen/ses_1/connect?ticket=t1');
      expect(api.calls.find((c) => c.path === '/v1/webhooks/listen')?.body).toEqual({ events: ['render.completed', 'render.failed'] });

      sockets[0]!.message({ type: 'ready', session: 'ses_1' });
      expect(out.join('\n')).toContain(`Ready. Forwarding test-environment events of workspace "Production" to ${local.url}/webhooks`);
      expect(out.join('\n')).toContain('Webhook signing secret: whsec_session1');

      const body = deliveryBody('render.completed', 'rnd_8Hk2');
      sockets[0]!.message({ type: 'delivery', id: 'del_1', headers: relayedHeaders, body });
      sockets[0]!.message({ type: 'delivery', id: 'del_2', headers: { ...relayedHeaders, 'webhook-attempt': '2' }, body: deliveryBody('render.failed', 'rnd_Q1a9') });
      await until(() => sockets[0]!.sent.length === 2, 'two results');
      expect(sockets[0]!.sent).toEqual(
        expect.arrayContaining([
          { type: 'result', id: 'del_1', status: 200, ms: expect.any(Number) },
          { type: 'result', id: 'del_2', status: 500, ms: expect.any(Number) },
        ]),
      );
      const first = received.find((r) => r.body === body)!;
      expect(first.path).toBe('/webhooks');
      expect(first.headers).toMatchObject({ 'webhook-signature': 't=1789293851,v1=abc', 'webhook-id': 'evt_x', 'content-type': 'application/json' });
      expect(out.join('\n')).toMatch(/12:04:11 {2}render\.completed {2}rnd_8Hk2 {2}→ 200 \(\d+ ms\) {2}evt_rnd_8Hk2/);
      expect(out.join('\n')).toMatch(/render\.failed\s+rnd_Q1a9 {2}→ 500 \(\d+ ms\) {2}attempt 2/);

      // resend without --to finds the running session of this key
      expect(await run(['webhooks', 'resend', 'evt_1'], ctx), err.join('\n')).toBe(0);
      expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/webhooks/events/evt_1/resend', body: { endpoint_id: 'ses_1' } });

      // the socket drops: a new session with a new secret, announced loudly
      sockets[0]!.drop(1006);
      await until(() => sockets.length === 2, 'the reconnect');
      expect(sockets[1]!.url).toContain('ses_2');
      sockets[1]!.message({ type: 'ready', session: 'ses_2' });
      expect(out.join('\n')).toContain('The signing secret changed, update your server: whsec_session2');
      expect(err.join('\n')).toContain('reconnecting');
      expect(await run(['webhooks', 'resend', 'evt_1'], ctx)).toBe(0);
      expect(api.calls.at(-1)?.body).toEqual({ endpoint_id: 'ses_2' });

      controller.abort();
      expect(await listening).toBe(0);
      expect(sockets[1]!.closedWith).toBe(1000);
      expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/webhooks/listen/ses_2' });
      expect(existsSync(join(dir, 'user', 'listen'))).toBe(true);
      expect(await run(['webhooks', 'resend', 'evt_1'], ctx)).toBe(2);
      expect(err.join('\n')).toContain('No formfeed listen is running');
    } finally {
      controller.abort();
      await local.close();
    }
  });

  it('listen exits when the session is ended in the app or taken over, prints JSON lines and reports an unreachable server as status 0', async () => {
    const sockets: FakeSocket[] = [];
    const connect = (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    };
    // nothing listens on this port
    const closed = await receiver(() => undefined);
    await closed.close();

    const ended = run(['listen', '--json', '--live', '--forward-to', `${closed.url}/hooks`], { ...ctx, connect });
    await until(() => sockets.length === 1, 'the connection');
    expect(api.calls.find((c) => c.path === '/v1/webhooks/listen')?.body).toEqual({ live: true });
    sockets[0]!.message({ type: 'ready', session: 'ses_1' });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ type: 'ready', reconnected: false, secret: 'whsec_session1', environments: ['live', 'test'] });
    sockets[0]!.message({ type: 'delivery', id: 'del_1', headers: relayedHeaders, body: deliveryBody('render.completed', 'rnd_1') });
    await until(() => sockets[0]!.sent.length === 1, 'the result');
    expect(sockets[0]!.sent[0]).toMatchObject({ type: 'result', id: 'del_1', status: 0, error: expect.stringMatching(/ECONNREFUSED/) });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ type: 'delivery', event: 'render.completed', object_id: 'rnd_1', event_id: 'evt_rnd_1', status: 0 });
    sockets[0]!.message({ type: 'ended', reason: 'ended_by_user' });
    sockets[0]!.drop(4000, 'ended');
    expect(await ended).toBe(0);
    expect(err.join('\n')).toContain('ended in the app (ended_by_user)');

    const replaced = run(['listen'], { ...ctx, connect });
    await until(() => sockets.length === 2, 'the second connection');
    sockets[1]!.drop(4001);
    expect(await replaced).toBe(2);
    expect(err.join('\n')).toContain('took over');

    // the socket never opens: give up after the retries with the network exit code
    const failing = run(['listen'], { ...ctx, connect: () => { throw new Error('getaddrinfo ENOTFOUND relay.test'); } });
    expect(await failing).toBe(4);
    expect(err.join('\n')).toContain('ENOTFOUND');
  });

  it('listen --print-secret prints only the secret and ends the session; --skip-verify reaches a self-signed https server', async () => {
    expect(await run(['listen', '--print-secret'], ctx), err.join('\n')).toBe(0);
    expect(out).toEqual(['whsec_session1']);
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/webhooks/listen/ses_1' });
    expect(await run(['listen', '--forward-to', 'ftp://x'], ctx)).toBe(2);

    const tls = selfSignedCertificate(dir);
    if (!tls) return; // openssl is not installed; CI has it
    const received: Received[] = [];
    const server = createHttpsServer(tls, recordingHandler(received));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    try {
      expect(await forwardDelivery(url, { headers: relayedHeaders, body: '{}' })).toMatchObject({ status: 0, error: expect.stringMatching(/self.signed|certificate/i) });
      expect(await forwardDelivery(url, { headers: relayedHeaders, body: '{}' }, { skipVerify: true })).toMatchObject({ status: 200 });
      expect(received).toHaveLength(1);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('webhooks resend needs a target and explains an ended session; trigger makes an async test render', async () => {
    expect(await run(['webhooks', 'resend', 'evt_1'], ctx)).toBe(2);
    expect(await run(['webhooks', 'resend', 'evt_1', '--to', 'end_1', '--json'], ctx)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ delivery_id: 'del_9', endpoint_id: 'end_1' });
    err = [];
    expect(await run(['webhooks', 'resend', 'evt_gone', '--to', 'ses_old'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('has ended');

    expect(await run(['trigger', 'render.failed', '--template', 'invoice'], ctx)).toBe(2);
    expect(err.join('\n')).toContain('webhooks resend');

    // outside a project: the published sample data
    out = [];
    expect(await run(['trigger', 'render.completed', '--template', 'invoice'], ctx), err.join('\n')).toBe(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/renders', body: { template: 'invoice', mode: 'async', data: version.sample_data } });
    expect(out.join('\n')).toContain('Queued rnd_1 (test render of invoice)');

    // a data file, and a warning for a live key
    writeFileSync(join(dir, 'data.json'), '{"invoice": {"number": "T-1"}}');
    err = [];
    expect(await run(['trigger', 'render.completed', '--template', 'invoice', '--data', 'data.json'], { ...ctx, env: { ...ctx.env, FORMFEED_API_KEY: 'ff_live_k' } })).toBe(0);
    expect(api.calls.at(-1)?.body).toMatchObject({ data: { invoice: { number: 'T-1' } } });
    expect(err.join('\n')).toContain('live key');
  });
});

/** A throwaway certificate for 127.0.0.1, made with openssl at test time; null without openssl. */
function selfSignedCertificate(dir: string): { key: string; cert: string } | null {
  const key = join(dir, 'tls-key.pem');
  const cert = join(dir, 'tls-cert.pem');
  const result = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  if (result.status !== 0 || !existsSync(cert)) return null;
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

function writeTmp(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
