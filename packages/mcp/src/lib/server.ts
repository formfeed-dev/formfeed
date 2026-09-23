import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEngine, inferSchema, outputFormats, type Diagnostic } from '@formfeed/engine';
import { Formfeed, FormfeedError, type Render } from '@formfeed/sdk-ts';
import { z } from 'zod';

/**
 * `@formfeed/mcp` (spec 10 §3): the tools an agent needs to produce documents. One server per API
 * key: stdio takes the key from the environment, the hosted Streamable HTTP endpoint from the
 * request's bearer token. Validation of a stored template asks the API, which checks the data against
 * the template's schema; ad-hoc HTML is validated locally with the shared engine. Both are free.
 */
export interface ServerOptions {
  /** An API key, or an OAuth access token together with `workspaceId` (spec 10 §3.1). */
  apiKey: string;
  /** The workspace an access token acts in; sent as `X-Formfeed-Workspace`. Not for API keys, which carry theirs. */
  workspaceId?: string;
  baseUrl?: string;
  region?: 'eu' | 'us';
  fetch?: typeof fetch;
  /**
   * Lets `convert_to_pdf` read a local `path`: only the stdio server, which runs on the user's own
   * machine, sets it. The hosted server never reads files.
   */
  localFiles?: boolean;
}

/** The converter's upload limit; larger files are refused before they are read or sent. */
const CONVERT_LIMIT_BYTES = 20 * 1024 * 1024;

export const SERVER_INFO = { name: 'formfeed', version: '0.3.8' };

