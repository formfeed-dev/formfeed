import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { invoiceSkeleton } from '@formfeed/engine';
import { createFormfeedServer } from './server';
import { startHttp } from './transports';

const template = {
  id: 'tpl_1',
  slug: 'invoice',
  name: 'Invoice',
  description: null,
  kind: 'pdf',
  engine: 'jinja2',
  tags: ['billing'],
  published_version: 2,
  latest_version: 2,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
};
const version = {
  id: 'v2',
  number: 2,
  status: 'published',
  checksum: 'c',
  change_note: null,
  created_at: '',
  published_at: '',
  html: '<h1>{{ invoice.number | money }}</h1>',
  css: '',
  head: '',
  settings: {},
  sample_data: { invoice: { number: 5 } },
  data_schema: null,
  i18n: null,
};
/** What the validator said about a file that skips a heading level, delivered with `check: "report"`. */
const verdict = {
  standard: 'PDF/UA-1',
  check: 'report',
  conformant: false,
  validator: 'veraPDF 1.30.2',
  rules: { passed: 105, failed: 1 },
  failures: [
    {
      rule: '7.4.2-1',
      code: 'heading-order',
      count: 1,
      message:
        'This h3 follows an h1, so a heading level is skipped. Make it an h2 and size it with CSS.',
      elements: ['<h3>'],
    },
  ],
  warnings: [],
};

