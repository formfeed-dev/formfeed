import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEngine, inferSchema, outputFormats, type Diagnostic } from '@formfeed/engine';
import { Formfeed, FormfeedError, type Render } from '@formfeed/sdk-ts';
import { z } from 'zod';

/**
 * `@formfeed/mcp` (spec 10 §3): the tools an agent needs to produce documents. One server per API
 * key: stdio takes the key from the environment, the hosted Streamable HTTP endpoint from the
 * request's bearer token. Validation runs the shared engine locally, so it is free and instant.
 */
export interface ServerOptions {
  apiKey: string;
  baseUrl?: string;
  region?: 'eu' | 'us';
  fetch?: typeof fetch;
}

export const SERVER_INFO = { name: 'formfeed', version: '0.2.0' };

const engineSchema = z.enum(['jinja2', 'liquid', 'handlebars']);
const outputSchema = z.enum(outputFormats);

const templateSummary = (t: { id: string; slug: string; name: string; kind: string; engine: string; description: string | null; tags: string[]; published_version: number | null; updated_at: string }) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  kind: t.kind,
  engine: t.engine,
  description: t.description,
  tags: t.tags,
  published_version: t.published_version,
  updated_at: t.updated_at,
});

const renderSummary = (r: Render) => ({
  id: r.id,
  status: r.status,
  download_url: r.download_url,
  expires_at: r.expires_at,
  page_count: r.page_count,
  units: r.units,
  environment: r.environment,
  template: r.template,
  error: r.error,
});

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function failure(e: unknown) {
  const message = e instanceof FormfeedError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

export function createFormfeedServer(options: ServerOptions): McpServer {
  const client = new Formfeed({
    apiKey: options.apiKey,
    ...(options.region ? { region: options.region } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Formfeed renders PDFs and images from templates. Start with list_templates, read the data shape with get_template_schema, check data with validate_template, then call render and hand the download_url to the user.',
  });

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description: 'Templates of the workspace the API key belongs to, with slug, kind (pdf or image), engine and published version.',
      inputSchema: {
        kind: z.enum(['pdf', 'image']).optional(),
        engine: engineSchema.optional(),
        tag: z.string().optional(),
        q: z.string().optional().describe('Search in name and slug'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const templates = await client.templates.all(args);
        return text({ templates: templates.map(templateSummary) });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'get_template_schema',
    {
      title: 'Get the data schema of a template',
      description: 'JSON Schema of the `data` object a template expects, plus the sample data it was designed with. Use it to build the data for render.',
      inputSchema: { template: z.string().describe('Template slug or tpl_ id') },
      annotations: { readOnlyHint: true },
    },
    async ({ template }) => {
      try {
        const version = await client.templates.versions.get(template, 'published').catch(async (e: FormfeedError) => {
          if (e.status === 404) return client.templates.versions.get(template, 'latest');
          throw e;
        });
        const schema = version.data_schema ?? inferSchema(version.sample_data ?? {});
        return text({ template, version: version.number, status: version.status, schema, sample_data: version.sample_data ?? {} });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'validate_template',
    {
      title: 'Validate a template with data',
      description: 'Compiles a template offline and reports errors (unknown filters, syntax) and warnings (variables missing from the data) without rendering. Pass a template slug, or html plus engine for ad-hoc HTML.',
      inputSchema: {
        template: z.string().optional().describe('Template slug or tpl_ id'),
        html: z.string().optional().describe('Template source when no slug is given'),
        engine: engineSchema.optional().describe('Required with html'),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ template, html, engine, data }) => {
      try {
        let source = html;
        let engineId = engine;
        let sample: unknown = data;
        if (template) {
          const version = await client.templates.versions.get(template, 'latest');
          const meta = await client.templates.get(template);
          source = version.html ?? '';
          engineId = meta.engine;
          sample = data ?? version.sample_data ?? {};
        }
        if (!source || !engineId) return failure(new Error('Pass a template slug, or html and engine'));
        const eng = getEngine(engineId);
        const diagnostics: Diagnostic[] = [];
        try {
          eng.compile(source, { name: template ?? 'ad-hoc' });
        } catch (e) {
          diagnostics.push({ severity: 'error', code: 'syntax-error', message: e instanceof Error ? e.message : String(e), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } });
        }
        diagnostics.push(...eng.analyze(source, { sampleData: sample ?? {} }).diagnostics);
        return text({
          ok: !diagnostics.some((d) => d.severity === 'error'),
          diagnostics: diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message, line: d.range.start.line, column: d.range.start.column })),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'render',
    {
      title: 'Render a document',
      description: 'Renders a template (with data) or raw HTML to a PDF or image and returns a download URL. Live keys consume units; test keys render free with a watermark.',
      inputSchema: {
        template: z.string().optional().describe('Template slug or tpl_ id'),
        html: z.string().optional().describe('Raw HTML instead of a template'),
        engine: engineSchema.optional().describe('Engine for html that contains template syntax'),
        data: z.record(z.string(), z.unknown()).optional(),
        output: outputSchema.optional().describe('Left out: PDF for PDF templates and html, the template\'s image format for image templates'),
        filename: z.string().optional(),
        locale: z.string().optional().describe('BCP 47 tag for helpers and translations, e.g. de-DE'),
        wait: z.boolean().default(true).describe('Wait for the render to finish (sync renders finish immediately)'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ template, html, engine, data, output, filename, locale, wait }) => {
      try {
        if (!template && !html) return failure(new Error('Pass template or html'));
        let render = await client.renders.create({
          ...(template ? { template } : {}),
          ...(html ? { html } : {}),
          ...(engine ? { engine } : {}),
          data: data ?? {},
          ...(output ? { output } : {}),
          ...(filename ? { filename } : {}),
          ...(locale ? { locale } : {}),
          meta: { source: 'mcp' },
        });
        if (wait && render.status !== 'succeeded' && render.status !== 'failed') render = await client.renders.waitFor(render.id);
        return text(renderSummary(render));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'get_render',
    {
      title: 'Get a render',
      description: 'Status, download URL and error of a render by id (rnd_…).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        return text(renderSummary(await client.renders.get(id)));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