/**
 * Tool annotations, spelled out in full because directories read them literally: ChatGPT's wants
 * `readOnlyHint`, `destructiveHint` and `openWorldHint` on every tool, Claude's a title plus one of
 * the first two (docs/marketing/listings.md). No tool deletes or overwrites anything, and none acts
 * outside the key's workspace and the user's own files: a render's output is reachable only through
 * its signed link.
 */
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const CREATES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const engineSchema = z.enum(['jinja2', 'liquid', 'handlebars']);
const outputSchema = z.enum(outputFormats);
const kindSchema = z.enum(['pdf', 'image', 'docx', 'pptx']);

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
    headers: { 'user-agent': `formfeed-mcp/${SERVER_INFO.version}`, ...(options.workspaceId ? { 'x-formfeed-workspace': options.workspaceId } : {}) },
    ...(options.region ? { region: options.region } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Formfeed renders PDFs and images from HTML templates, and fills Word and PowerPoint templates (as DOCX, PPTX or PDF). Start with list_templates, read the data shape with get_template_schema, check data with validate_template, then call render and hand the download_url to the user. convert_to_pdf turns office documents into PDFs.',
  });

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description: 'Templates of the workspace the API key belongs to, with slug, kind (pdf, image, docx for Word, pptx for PowerPoint), engine and published version.',
      inputSchema: {
        kind: kindSchema.optional(),
        engine: engineSchema.optional(),
        tag: z.string().optional(),
        q: z.string().optional().describe('Search in name and slug'),
      },
      annotations: READS,
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
      annotations: READS,
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
      description:
        'Checks a template with data without rendering; free. With a template slug the API checks the version a render uses (the published one, else the latest) as the render would: syntax, header and footer, errors that happen only with this data, and the data against the template\'s stored JSON Schema (a wrong type or a missing required field is an error). With html plus engine it compiles offline and reports syntax errors, unknown filters and variables missing from the data. Warnings leave ok true: treat each one as a question to settle before rendering. For Word and PowerPoint templates the findings name the document part and paragraph.',
      inputSchema: {
        template: z.string().optional().describe('Template slug or tpl_ id'),
        html: z.string().optional().describe('Template source when no slug is given'),
        engine: engineSchema.optional().describe('Required with html'),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: READS,
    },
    async ({ template, html, engine, data }) => {
      try {
        if (template) {
          // The server's check is the one a render would pass: it knows the stored schema, so a rate
          // written as "19 %" fails here instead of printing NaN. Free, and it counts no unit. The
          // version is the one render and get_template_schema use: published, else the latest.
          const check = (version: string) => client.templates.validate(template, { version, ...(data ? { data } : {}) });
          const result = await check('published').catch((e: FormfeedError) => {
            if (e.status === 404) return check('latest');
            throw e;
          });
          return text({
            ok: result.ok,
            template: result.template,
            diagnostics: result.diagnostics.map((d) => ({
              severity: d.severity,
              code: d.code,
              message: d.message,
              ...(d.path ? { path: d.path } : {}),
              ...(d.location ? { line: d.location.line, column: d.location.column } : {}),
              ...(d.part ? { part: d.part, paragraph: d.paragraph } : {}),
            })),
          });
        }
        if (!html || !engine) return failure(new Error('Pass a template slug, or html and engine'));
        const eng = getEngine(engine);
        const diagnostics: Diagnostic[] = [];
        try {
          eng.compile(html, { name: 'ad-hoc' });
        } catch (e) {
          diagnostics.push({ severity: 'error', code: 'syntax-error', message: e instanceof Error ? e.message : String(e), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } });
        }
        diagnostics.push(...eng.analyze(html, { sampleData: data ?? {} }).diagnostics);
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
      description: 'Renders a template (with data) or raw HTML to a PDF or image, or a Word or PowerPoint template to DOCX, PPTX or PDF, and returns a download URL. Live keys consume units; test keys render free with a watermark.',
      inputSchema: {
        template: z.string().optional().describe('Template slug or tpl_ id'),
        html: z.string().optional().describe('Raw HTML instead of a template'),
        engine: engineSchema.optional().describe('Engine for html that contains template syntax'),
        data: z.record(z.string(), z.unknown()).optional(),
        output: outputSchema
          .optional()
          .describe(
            'Left out, the template decides: PDF for PDF templates and html, its image format for image templates, its default output for Word and PowerPoint templates. Word templates render docx or pdf, PowerPoint templates pptx or pdf',
          ),
        filename: z.string().optional(),
        locale: z.string().optional().describe('BCP 47 tag for helpers and translations, e.g. de-DE'),
        wait: z.boolean().default(true).describe('Wait for the render to finish (sync renders finish immediately)'),
      },
      annotations: CREATES,
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
    'convert_to_pdf',
    {
      title: 'Convert an office document to PDF',
      description: [
        'Converts a Word, Excel, PowerPoint, OpenDocument, RTF or HTML document (up to 20 MB) to a PDF and returns a download URL (Starter plan and above; units follow the PDF rule).',
        'Pass exactly one source: render_id, the render of a Word or PowerPoint template (output docx or pptx);',
        options.localFiles
          ? 'path, a file on this machine; or file_base64 with file_name.'
          : 'or file_base64 with file_name, the document itself.',
        'The document is converted and not kept.',
      ].join(' '),
      inputSchema: {
        render_id: z.string().optional().describe('rnd_ id of a render whose output is docx or pptx'),
        ...(options.localFiles ? { path: z.string().optional().describe('Absolute path of a document on this machine') } : {}),
        file_base64: z.string().optional().describe('The document, base64 encoded'),
        file_name: z.string().optional().describe('Name of the document, e.g. report.xlsx; the type is read from the content'),
        page_ranges: z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/).optional().describe('Pages to convert, e.g. 1-3,5'),
        landscape: z.boolean().optional().describe('Landscape for spreadsheets and documents without their own page setup'),
        single_page_sheets: z.boolean().optional().describe('Each spreadsheet sheet on one page'),
        filename: z.string().optional().describe('Name of the PDF'),
      },
      annotations: CREATES,
    },
    async (args) => {
      try {
        const { render_id, file_base64, file_name, page_ranges, landscape, single_page_sheets, filename } = args;
        const path = (args as { path?: string }).path;
        const sources = [render_id, file_base64, path].filter((s) => s !== undefined && s !== '');
        if (sources.length !== 1) return failure(new Error('Pass exactly one of render_id, file_base64' + (options.localFiles ? ' or path' : '')));
        const convert = {
          meta: { source: 'mcp' },
          ...(page_ranges ? { page_ranges } : {}),
          ...(landscape !== undefined ? { landscape } : {}),
          ...(single_page_sheets !== undefined ? { single_page_sheets } : {}),
          ...(filename ? { filename } : {}),
        };
        let render: Render;
        if (render_id) {
          render = await client.pdf.convert(render_id, convert);
        } else {
          let data: Uint8Array;
          let name: string;
          if (path) {
            const { readFile, stat } = await import('node:fs/promises');
            const { basename } = await import('node:path');
            if ((await stat(path)).size > CONVERT_LIMIT_BYTES) return failure(new Error(`${path} is larger than 20 MB, the limit for conversions`));
            data = new Uint8Array(await readFile(path));
            name = file_name ?? basename(path);
          } else {
            if (!file_name) return failure(new Error('file_name is required with file_base64'));
            data = Uint8Array.from(Buffer.from(file_base64!, 'base64'));
            if (data.length === 0) return failure(new Error('file_base64 is empty or not base64'));
            if (data.length > CONVERT_LIMIT_BYTES) return failure(new Error('The document is larger than 20 MB, the limit for conversions'));
            name = file_name;
          }
          render = await client.pdf.convert({ file: { data, name } }, { ...convert, ...(filename ? {} : { filename: `${name.replace(/\.[^.]+$/, '')}.pdf` }) });
        }
        if (render.status !== 'succeeded' && render.status !== 'failed') render = await client.renders.waitFor(render.id);
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
      annotations: READS,
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
