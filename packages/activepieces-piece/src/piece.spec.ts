import { httpClient, type HttpRequest } from '@activepieces/pieces-common';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formfeed } from '../piece/src/index';
import {
  convertFields,
  dataFromFields,
  downloadName,
  headerValue,
  mergeData,
  parseObject,
  renderBody,
  schemaFields,
  verifySignature,
  versionOptions,
} from '../piece/src/lib/common/utils';

const workspace = join(import.meta.dirname, '..', '..', '..');
// Both live outside the package, so the public repository, which exports only the packages, has neither.
const logoFile = join(workspace, 'apps', 'landing', 'public', 'brand', 'formfeed-512.png');
const openapiFile = join(workspace, 'packages', 'api-types', 'openapi.json');
const auth = { type: 'SECRET_TEXT', secret_text: 'ff_test_x' };
const sign = (secret: string, t: number, body: string) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

type Json = Record<string, unknown>;
/** A dropdown's `options` or the dynamic fields' `props`, called the way the builder calls them. */
type Loader = (props: Json, ctx: Json) => Promise<unknown>;
interface Recorded {
  method: string;
  url: string;
  body: unknown;
  headers: Json;
}

/** Answers every request the piece sends, and records it. */
function stubApi(answer: (request: Recorded) => unknown = () => ({})) {
  const requests: Recorded[] = [];
  vi.spyOn(httpClient, 'sendRequest').mockImplementation((async (request: HttpRequest) => {
    const recorded = {
      method: String(request.method),
      url: request.url + (request.queryParams ? `?${new URLSearchParams(request.queryParams as Record<string, string>)}` : ''),
      body: request.body,
      headers: (request.headers ?? {}) as Json,
    };
    requests.push(recorded);
    return { status: 200, headers: {}, body: answer(recorded) };
  }) as never);
  return requests;
}

/** The context an action or trigger hook runs with, as far as the piece uses it. */
function context(propsValue: Json) {
  const store = new Map<string, unknown>();
  const written: Array<{ fileName: string; data: Buffer }> = [];
  return {
    auth,
    propsValue,
    webhookUrl: 'https://cloud.activepieces.com/api/v1/webhooks/flow-1',
    files: {
      write: async (file: { fileName: string; data: Buffer }) => {
        written.push(file);
        return `file://${file.fileName}`;
      },
    },
    store: {
      put: async (key: string, value: unknown) => store.set(key, value),
      get: async (key: string) => store.get(key) ?? null,
      delete: async (key: string) => void store.delete(key),
    },
    written,
    stored: store,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('request shapes', () => {
  it('builds render bodies and leaves out what is empty', () => {
    expect(renderBody({ template: 'invoice-de', version: 'published', data: {}, locale: 'de-DE' })).toEqual({
      template: 'invoice-de',
      locale: 'de-DE',
      meta: { source: 'activepieces' },
    });
    expect(renderBody({ html: '<p/>' })).toMatchObject({ html: '<p/>', engine: 'jinja2' });
    expect(renderBody({ url: 'https://example.com', output: 'png' })).toMatchObject({ url: 'https://example.com', output: 'png' });
  });

  it('turns a schema into fields and the fields back into nested data', () => {
    const fields = schemaFields({
      type: 'object',
      required: ['invoice'],
      properties: {
        invoice: {
          type: 'object',
          required: ['number'],
          properties: { number: { type: 'string', title: 'Invoice number' }, total: { type: 'number' }, paid: { type: 'boolean' } },
        },
        lines: { type: 'array', items: { type: 'object' } },
      },
    });
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['invoice__number', 'text', true],
      ['invoice__total', 'number', false],
      ['invoice__paid', 'boolean', false],
    ]);
    expect(fields[0]?.label).toBe('Invoice number');
    expect(dataFromFields({ invoice__number: '2026-0042', invoice__total: 19.5, invoice__paid: false, empty: '' })).toEqual({
      invoice: { number: '2026-0042', total: 19.5, paid: false },
    });
    expect(mergeData({ invoice: { number: '1' } }, { invoice: { total: 2 }, lines: [] })).toEqual({
      invoice: { number: '1', total: 2 },
      lines: [],
    });
  });

  it('reads JSON props given as objects or text', () => {
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseObject(undefined)).toEqual({});
    expect(() => parseObject('nope', 'Settings')).toThrow('Settings is not valid JSON');
    expect(() => parseObject([1])).toThrow('Data must be a JSON object');
  });

  it('offers release channels only when there is one besides published', () => {
    expect(versionOptions([{ name: 'published', version: 2 }])).toEqual([]);
    expect(versionOptions([{ name: 'published', version: 2 }, { name: 'beta', version: null }])).toEqual([
      { label: 'published (v2)', value: 'published' },
      { label: 'beta (nothing published yet)', value: 'beta' },
    ]);
  });

  it('names files after what was rendered', () => {
    expect(downloadName(undefined, 'rnd_1', 'png')).toBe('rnd_1.png');
    expect(downloadName('offer.pdf', 'rnd_1', 'docx')).toBe('offer.docx');
    expect(convertFields({ renderId: 'rnd_1', filename: 'a.pptx' })).toEqual({
      source: 'rnd_1',
      filename: 'a.pdf',
      meta: { source: 'activepieces' },
    });
  });

  it('checks webhook signatures the way the SDKs do', () => {
    const body = '{"id":"evt_1"}';
    const now = 1_757_584_800;
    expect(verifySignature('s', sign('s', now, body), body, now)).toBe(true);
    expect(verifySignature('s', sign('t', now, body), body, now)).toBe(false);
    expect(verifySignature('s', sign('s', now - 600, body), body, now)).toBe(false);
    expect(verifySignature('s', sign('s', now, body), undefined, now)).toBe(false);
    expect(headerValue({ 'Webhook-Signature': 'x' }, 'webhook-signature')).toBe('x');
  });
});

