import { Formfeed, FormfeedError } from './client';
import { parseWebhookEvent, verifyWebhookSignature } from './webhooks';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(responder: (call: Call, attempt: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      // multipart uploads stay FormData so tests can read the parts; everything else is JSON
      body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return responder(call, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const templateRow = {
  id: 'tpl_1',
  slug: 'invoice',
  name: 'Invoice',
  description: null,
  kind: 'pdf',
  engine: 'jinja2',
  tags: [],
  published_version: 2,
  latest_version: 3,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
};

const render = { id: 'rnd_1', status: 'succeeded', download_url: 'https://cdn.test/o/x.pdf?exp=1&sig=2', page_count: 1 };

describe('Formfeed client', () => {
  it('sends the key, an idempotency key and the region host', async () => {
    const { calls, fetchImpl } = stub(() => json(render));
    const client = new Formfeed({ apiKey: 'ff_test_k', region: 'us', fetch: fetchImpl });
    const result = await client.renders.create({ template: 'invoice', data: { a: 1 } });
    expect(result.id).toBe('rnd_1');
    expect(calls[0]!.url).toBe('https://api-us.formfeed.dev/v1/renders');
    expect(calls[0]!.headers['authorization']).toBe('Bearer ff_test_k');
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S+/);
    expect(calls[0]!.body).toEqual({ template: 'invoice', data: { a: 1 } });
  });

  it('retries 429 and 503 with Retry-After and then surfaces problems as typed errors', async () => {
    const { calls, fetchImpl } = stub((_, attempt) =>
      attempt === 1
        ? json({ code: 'rate_limited' }, 429, { 'retry-after': '0' })
        : attempt === 2
          ? json({ code: 'region_unavailable' }, 503)
          : json(render),
    );
    const client = new Formfeed({ apiKey: 'k', baseUrl: 'http://gw.test/v1', fetch: fetchImpl, maxRetries: 3 });
    const result = await client.renders.get('rnd_1');
    expect(result.status).toBe('succeeded');
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.headers['idempotency-key'] === undefined)).toBe(true);

    const failing = stub(() => json({ code: 'template_not_found', detail: 'No template "x"', status: 404 }, 404, { 'x-request-id': 'req_9' }));
    const client2 = new Formfeed({ apiKey: 'k', baseUrl: 'http://gw.test/v1', fetch: failing.fetchImpl });
    await expect(client2.renders.create({ template: 'x' })).rejects.toMatchObject({
      name: 'FormfeedError',
      code: 'template_not_found',
      status: 404,
      requestId: 'req_9',
    });
    const err = await client2.renders.create({ template: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormfeedError);
    expect((err as FormfeedError).message).toBe('No template "x"');
  });

  it('waits for async renders and jobs and downloads outputs', async () => {
    let polls = 0;
    const { calls, fetchImpl } = stub((call) => {
      if (call.url.endsWith('/renders') && call.method === 'POST') return json({ ...render, status: 'queued', download_url: null });
      if (call.url.endsWith('/renders/rnd_1')) return json(++polls < 2 ? { ...render, status: 'rendering', download_url: null } : render);
      if (call.url.endsWith('/renders/batch')) return json({ id: 'job_1', status: 'queued', items: [] });
      if (call.url.endsWith('/jobs/job_1')) return json({ id: 'job_1', status: 'completed', zip_url: 'https://cdn.test/z.zip' });
      if (call.url.startsWith('https://cdn.test/o/')) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
      return json({ code: 'not_found' }, 404);
    });
    const client = new Formfeed({ apiKey: 'k', baseUrl: 'http://gw.test/v1', fetch: fetchImpl });
    const queued = await client.renders.create({ template: 'invoice', mode: 'async' });
    expect(queued.status).toBe('queued');
    const done = await client.renders.waitFor(queued.id, { intervalMs: 1 });
    expect(done.status).toBe('succeeded');
    const bytes = await client.renders.download(done);
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    const job = await client.renders.batch({ template: 'invoice', items: [{ data: { a: 1 } }], zip: true });
    const finished = await client.jobs.waitFor(job.id, { intervalMs: 1 });
    expect(finished.zip_url).toContain('z.zip');
    expect(calls.filter((c) => c.url.endsWith('/renders/rnd_1'))).toHaveLength(2);
  });

  it('manages webhooks and treats 204 as success', async () => {
    const { calls, fetchImpl } = stub((call) => {
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      if (call.method === 'POST' && call.url.endsWith('/webhooks')) return json({ id: 'w1', url: call.body ? (call.body as { url: string }).url : '', secret: 'whsec_x' }, 201);
      return json({ data: [{ id: 'w1' }] });
    });
    const client = new Formfeed({ apiKey: 'k', baseUrl: 'http://gw.test/v1', fetch: fetchImpl });
    const created = await client.webhooks.create({ url: 'https://hooks.example/x', events: ['render.completed'] });
    expect(created.secret).toBe('whsec_x');
    expect(await client.webhooks.list()).toEqual([{ id: 'w1' }]);
    await expect(client.webhooks.delete('w1')).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE']);
  });
});

describe('render inputs, resend and listen sessions', () => {
  it('reads a stored render request and maps an expired one to a typed error', async () => {
    const input = { render_id: 'rnd_1', template: { id: 'tpl_1', slug: 'invoice', version: 3 }, data: { n: 1 }, environment: 'test', created_at: '' };
    const { calls, fetchImpl } = stub((call) =>
      call.url.endsWith('/renders/rnd_2/input')
        ? json({ code: 'render_input_expired', status: 410, detail: 'gone', request_data_retention: 'off' }, 410)
        : json(input),
    );
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    expect(await client.renders.input('rnd_1')).toEqual(input);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api-eu.formfeed.dev/v1/renders/rnd_1/input' });
    await expect(client.renders.input('rnd_2')).rejects.toMatchObject({
      code: 'render_input_expired',
      status: 410,
      problem: { request_data_retention: 'off' },
    });
  });

  it('resends an event and starts and ends a listen session', async () => {
    const session = { id: 's1', secret: 'whsec_s', events: ['render.completed'], environments: ['test'], expires_at: '', websocket_url: 'wss://gw.test/x' };
    const { calls, fetchImpl } = stub((call) => {
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      if (call.url.endsWith('/resend')) return json({ delivery_id: 'd1', event_id: 'evt_1', event: 'render.completed', endpoint_id: 's1' }, 202);
      if (call.url.endsWith('/webhooks/listen')) return json(session, 201);
      return json({ id: 'w1', environments: (call.body as { environments?: string[] }).environments });
    });
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });

    expect(await client.webhooks.resend('evt_1', 's1')).toMatchObject({ delivery_id: 'd1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api-eu.formfeed.dev/v1/webhooks/events/evt_1/resend', body: { endpoint_id: 's1' } });

    expect(await client.webhooks.listen.start({ events: ['render.completed'], live: false })).toEqual(session);
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api-eu.formfeed.dev/v1/webhooks/listen', body: { events: ['render.completed'], live: false } });
    await client.webhooks.listen.start();
    expect(calls[2]!.body).toEqual({});
    await expect(client.webhooks.listen.end('s1')).resolves.toBeUndefined();
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: 'https://api-eu.formfeed.dev/v1/webhooks/listen/s1' });

    const updated = await client.webhooks.update('w1', { environments: ['live'] });
    expect(updated.environments).toEqual(['live']);
    expect(calls[4]).toMatchObject({ method: 'PUT', body: { environments: ['live'] } });
  });
});

