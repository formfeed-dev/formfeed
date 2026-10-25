import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  checkInvoice,
  getEngine,
  inferSchema,
  outputFormats,
  type Diagnostic,
} from '@formfeed/engine';
import { Formfeed, FormfeedError, type Render } from '@formfeed/sdk-ts';
import { z } from 'zod';

/**
 * `@formfeed/mcp` (spec 10 §3): the tools an agent needs to produce documents. One server per API
 * key: stdio takes the key from the environment, the hosted Streamable HTTP endpoint from the
 * request's bearer token. Validation of a stored template asks the API, which checks the data against
 * the template's schema; ad-hoc HTML is validated locally with the shared engine. Both are free.
 */
export interface ServerOptions {
  /**
   * An API key, or an OAuth access token together with `workspaceId` (spec 10 §3.1). Without one, as
   * the stdio server starts when FORMFEED_API_KEY is not set, only the offline tools work
   * (`validate_template` with html, `check_invoice`), and the others say how to get a key.
   */
  apiKey?: string;
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

/** What a tool that needs the API answers when the server has no key. */
const NO_KEY =
  'This tool needs a Formfeed API key. Set FORMFEED_API_KEY to a key from https://app.formfeed.dev/keys (a test key, ff_test_…, renders for free), or connect to https://mcp.formfeed.dev/mcp and sign in. Without a key, validate_template (with html and engine) and check_invoice work.';
const NO_KEY_INSTRUCTION =
  'No API key is set, so only validate_template with html and engine, and check_invoice, work here; every other tool answers with how to get a key.';

/** Outputs whose file is a picture an agent can look at, with the type it is sent as. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};
/** A larger picture stays a link: clients cap what one tool result may carry. */
const IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;

/** The body, or null once it grows past `limit`, without reading the rest. */
async function readCapped(
  res: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Base64 with Web APIs only: the hosted server runs in a Worker, which has no Buffer. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const SERVER_INFO = { name: 'formfeed', version: '0.3.20' };

/**
 * Tool annotations, spelled out in full because directories read them literally: ChatGPT's wants
 * `readOnlyHint`, `destructiveHint` and `openWorldHint` on every tool, Claude's a title plus one of
 * the first two (docs/marketing/listings.md). No tool deletes or overwrites anything, and none acts
 * outside the key's workspace and the user's own files: a render's output is reachable only through
 * its signed link.
 */
const READS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const CREATES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const engineSchema = z.enum(['jinja2', 'liquid', 'handlebars']);
const outputSchema = z.enum(outputFormats);
const kindSchema = z.enum(['pdf', 'image', 'docx', 'pptx']);

/*
 * What each tool returns, declared as its `outputSchema` so that a client can check the
 * `structuredContent` every result carries (Smithery scores it, and agents read the fields from it).
 * The SDK holds each result to its schema and turns a mismatch into an error, so a schema says only
 * what the API guarantees: a value the API leaves open stays a string or an open object, and nothing
 * here is strict about fields it does not name.
 */
const renderOutput = {
  id: z.string().describe('rnd_ id of the render'),
  status: z.enum(['queued', 'rendering', 'succeeded', 'failed']),
  download_url: z
    .string()
    .nullable()
    .describe('Signed link to the file; null until the render succeeded'),
  expires_at: z
    .string()
    .nullable()
    .describe('When download_url stops working; get_render issues a fresh one'),
  page_count: z.number().nullable(),
  units: z.number().describe('Units the render counted'),
  environment: z.enum(['live', 'test']),
  template: z
    .object({
      id: z.string(),
      slug: z.string(),
      version: z.number(),
      channel: z.string().nullable().optional(),
      canary: z.boolean().optional(),
    })
    .nullable()
    .describe(
      'The template and version rendered; null for html and conversions',
    ),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .nullable()
    .describe('Why a failed render failed'),
  accessibility: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The PDF/UA-1 verdict, when the template declares it'),
  einvoice: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The e-invoice report, when the render made one'),
};

const diagnosticOutput = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  path: z.string().optional().describe('Where in the data, for data errors'),
  line: z.number().optional(),
  column: z.number().optional(),
  part: z
    .string()
    .optional()
    .describe('Word and PowerPoint templates: the file part of the tag'),
  paragraph: z.number().optional(),
});