describe('the piece', () => {
  it('declares its actions, triggers and auth', () => {
    expect(Object.keys(formfeed.actions())).toEqual([
      'create_document',
      'create_document_from_html',
      'create_document_from_url',
      'get_render',
      'convert_to_pdf',
      'upload_file',
      'custom_api_call',
    ]);
    expect(Object.keys(formfeed.triggers())).toEqual(['render_completed', 'render_failed', 'batch_finished']);
    expect(formfeed.logoUrl).toBe('https://formfeed.dev/brand/formfeed-512.png');
  });

  it.skipIf(!existsSync(logoFile))('serves its logo from the landing site', () => {
    expect(readFileSync(logoFile).subarray(1, 4).toString()).toBe('PNG');
  });

  it.skipIf(!existsSync(openapiFile))('calls only documented operations, with the key as a bearer token', async () => {
    const openapi = JSON.parse(readFileSync(openapiFile, 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = Object.entries(openapi.paths).map(([path, operations]) => ({
      pattern: new RegExp(`^https://api\\.formfeed\\.dev/v1${path.replace(/\{[^}]+\}/g, '[^/?]+')}(\\?.*)?$`),
      methods: new Set(Object.keys(operations).map((m) => m.toUpperCase())),
    }));
    const requests = stubApi((request) =>
      request.url.includes('/webhooks') ? { id: 'hook-1', secret: 'whsec_x' } : { id: 'rnd_1', status: 'succeeded', output: 'pdf', data: [] },
    );
    const actions = formfeed.actions();
    const file = { filename: 'report.docx', extension: 'docx', data: Buffer.from('x'), base64: 'eA==' };
    const runs: Array<[string, Json]> = [
      ['create_document', { template: 'invoice-de', fields: {}, saveFile: false }],
      ['create_document_from_html', { html: '<p/>', saveFile: false }],
      ['create_document_from_url', { url: 'https://example.com', saveFile: false }],
      ['get_render', { renderId: 'rnd_1' }],
      ['convert_to_pdf', { renderId: 'rnd_1', saveFile: false }],
      ['convert_to_pdf', { file, saveFile: false }],
      ['upload_file', { file }],
    ];
    for (const [name, props] of runs) await actions[name]!.run(context(props) as never);
    for (const trigger of Object.values(formfeed.triggers())) {
      const ctx = context({ environment: 'both' });
      await trigger.onEnable(ctx as never);
      await trigger.onDisable(ctx as never);
    }
    const props = formfeed.getAction('create_document')!.props as Record<string, { options?: Loader; props?: Loader }>;
    await props['template']!.options!({ auth }, {});
    await props['version']!.options!({ auth, template: 'invoice-de' }, {});
    await props['fields']!.props!({ auth, template: 'invoice-de' }, {});
    await (formfeed.auth as unknown as { validate: (params: Json) => Promise<unknown> }).validate({ auth: 'ff_test_x' });

    expect(requests.length).toBeGreaterThan(15);
    for (const request of requests) expect(request.headers['Authorization']).toBe('Bearer ff_test_x');
    const undocumented = requests.filter(({ method, url }) => !documented.some((d) => d.pattern.test(url) && d.methods.has(method)));
    expect(undocumented).toEqual([]);
  });

  it('offers one field per schema value and sends them as nested data', async () => {
    const requests = stubApi((request) => {
      if (request.url.endsWith('/schema'))
        return { type: 'object', properties: { invoice: { type: 'object', properties: { number: { type: 'string' }, total: { type: 'number' } } } } };
      if (request.url.startsWith('https://cdn.formfeed.dev/')) return new TextEncoder().encode('%PDF-1.7').buffer;
      return { id: 'rnd_1', status: 'succeeded', output: 'pdf', download_url: 'https://cdn.formfeed.dev/o/x.pdf?sig=0' };
    });
    const action = formfeed.getAction('create_document')!;
    const fields = await (action.props['fields'] as unknown as { props: Loader }).props({ auth, template: 'invoice-de' }, {});
    expect(Object.keys(fields as Json)).toEqual(['invoice__number', 'invoice__total']);

    const ctx = context({
      template: 'invoice-de',
      fields: { invoice__number: '2026-0042', invoice__total: 12 },
      data: { lines: [{ qty: 1 }] },
      filename: 'invoice.pdf',
    });
    const result = (await action.run(ctx as never)) as Json;
    const render = requests.find((r) => r.method === 'POST')!;
    expect(render.body).toEqual({
      template: 'invoice-de',
      data: { invoice: { number: '2026-0042', total: 12 }, lines: [{ qty: 1 }] },
      filename: 'invoice.pdf',
      meta: { source: 'activepieces' },
    });
    // the file comes from the signed URL, which never sees the key
    const download = requests.find((r) => r.url.startsWith('https://cdn.formfeed.dev/'))!;
    expect(download.headers['Authorization']).toBeUndefined();
    expect(ctx.written[0]?.fileName).toBe('invoice.pdf');
    expect(ctx.written[0]?.data.toString()).toBe('%PDF-1.7');
    expect(result['file']).toBe('file://invoice.pdf');
  });

  it('turns a problem answer into a readable error', async () => {
    const { HttpError } = await import('@activepieces/pieces-common');
    const error = Object.create(HttpError.prototype) as InstanceType<typeof HttpError>;
    Object.defineProperty(error, 'response', {
      get: () => ({ status: 404, body: { detail: 'No published template "x"', code: 'template_not_found' } }),
    });
    vi.spyOn(httpClient, 'sendRequest').mockRejectedValue(error);
    await expect(formfeed.getAction('get_render')!.run(context({ renderId: 'rnd_1' }) as never)).rejects.toThrow(
      '[404] No published template "x" (template_not_found)',
    );
  });
});

describe('webhook triggers', () => {
  it('register the endpoint, keep the secret and pass on signed deliveries only', async () => {
    const requests = stubApi(() => ({ id: 'hook-1', secret: 'whsec_x' }));
    const trigger = formfeed.getTrigger('render_completed')!;
    const ctx = context({ environment: 'live' });
    await trigger.onEnable(ctx as never);
    expect(requests[0]?.body).toEqual({
      url: ctx.webhookUrl,
      events: ['render.completed'],
      environments: ['live'],
      description: 'Activepieces',
    });
    expect(ctx.stored.get('formfeed_webhook_secret')).toBe('whsec_x');

    const event = trigger.sampleData as Json;
    const rawBody = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const deliver = (signature: string, body: Json = event) =>
      trigger.run({ ...ctx, payload: { body, rawBody, headers: { 'webhook-signature': signature } } } as never);
    expect(await deliver(sign('whsec_x', t, rawBody))).toEqual([event]);
    expect(await deliver(sign('whsec_other', t, rawBody))).toEqual([]);
    expect(await deliver(sign('whsec_x', t, rawBody), { ...event, type: 'job.completed' })).toEqual([]);

    await trigger.onDisable(ctx as never);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.formfeed.dev/v1/webhooks/hook-1' });
    expect(ctx.stored.size).toBe(0);
  });

  it('test with recent renders, else with the sample', async () => {
    stubApi(() => ({ data: [{ id: 'rnd_9', status: 'succeeded', created_at: '2026-09-11T10:00:00Z' }] }));
    const trigger = formfeed.getTrigger('render_completed')!;
    expect(await trigger.test!(context({}) as never)).toEqual([expect.objectContaining({ type: 'render.completed', data: expect.objectContaining({ id: 'rnd_9' }) })]);
    const batch = formfeed.getTrigger('batch_finished')!;
    expect(await batch.test!(context({}) as never)).toEqual([batch.sampleData]);
  });
});
