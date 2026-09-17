import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { starterDocument } from '@formfeed/engine';
import { strToU8, zipSync } from 'fflate';
import { createFormfeedServer } from './server';
import { startHttp } from './transports';

const template = { id: 'tpl_1', slug: 'invoice', name: 'Invoice', description: null, kind: 'pdf', engine: 'jinja2', tags: ['billing'], published_version: 2, latest_version: 2, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-08T00:00:00Z' };
const version = { id: 'v2', number: 2, status: 'published', checksum: 'c', change_note: null, created_at: '', published_at: '', html: '<h1>{{ invoice.number | money }}</h1>', css: '', head: '', settings: {}, sample_data: { invoice: { number: 5 } }, data_schema: null, i18n: null };

const offer = { ...template, id: 'tpl_2', slug: 'offer', name: 'Offer', kind: 'docx' };
const starter = starterDocument('jinja2');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** A Word document whose second paragraph uses a filter no engine knows. */
const brokenDocx = zipSync({
  '[Content_Types].xml': strToU8(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ),
  'word/document.xml': strToU8(
    `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Offer</w:t></w:r></w:p><w:p><w:r><w:t>{{ customer.name | nope }}</w:t></w:r></w:p></w:body></w:document>`,
  ),
});

function fakeApi(seenKeys: string[] = []) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seenKeys.push(headers.get('authorization') ?? '');
    const call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === '/v1/templates') return json({ data: [template], next_cursor: null });
    if (call.path === '/v1/templates/invoice') return json(template);
    if (call.path === '/v1/templates/offer' || call.path === '/v1/templates/broken') return json({ ...offer, slug: call.path.slice(14) });
    if (call.path === '/v1/templates/offer/versions/latest' || call.path === '/v1/templates/broken/versions/latest')
      return json({ ...version, html: '', sample_data: starter.sampleData, source_file: { sha256: 'x', bytes: 1, format: 'docx' } });
    if (call.path === '/v1/templates/offer/versions/2/file') return new Response(starter.bytes, { status: 200 });
    if (call.path === '/v1/templates/broken/versions/2/file') return new Response(brokenDocx, { status: 200 });
    if (call.path === '/v1/templates/invoice/versions/published' || call.path === '/v1/templates/invoice/versions/latest') return json(version);
    if (call.path === '/v1/templates/nope/versions/published') return json({ code: 'template_not_found', status: 404 }, 404);
    if (call.path === '/v1/templates/nope/versions/latest') return json({ code: 'template_not_found', status: 404, detail: 'no such template' }, 404);
    if (call.path === '/v1/renders' && call.method === 'POST') return json({ id: 'rnd_1', status: 'succeeded', download_url: 'https://cdn.test/o/x.pdf', page_count: 1, units: 1, environment: 'test', template: { id: 'tpl_1', slug: 'invoice', version: 2 }, error: null }, 201);
    if (call.path === '/v1/renders/rnd_1') return json({ id: 'rnd_1', status: 'succeeded', download_url: 'https://cdn.test/o/x.pdf', page_count: 1, units: 1, error: null });
    return json({ code: 'not_found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function connectedClient(fetchImpl: typeof fetch) {
  const server = createFormfeedServer({ apiKey: 'ff_test_k', fetch: fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const structured = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

describe('@formfeed/mcp', () => {
  it('lists the five tools with schemas', async () => {
    const { client, close } = await connectedClient(fakeApi().fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_render', 'get_template_schema', 'list_templates', 'render', 'validate_template']);
    expect(tools.find((t) => t.name === 'render')?.inputSchema).toMatchObject({ type: 'object' });
    await close();
  });

  it('lists templates, infers the schema and validates offline', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const list = structured(await client.callTool({ name: 'list_templates', arguments: { kind: 'pdf' } }));
    expect(list['templates']).toEqual([expect.objectContaining({ slug: 'invoice', engine: 'jinja2', published_version: 2 })]);

    const schema = structured(await client.callTool({ name: 'get_template_schema', arguments: { template: 'invoice' } }));
    expect(schema['schema']).toMatchObject({ type: 'object', properties: { invoice: { type: 'object' } } });
    expect(schema['sample_data']).toEqual({ invoice: { number: 5 } });

    const valid = structured(await client.callTool({ name: 'validate_template', arguments: { template: 'invoice' } }));
    expect(valid['ok']).toBe(true);
    const invalid = structured(await client.callTool({ name: 'validate_template', arguments: { html: '<p>{{ x | nope }}</p>', engine: 'liquid', data: {} } }));
    expect(invalid['ok']).toBe(false);
    expect(JSON.stringify(invalid['diagnostics'])).toMatch(/nope/);
    // validation never called the render API
    expect(api.calls.some((c) => c.path === '/v1/renders')).toBe(false);
    await close();
  });

  it('validates a Word template from its document, by part and paragraph', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const valid = structured(await client.callTool({ name: 'validate_template', arguments: { template: 'offer' } }));
    expect(valid).toMatchObject({ ok: true });
    const broken = structured(await client.callTool({ name: 'validate_template', arguments: { template: 'broken' } }));
    expect(broken['ok']).toBe(false);
    expect(broken['diagnostics']).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', part: 'word/document.xml', paragraph: 2, message: expect.stringMatching(/nope/) })]),
    );
    await close();
  });

  it('renders and reports API problems as tool errors', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const render = await client.callTool({ name: 'render', arguments: { template: 'invoice', data: { invoice: { number: 7 } }, output: 'pdf' } });
    expect(structured(render)).toMatchObject({ id: 'rnd_1', status: 'succeeded', download_url: 'https://cdn.test/o/x.pdf' });
    const request = api.calls.find((c) => c.path === '/v1/renders');
    expect(request?.body).toMatchObject({ template: 'invoice', data: { invoice: { number: 7 } }, output: 'pdf', meta: { source: 'mcp' } });

    const missing = await client.callTool({ name: 'get_template_schema', arguments: { template: 'nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/template_not_found/);
    await close();
  });

  it('serves Streamable HTTP with the key from the bearer header', async () => {
    const keys: string[] = [];
    const api = fakeApi(keys);
    const handle = await startHttp({ port: 0, fetch: api.fetchImpl });
    try {
      const unauthorised = await fetch(handle.url, { method: 'POST' });
      expect(unauthorised.status).toBe(401);
      const client = new Client({ name: 'http-test', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: { authorization: 'Bearer ff_test_http' } } }));
      const result = structured(await client.callTool({ name: 'get_render', arguments: { id: 'rnd_1' } }));
      expect(result['status']).toBe('succeeded');
      expect(keys).toContain('Bearer ff_test_http');
      await client.close();
    } finally {
      await handle.close();
    }
  });
});