const templateSummary = (t: {
  id: string;
  slug: string;
  name: string;
  kind: string;
  engine: string;
  description: string | null;
  tags: string[];
  published_version: number | null;
  updated_at: string;
}) => ({
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
  // the validator's verdict of a render whose template declares PDF/UA-1 (plan 21): whether the
  // file passed, and for each failed rule what to change and in which elements
  ...(r.accessibility ? { accessibility: r.accessibility } : {}),
  // the report of an e-invoice (spec 17): valid, the findings, the XML's link, the hashes it checked
  ...(r.einvoice ? { einvoice: r.einvoice } : {}),
});

/** Problems of an e-invoice that carry what to fix: the findings of the check, or the validator's report. */
const EINVOICE_PROBLEMS = new Set([
  'einvoice_data_invalid',
  'einvoice_display_mismatch',
  'pdfa_conversion_failed',
]);

function text(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(e: unknown) {
  const message =
    e instanceof FormfeedError
      ? `${e.code}: ${e.message}`
      : e instanceof Error
        ? e.message
        : String(e);
  // A strict PDF/UA render that failed (plan 21) names the rules and their elements in the problem:
  // without them an agent knows that the template is at fault and not what to change in it.
  const verdict =
    e instanceof FormfeedError && e.code === 'pdfua_validation_failed'
      ? e.problem?.['accessibility']
      : undefined;
  // A refused e-invoice names the fields and rules to fix (`errors`) or carries the validator's
  // report (`einvoice`): an agent can correct the _invoice block only with them.
  const invoice =
    e instanceof FormfeedError && EINVOICE_PROBLEMS.has(e.code)
      ? Object.fromEntries(
          ['errors', 'einvoice']
            .filter((key) => e.problem?.[key] !== undefined)
            .map((key) => [key, e.problem?.[key]]),
        )
      : {};
  const details = {
    ...(verdict ? { accessibility: verdict } : {}),
    ...invoice,
  };
  return {
    content: [
      {
        type: 'text' as const,
        text:
          Object.keys(details).length > 0
            ? `${message}\n${JSON.stringify(details, null, 2)}`
            : message,
      },
    ],
    isError: true as const,
  };
}

export function createFormfeedServer(options: ServerOptions): McpServer {
  const client = options.apiKey
    ? new Formfeed({
        apiKey: options.apiKey,
        headers: {
          'user-agent': `formfeed-mcp/${SERVER_INFO.version}`,
          ...(options.workspaceId
            ? { 'x-formfeed-workspace': options.workspaceId }
            : {}),
        },
        ...(options.region ? { region: options.region } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  /** The API client of every tool that asks the API; without a key it answers with how to get one. */
  const api = (): Formfeed => {
    if (!client) throw new Error(NO_KEY);
    return client;
  };
  // called as a plain function: a stored Web API function called as a method loses its binding
  const fetchImpl: typeof fetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const server = new McpServer(SERVER_INFO, {
    instructions:
      (client ? '' : `${NO_KEY_INSTRUCTION} `) +
      'Formfeed renders PDFs and images from HTML templates, and fills Word and PowerPoint templates (as DOCX, PPTX or PDF). Start with list_templates, read the data shape with get_template_schema, check data with validate_template, then call render and hand the download_url to the user. An image render also returns the picture itself, so look at it before handing it on. For an e-invoice (ZUGFeRD / Factur-X), put the invoice into data._invoice, check it with check_invoice, and call render with einvoice set; the template prints the same block. convert_to_pdf turns office documents into PDFs. get_workspace says which workspace this server works in and what the period has left.',
  });

  /**
   * The rendered picture as image content, so an agent sees what it made: only for image outputs
   * (a PDF would need its page drawn first) and only up to IMAGE_LIMIT_BYTES. Anything that goes
   * wrong leaves the result as it was, with its link.
   */
  const picture = async (render: Render) => {
    const mimeType = IMAGE_TYPES[render.output];
    if (render.status !== 'succeeded' || !mimeType || !render.download_url)
      return [];
    try {
      const res = await fetchImpl(render.download_url);
      const bytes = res.ok ? await readCapped(res, IMAGE_LIMIT_BYTES) : null;
      return bytes
        ? [{ type: 'image' as const, data: base64(bytes), mimeType }]
        : [];
    } catch {
      return [];
    }
  };
  /** A render's result: its summary as text and structured content, then its picture if it has one. */
  const renderResult = async (render: Render) => {
    const result = text(renderSummary(render));
    return {
      ...result,
      content: [...result.content, ...(await picture(render))],
    };
  };

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        "Lists the templates of the workspace this server works in (the one chosen at sign-in, or the API key's), most recently changed first: id, slug, name, kind (pdf, image, docx for Word, pptx for PowerPoint), engine, tags and published_version. Call it first to find the slug that get_template_schema, validate_template and render take; skip it when the user already named the template. Returns every match in one answer, without archived templates, and an empty list when nothing matches. A template whose published_version is null has never been published, so render cannot use it yet. Read-only and free.",
      inputSchema: {
        kind: kindSchema
          .optional()
          .describe('Only templates that produce this kind of document'),
        engine: engineSchema
          .optional()
          .describe('Only templates written in this template language'),
        tag: z
          .string()
          .optional()
          .describe(
            'Only templates with this tag; exact match, tags are lowercase with dashes (e.g. billing)',
          ),
        q: z
          .string()
          .optional()
          .describe(
            'Text to find in the name or slug, case-insensitive (e.g. invoice)',
          ),
      },
      outputSchema: {
        templates: z.array(
          z.object({
            id: z.string().describe('tpl_ id'),
            slug: z.string(),
            name: z.string(),
            kind: z
              .string()
              .describe('pdf, image, docx (Word) or pptx (PowerPoint)'),
            engine: z.string().describe('jinja2, liquid or handlebars'),
            description: z.string().nullable(),
            tags: z.array(z.string()),
            published_version: z
              .number()
              .nullable()
              .describe('null: never published, so render cannot use it yet'),
            updated_at: z.string(),
          }),
        ),
      },
      annotations: READS,
    },
    async (args) => {
      try {
        const templates = await api().templates.all(args);
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
      description:
        'Returns the JSON Schema of the `data` object a template expects and the sample data it was designed with, from its published version, else its latest draft. Call it after list_templates and before render or validate_template, to build data that fits; ad-hoc html has no stored schema to read. When the template stores no schema, one is inferred from the sample data: treat that as a guide, not a contract. Read-only and free; an unknown slug returns an error.',
      inputSchema: {
        template: z
          .string()
          .describe(
            'Slug (e.g. invoice) or tpl_ id, as list_templates returns them',
          ),
      },
      outputSchema: {
        template: z.string(),
        version: z.number().describe('The version the schema comes from'),
        status: z
          .string()
          .describe('published, or draft when nothing is published yet'),
        schema: z
          .record(z.string(), z.unknown())
          .describe(
            'JSON Schema of data; inferred from sample_data when none is stored',
          ),
        sample_data: z.record(z.string(), z.unknown()),
      },
      annotations: READS,
    },
    async ({ template }) => {
      try {
        const version = await api()
          .templates.versions.get(template, 'published')
          .catch(async (e: FormfeedError) => {
            if (e.status === 404)
              return api().templates.versions.get(template, 'latest');
            throw e;
          });
        const schema =
          version.data_schema ?? inferSchema(version.sample_data ?? {});
        return text({
          template,
          version: version.number,
          status: version.status,
          schema,
          sample_data: version.sample_data ?? {},
        });
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
        'Checks a template and its data without rendering: free, no units, nothing stored, no document produced. Call it before render when you assembled the data yourself, or after writing ad-hoc html. With template, the API checks the published version (else the latest) as a render would: syntax, header and footer, errors only this data triggers, and the data against the stored JSON Schema (a wrong type or a missing required field is an error). With html and engine it compiles offline and reports syntax errors, unknown filters and variables missing from data. Returns ok and diagnostics (severity, code, message, plus path, line and column, or part and paragraph for Word and PowerPoint). Warnings leave ok true: settle each before rendering.',
      inputSchema: {
        template: z
          .string()
          .optional()
          .describe('Slug or tpl_ id of a stored template; pass this or html'),
        html: z
          .string()
          .optional()
          .describe(
            'Template source to check offline, when there is no stored template; pass this or template',
          ),
        engine: engineSchema
          .optional()
          .describe('Template language of html; required with html'),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'The data the document will be rendered with, shaped as get_template_schema describes. Left out, a stored template is checked with its sample data',
          ),
      },
      outputSchema: {
        ok: z.boolean().describe('false when a diagnostic is an error'),
        template: z
          .object({ id: z.string(), slug: z.string(), version: z.number() })
          .optional()
          .describe('The stored version checked; absent for html'),
        diagnostics: z.array(diagnosticOutput),
      },
      annotations: READS,
    },
    async ({ template, html, engine, data }) => {
      try {
        if (template) {
          // The server's check is the one a render would pass: it knows the stored schema, so a rate
          // written as "19 %" fails here instead of printing NaN. Free, and it counts no unit. The
          // version is the one render and get_template_schema use: published, else the latest.
          const check = (version: string) =>
            api().templates.validate(template, {
              version,
              ...(data ? { data } : {}),
            });
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
              ...(d.location
                ? { line: d.location.line, column: d.location.column }
                : {}),
              ...(d.part ? { part: d.part, paragraph: d.paragraph } : {}),
            })),
          });
        }
        if (!html || !engine)
          return failure(new Error('Pass a template slug, or html and engine'));
        const eng = getEngine(engine);
        const diagnostics: Diagnostic[] = [];
        try {
          eng.compile(html, { name: 'ad-hoc' });
        } catch (e) {
          diagnostics.push({
            severity: 'error',
            code: 'syntax-error',
            message: e instanceof Error ? e.message : String(e),
            range: {
              start: { line: 1, column: 1 },
              end: { line: 1, column: 2 },
            },
          });
        }
        diagnostics.push(
          ...eng.analyze(html, { sampleData: data ?? {} }).diagnostics,
        );
        return text({
          ok: !diagnostics.some((d) => d.severity === 'error'),
          diagnostics: diagnostics.map((d) => ({
            severity: d.severity,
            code: d.code,
            message: d.message,
            line: d.range.start.line,
            column: d.range.start.column,
          })),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'check_invoice',
    {
      title: 'Check an e-invoice',
      description:
        "Checks the _invoice block of an e-invoice offline, as the API does before it renders one: the fields EN 16931 asks for, the totals to the cent, VAT categories and code lists, and France's rules for an invoice between two French businesses. Free, no units, nothing sent. Returns ok and problems, each with the field, the rule (BR-…) where one applies and a message. Nothing is computed for you: change the values a problem names, check again, then call render with einvoice and the block as data._invoice. The validator that runs during the render holds the file to the full rule set and to PDF/A-3b as well.",
      inputSchema: {
        invoice: z
          .record(z.string(), z.unknown())
          .describe(
            'The _invoice block as it goes into data._invoice: number, issue_date, currency, seller, buyer, lines, tax.breakdown, totals and payment, as https://docs.formfeed.dev/templates/e-invoices#invoice-block describes',
          ),
        profile: z
          .enum(['en16931', 'basic'])
          .optional()
          .describe(
            'The profile the render will ask for; en16931 when left out. basic cannot carry a rounding amount and is refused between two French businesses',
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        problems: z.array(
          z.object({
            path: z.string().describe('The field, e.g. _invoice.seller.vat_id'),
            rule: z
              .string()
              .optional()
              .describe('The EN 16931 rule, e.g. BR-03'),
            message: z.string(),
          }),
        ),
      },
      annotations: READS,
    },
    async ({ invoice, profile }) => {
      const check = checkInvoice(invoice, { profile: profile ?? 'en16931' });
      return text({
        ok: check.ok,
        problems: check.problems.map((problem) => ({
          path: problem.path ? `_invoice.${problem.path}` : '_invoice',
          ...(problem.rule ? { rule: problem.rule } : {}),
          message: problem.message,
        })),
      });
    },
  );

  server.registerTool(
    'render',
    {
      title: 'Render a document',
      description:
        "Creates a document by filling a stored template, or ad-hoc html, with data: a PDF or image, or DOCX, PPTX or PDF from Word and PowerPoint templates. Returns the render with status and download_url; for an image (png, jpg or webp) up to 2 MB the result also carries the picture itself, so look at what you made before handing it on (a PDF comes as its link). Use it to make a document from data; to turn an existing office file into a PDF, use convert_to_pdf. Stored templates render their published version, so one whose published_version is null fails with template_not_found. Every call is a new render: a live key or a signed-in agent consumes units, a test key is free (watermarked on the Free plan). A render that fails returns status failed and an error with code and message; validate_template finds most causes beforehand. With einvoice the PDF becomes a ZUGFeRD / Factur-X e-invoice built from data._invoice (check the block with check_invoice first): the render then carries einvoice, the validator's report, and a refused invoice names the fields and rules to fix. The link expires at expires_at; get_render issues a fresh one.",
      inputSchema: {
        template: z
          .string()
          .optional()
          .describe('Slug or tpl_ id of a stored template; pass this or html'),
        html: z
          .string()
          .optional()
          .describe(
            'A complete HTML document to render instead of a stored template, up to 5 MB',
          ),
        engine: engineSchema
          .optional()
          .describe(
            'Template language of html, when it contains expressions to fill from data',
          ),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Values for the template, shaped as get_template_schema describes; leave out when it needs none',
          ),
        output: outputSchema
          .optional()
          .describe(
            'Left out, the template decides: PDF for PDF templates and html, its image format for image templates, its default output for Word and PowerPoint templates. Word templates render docx or pdf, PowerPoint templates pptx or pdf',
          ),
        filename: z
          .string()
          .optional()
          .describe(
            'Name of the file behind download_url, e.g. invoice-2026-0042.pdf',
          ),
        locale: z
          .string()
          .optional()
          .describe('BCP 47 tag for helpers and translations, e.g. de-DE'),
        wait: z
          .boolean()
          .default(true)
          .describe(
            'Most renders are finished when the call returns; true also waits for one that continues in the background, false returns it as it is (queued or rendering) to check later with get_render',
          ),
        einvoice: z
          .union([
            z.boolean(),
            z.object({
              profile: z
                .enum(['en16931', 'basic'])
                .optional()
                .describe(
                  'en16931 (default) carries the whole European standard; basic is the smallest full invoice and is refused between two French businesses',
                ),
              flavour: z
                .enum(['factur-x', 'zugferd'])
                .optional()
                .describe(
                  'One specification under two names; the default factur-x and zugferd make the same file',
                ),
              xml: z
                .enum(['embedded', 'both'])
                .optional()
                .describe(
                  'both also stores the XML as a file of its own, linked as einvoice.xml_url',
                ),
              display_check: z
                .enum(['warn', 'strict'])
                .optional()
                .describe(
                  'What a value of the XML that the PDF does not show does: a warning in the report (default) or a failed render',
                ),
            }),
          ])
          .optional()
          .describe(
            'Makes the PDF a ZUGFeRD / Factur-X e-invoice whose XML is built from data._invoice: true for the defaults, an object to choose, false to switch off what the template declares. PDF only; live renders from the Starter plan, test keys on Free make 20 marked ones a day',
          ),
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async ({
      template,
      html,
      engine,
      data,
      output,
      filename,
      locale,
      wait,
      einvoice,
    }) => {
      try {
        if (!template && !html)
          return failure(new Error('Pass template or html'));
        let render = await api().renders.create({
          ...(template ? { template } : {}),
          ...(html ? { html } : {}),
          ...(engine ? { engine } : {}),
          data: data ?? {},
          ...(output ? { output } : {}),
          ...(filename ? { filename } : {}),
          ...(locale ? { locale } : {}),
          ...(einvoice !== undefined
            ? { post: { einvoice: einvoice === true ? {} : einvoice } }
            : {}),
          meta: { source: 'mcp' },
        });
        if (wait && render.status !== 'succeeded' && render.status !== 'failed')
          render = await api().renders.waitFor(render.id);
        return await renderResult(render);
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
        'Converts an existing Word, Excel, PowerPoint, OpenDocument, RTF or HTML document (up to 20 MB) to a PDF as it is, without filling in data, and returns the render with status and download_url.',
        'To make a document from a template and data, use render instead.',
        'Pass exactly one source: render_id, the render of a Word or PowerPoint template (output docx or pptx);',
        options.localFiles
          ? 'path, a file on this machine; or file_base64 with file_name.'
          : 'or file_base64 with file_name, the document itself.',
        'Every call is a new render that counts units like a PDF; the Free plan cannot convert (Starter and above). The document is converted and not kept.',
      ].join(' '),
      inputSchema: {
        render_id: z
          .string()
          .optional()
          .describe(
            'rnd_ id of a render whose output is docx or pptx, to get that document as a PDF',
          ),
        ...(options.localFiles
          ? {
              path: z
                .string()
                .optional()
                .describe('Absolute path of the document on this machine'),
            }
          : {}),
        file_base64: z
          .string()
          .optional()
          .describe('The document to convert, base64 encoded; needs file_name'),
        file_name: z
          .string()
          .optional()
          .describe(
            'Name of the document, e.g. report.xlsx; the type is read from the content',
          ),
        page_ranges: z
          .string()
          .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/)
          .optional()
          .describe('Pages to convert, e.g. 1-3,5; all pages when left out'),
        landscape: z
          .boolean()
          .optional()
          .describe(
            'Landscape for spreadsheets and documents without their own page setup',
          ),
        single_page_sheets: z
          .boolean()
          .optional()
          .describe('Each spreadsheet sheet on one page'),
        filename: z
          .string()
          .optional()
          .describe('Name of the PDF behind download_url, e.g. report.pdf'),
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) => {
      try {
        const {
          render_id,
          file_base64,
          file_name,
          page_ranges,
          landscape,
          single_page_sheets,
          filename,
        } = args;
        const path = (args as { path?: string }).path;
        const sources = [render_id, file_base64, path].filter(
          (s) => s !== undefined && s !== '',
        );
        if (sources.length !== 1)
          return failure(
            new Error(
              'Pass exactly one of render_id, file_base64' +
                (options.localFiles ? ' or path' : ''),
            ),
          );
        const convert = {
          meta: { source: 'mcp' },
          ...(page_ranges ? { page_ranges } : {}),
          ...(landscape !== undefined ? { landscape } : {}),
          ...(single_page_sheets !== undefined ? { single_page_sheets } : {}),
          ...(filename ? { filename } : {}),
        };
        let render: Render;
        if (render_id) {
          render = await api().pdf.convert(render_id, convert);
        } else {
          let data: Uint8Array;
          let name: string;
          if (path) {
            const { readFile, stat } = await import('node:fs/promises');
            const { basename } = await import('node:path');
            if ((await stat(path)).size > CONVERT_LIMIT_BYTES)
              return failure(
                new Error(
                  `${path} is larger than 20 MB, the limit for conversions`,
                ),
              );
            data = new Uint8Array(await readFile(path));
            name = file_name ?? basename(path);
          } else {
            if (!file_name)
              return failure(
                new Error('file_name is required with file_base64'),
              );
            data = Uint8Array.from(Buffer.from(file_base64!, 'base64'));
            if (data.length === 0)
              return failure(new Error('file_base64 is empty or not base64'));
            if (data.length > CONVERT_LIMIT_BYTES)
              return failure(
                new Error(
                  'The document is larger than 20 MB, the limit for conversions',
                ),
              );
            name = file_name;
          }
          render = await api().pdf.convert(
            { file: { data, name } },
            {
              ...convert,
              ...(filename
                ? {}
                : { filename: `${name.replace(/\.[^.]+$/, '')}.pdf` }),
            },
          );
        }
        if (render.status !== 'succeeded' && render.status !== 'failed')
          render = await api().renders.waitFor(render.id);
        return await renderResult(render);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'get_render',
    {
      title: 'Get a render',
      description:
        'Returns the current state of a render: status (queued, rendering, succeeded or failed), download_url with expires_at, page_count, units and error, and the picture of a finished image render up to 2 MB. Use it to follow a render started with wait false, or to get a fresh link once the old one has expired; render and convert_to_pdf already return this for the render they just made. Read-only and free; an unknown id returns an error.',
      inputSchema: {
        id: z
          .string()
          .describe(
            'rnd_ id of the render, as render or convert_to_pdf returned it',
          ),
      },
      outputSchema: renderOutput,
      annotations: READS,
    },
    async ({ id }) => {
      try {
        return await renderResult(await api().renders.get(id));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'get_workspace',
    {
      title: 'Which workspace this server works in',
      description:
        'Returns the workspace and organisation this server acts in, the plan, the environment (live or test) and the units of the current period: included, used and the balance of prepaid units. Call it when the user asks where a document will land or how many renders are left, or when list_templates returns nothing you expected. A signed-in agent works in the workspace chosen when it was connected, which the person changes in Formfeed under Account → Connected agents; an API key works in the workspace it was made for. Read-only and free.',
      inputSchema: {},
      outputSchema: {
        workspace: z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          region: z.string().describe('eu, us or apac'),
        }),
        organization: z.object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
        }),
        plan: z.object({
          id: z.string(),
          name: z.string(),
          monthly_units: z
            .number()
            .nullable()
            .optional()
            .describe('Units included a month; null where the plan sets none'),
        }),
        environment: z
          .enum(['live', 'test'])
          .optional()
          .describe('live renders count units; test renders are free'),
        period: z
          .object({ start: z.string(), end: z.string() })
          .describe('The current billing period'),
        units: z.object({
          included: z.number().nullable().optional(),
          used: z.number(),
          overage_balance: z
            .number()
            .optional()
            .describe('Prepaid units left beyond the included ones'),
        }),
      },
      annotations: READS,
    },
    async () => {
      try {
        const { workspace, organization, plan, environment, period, units } =
          await api().account.get();
        return text({
          workspace,
          organization,
          plan,
          environment,
          period,
          units,
        });
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