describe('brand kit and shared partials', () => {
  const brand = {
    version: 7,
    name: 'Fennlor Studio GmbH',
    colors: { primary: '#0f766e' },
    fonts: { heading: 'Inter', body: null },
    font_size: '10pt',
    logo: { primary: 'https://cdn.test/a/brand/org/primary-3f9a1c2b7d4e.svg', inverse: null, mark: null },
    legal_footer: 'Fennlor Studio GmbH',
    page_defaults: { paper: { format: 'A4' } },
    updated_at: '2026-09-13T00:00:00Z',
  };
  const partial = { name: 'letterhead', engine: 'jinja2', description: null, version: 3, created_at: '', updated_at: '' };

  it('reads the brand kit', async () => {
    const { calls, fetchImpl } = stub(() => json(brand));
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    expect(await client.brand.get()).toEqual(brand);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api-eu.formfeed.dev/v1/brand' });
  });

  it('lists, reads, creates, updates and deletes partials', async () => {
    const { calls, fetchImpl } = stub((call) => {
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      if (call.method === 'PUT') {
        const body = call.body as { source: string; base_version?: number };
        return json({ ...partial, source: body.source, version: body.base_version ? body.base_version + 1 : 1 }, body.base_version ? 200 : 201);
      }
      if (call.url.endsWith('/partials')) return json({ data: [partial] });
      return json({ ...partial, source: '<header>Fennlor</header>' });
    });
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });

    expect(await client.partials.list()).toEqual([partial]);
    expect((await client.partials.get('letterhead')).source).toBe('<header>Fennlor</header>');
    expect(calls[1]!.url).toBe('https://api-eu.formfeed.dev/v1/partials/letterhead');

    const created = await client.partials.put('footer', { engine: 'jinja2', source: '<footer/>' });
    expect(created).toMatchObject({ created: true, partial: { version: 1, source: '<footer/>' } });
    expect(calls[2]).toMatchObject({ method: 'PUT', url: 'https://api-eu.formfeed.dev/v1/partials/footer', body: { engine: 'jinja2', source: '<footer/>' } });

    const updated = await client.partials.put('letterhead', { engine: 'jinja2', source: '<header/>', base_version: 3 });
    expect(updated).toMatchObject({ created: false, partial: { version: 4 } });
    expect(calls[3]!.body).toEqual({ engine: 'jinja2', source: '<header/>', base_version: 3 });

    await expect(client.partials.delete('letterhead')).resolves.toBeUndefined();
    expect(calls[4]).toMatchObject({ method: 'DELETE', url: 'https://api-eu.formfeed.dev/v1/partials/letterhead' });
  });

  it('maps a stale base_version to a conflict error', async () => {
    const { fetchImpl } = stub(() =>
      json({ type: 'https://docs.formfeed.dev/errors/conflict', title: 'Conflict', status: 409, code: 'conflict', detail: 'The partial is at version 4, not 3; pull it first', current: { ...partial, version: 4 } }, 409),
    );
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    await expect(client.partials.put('letterhead', { engine: 'liquid', source: 'x', base_version: 3 })).rejects.toMatchObject({
      name: 'FormfeedError',
      code: 'conflict',
      status: 409,
      message: 'The partial is at version 4, not 3; pull it first',
      problem: { current: { name: 'letterhead', version: 4 } },
    });
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"render.completed","data":{"id":"rnd_1"}}';
  const t = 1_800_000_000;

  async function sign(): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
    return `t=${t},v1=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  it('verifies a fresh signature and rejects tampering, wrong secrets and old timestamps', async () => {
    const header = await sign();
    expect(await verifyWebhookSignature(secret, header, body, { now: t + 10 })).toBe(true);
    expect(await verifyWebhookSignature('other', header, body, { now: t + 10 })).toBe(false);
    expect(await verifyWebhookSignature(secret, header, body.replace('rnd_1', 'rnd_2'), { now: t + 10 })).toBe(false);
    expect(await verifyWebhookSignature(secret, header, body, { now: t + 1000 })).toBe(false);
    expect(await verifyWebhookSignature(secret, null, body)).toBe(false);
    const event = await parseWebhookEvent<{ type: string }>(secret, header, body, { now: t });
    expect(event.type).toBe('render.completed');
    await expect(parseWebhookEvent(secret, 't=1,v1=00', body, { now: t })).rejects.toThrow('invalid webhook signature');
  });
});

describe('usage', () => {
  it('reads the usage of a period', async () => {
    const { calls, fetchImpl } = stub(() =>
      json({ period: '2026-09', included: 15000, used: 120, overage_used: 0, overage_balance: 0, daily: [], by_template: [] }),
    );
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    const usage = await client.account.usage('2026-08');
    expect(usage.period).toBe('2026-09');
    expect(calls[0]?.url).toContain('/usage?period=2026-08');
  });
});

describe('workspaces', () => {
  it('deletes a workspace and surfaces last_workspace', async () => {
    const { calls, fetchImpl } = stub((call) =>
      call.url.endsWith('/workspaces/ws-last')
        ? json(
            { type: 'https://docs.formfeed.dev/errors/last-workspace', title: 'Last workspace', status: 409, code: 'last_workspace', detail: 'x' },
            409,
          )
        : new Response(null, { status: 204 }),
    );
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl, maxRetries: 0 });
    await client.workspaces.delete('f0000000-0000-4000-8000-000000000002');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toMatch(/\/workspaces\/f0000000-0000-4000-8000-000000000002$/);

    const refused = await client.workspaces.delete('ws-last').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FormfeedError);
    expect((refused as FormfeedError).code).toBe('last_workspace');
    expect(calls).toHaveLength(2);
  });
});

describe('render listing', () => {
  it('lists with filters, follows the cursor and deletes outputs', async () => {
    const { calls, fetchImpl } = stub((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith('/outputs') && call.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ data: [render], next_cursor: url.searchParams.get('cursor') ? null : 'c1' });
    });
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });

    const page = await client.renders.list({ status: 'succeeded', limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(calls[0]?.url).toContain('status=succeeded');
    expect(calls[0]?.url).toContain('limit=1');

    const all = await client.renders.all({ template: 'invoice' });
    expect(all).toHaveLength(2);
    expect(calls.at(-1)?.url).toContain('cursor=c1');

    await client.renders.deleteOutputs('rnd_1');
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.at(-1)?.url).toMatch(/\/renders\/rnd_1\/outputs$/);
  });
});

describe('templates', () => {
  it('lists with filters, follows cursors and addresses versions', async () => {
    const { calls, fetchImpl } = stub((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith('/templates') && call.method === 'GET')
        return json({ data: [templateRow], next_cursor: url.searchParams.get('cursor') ? null : 'c1' });
      if (url.pathname.endsWith('/versions/latest')) return json({ id: 'v3', number: 3, status: 'draft', checksum: 'x', html: '<p>' });
      if (url.pathname.endsWith('/versions') && call.method === 'POST') return json({ id: 'v4', number: 4, status: 'draft', checksum: 'y' }, 201);
      if (url.pathname.endsWith('/versions/4/publish')) return json({ id: 'v4', number: 4, status: 'published', checksum: 'y' });
      return json(templateRow);
    });
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    const all = await client.templates.all({ kind: 'pdf', tag: 'invoice' });
    expect(all).toHaveLength(2);
    expect(calls[0]?.url).toContain('kind=pdf');
    expect(calls[0]?.url).toContain('tag=invoice');
    expect(calls[1]?.url).toContain('cursor=c1');

    const latest = await client.templates.versions.get('invoice', 'latest');
    expect(latest.html).toBe('<p>');
    const draft = await client.templates.versions.create('invoice', { html: '<p>v4</p>', base_checksum: 'x' });
    expect(draft.number).toBe(4);
    expect(calls.at(-1)?.body).toMatchObject({ base_checksum: 'x' });
    const published = await client.templates.versions.publish('invoice', 4);
    expect(published.status).toBe('published');
    expect(calls.at(-1)?.url).toMatch(/\/templates\/invoice\/versions\/4\/publish$/);
    expect(calls.at(-1)?.body).toBeUndefined();
    await client.templates.versions.publish('invoice', 4, { allowBreaking: true });
    expect(calls.at(-1)?.body).toEqual({ allow_breaking: true });
  });

  it('manages release channels and surfaces a breaking schema change as a typed error', async () => {
    const channel = { name: 'staging', version: 5, canary: null, previous_version: 4, updated_at: '2026-09-13T10:00:00Z' };
    const { calls, fetchImpl } = stub((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith('/channels') && call.method === 'GET')
        return json({ data: [{ ...channel, name: 'published' }, channel], limits: { channels: 2, canary: false } });
      if (call.method === 'PUT' && !(call.body as { allow_breaking?: boolean }).allow_breaking)
        return json(
          { type: 'https://docs.formfeed.dev/errors/schema-breaking-change', title: 'Schema change breaks callers', status: 409, code: 'schema_breaking_change', detail: 'x', breaking: [{ path: 'a', kind: 'field-added-required' }] },
          409,
        );
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ ...channel, schema_check: { source: 'stored', breaking: [], safe: [] } });
    });
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl, maxRetries: 0 });
    const list = await client.templates.channels.list('invoice');
    expect(list.limits).toEqual({ channels: 2, canary: false });
    expect(list.data.map((c) => c.name)).toEqual(['published', 'staging']);

    const refused = await client.templates.channels.set('invoice', 'staging', { version: 5 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FormfeedError);
    expect((refused as FormfeedError).code).toBe('schema_breaking_change');
    expect((refused as FormfeedError).problem?.['breaking']).toEqual([{ path: 'a', kind: 'field-added-required' }]);

    const moved = await client.templates.channels.set('invoice', 'staging', { version: 5, canary: { version: 6, percent: 10 } }, { allowBreaking: true });
    expect(moved.schema_check?.source).toBe('stored');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { version: 5, canary: { version: 6, percent: 10 }, allow_breaking: true } });
    await client.templates.channels.promote('invoice', 'staging');
    expect(calls.at(-1)?.url).toMatch(/\/templates\/invoice\/channels\/staging\/promote$/);
    await client.templates.channels.rollback('invoice', 'staging', { allowBreaking: true });
    expect(calls.at(-1)).toMatchObject({ body: { allow_breaking: true } });
    expect(calls.at(-1)?.url).toMatch(/\/rollback$/);
    await client.templates.channels.delete('invoice', 'staging', { force: true });
    expect(calls.at(-1)?.url).toMatch(/\/channels\/staging\?force=true$/);

    await client.templates.versions.get('invoice', 'staging');
    expect(calls.at(-1)?.url).toMatch(/\/versions\/staging$/);
  });
});

describe('Word and PowerPoint templates', () => {
  const docx = new Uint8Array([0x50, 0x4b, 3, 4]);

  it('creates a template from its file as multipart, with objects as JSON text', async () => {
    const { calls, fetchImpl } = stub(() => json({ ...templateRow, kind: 'docx' }, 201));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    const created = await client.templates.create({
      name: 'Offer',
      slug: 'offer',
      kind: 'docx',
      engine: 'jinja2',
      tags: ['sales'],
      sample_data: { customer: { name: 'Olvarest GmbH' } },
      publish: true,
      file: { data: docx, name: 'offer.docx' },
    });
    expect(created.kind).toBe('docx');
    expect(calls[0]!.url).toBe('https://api-eu.formfeed.dev/v1/templates');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    const form = calls[0]!.body as FormData;
    expect(form.get('kind')).toBe('docx');
    expect(form.get('tags')).toBe('["sales"]');
    expect(form.get('sample_data')).toBe('{"customer":{"name":"Olvarest GmbH"}}');
    expect(form.get('publish')).toBe('true');
    const part = form.get('file') as File;
    expect(part.name).toBe('offer.docx');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(docx);
  });

  it('sends a new version with a file as multipart and without one as JSON', async () => {
    const version = { id: 'v2', number: 2, status: 'draft', checksum: 'c', source_file: { sha256: 'ab', bytes: 4, format: 'docx' } };
    const { calls, fetchImpl } = stub(() => json(version, 201));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });

    const saved = await client.templates.versions.create('offer', { file: { data: new Blob([docx]) }, change_note: 'New layout' });
    expect(saved.source_file).toEqual({ sha256: 'ab', bytes: 4, format: 'docx' });
    const form = calls[0]!.body as FormData;
    expect(form.get('change_note')).toBe('New layout');
    expect((form.get('file') as File).name).toBe('document');

    await client.templates.versions.create('offer', { sample_data: { a: 1 }, file: undefined });
    expect(calls[1]!.headers['content-type']).toBe('application/json');
    expect(calls[1]!.body).toEqual({ sample_data: { a: 1 } });
  });

  it('downloads a version file as bytes and reads problems as JSON', async () => {
    const { calls, fetchImpl } = stub((call) =>
      call.url.includes('/versions/9/')
        ? json({ type: 'https://docs.formfeed.dev/errors/not-found', title: 'Not found', status: 404, code: 'not_found' }, 404)
        : new Response(docx, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }),
    );
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl, maxRetries: 0 });
    expect(await client.templates.versions.file('offer', 'latest')).toEqual(docx);
    expect(calls[0]!.url).toBe('https://api-eu.formfeed.dev/v1/templates/offer/versions/latest/file');
    expect(calls[0]!.headers['accept']).toBe('*/*');
    const missing = await client.templates.versions.file('offer', 9).catch((e: unknown) => e);
    expect((missing as FormfeedError).code).toBe('not_found');
  });

  it('renders a template to its own format', async () => {
    const { calls, fetchImpl } = stub(() => json({ ...render, output: 'docx' }));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    await client.renders.create({ template: 'offer', output: 'docx', data: {} });
    expect(calls[0]!.body).toMatchObject({ output: 'docx' });
  });
});

describe('PDF tools', () => {
  it('converts an uploaded office file or a template render to PDF', async () => {
    const { calls, fetchImpl } = stub(() => json({ ...render, id: 'rnd_pdf' }));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    const converted = await client.pdf.convert(
      { file: { data: new Uint8Array([1, 2]), name: 'sheet.xlsx' } },
      { landscape: true, single_page_sheets: false, expires_in: 3600, meta: { order: 7 } },
    );
    expect(converted.id).toBe('rnd_pdf');
    expect(calls[0]!.url).toBe('https://api-eu.formfeed.dev/v1/pdf/convert');
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S+/);
    const form = calls[0]!.body as FormData;
    expect(form.get('landscape')).toBe('true');
    expect(form.get('single_page_sheets')).toBe('false');
    expect(form.get('expires_in')).toBe('3600');
    expect(form.get('meta')).toBe('{"order":7}');
    expect((form.get('file') as File).name).toBe('sheet.xlsx');

    await client.pdf.convert({ id: 'rnd_docx' } as never, { page_ranges: '1-2' });
    expect(calls[1]!.body).toEqual({ source: 'rnd_docx', page_ranges: '1-2' });
    await client.pdf.convert('rnd_pptx');
    expect(calls[2]!.body).toEqual({ source: 'rnd_pptx' });
  });

  it('posts sources as render ids with an idempotency key, and info without one', async () => {
    const { calls, fetchImpl } = stub((call) =>
      call.url.endsWith('/pdf/info') ? json({ source: 'rnd_1', page_count: 2, pages: [], encrypted: false, metadata: {} }) : json({ ...render, id: 'rnd_9', units: 0.5 }),
    );
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    const merged = await client.pdf.merge([render as never, 'rnd_2'], { filename: 'bundle.pdf' });
    expect(merged.id).toBe('rnd_9');
    expect(calls[0]!.url).toBe('https://api-eu.formfeed.dev/v1/pdf/merge');
    expect(calls[0]!.body).toEqual({ filename: 'bundle.pdf', sources: ['rnd_1', 'rnd_2'] });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S+/);

    await client.pdf.protect('rnd_9', { user_password: 'open-me', permissions: ['print'] });
    expect(calls[1]!.body).toEqual({ source: 'rnd_9', user_password: 'open-me', permissions: ['print'] });
    await client.pdf.watermark('rnd_9', { text: 'COPY', rotation: 0 });
    expect(calls[2]!.body).toEqual({ source: 'rnd_9', text: 'COPY', rotation: 0 });

    const info = await client.pdf.info('rnd_1');
    expect(info.page_count).toBe(2);
    expect(calls[3]!.headers['idempotency-key']).toBeUndefined();
  });

  it('uploads to the file library as multipart, lists, reads and deletes', async () => {
    const file = { id: 'fil_1', name: 'brand/logo.png', content_type: 'image/png', bytes: 3, sha256: 'aa', url: 'https://cdn.test/a/ws/brand/logo.png', created_at: '', updated_at: '' };
    const { calls, fetchImpl } = stub((call) =>
      call.method === 'DELETE' ? new Response(null, { status: 204 }) : call.url.includes('/files?') || call.url.endsWith('/files') && call.method === 'GET' ? json({ data: [file], next_cursor: null }) : json(file, call.method === 'POST' ? 201 : 200),
    );
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });

    const uploaded = await client.files.upload({ data: new Uint8Array([1, 2, 3]), name: 'brand/logo.png', contentType: 'image/png' });
    expect(uploaded.url).toBe('https://cdn.test/a/ws/brand/logo.png');
    expect(calls[0]!.url).toBe('https://api-eu.formfeed.dev/v1/files');
    // no JSON content type: fetch sets multipart/form-data with the boundary itself
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    const form = calls[0]!.body as FormData;
    expect(form.get('name')).toBe('brand/logo.png');
    const part = form.get('file') as File;
    expect(part.type).toBe('image/png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    expect((await client.files.all({ prefix: 'brand/' })).map((f) => f.name)).toEqual(['brand/logo.png']);
    expect(calls[1]!.url).toBe('https://api-eu.formfeed.dev/v1/files?prefix=brand%2F');
    expect((await client.files.get('fil_1')).id).toBe('fil_1');
    await client.files.delete(uploaded);
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: 'https://api-eu.formfeed.dev/v1/files/fil_1' });
  });

  it('sends the configured headers with every request, an OAuth token and workspace included', async () => {
    const { calls, fetchImpl } = stub(() => json({ data: [], next_cursor: null }));
    const client = new Formfeed({ apiKey: 'eyJ.access.token', fetch: fetchImpl, headers: { 'X-Formfeed-Workspace': 'ws-1', 'User-Agent': 'formfeed-mcp/1' } });
    await client.templates.list();
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer eyJ.access.token', 'x-formfeed-workspace': 'ws-1', 'user-agent': 'formfeed-mcp/1' });
  });

  it('validates a template version with data', async () => {
    const result = { ok: false, template: { id: 'tpl_1', slug: 'invoice', version: 3 }, diagnostics: [{ severity: 'error', code: 'data-validation', path: 'data.n', message: 'data.n: is required' }] };
    const { calls, fetchImpl } = stub(() => json(result));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    expect(await client.templates.validate('invoice', { version: 'latest', data: { a: 1 } })).toEqual(result);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api-eu.formfeed.dev/v1/templates/invoice/validate', body: { version: 'latest', data: { a: 1 } } });
    // a channel name names its main version, on the check and on the schema
    await client.templates.validate('invoice', { version: 'staging' });
    expect(calls[1]!.body).toEqual({ version: 'staging' });
    await client.templates.schema('invoice');
    expect(calls[2]!.url).toBe('https://api-eu.formfeed.dev/v1/templates/invoice/schema');
    await client.templates.schema('invoice', { version: 'staging' });
    expect(calls[3]!.url).toBe('https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=staging');
    await client.templates.schema('invoice', { version: 8 });
    expect(calls[4]!.url).toBe('https://api-eu.formfeed.dev/v1/templates/invoice/schema?version=8');
  });

  it('uses library files as image watermarks and merge sources', async () => {
    const { calls, fetchImpl } = stub(() => json(render));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    await client.renders.create({ template: 'invoice', post: { merge_after: ['terms.pdf'], watermark: { image: 'draft.png', opacity: 0.2 } } });
    expect(calls[0]!.body).toMatchObject({ post: { merge_after: ['terms.pdf'], watermark: { image: 'draft.png', opacity: 0.2 } } });
    await client.pdf.watermark('rnd_1', { image: 'fil_1' });
    expect(calls[1]!.body).toEqual({ source: 'rnd_1', image: 'fil_1' });
    await client.pdf.merge(['rnd_1', { id: 'fil_2' } as never]);
    expect(calls[2]!.body).toEqual({ sources: ['rnd_1', 'fil_2'] });
  });

  it('passes post-processing through on renders', async () => {
    const { calls, fetchImpl } = stub(() => json(render));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    await client.renders.create({ template: 'invoice', post: { merge_after: ['rnd_terms'], password: { user: 'pw' } } });
    expect(calls[0]!.body).toMatchObject({ post: { merge_after: ['rnd_terms'], password: { user: 'pw' } } });
  });
});

describe('bring your own storage', () => {
  it('sends the storage option with renders and PDF tools and reads the delivery back', async () => {
    const delivery = { status: 'pending', bucket: 'fennlor-docs', key: 'formfeed/invoices/RE-1001.pdf', url: null, reason: null, error: null };
    const { calls, fetchImpl } = stub((call) =>
      call.url.endsWith('/renders') ? json({ ...render, storage: delivery }) : json({ ...render, id: 'rnd_pdf', storage: null }),
    );
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    const result = await client.renders.create({ template: 'invoice', storage: { key: 'invoices/RE-1001.pdf' } });
    expect(calls[0]!.body).toEqual({ template: 'invoice', storage: { key: 'invoices/RE-1001.pdf' } });
    expect(result.storage?.status).toBe('pending');

    await client.pdf.convert({ file: { data: new Uint8Array([80, 75, 3, 4]), name: 'offer.docx' } }, { storage: false });
    expect((calls[1]!.body as FormData).get('storage')).toBe('false');
  });

  it('surfaces a key without a connection as a typed error', async () => {
    const { fetchImpl } = stub(() => json({ code: 'storage_not_configured', status: 409, detail: 'no connection' }, 409));
    const client = new Formfeed({ apiKey: 'ff_live_k', fetch: fetchImpl });
    await expect(client.renders.create({ html: '<p>x</p>', storage: { key: 'x.pdf' } })).rejects.toMatchObject({
      code: 'storage_not_configured',
      status: 409,
    });
  });
});