/** A 1x1 transparent PNG, as an image render's link serves it. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

function fakeApi(seenKeys: string[] = []) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seenKeys.push(headers.get('authorization') ?? '');
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    const call = { method: init?.method ?? 'GET', path: url.pathname, body };
    calls.push(call);
    if (call.path === '/v1/pdf/convert' && call.method === 'POST')
      return json({
        id: 'rnd_pdf',
        status: 'succeeded',
        download_url: 'https://cdn.test/o/report.pdf',
        expires_at: '2026-10-21T00:00:00Z',
        page_count: 2,
        units: 1,
        environment: 'live',
        template: null,
        error: null,
      });
    // save_template (spec 10 §3.2): a new template, a new version of `invoice`, the Word template
    // `offer`, and `locked`, which the gateway refuses as it refuses an agent without permission
    if (call.path === '/v1/templates' && call.method === 'POST') {
      const created = call.body as { slug: string; name: string };
      return json(
        {
          ...template,
          id: 'tpl_9',
          slug: created.slug,
          name: created.name,
          published_version: null,
          latest_version: 1,
        },
        201,
      );
    }
    if (call.path === '/v1/templates/agent-invoice')
      return json({
        ...template,
        id: 'tpl_9',
        slug: 'agent-invoice',
        name: 'Agent invoice',
        published_version: null,
      });
    if (call.path === '/v1/templates/agent-invoice/versions/latest')
      return json({
        ...version,
        id: 'v9',
        number: 1,
        status: 'draft',
        checksum: 'n1',
      });
    if (
      call.path === '/v1/templates/invoice/versions' &&
      call.method === 'POST'
    )
      return json(
        { ...version, id: 'v3', number: 3, status: 'draft', checksum: 'c3' },
        201,
      );
    if (call.path === '/v1/templates/offer')
      return json({ ...template, id: 'tpl_2', slug: 'offer', kind: 'docx' });
    if (call.path === '/v1/templates/locked')
      return json({ ...template, id: 'tpl_6', slug: 'locked' });
    if (
      call.path === '/v1/templates/offer/versions/latest' ||
      call.path === '/v1/templates/locked/versions/latest'
    )
      return json(version);
    if (call.path === '/v1/templates/locked/versions' && call.method === 'POST')
      return json(
        {
          type: 'https://docs.formfeed.dev/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'forbidden',
          detail:
            'This agent may not save templates. Drafts are allowed per agent in Formfeed under Account → Connected agents, for members whose role may edit templates',
        },
        403,
      );
    if (call.path === '/v1/templates')
      return json({ data: [template], next_cursor: null });
    if (call.path === '/v1/account')
      return json({
        workspace: {
          id: 'f0000000-0000-4000-8000-000000000001',
          slug: 'production',
          name: 'Production',
          region: 'eu',
        },
        organization: {
          id: '0a000000-0000-4000-8000-00000000000a',
          slug: 'fennlor',
          name: 'Fennlor Studio',
        },
        plan: { id: 'starter', name: 'Starter', monthly_units: 3000 },
        period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
        units: { included: 3000, used: 12, overage_balance: 0 },
        limits: {},
        environment: 'live',
      });
    if (call.path === '/v1/templates/invoice') return json(template);
    const validate = /^\/v1\/templates\/([^/]+)\/validate$/.exec(call.path);
    if (validate && call.method === 'POST') {
      // the API's check (POST /templates/{id}/validate): the data against the stored schema
      const slug = validate[1];
      const { version: which, data } = call.body as {
        version: string;
        data?: { invoice?: { vat_rate?: unknown } };
      };
      if (slug === 'draft' && which === 'published')
        return json(
          {
            code: 'template_not_found',
            status: 404,
            detail: 'nothing published',
          },
          404,
        );
      if (slug === 'offer')
        return json({
          ok: false,
          template: { id: 'tpl_2', slug, version: 3 },
          diagnostics: [
            {
              severity: 'error',
              code: 'unknown-filter',
              message: 'Unknown filter or helper "nope"',
              part: 'word/document.xml',
              paragraph: 2,
            },
          ],
        });
      if (typeof data?.invoice?.vat_rate === 'string')
        return json({
          ok: false,
          template: { id: 'tpl_1', slug, version: 2 },
          diagnostics: [
            {
              severity: 'error',
              code: 'data-validation',
              path: 'data.invoice.vat_rate',
              message: 'data.invoice.vat_rate: must be number',
            },
          ],
        });
      return json({
        ok: true,
        template: { id: 'tpl_1', slug, version: which === 'latest' ? 1 : 2 },
        diagnostics: [],
      });
    }
    if (
      call.path === '/v1/templates/invoice/versions/published' ||
      call.path === '/v1/templates/invoice/versions/latest'
    )
      return json(version);
    if (call.path === '/v1/templates/nope/versions/published')
      return json({ code: 'template_not_found', status: 404 }, 404);
    if (call.path === '/v1/templates/nope/versions/latest')
      return json(
        { code: 'template_not_found', status: 404, detail: 'no such template' },
        404,
      );
    // `bescheid` declares PDF/UA-1 (plan 21): its render carries the validator's verdict; `streng` is strict and fails
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (call.body as { template?: string }).template === 'streng'
    )
      return json(
        {
          type: 'https://docs.formfeed.dev/errors/pdfua-validation-failed',
          title: 'PDF/UA validation failed',
          status: 422,
          code: 'pdfua_validation_failed',
          detail: 'The PDF fails 1 rule of PDF/UA-1',
          accessibility: { ...verdict, check: 'strict' },
        },
        422,
      );
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (call.body as { template?: string }).template === 'bescheid'
    )
      return json(
        {
          id: 'rnd_2',
          status: 'succeeded',
          download_url: 'https://cdn.test/o/b.pdf',
          expires_at: '2026-10-21T00:00:00Z',
          page_count: 1,
          units: 1,
          environment: 'test',
          template: { id: 'tpl_3', slug: 'bescheid', version: 1 },
          error: null,
          accessibility: verdict,
        },
        201,
      );
    // `rechnung` is an e-invoice template (spec 17): its render carries the report; `falsch` is refused
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (call.body as { template?: string }).template === 'falsch'
    )
      return json(
        {
          type: 'https://docs.formfeed.dev/errors/einvoice-data-invalid',
          title: 'E-invoice data invalid',
          status: 422,
          code: 'einvoice_data_invalid',
          detail:
            '_invoice.totals.due is 1.00, but grand less prepaid plus rounding is 1142.40 (BR-CO-16)',
          errors: [
            {
              path: 'data._invoice.totals.due',
              message:
                '_invoice.totals.due is 1.00, but grand less prepaid plus rounding is 1142.40 (BR-CO-16)',
              rule: 'BR-CO-16',
            },
          ],
        },
        422,
      );
    // `gestoppt`: the validator's rules stopped (Mustang #904), so nothing in the block is to fix
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (call.body as { template?: string }).template === 'gestoppt'
    )
      return json(
        {
          type: 'https://docs.formfeed.dev/errors/einvoice-validator-error',
          title: 'E-invoice could not be validated',
          status: 500,
          code: 'einvoice_validator_error',
          detail:
            'The validator could not check the e-invoice: its rules stopped before they finished',
          einvoice: {
            profile: 'en16931',
            flavour: 'factur-x',
            validation: {
              valid: false,
              messages: [
                {
                  part: 'xml',
                  severity: 'error',
                  rule: null,
                  message:
                    'The invoice could not be validated: its rules stopped before they finished.',
                  location: null,
                },
              ],
            },
          },
        },
        500,
      );
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (call.body as { template?: string }).template === 'rechnung'
    )
      return json(
        {
          id: 'rnd_3',
          status: 'succeeded',
          download_url: 'https://cdn.test/o/rechnung.pdf',
          expires_at: '2026-10-21T00:00:00Z',
          page_count: 1,
          units: 2,
          environment: 'test',
          template: { id: 'tpl_4', slug: 'rechnung', version: 1 },
          error: null,
          einvoice: {
            profile: 'en16931',
            flavour: 'factur-x',
            spec_version: '1.09',
            xml_url: null,
            validation: {
              valid: true,
              schematron: 'Factur-X 1.09.2 (Mustang 2.26.0)',
              pdfa: 'PDF/A-3b',
              messages: [],
            },
            display: { checked: ['BT-1', 'BT-112'], missing: [] },
          },
        },
        201,
      );
    // image templates: `card` renders a small picture, `poster` one larger than a result may carry
    const image = (call.body as { template?: string } | undefined)?.template;
    if (
      call.path === '/v1/renders' &&
      call.method === 'POST' &&
      (image === 'card' || image === 'poster')
    )
      return json(
        {
          id: `rnd_${image}`,
          status: 'succeeded',
          output: 'png',
          download_url: `https://cdn.test/o/${image}.png`,
          expires_at: '2026-10-21T00:00:00Z',
          page_count: null,
          units: 0,
          environment: 'test',
          template: { id: 'tpl_5', slug: image, version: 1 },
          error: null,
        },
        201,
      );
    // the files behind those links, as the CDN serves them
    if (url.host === 'cdn.test' && url.pathname === '/o/card.png')
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (url.host === 'cdn.test' && url.pathname === '/o/poster.png')
      return new Response(new Uint8Array(3 * 1024 * 1024), {
        headers: { 'content-type': 'image/png' },
      });
    if (call.path === '/v1/renders' && call.method === 'POST')
      return json(
        {
          id: 'rnd_1',
          status: 'succeeded',
          download_url: 'https://cdn.test/o/x.pdf',
          expires_at: '2026-10-21T00:00:00Z',
          page_count: 1,
          units: 1,
          environment: 'test',
          template: { id: 'tpl_1', slug: 'invoice', version: 2 },
          error: null,
        },
        201,
      );
    if (call.path === '/v1/renders/rnd_1')
      return json({
        id: 'rnd_1',
        status: 'succeeded',
        download_url: 'https://cdn.test/o/x.pdf',
        expires_at: '2026-10-21T00:00:00Z',
        page_count: 1,
        units: 1,
        environment: 'test',
        template: { id: 'tpl_1', slug: 'invoice', version: 2 },
        error: null,
      });
    return json({ code: 'not_found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function connectedClient(
  fetchImpl: typeof fetch,
  localFiles = false,
  /** null: a server started without a key */
  apiKey: string | null = 'ff_test_k',
) {
  const server = createFormfeedServer({
    ...(apiKey ? { apiKey } : {}),
    fetch: fetchImpl,
    localFiles,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const structured = (r: { structuredContent?: unknown }) =>
  r.structuredContent as Record<string, unknown>;

describe('@formfeed/mcp', () => {
  it('lists the ten tools with schemas', async () => {
    const { client, close } = await connectedClient(fakeApi().fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_invoice',
      'convert_to_pdf',
      'get_render',
      'get_template_schema',
      'get_template_source',
      'get_workspace',
      'list_templates',
      'render',
      'save_template',
      'validate_template',
    ]);
    expect(tools.find((t) => t.name === 'render')?.inputSchema).toMatchObject({
      type: 'object',
    });
    // the hosted server reads no files, so its convert tool has no path
    expect(
      Object.keys(
        (
          tools.find((t) => t.name === 'convert_to_pdf')?.inputSchema as {
            properties: object;
          }
        ).properties,
      ),
    ).not.toContain('path');
    // directories read the hints literally: ChatGPT's wants all three on every tool, Claude's a title too
    for (const tool of tools) {
      // every tool says what it returns, so a client can check structuredContent against it (Smithery
      // scores it); the SDK holds each result to it, so the calls below prove the schemas fit
      expect(tool.outputSchema, tool.name).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      });
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    expect(
      tools
        .filter((t) => !t.annotations?.readOnlyHint)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['convert_to_pdf', 'render', 'save_template']);
    await close();
  });

  it('describes every parameter and names a sibling tool in every description', async () => {
    // What agents and the directories' graders read (Glama scores each tool on it): a parameter with a
    // type but no description, or a tool that never says when another one fits better, scored lowest.
    for (const localFiles of [false, true]) {
      const { client, close } = await connectedClient(
        fakeApi().fetchImpl,
        localFiles,
      );
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const tool of tools) {
        expect(
          names.filter((n) => n !== tool.name && tool.description?.includes(n)),
          tool.name,
        ).not.toEqual([]);
        const properties = (
          tool.inputSchema as {
            properties: Record<string, { description?: string }>;
          }
        ).properties;
        for (const [name, property] of Object.entries(properties))
          expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      }
      await close();
    }
  });

  it('says which workspace the server works in, from the account (plan 23)', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const result = structured(
      await client.callTool({ name: 'get_workspace', arguments: {} }),
    );
    expect(result).toMatchObject({
      workspace: { slug: 'production', name: 'Production', region: 'eu' },
      organization: { slug: 'fennlor' },
      plan: { id: 'starter' },
      environment: 'live',
      units: { included: 3000, used: 12 },
    });
    // nothing the API did not say: no limits, no ids an agent has no use for beyond the workspace's
    expect(Object.keys(result).sort()).toEqual([
      'environment',
      'organization',
      'period',
      'plan',
      'units',
      'workspace',
    ]);
    expect(api.calls.at(-1)).toMatchObject({
      method: 'GET',
      path: '/v1/account',
    });
    await close();
  });

  it('converts a render, an uploaded document and, on the user machine, a local file', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const fromRender = structured(
      await client.callTool({
        name: 'convert_to_pdf',
        arguments: { render_id: 'rnd_docx', page_ranges: '1-2' },
      }),
    );
    expect(fromRender).toMatchObject({
      id: 'rnd_pdf',
      download_url: 'https://cdn.test/o/report.pdf',
    });
    expect(api.calls.at(-1)?.body).toEqual({
      source: 'rnd_docx',
      page_ranges: '1-2',
      meta: { source: 'mcp' },
    });

    const bytes = Buffer.from('PK document');
    await client.callTool({
      name: 'convert_to_pdf',
      arguments: {
        file_base64: bytes.toString('base64'),
        file_name: 'report.xlsx',
        single_page_sheets: true,
      },
    });
    const form = api.calls.at(-1)?.body as FormData;
    expect((form.get('file') as File).name).toBe('report.xlsx');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(
      bytes,
    );
    expect(form.get('single_page_sheets')).toBe('true');
    expect(form.get('filename')).toBe('report.pdf');

    const none = await client.callTool({
      name: 'convert_to_pdf',
      arguments: {},
    });
    expect(none.isError).toBe(true);
    const two = await client.callTool({
      name: 'convert_to_pdf',
      arguments: {
        render_id: 'rnd_docx',
        file_base64: 'eA==',
        file_name: 'x.docx',
      },
    });
    expect(two.isError).toBe(true);
    const unnamed = await client.callTool({
      name: 'convert_to_pdf',
      arguments: { file_base64: 'eA==' },
    });
    expect(JSON.stringify(unnamed.content)).toMatch(/file_name is required/);
    await close();

    const local = await connectedClient(api.fetchImpl, true);
    const dir = mkdtempSync(join(tmpdir(), 'formfeed-mcp-'));
    try {
      writeFileSync(join(dir, 'slides.pptx'), bytes);
      const converted = structured(
        await local.client.callTool({
          name: 'convert_to_pdf',
          arguments: { path: join(dir, 'slides.pptx') },
        }),
      );
      expect(converted['id']).toBe('rnd_pdf');
      expect(
        ((api.calls.at(-1)?.body as FormData).get('file') as File).name,
      ).toBe('slides.pptx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await local.close();
    }
  });

  it('lists templates, infers the schema and validates html offline', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const list = structured(
      await client.callTool({
        name: 'list_templates',
        arguments: { kind: 'pdf' },
      }),
    );
    expect(list['templates']).toEqual([
      expect.objectContaining({
        slug: 'invoice',
        engine: 'jinja2',
        published_version: 2,
      }),
    ]);

    const schema = structured(
      await client.callTool({
        name: 'get_template_schema',
        arguments: { template: 'invoice' },
      }),
    );
    expect(schema['schema']).toMatchObject({
      type: 'object',
      properties: { invoice: { type: 'object' } },
    });
    expect(schema['sample_data']).toEqual({ invoice: { number: 5 } });

    const invalid = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: {
          html: '<p>{{ x | nope }}</p>',
          engine: 'liquid',
          data: {},
        },
      }),
    );
    expect(invalid['ok']).toBe(false);
    expect(JSON.stringify(invalid['diagnostics'])).toMatch(/nope/);
    // validation never called the render API
    expect(api.calls.some((c) => c.path === '/v1/renders')).toBe(false);
    await close();
  });

  it('validates a stored template through the API, which checks the data against its schema', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const valid = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: { template: 'invoice', data: { invoice: { vat_rate: 19 } } },
      }),
    );
    expect(valid).toEqual({
      ok: true,
      template: { id: 'tpl_1', slug: 'invoice', version: 2 },
      diagnostics: [],
    });
    expect(
      api.calls.find((c) => c.path === '/v1/templates/invoice/validate')?.body,
    ).toEqual({ version: 'published', data: { invoice: { vat_rate: 19 } } });

    // a rate written the way an invoice prints it passes the name check; the schema knows better
    const typed = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: {
          template: 'invoice',
          data: { invoice: { vat_rate: '19 %' } },
        },
      }),
    );
    expect(typed).toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'data-validation',
          path: 'data.invoice.vat_rate',
          message: 'data.invoice.vat_rate: must be number',
        },
      ],
    });

    // nothing published yet: the latest version, as render and get_template_schema do
    const draft = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: { template: 'draft' },
      }),
    );
    expect(draft).toMatchObject({ ok: true, template: { version: 1 } });

    // Word and PowerPoint findings keep their part and paragraph
    const office = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: { template: 'offer' },
      }),
    );
    expect(office['diagnostics']).toEqual([
      {
        severity: 'error',
        code: 'unknown-filter',
        message: 'Unknown filter or helper "nope"',
        part: 'word/document.xml',
        paragraph: 2,
      },
    ]);
    expect(api.calls.some((c) => c.path === '/v1/renders')).toBe(false);
    await close();
  });

  it('reads the source of a template and saves a change as a draft, never published (spec 10 §3.2)', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const posts = (path: string) =>
      api.calls.filter((c) => c.method === 'POST' && c.path === path);

    // the newest version by default, which a change builds on, with its checksum
    const source = structured(
      await client.callTool({
        name: 'get_template_source',
        arguments: { template: 'invoice' },
      }),
    );
    expect(source).toMatchObject({
      template: {
        id: 'tpl_1',
        slug: 'invoice',
        kind: 'pdf',
        engine: 'jinja2',
        published_version: 2,
      },
      version: { number: 2, checksum: 'c' },
      html: version.html,
      css: '',
      settings: {},
      sample_data: version.sample_data,
      data_sets: {},
      partials: {},
    });
    expect(
      api.calls.some((c) => c.path === '/v1/templates/invoice/versions/latest'),
    ).toBe(true);

    // a change keeps the parts it does not name, says what it is, and is not published
    const saved = await client.callTool({
      name: 'save_template',
      arguments: {
        template: 'invoice',
        base_checksum: 'c',
        css: 'tr:nth-child(even) { background: #f4f4f5 }',
        change_note: 'Zebra rows in the line items',
      },
    });
    expect(saved.isError).toBeFalsy();
    expect(posts('/v1/templates/invoice/versions')[0]?.body).toEqual({
      html: version.html,
      css: 'tr:nth-child(even) { background: #f4f4f5 }',
      head: '',
      settings: {},
      sample_data: version.sample_data,
      data_schema: null,
      i18n: null,
      change_note: 'Zebra rows in the line items',
      base_checksum: 'c',
      publish: false,
    });
    expect(structured(saved)).toMatchObject({
      template: { slug: 'invoice', published_version: 2 },
      version: { number: 3, status: 'draft', checksum: 'c3' },
      ok: true,
      diagnostics: [],
      review_url:
        'https://app.formfeed.dev/o/fennlor/w/production/templates/invoice',
    });
    // the check is of the draft just saved, not of what renders use
    expect(posts('/v1/templates/invoice/validate')[0]?.body).toEqual({
      version: '3',
    });

    // a version the agent did not read, or none, saves nothing
    for (const args of [
      { base_checksum: 'stale', change_note: 'x', html: '<p>x</p>' },
      { change_note: 'x', html: '<p>x</p>' },
    ]) {
      const refused = await client.callTool({
        name: 'save_template',
        arguments: { template: 'invoice', ...args },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('get_template_source');
    }
    expect(posts('/v1/templates/invoice/versions')).toHaveLength(1);

    // a new template's version 1 is a draft too
    const created = await client.callTool({
      name: 'save_template',
      arguments: {
        new_template: {
          slug: 'agent-invoice',
          name: 'Agent invoice',
          kind: 'pdf',
          engine: 'jinja2',
        },
        html: '<p>{{ number }}</p>',
        sample_data: { number: 1 },
        change_note: 'First draft',
      },
    });
    expect(posts('/v1/templates')[0]?.body).toEqual({
      slug: 'agent-invoice',
      name: 'Agent invoice',
      kind: 'pdf',
      engine: 'jinja2',
      html: '<p>{{ number }}</p>',
      sample_data: { number: 1 },
      change_note: 'First draft',
      publish: false,
    });
    expect(structured(created)).toMatchObject({
      template: { slug: 'agent-invoice', published_version: null },
      version: { number: 1, status: 'draft', checksum: 'n1' },
    });

    // a Word template is a document, and the gateway's refusal reaches the agent with its reason
    const word = await client.callTool({
      name: 'save_template',
      arguments: { template: 'offer', base_checksum: 'c', change_note: 'x' },
    });
    expect(word.isError).toBe(true);
    expect(JSON.stringify(word.content)).toContain('Word template');
    const locked = await client.callTool({
      name: 'save_template',
      arguments: { template: 'locked', base_checksum: 'c', change_note: 'x' },
    });
    expect(locked.isError).toBe(true);
    expect(JSON.stringify(locked.content)).toContain('Connected agents');

    // nothing anywhere published or moved a channel
    expect(
      api.calls.some(
        (c) => c.path.endsWith('/publish') || c.path.includes('/channels'),
      ),
    ).toBe(false);

    // and validate_template checks a named version, such as the draft
    const draft = structured(
      await client.callTool({
        name: 'validate_template',
        arguments: { template: 'invoice', version: 'latest' },
      }),
    );
    expect(draft).toMatchObject({ ok: true, template: { version: 1 } });
    expect(posts('/v1/templates/invoice/validate').at(-1)?.body).toEqual({
      version: 'latest',
    });
    await close();
  });

  it('renders and reports API problems as tool errors', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl);
    const render = await client.callTool({
      name: 'render',
      arguments: {
        template: 'invoice',
        data: { invoice: { number: 7 } },
        output: 'pdf',
      },
    });
    expect(structured(render)).toMatchObject({
      id: 'rnd_1',
      status: 'succeeded',
      download_url: 'https://cdn.test/o/x.pdf',
    });
    const request = api.calls.find((c) => c.path === '/v1/renders');
    expect(request?.body).toMatchObject({
      template: 'invoice',
      data: { invoice: { number: 7 } },
      output: 'pdf',
      meta: { source: 'mcp' },
    });

    const missing = await client.callTool({
      name: 'get_template_schema',
      arguments: { template: 'nope' },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/template_not_found/);
    await close();
  });

  it('hands an image back as a picture the agent can look at, and a large one or a PDF as its link', async () => {
    const { client, close } = await connectedClient(fakeApi().fetchImpl);
    const kinds = (r: { content?: unknown }) =>
      (r.content as Array<{ type: string }>).map((c) => c.type);

    const card = await client.callTool({
      name: 'render',
      arguments: { template: 'card', data: { title: 'Launch' } },
    });
    expect(structured(card)).toMatchObject({
      id: 'rnd_card',
      download_url: 'https://cdn.test/o/card.png',
    });
    expect(card.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ]);

    // past the limit the link is enough; a PDF has no picture to show
    const poster = await client.callTool({
      name: 'render',
      arguments: { template: 'poster', data: {} },
    });
    expect(kinds(poster)).toEqual(['text']);
    expect(structured(poster)).toMatchObject({ id: 'rnd_poster' });
    const invoice = await client.callTool({
      name: 'render',
      arguments: { template: 'invoice', data: { invoice: { number: 7 } } },
    });
    expect(kinds(invoice)).toEqual(['text']);
    await close();
  });

  it('starts without a key: the offline tools work, the others say how to get one', async () => {
    const api = fakeApi();
    const { client, close } = await connectedClient(api.fetchImpl, false, null);
    expect(client.getInstructions()).toMatch(/^No API key is set/);

    const invoice = await client.callTool({
      name: 'check_invoice',
      arguments: { invoice: {} },
    });
    expect(structured(invoice).ok).toBe(false);
    const html = await client.callTool({
      name: 'validate_template',
      arguments: { html: '<p>{{ a }}</p>', engine: 'jinja2', data: { a: 1 } },
    });
    expect(structured(html).ok).toBe(true);

    for (const [name, args] of [
      ['list_templates', {}],
      ['render', { html: '<p>x</p>' }],
      ['validate_template', { template: 'invoice' }],
      ['get_template_source', { template: 'invoice' }],
      [
        'save_template',
        { template: 'invoice', base_checksum: 'c', change_note: 'x' },
      ],
      ['get_workspace', {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect([name, result.isError]).toEqual([name, true]);
      expect(JSON.stringify(result.content)).toContain('FORMFEED_API_KEY');
    }
    // nothing was sent anywhere
    expect(api.calls).toHaveLength(0);
    await close();
  });

  it('hands on the verdict of a template that declares PDF/UA-1, and the rules of a strict render that failed', async () => {
    const { client, close } = await connectedClient(fakeApi().fetchImpl);
    // a render that did not ask says nothing about it
    expect(
      structured(
        await client.callTool({
          name: 'render',
          arguments: { template: 'invoice' },
        }),
      ),
    ).not.toHaveProperty('accessibility');
    const reported = structured(
      await client.callTool({
        name: 'render',
        arguments: { template: 'bescheid' },
      }),
    );
    expect(reported).toMatchObject({
      id: 'rnd_2',
      status: 'succeeded',
      accessibility: {
        standard: 'PDF/UA-1',
        conformant: false,
        failures: [{ rule: '7.4.2-1', elements: ['<h3>'] }],
      },
    });

    // strict: no file, and an agent that is to fix the template needs the rule and the element, not only the count
    const failed = await client.callTool({
      name: 'render',
      arguments: { template: 'streng' },
    });
    expect(failed.isError).toBe(true);
    const said = (failed.content as Array<{ text: string }>)[0]!.text;
    expect(said.startsWith('pdfua_validation_failed: ')).toBe(true);
    expect(JSON.parse(said.slice(said.indexOf('\n') + 1))).toMatchObject({
      accessibility: {
        check: 'strict',
        failures: [
          { rule: '7.4.2-1', code: 'heading-order', elements: ['<h3>'] },
        ],
      },
    });
    await close();
  });

  it('checks an e-invoice offline, renders one, and names the fields of a refused one', async () => {
    const { calls, fetchImpl } = fakeApi();
    const { client, close } = await connectedClient(fetchImpl);
    const invoice = invoiceSkeleton('2026-10-09');

    // offline: the engine's own check, nothing sent
    const before = calls.length;
    expect(
      structured(
        await client.callTool({
          name: 'check_invoice',
          arguments: { invoice },
        }),
      ),
    ).toEqual({ ok: true, problems: [] });
    const wrong = structured(
      await client.callTool({
        name: 'check_invoice',
        arguments: {
          invoice: { ...invoice, totals: { ...invoice.totals, due: '1.00' } },
        },
      }),
    );
    expect(wrong['ok']).toBe(false);
    expect(wrong['problems']).toEqual([
      expect.objectContaining({
        path: '_invoice.totals.due',
        rule: 'BR-CO-16',
      }),
    ]);
    expect(calls.length).toBe(before);

    // true asks for the defaults, and the render hands on the validator's report
    const made = structured(
      await client.callTool({
        name: 'render',
        arguments: {
          template: 'rechnung',
          data: { _invoice: invoice },
          einvoice: true,
        },
      }),
    );
    expect(calls.at(-1)?.body).toMatchObject({
      template: 'rechnung',
      data: { _invoice: { number: invoice.number } },
      post: { einvoice: {} },
    });
    expect(made['einvoice']).toMatchObject({
      validation: { valid: true, pdfa: 'PDF/A-3b' },
    });
    await client.callTool({
      name: 'render',
      arguments: {
        template: 'rechnung',
        data: { _invoice: invoice },
        einvoice: { profile: 'basic', xml: 'both' },
      },
    });
    expect(calls.at(-1)?.body).toMatchObject({
      post: { einvoice: { profile: 'basic', xml: 'both' } },
    });

    // a refusal names the field and the rule, which is what an agent corrects the block with
    const refused = await client.callTool({
      name: 'render',
      arguments: {
        template: 'falsch',
        data: { _invoice: invoice },
        einvoice: true,
      },
    });
    expect(refused.isError).toBe(true);
    const said = (refused.content as Array<{ text: string }>)[0]!.text;
    expect(said).toContain('einvoice_data_invalid');
    expect(said).toContain('data._invoice.totals.due');
    expect(said).toContain('BR-CO-16');

    // rules that stopped carry the report too, which tells the agent there is nothing to correct
    const stopped = await client.callTool({
      name: 'render',
      arguments: {
        template: 'gestoppt',
        data: { _invoice: invoice },
        einvoice: true,
      },
    });
    expect(stopped.isError).toBe(true);
    const told = (stopped.content as Array<{ text: string }>)[0]!.text;
    expect(told.startsWith('einvoice_validator_error: ')).toBe(true);
    expect(told).toContain('its rules stopped before they finished.');
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
      await client.connect(
        new StreamableHTTPClientTransport(new URL(handle.url), {
          requestInit: { headers: { authorization: 'Bearer ff_test_http' } },
        }),
      );
      const result = structured(
        await client.callTool({
          name: 'get_render',
          arguments: { id: 'rnd_1' },
        }),
      );
      expect(result['status']).toBe('succeeded');
      expect(keys).toContain('Bearer ff_test_http');
      await client.close();
    } finally {
      await handle.close();
    }
  });
});
