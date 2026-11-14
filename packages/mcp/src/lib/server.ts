import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  checkInvoice,
  getEngine,
  inferSchema,
  inlineMarkdownPictures,
  outputFormats,
  type Diagnostic,
} from '@formfeed/engine';
import {
  Formfeed,
  FormfeedError,
  type Diagnostic as SdkDiagnostic,
  type EinvoiceValidationReport,
  type PdfSource,
  type Render,
  type TemplateVersion,
} from '@formfeed/sdk-ts';
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
/** The PDF tools take up to 100 MB from a path; a PDF handed over as base64 goes up to 20 MB. */
const PDF_PATH_LIMIT_BYTES = 100 * 1024 * 1024;
const PDF_BASE64_LIMIT_BYTES = 20 * 1024 * 1024;
/** The most an e-invoice validation reads (plan 25 §9); a larger XML is refused before it is sent. */
const VALIDATE_LIMIT_BYTES = 4 * 1024 * 1024;

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

export const SERVER_INFO = { name: 'formfeed', version: '0.3.25' };

/**
 * Tool annotations, spelled out in full because directories read them literally: ChatGPT's wants
 * `readOnlyHint`, `destructiveHint` and `openWorldHint` on every tool, Claude's a title plus one of
 * the first two (docs/marketing/listings.md). No tool deletes or overwrites anything (save_template
 * adds a draft version beside the others), and none acts outside the key's workspace and the user's
 * own files: a render's output is reachable only through its signed link.
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
  output: z
    .string()
    .optional()
    .describe(
      'The format of the file: pdf, png, jpg, webp, docx or pptx, or zip for the several files of split_pdf and pdf_to_image',
    ),
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
  pdfa: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'The PDF/A verdict (PDF/A-2b or PDF/A-3b), when the template declares it',
    ),
  einvoice: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The e-invoice report, when the render made one'),
  form: z
    .object({
      filled: z.number(),
      skipped: z.array(z.object({ field: z.string(), reason: z.string() })),
      warnings: z.array(z.object({ field: z.string(), code: z.string() })),
      xfa_removed: z.boolean(),
    })
    .optional()
    .describe(
      'What fill_pdf_form did: the fields filled, those left out (unknown name or invalid value) and those whose calculation or display format no viewer ran',
    ),
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
  ...(r.output ? { output: r.output } : {}),
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
  // the verdict of a render whose template declares PDF/A (plan 26): the level and the validator
  ...(r.pdfa ? { pdfa: r.pdfa } : {}),
  // the report of an e-invoice (spec 17): valid, the findings, the XML's link, the hashes it checked
  ...(r.einvoice ? { einvoice: r.einvoice } : {}),
  // what a fill did (plan 30): the field names it filled, left out or could not compute, never a value
  ...(r.form ? { form: r.form } : {}),
});

/** A finding of the API's check as the tools hand it on: the location flattened to line and column. */
const diagnosticOf = (d: SdkDiagnostic) => ({
  severity: d.severity,
  code: d.code,
  message: d.message,
  ...(d.path ? { path: d.path } : {}),
  ...(d.location ? { line: d.location.line, column: d.location.column } : {}),
  ...(d.part ? { part: d.part, paragraph: d.paragraph } : {}),
});

const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  .describe(
    'New in the workspace: lowercase letters, digits and dashes, e.g. invoice-de',
  );

/** The parts of a version save_template takes; get_template_source returns the same names. */
const sourceParts = {
  html: z
    .string()
    .max(2 * 1024 * 1024)
    .optional()
    .describe(
      'The body markup in the template language, without <html>, <head> or <body>; up to 2 MB',
    ),
  css: z
    .string()
    .max(1024 * 1024)
    .optional()
    .describe('The stylesheet; up to 1 MB'),
  head: z
    .string()
    .max(256 * 1024)
    .optional()
    .describe('Extra markup for <head>, such as font links'),
  settings: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Paper, margins, header, footer, fonts and the other settings, as get_template_source returns them; replaces the stored settings as a whole',
    ),
  sample_data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'The data the editor previews with and the draft is checked with; never used by a render',
    ),
  data_sets: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Named sample data sets besides sample_data (name → data)'),
  data_schema: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe('JSON Schema of data; null removes the stored one'),
  i18n: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe('Translations: locale → key → text, read by the t helper'),
  partials: z
    .record(z.string(), z.string())
    .optional()
    .describe('Partials the template includes (name → source)'),
};

/**
 * The app a person reviews a draft in: Formfeed's own for its API hosts, none for another API (a
 * local stack), whose app the server cannot know.
 */
function appOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return 'https://app.formfeed.dev';
  try {
    return /^api(-[a-z]+)?\.formfeed\.dev$/.test(new URL(baseUrl).hostname)
      ? 'https://app.formfeed.dev'
      : null;
  } catch {
    return null;
  }
}

/** `organization.slug` or `workspace.slug` of the account, which the SDK leaves an open record. */
function slugIn(
  account: Record<string, unknown> | null,
  part: 'organization' | 'workspace',
): string | null {
  const value = account?.[part];
  const slug =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['slug']
      : null;
  return typeof slug === 'string' ? slug : null;
}

/**
 * Problems of an e-invoice that carry a report: the findings of the check, or the validator's
 * report, which also says when there was nothing to fix in the block (`einvoice_validator_error`).
 */
const EINVOICE_PROBLEMS = new Set([
  'einvoice_data_invalid',
  'einvoice_display_mismatch',
  'pdfa_validation_failed',
  'pdfa_conversion_failed',
  'einvoice_validator_error',
]);

/** The problems of the PDF tools whose extra fields an agent needs, and those fields. */
const PDF_TOOL_PROBLEMS = new Set([
  'redaction_incomplete',
  'form_field_unknown',
  'form_value_invalid',
  'invalid_request',
  'page_limit_exceeded',
]);
const PDF_TOOL_KEYS = [
  'page',
  'region',
  'regions',
  'text',
  'places',
  'copies',
  'unread',
  'unread_pages',
  'revisions',
  'field',
  'rule',
] as const;

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
  // A PDF/A that failed (plan 26) names the rules of its level and where veraPDF found them.
  const pdfa =
    e instanceof FormfeedError &&
    (e.code === 'pdfa_validation_failed' ||
      e.code === 'pdfa_conversion_failed' ||
      e.code === 'pdfua_validation_failed')
      ? e.problem?.['pdfa']
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
  // A PDF tool's refusal (plan 30) says what it is about by number and name, never by a value or a
  // text: the regions and texts a redaction left behind and the places that still hold one, the page
  // or region refused, a form field and the rule its value broke. With them an agent can correct
  // the call instead of guessing.
  const tool =
    e instanceof FormfeedError && PDF_TOOL_PROBLEMS.has(e.code)
      ? Object.fromEntries(
          PDF_TOOL_KEYS.filter((key) => e.problem?.[key] !== undefined).map(
            (key) => [key, e.problem?.[key]],
          ),
        )
      : {};
  const details = {
    ...(verdict ? { accessibility: verdict } : {}),
    ...(pdfa ? { pdfa } : {}),
    ...invoice,
    ...tool,
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
      'Formfeed renders PDFs and images from HTML templates, and fills Word and PowerPoint templates (as DOCX, PPTX or PDF). Start with list_templates, read the data shape with get_template_schema, check data with validate_template, then call render and hand the download_url to the user. An image render also returns the picture itself, so look at it before handing it on. For an e-invoice (ZUGFeRD / Factur-X), put the invoice into data._invoice, check it with check_invoice, and call render with einvoice set; the template prints the same block. validate_einvoice says which rules an e-invoice XML passed, by which validator, also one Formfeed did not make. markdown_to_pdf turns a Markdown document, such as a report you wrote, into a PDF without a template. convert_to_pdf turns office documents into PDFs. For a PDF that already exists, a render or one you are given: get_pdf_info reads its pages and form fields, fill_pdf_form fills the form by those names, redact_pdf removes text for good and checks that it is gone, split_pdf and compress_pdf cut and shrink it, and pdf_to_image draws a page and hands the picture back so you can look at it. To change a template or write a new one, read it with get_template_source and save it with save_template: it stays a draft until a person publishes it in Formfeed. get_workspace says which workspace this server works in and what the period has left.',
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
    'get_template_source',
    {
      title: 'Read the source of a template',
      description:
        "Returns what a template version is made of: the body markup (html), css, head, settings (paper, margins, header, footer, fonts), sample data, data sets, data schema, translations and partials, with the version's checksum. Call it before save_template to change a template the user named, and save what you edited with that checksum as base_checksum. Reads the latest version by default, the newest draft a change builds on; published reads what renders use. Word and PowerPoint templates are documents: for them it returns the settings and data, not the document. Read-only and free.",
      inputSchema: {
        template: z
          .string()
          .describe(
            'Slug (e.g. invoice) or tpl_ id, as list_templates returns them',
          ),
        version: z
          .union([z.string().min(1).max(32), z.number().int().positive()])
          .optional()
          .describe(
            'latest (default), published, a version number or a channel name',
          ),
      },
      outputSchema: {
        template: z.object({
          id: z.string().describe('tpl_ id'),
          slug: z.string(),
          name: z.string(),
          kind: z
            .string()
            .describe('pdf, image, docx (Word) or pptx (PowerPoint)'),
          engine: z.string().describe('jinja2, liquid or handlebars'),
          published_version: z.number().nullable(),
        }),
        version: z.object({
          number: z.number(),
          status: z.string().describe('draft, published or archived'),
          checksum: z
            .string()
            .describe('Pass it to save_template as base_checksum'),
          change_note: z.string().nullable(),
        }),
        html: z.string(),
        css: z.string(),
        head: z.string(),
        settings: z.record(z.string(), z.unknown()),
        sample_data: z.record(z.string(), z.unknown()),
        data_sets: z.record(z.string(), z.unknown()),
        data_schema: z.record(z.string(), z.unknown()).nullable(),
        i18n: z.record(z.string(), z.unknown()).nullable(),
        partials: z.record(z.string(), z.string()),
      },
      annotations: READS,
    },
    async ({ template, version }) => {
      try {
        const [tpl, row] = await Promise.all([
          api().templates.get(template),
          api().templates.versions.get(template, version ?? 'latest'),
        ]);
        return text({
          template: {
            id: tpl.id,
            slug: tpl.slug,
            name: tpl.name,
            kind: tpl.kind,
            engine: tpl.engine,
            published_version: tpl.published_version,
          },
          version: {
            number: row.number,
            status: row.status,
            checksum: row.checksum,
            change_note: row.change_note,
          },
          html: row.html ?? '',
          css: row.css ?? '',
          head: row.head ?? '',
          settings: row.settings ?? {},
          sample_data: row.sample_data ?? {},
          data_sets: row.data_sets ?? {},
          data_schema: row.data_schema ?? null,
          i18n: row.i18n ?? null,
          partials: row.partials ?? {},
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
        'Checks a template and its data without rendering: free, no units, nothing stored, no document produced. Call it before render when you assembled the data yourself, or after writing ad-hoc html. With template, the API checks the published version (else the latest, or the version you name) as a render would: syntax, header and footer, errors only this data triggers, and the data against the stored JSON Schema (a wrong type or a missing required field is an error). With html and engine it compiles offline and reports syntax errors, unknown filters and variables missing from data. Returns ok and diagnostics (severity, code, message, plus path, line and column, or part and paragraph for Word and PowerPoint). Warnings leave ok true: settle each before rendering.',
      inputSchema: {
        template: z
          .string()
          .optional()
          .describe('Slug or tpl_ id of a stored template; pass this or html'),
        version: z
          .union([z.string().min(1).max(32), z.number().int().positive()])
          .optional()
          .describe(
            'With template: the version to check, such as latest for the newest draft or a number; left out, the published one, else the latest',
          ),
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
    async ({ template, version, html, engine, data }) => {
      try {
        if (template) {
          // The server's check is the one a render would pass: it knows the stored schema, so a rate
          // written as "19 %" fails here instead of printing NaN. Free, and it counts no unit. The
          // version is the one render and get_template_schema use, published, else the latest,
          // unless one is named (a draft save_template just saved).
          const check = (which: string) =>
            api().templates.validate(template, {
              version: which,
              ...(data ? { data } : {}),
            });
          const result =
            version !== undefined
              ? await check(String(version))
              : await check('published').catch((e: FormfeedError) => {
                  if (e.status === 404) return check('latest');
                  throw e;
                });
          return text({
            ok: result.ok,
            template: result.template,
            diagnostics: result.diagnostics.map(diagnosticOf),
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

  /**
   * Template drafts (spec 10 §3.2): a new version of a template, or a new template, never published,
   * so renders keep the published version until a person publishes the draft in Formfeed. An API key
   * needs `template:write`; a signed-in agent needs its person's permission, which the gateway
   * checks and explains when it refuses.
   */
  server.registerTool(
    'save_template',
    {
      title: 'Save a template as a draft',
      description:
        "Saves a template as a draft, never published: renders keep using the published version until a person publishes the draft in Formfeed. With template and base_checksum it saves a new version of that template: read it with get_template_source first, change what the user asked for, and pass only the parts you changed (the others are kept from the version you read). With new_template and html it creates a template whose version 1 is the draft. change_note says what changed; the person reads it before publishing. Returns the saved version, the check of the draft with its sample data (fix every error and save again) and review_url, the page where the person reviews and publishes it: hand that to the user. Needs an API key with template:write, or, for a signed-in agent, the person's permission under Account → Connected agents in Formfeed. Word and PowerPoint templates cannot be saved here. Free; a new template counts towards the plan's template limit.",
      inputSchema: {
        template: z
          .string()
          .optional()
          .describe(
            'Slug or tpl_ id of the template to save a new draft of; pass this or new_template',
          ),
        base_checksum: z
          .string()
          .max(80)
          .optional()
          .describe(
            'With template: the checksum get_template_source returned. When someone saved a newer version since, nothing is saved: read the source again and redo the change on it',
          ),
        new_template: z
          .object({
            slug: slugSchema,
            name: z.string().min(1).max(200),
            kind: z
              .enum(['pdf', 'image'])
              .describe('pdf for documents, image for pictures'),
            engine: engineSchema.describe('The template language of html'),
            description: z.string().max(2000).optional(),
            tags: z
              .array(z.string().max(40))
              .max(20)
              .optional()
              .describe('Lowercase with dashes, e.g. billing'),
          })
          .optional()
          .describe(
            'Creates a template whose version 1 is this draft; pass this and html, or template',
          ),
        ...sourceParts,
        change_note: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'What the draft changes, in one sentence, shown in the version history',
          ),
      },
      outputSchema: {
        template: z.object({
          id: z.string().describe('tpl_ id'),
          slug: z.string(),
          name: z.string(),
          published_version: z
            .number()
            .nullable()
            .describe(
              'The version renders still use; null when nothing is published yet',
            ),
        }),
        version: z.object({
          number: z.number(),
          status: z.string().describe('draft'),
          checksum: z
            .string()
            .describe('base_checksum for a further change to this draft'),
        }),
        ok: z
          .boolean()
          .nullable()
          .describe(
            'false when the check of the draft found an error; null when the check could not run',
          ),
        diagnostics: z.array(diagnosticOutput),
        review_url: z
          .string()
          .optional()
          .describe(
            'The page in Formfeed where the person reviews and publishes the draft',
          ),
        next: z.string(),
      },
      annotations: CREATES,
    },
    async (args) => {
      const { template, base_checksum, new_template, change_note } = args;
      try {
        if (!template === !new_template)
          return failure(
            new Error(
              'Pass template with base_checksum to save a new draft of a template, or new_template with html to create one',
            ),
          );
        let saved: TemplateVersion;
        let slug: string;
        if (template) {
          if (!base_checksum)
            return failure(
              new Error(
                'Pass base_checksum: read the template with get_template_source, change it, and save it with the checksum you read',
              ),
            );
          const [tpl, base] = await Promise.all([
            api().templates.get(template),
            api().templates.versions.get(template, 'latest'),
          ]);
          if (tpl.kind === 'docx' || tpl.kind === 'pptx')
            return failure(
              new Error(
                `${tpl.slug} is a ${tpl.kind === 'docx' ? 'Word' : 'PowerPoint'} template: its document is changed in ${tpl.kind === 'docx' ? 'Word' : 'PowerPoint'} and uploaded in Formfeed, not saved here`,
              ),
            );
          // the API checks it too; checked here first so the kept parts come from the version the agent read
          if (base.checksum !== base_checksum)
            return failure(
              new Error(
                'conflict: someone saved a newer version of this template since you read it. Read it again with get_template_source and make the change on that version',
              ),
            );
          saved = await api().templates.versions.create(template, {
            html: args.html ?? base.html ?? '',
            css: args.css ?? base.css,
            head: args.head ?? base.head,
            settings: args.settings ?? base.settings,
            sample_data: args.sample_data ?? base.sample_data,
            data_sets: args.data_sets ?? base.data_sets,
            data_schema:
              args.data_schema !== undefined
                ? args.data_schema
                : base.data_schema,
            i18n: args.i18n !== undefined ? args.i18n : base.i18n,
            partials: args.partials ?? base.partials,
            change_note,
            base_checksum,
            publish: false,
          });
          slug = tpl.slug;
        } else {
          if (!new_template || args.html === undefined)
            return failure(new Error('html is required for a new template'));
          const created = await api().templates.create({
            ...new_template,
            html: args.html,
            css: args.css,
            head: args.head,
            settings: args.settings,
            sample_data: args.sample_data,
            data_sets: args.data_sets,
            data_schema: args.data_schema,
            i18n: args.i18n,
            partials: args.partials,
            change_note,
            publish: false,
          });
          slug = created.slug;
          saved = await api().templates.versions.get(slug, 'latest');
        }
        const origin = appOrigin(options.baseUrl);
        const [tpl, check, account] = await Promise.all([
          api().templates.get(slug),
          // the check of the draft itself, with its sample data; a check that cannot run leaves the draft saved
          api()
            .templates.validate(slug, { version: String(saved.number) })
            .then(
              (result) => ({ result, error: null }),
              (e: unknown) => ({
                result: null,
                error: e instanceof Error ? e.message : String(e),
              }),
            ),
          origin
            ? api()
                .account.get()
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        const org = slugIn(account, 'organization');
        const workspace = slugIn(account, 'workspace');
        return text({
          template: {
            id: tpl.id,
            slug: tpl.slug,
            name: tpl.name,
            published_version: tpl.published_version,
          },
          version: {
            number: saved.number,
            status: saved.status,
            checksum: saved.checksum,
          },
          ok: check.result ? check.result.ok : null,
          diagnostics: check.result
            ? check.result.diagnostics.map(diagnosticOf)
            : [],
          ...(origin && org && workspace
            ? {
                review_url: `${origin}/o/${org}/w/${workspace}/templates/${tpl.slug}`,
              }
            : {}),
          next: check.result
            ? `Saved as draft version ${saved.number}; nothing is published. Ask the person to review it in Formfeed and publish it there.`
            : `Saved as draft version ${saved.number}; nothing is published. The check could not run (${check.error}): call validate_template with version ${saved.number} before asking the person to publish it.`,
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
    'validate_einvoice',
    {
      title: 'Validate an e-invoice',
      description: [
        'Says which rules an e-invoice passed, by which validator and release: the file is held to the rule set its specification identifier (BT-24) names, Factur-X and ZUGFeRD by Mustang, XRechnung (CII and UBL) by the KoSIT validator, and each check (syntax, schema, every named rule set) comes back with its own result and findings.',
        'Pass exactly one source: render_id, an e-invoice this workspace rendered, which is answered from the report the render keeps and costs nothing;',
        options.localFiles
          ? 'path, an XML file on this machine; or xml_base64, the XML itself.'
          : 'or xml_base64, the XML itself.',
        "An XML takes one of the organisation's validations of the day (from the Starter plan; Free validates no uploads). Up to 4 MB of CII or UBL; a PDF is not taken. result is passed, failed or not_checked: not_checked means no rule set here is for the file (reason and explanation say why, such as an identifier it does not know), not that the file is wrong.",
        'The report says which rules a file passed; it does not say whether the document is a proper invoice for VAT purposes. To check an _invoice block before rendering it, use check_invoice.',
      ].join(' '),
      inputSchema: {
        render_id: z
          .string()
          .optional()
          .describe(
            'rnd_ id of a render of this workspace that made an e-invoice; free',
          ),
        xml_base64: z
          .string()
          .optional()
          .describe(
            'The e-invoice XML (CII or UBL), base64 encoded, up to 4 MB; counts one of the day’s validations',
          ),
        ...(options.localFiles
          ? {
              path: z
                .string()
                .optional()
                .describe(
                  'Absolute path of an e-invoice XML on this machine; counts one of the day’s validations',
                ),
            }
          : {}),
        rules: z
          .enum(['auto', 'factur-x', 'xrechnung', 'en16931'])
          .optional()
          .describe(
            "auto (default) takes the rule set the file's identifier names; a rule set named here judges only a file whose identifier it is for. en16931 holds a render's EN 16931 invoice to CEN's own rules, which counts like an upload",
          ),
      },
      outputSchema: {
        result: z
          .string()
          .describe('passed, failed or not_checked; new values may be added'),
        reason: z
          .string()
          .nullable()
          .describe('Why it was not checked, such as unknown_customization_id'),
        explanation: z.string().nullable(),
        validator: z
          .string()
          .nullable()
          .describe(
            'The validator and its version, e.g. KoSIT validator 1.6.3',
          ),
        rules: z
          .string()
          .nullable()
          .describe('The rule set and its release, as the validator names it'),
        customization_id: z
          .string()
          .nullable()
          .describe('The specification identifier (BT-24) the file names'),
        checks: z.array(
          z.object({
            kind: z.string().describe('syntax, schema, rules or container'),
            name: z.string(),
            result: z.string().describe('passed, failed or not_run'),
            errors: z.array(
              z.object({
                rule: z.string().nullable(),
                message: z.string(),
                location: z.string().nullable(),
              }),
            ),
            warnings: z.number().describe('How many warnings the check found'),
          }),
        ),
        xml_sha256: z
          .string()
          .nullable()
          .describe('SHA-256 of the XML that was judged'),
        allowance: z
          .object({
            limit: z.number().nullable(),
            used: z.number(),
            resets_at: z.string(),
          })
          .nullable()
          .describe(
            "What the day's validations have used after this call; null where nothing was counted",
          ),
      },
      annotations: READS,
    },
    async (args) => {
      try {
        const { render_id, xml_base64, rules } = args;
        const path = (args as { path?: string }).path;
        const sources = [render_id, xml_base64, path].filter(
          (s) => s !== undefined && s !== '',
        );
        if (sources.length !== 1)
          return failure(
            new Error(
              'Pass exactly one of render_id, xml_base64' +
                (options.localFiles ? ' or path' : ''),
            ),
          );
        let report: EinvoiceValidationReport;
        if (render_id) {
          report = await api().einvoices.validate(render_id, {
            ...(rules ? { rules } : {}),
          });
        } else {
          let data: Uint8Array;
          let name: string;
          if (path) {
            const { readFile, stat } = await import('node:fs/promises');
            const { basename } = await import('node:path');
            if ((await stat(path)).size > VALIDATE_LIMIT_BYTES)
              return failure(
                new Error(
                  `${path} is larger than 4 MB, the most a validation reads`,
                ),
              );
            data = new Uint8Array(await readFile(path));
            name = basename(path);
          } else {
            data = Uint8Array.from(Buffer.from(xml_base64!, 'base64'));
            if (data.length === 0)
              return failure(new Error('xml_base64 is empty or not base64'));
            if (data.length > VALIDATE_LIMIT_BYTES)
              return failure(
                new Error(
                  'The XML is larger than 4 MB, the most a validation reads',
                ),
              );
            name = 'invoice.xml';
          }
          report = await api().einvoices.validate(
            { file: { data, name } },
            { ...(rules ? { rules } : {}) },
          );
        }
        return text({
          result: report.result,
          reason: report.reason,
          explanation: report.explanation,
          validator: report.validator,
          rules: report.rules,
          customization_id: report.route?.customization_id ?? null,
          checks: report.checks.map((check) => ({
            kind: check.kind,
            name: check.name,
            result: check.result,
            errors: check.messages
              .filter((message) => message.severity === 'error')
              .map((message) => ({
                rule: message.rule,
                message: message.message,
                location: message.location,
              })),
            warnings: check.messages.filter(
              (message) => message.severity !== 'error',
            ).length,
          })),
          xml_sha256: report.xml_sha256,
          allowance: report.allowance,
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
      description:
        "Creates a document by filling a stored template, or ad-hoc html, with data: a PDF or image, or DOCX, PPTX or PDF from Word and PowerPoint templates. Returns the render with status and download_url; for an image (png, jpg or webp) up to 2 MB the result also carries the picture itself, so look at what you made before handing it on (a PDF comes as its link). Use it to make a document from data; to turn an existing office file into a PDF, use convert_to_pdf, and for a Markdown document, markdown_to_pdf. Stored templates render their published version, so one whose published_version is null fails with template_not_found. Every call is a new render: a live key or a signed-in agent consumes units, a test key is free (watermarked on the Free plan). A render that fails returns status failed and an error with code and message; validate_template finds most causes beforehand. With einvoice the PDF becomes a ZUGFeRD / Factur-X e-invoice built from data._invoice (check the block with check_invoice first): the render then carries einvoice, the validator's report, and a refused invoice names the fields and rules to fix. The link expires at expires_at; get_render issues a fresh one.",
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
    'markdown_to_pdf',
    {
      title: 'Turn Markdown into a PDF',
      description: [
        'Turns a Markdown document into a PDF without a template, e.g. a report, notes or an answer you wrote, and returns the render with status and download_url.',
        'It reads GitHub Flavored Markdown (tables, task lists, strikethrough) and footnotes; a YAML front matter block gives the title, author, subject and keywords, else the first heading is the title; a line \\newpage starts a new page.',
        'Raw HTML in the text is shown as text. A picture named without an address (![Logo](logo.png)) is a file of the workspace library, uploaded in Formfeed;',
        options.localFiles
          ? 'with path, a picture beside the file is sent along instead.'
          : 'a picture can also be a data:image URI.',
        'The headings become the PDF bookmarks by default, and pdf_ua checks the file against PDF/UA-1 before it is delivered.',
        'To fill a template with data, use render; to convert an office file, use convert_to_pdf.',
        'Every call is a new render: one unit per started five pages on a live key or for a signed-in agent, free with a test key; every plan.',
      ].join(' '),
      inputSchema: {
        // the hosted server reads no files, so the text is all there is
        markdown: (options.localFiles
          ? z.string().optional()
          : z.string()
        ).describe(
          'The document as Markdown text, up to 1 MB' +
            (options.localFiles ? '; pass this or path' : ''),
        ),
        ...(options.localFiles
          ? {
              path: z
                .string()
                .optional()
                .describe(
                  'Absolute path of a Markdown file on this machine; pictures inside its folder are sent along',
                ),
            }
          : {}),
        title: z
          .string()
          .max(500)
          .optional()
          .describe(
            'The PDF title; left out, the front matter title or the first heading',
          ),
        theme: z
          .enum(['document', 'none'])
          .optional()
          .describe(
            'document (default) styles the text, in the brand kit fonts and colour where the workspace has one; none leaves the styling to css',
          ),
        css: z
          .string()
          .max(256 * 1024)
          .optional()
          .describe(
            'A stylesheet after the theme, e.g. h1 { color: #0f766e }; the document is inside div.ff-markdown',
          ),
        paper: z
          .enum(['A4', 'Letter'])
          .optional()
          .describe('Paper size; A4 when left out'),
        landscape: z.boolean().optional().describe('Landscape pages'),
        outline: z
          .boolean()
          .default(true)
          .describe(
            'Bookmarks from the headings (default true); they cost nothing',
          ),
        pdf_ua: z
          .boolean()
          .optional()
          .describe(
            'Makes the file a PDF/UA-1 document checked by veraPDF; a file that fails is not delivered and the result names the rules',
          ),
        filename: z
          .string()
          .optional()
          .describe('Name of the PDF behind download_url, e.g. report.pdf'),
        wait: z
          .boolean()
          .default(true)
          .describe(
            'true waits for a render that continues in the background; false returns it as it is, to check later with get_render',
          ),
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) => {
      try {
        const path = (args as { path?: string }).path;
        if ((args.markdown === undefined) === (path === undefined))
          return failure(
            new Error(
              options.localFiles
                ? 'Pass exactly one of markdown or path'
                : 'Pass markdown',
            ),
          );
        let markdown: string;
        let name = 'document';
        if (path !== undefined) {
          const { readFile, stat } = await import('node:fs/promises');
          const { basename, dirname, extname, isAbsolute, relative, resolve } =
            await import('node:path');
          if (!/\.(md|markdown)$/i.test(path))
            return failure(new Error(`${path} is not a Markdown file (.md)`));
          const folder = dirname(path);
          const pictures = await inlineMarkdownPictures(
            (await readFile(path, 'utf8')).replace(/^\uFEFF/, ''),
            {
              locate(picture) {
                const file = resolve(folder, picture);
                const inside = relative(folder, file);
                return inside && !inside.startsWith('..') && !isAbsolute(inside)
                  ? file
                  : null;
              },
              async read(file) {
                const info = await stat(file).catch(() => null);
                return info?.isFile()
                  ? new Uint8Array(await readFile(file))
                  : null;
              },
            },
          );
          markdown = pictures.markdown;
          name = basename(path, extname(path));
        } else markdown = args.markdown!;
        const { title, theme, css, paper, landscape, outline, pdf_ua } = args;
        const settings = {
          ...(theme || css
            ? {
                markdown: {
                  ...(theme ? { theme } : {}),
                  ...(css ? { css } : {}),
                },
              }
            : {}),
          ...(paper || landscape !== undefined
            ? {
                paper: {
                  ...(paper ? { format: paper } : {}),
                  ...(landscape !== undefined ? { landscape } : {}),
                },
              }
            : {}),
          pdf: {
            outline,
            ...(pdf_ua ? { ua: true } : {}),
            ...(title ? { metadata: { title } } : {}),
          },
        };
        let render = await api().renders.create({
          markdown,
          output: 'pdf',
          settings,
          filename: args.filename ?? `${name}.pdf`,
          meta: { source: 'mcp' },
        });
        if (
          args.wait &&
          render.status !== 'succeeded' &&
          render.status !== 'failed'
        )
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

  // --- the PDF tools of plan 30: on a PDF of the workspace or one the call hands over ---------------
  const pdfInput = {
    source: z
      .string()
      .optional()
      .describe(
        'A PDF of the workspace: the rnd_ id of a PDF render, or a PDF of the file library by name (such as terms.pdf) or fil_ id',
      ),
    ...(options.localFiles
      ? {
          path: z
            .string()
            .optional()
            .describe(
              'Absolute path of a PDF on this machine, up to 100 MB; sent with the request and not kept',
            ),
        }
      : {}),
    file_base64: z
      .string()
      .optional()
      .describe(
        'The PDF itself, base64 encoded, up to 20 MB; sent with the request and not kept',
      ),
    file_name: z
      .string()
      .optional()
      .describe(
        'Name of the PDF given as file_base64 or path, e.g. contract.pdf; the results are named after it',
      ),
  };
  const pdfSourceLine = options.localFiles
    ? 'Pass exactly one PDF: source, a render or library file of the workspace; path, a file on this machine; or file_base64.'
    : 'Pass exactly one PDF: source, a render or library file of the workspace, or file_base64, the PDF itself.';
  const resultName = z
    .string()
    .optional()
    .describe(
      "Name of the file behind download_url; the source's name when left out",
    );
  const pageSelection = z.string().regex(/^\d+(-\d*)?(,\d+(-\d*)?)*$/);
  type PdfArgs = {
    source?: string;
    path?: string;
    file_base64?: string;
    file_name?: string;
    filename?: string;
  };

  /** The PDF a call names, as the SDK takes it, or why it names none, several or one too large. */
  const pdfOf = async (args: PdfArgs): Promise<PdfSource | Error> => {
    const given = [args.source, args.path, args.file_base64].filter(
      (s) => s !== undefined && s !== '',
    );
    if (given.length !== 1)
      return new Error(
        'Pass exactly one of source, file_base64' +
          (options.localFiles ? ' or path' : ''),
      );
    if (args.source) return args.source;
    if (args.path) {
      const { readFile, stat } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      if ((await stat(args.path)).size > PDF_PATH_LIMIT_BYTES)
        return new Error(
          `${args.path} is larger than 100 MB, the limit for the PDF tools`,
        );
      return {
        file: {
          data: new Uint8Array(await readFile(args.path)),
          name: args.file_name ?? basename(args.path),
        },
      };
    }
    const data = Uint8Array.from(Buffer.from(args.file_base64!, 'base64'));
    if (data.length === 0)
      return new Error('file_base64 is empty or not base64');
    if (data.length > PDF_BASE64_LIMIT_BYTES)
      return new Error(
        'The PDF is larger than 20 MB, the limit for file_base64',
      );
    return { file: { data, name: args.file_name ?? 'document.pdf' } };
  };

  /** One PDF tool as a render: the PDF the call names, the result with the picture of an image. */
  const pdfTool = async (
    args: PdfArgs,
    run: (
      client: Formfeed,
      input: PdfSource,
      output: { meta: Record<string, unknown>; filename?: string },
    ) => Promise<Render>,
  ) => {
    try {
      const client = api();
      const input = await pdfOf(args);
      if (input instanceof Error) return failure(input);
      let render = await run(client, input, {
        meta: { source: 'mcp' },
        ...(args.filename ? { filename: args.filename } : {}),
      });
      if (render.status !== 'succeeded' && render.status !== 'failed')
        render = await client.renders.waitFor(render.id);
      return await renderResult(render);
    } catch (e) {
      return failure(e);
    }
  };

  server.registerTool(
    'get_pdf_info',
    {
      title: "Read a PDF's pages, properties and form",
      description: [
        'Reads a PDF without changing it: the page count and the size of every page, whether it is password-protected, its document properties, and its form, with every field by its full name, label, type, value and the options it takes.',
        'Read it before fill_pdf_form, which takes the fields by these names, and before redact_pdf or split_pdf, which work on these pages.',
        pdfSourceLine,
        'Free on every plan; it creates no render, and an uploaded PDF is read and not kept.',
      ].join(' '),
      inputSchema: pdfInput,
      outputSchema: {
        source: z
          .string()
          .nullable()
          .optional()
          .describe('The render id or library file name the PDF came from'),
        page_count: z.number(),
        pages: z
          .array(
            z.object({
              width_pt: z.number(),
              height_pt: z.number(),
              width_mm: z.number(),
              height_mm: z.number(),
            }),
          )
          .describe(
            'The size of every page, in points (72 an inch) and millimetres',
          ),
        encrypted: z
          .boolean()
          .describe('Whether the file is password-protected'),
        metadata: z
          .record(z.string(), z.unknown())
          .describe(
            'Title, author, subject, producer and creator; null when unset',
          ),
        form: z
          .object({
            type: z
              .string()
              .nullable()
              .describe(
                'acroform, hybrid or xfa (which fill_pdf_form refuses); null for a PDF without a form',
              ),
            signed: z.boolean(),
            fields: z.array(
              z.object({
                name: z.string(),
                label: z.string().nullable(),
                type: z.string(),
                value: z.unknown(),
                options: z.array(z.string()).nullable(),
                required: z.boolean(),
                readonly: z.boolean(),
                calculated: z.boolean(),
                format: z.string().nullable(),
                pages: z.array(z.number()),
              }),
            ),
          })
          .nullable()
          .optional()
          .describe('The form; null when the file needs a password to open'),
      },
      annotations: READS,
    },
    async (args) => {
      try {
        const client = api();
        const input = await pdfOf(args as PdfArgs);
        if (input instanceof Error) return failure(input);
        return text(await client.pdf.info(input));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'split_pdf',
    {
      title: 'Split a PDF',
      description: [
        'Cuts a PDF into parts, every N pages each or one part per entry of ranges, and returns the render with download_url: a ZIP of the parts, named after the source (contract-1.pdf, contract-2.pdf and so on), or the PDF itself when there is one part.',
        'get_pdf_info gives the page count first.',
        pdfSourceLine,
        'Starter plan and above; 0.5 units on a live key. A PDF/A or a password-protected PDF is refused.',
      ].join(' '),
      inputSchema: {
        ...pdfInput,
        every: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Pages per part; give every or ranges'),
        ranges: z
          .array(pageSelection)
          .min(1)
          .max(100)
          .optional()
          .describe(
            'One part per entry, each a page selection such as 1-3,5, or 4- for page 4 to the last; give every or ranges',
          ),
        filename: resultName,
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) => {
      if ((args.every === undefined) === (args.ranges === undefined))
        return failure(new Error('Pass every or ranges'));
      return pdfTool(args as PdfArgs, (client, input, output) =>
        client.pdf.split(input, {
          ...output,
          ...(args.every !== undefined
            ? { every: args.every }
            : { ranges: args.ranges }),
        }),
      );
    },
  );

  server.registerTool(
    'compress_pdf',
    {
      title: 'Compress a PDF',
      description: [
        'Makes a PDF smaller and returns the render with download_url; a PDF that cannot be made smaller comes back as it was.',
        'For a preview picture of a page instead, use pdf_to_image.',
        pdfSourceLine,
        'Starter plan and above; 0.5 units on a live key. A PDF/A or a password-protected PDF is refused.',
      ].join(' '),
      inputSchema: { ...pdfInput, filename: resultName },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) =>
      pdfTool(args as PdfArgs, (client, input, output) =>
        client.pdf.compress(input, output),
      ),
  );

  server.registerTool(
    'pdf_to_image',
    {
      title: 'Turn PDF pages into pictures',
      description: [
        'Draws pages of a PDF as PNG or JPEG pictures and returns the render with download_url: one page gives the picture, which this tool also hands back so you can look at it (up to 2 MB), several pages a ZIP of pictures named by page.',
        'At most 100 pages and 120 million pixels a call, about 13 A4 pages at 300 dpi. Use it to see a page before redact_pdf, or for thumbnails.',
        pdfSourceLine,
        'Starter plan and above; one unit per picture on a live key.',
      ].join(' '),
      inputSchema: {
        ...pdfInput,
        pages: pageSelection
          .optional()
          .describe(
            'The pages to draw, such as 1, 1-3,5 or 2- (page 2 to the last); every page when left out',
          ),
        format: z
          .enum(['png', 'jpg'])
          .optional()
          .describe('png (the default) or jpg'),
        dpi: z
          .number()
          .int()
          .min(36)
          .max(300)
          .optional()
          .describe(
            'Resolution, 36 to 300, 150 when left out; at 72 a pixel stands for a point',
          ),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('JPEG quality, 1 to 100; ignored for PNG'),
        filename: resultName,
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) =>
      pdfTool(args as PdfArgs, (client, input, output) =>
        client.pdf.toImage(input, {
          ...output,
          ...(args.pages ? { pages: args.pages } : {}),
          ...(args.format ? { format: args.format } : {}),
          ...(args.dpi !== undefined ? { dpi: args.dpi } : {}),
          ...(args.quality !== undefined ? { quality: args.quality } : {}),
        }),
      ),
  );

  server.registerTool(
    'redact_pdf',
    {
      title: 'Redact a PDF',
      description: [
        'Removes what lies under rectangles of the pages, and every place where a text stands, from the file itself and not just from view: text, the pixels of images under a rectangle, and links and comments it touches.',
        'The result is read again: a text that can still be found fails the call with redaction_incomplete, which names rectangles and texts by their number, and nothing is delivered.',
        'Rectangles are points from the top-left corner of the page as a viewer shows it, 72 to an inch; get_pdf_info gives the page sizes and pdf_to_image a picture of the page. A text is found whatever its spacing, ignoring case unless match_case is true.',
        'A black box is drawn over each removed place, another colour with fill, none with fill null.',
        pdfSourceLine,
        'Starter plan and above; 0.5 units on a live key. The texts are never stored.',
      ].join(' '),
      inputSchema: {
        ...pdfInput,
        regions: z
          .array(
            z.object({
              page: z.number().int().min(1).describe('Page number, from 1'),
              x: z.number().min(0).describe('Points from the left edge'),
              y: z.number().min(0).describe('Points from the top edge'),
              width: z.number().positive().describe('Width in points'),
              height: z.number().positive().describe('Height in points'),
            }),
          )
          .min(1)
          .max(500)
          .optional()
          .describe(
            'The rectangles to remove, as a viewer shows the page; give regions, text or both',
          ),
        text: z
          .array(z.string().min(1).max(500))
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Texts to remove wherever they stand, such as a name or an IBAN, found whatever their spacing',
          ),
        match_case: z
          .boolean()
          .optional()
          .describe('Find a text only in the case it is written in'),
        whole_words: z
          .boolean()
          .optional()
          .describe(
            'Find a text only where a word boundary stands on each side',
          ),
        fill: z
          .string()
          .regex(/^#?[0-9a-fA-F]{6}$/)
          .nullable()
          .optional()
          .describe(
            'Colour of the box drawn over each removed place, #000000 when left out; null draws none',
          ),
        filename: resultName,
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) => {
      if (!args.regions && !args.text)
        return failure(new Error('Pass regions, text or both'));
      return pdfTool(args as PdfArgs, (client, input, output) =>
        client.pdf.redact(input, {
          ...output,
          ...(args.regions ? { regions: args.regions } : {}),
          ...(args.text ? { text: args.text } : {}),
          ...(args.match_case !== undefined
            ? { match_case: args.match_case }
            : {}),
          ...(args.whole_words !== undefined
            ? { whole_words: args.whole_words }
            : {}),
          ...(args.fill !== undefined ? { fill: args.fill } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'fill_pdf_form',
    {
      title: 'Fill a PDF form',
      description: [
        'Fills the fields of a PDF form by their full names, as get_pdf_info lists them, and returns the render with download_url and form: how many fields were filled, which were left out, and which hold a calculation or display format that no viewer ran.',
        'The form stays fillable, or flatten draws the values into the pages. A name the form lacks or a value its field does not take fails the call with form_field_unknown or form_value_invalid, naming the field, unless strict is false.',
        pdfSourceLine,
        'Starter plan and above; 0.5 units on a live key. The values are never stored; a signed form and an XFA form are refused.',
      ].join(' '),
      inputSchema: {
        ...pdfInput,
        fields: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
          )
          .optional()
          .describe(
            "Values by the fields' full names: text for a text field, true or false for a check box, one of the field's options for a dropdown, a radio group or a check box with several on-values, a list of options for a list box",
          ),
        flatten: z
          .boolean()
          .optional()
          .describe(
            'Draw the values into the pages and remove the fields, so the values can no longer be changed',
          ),
        strict: z
          .boolean()
          .optional()
          .describe(
            'true (the default) fails on a name the form lacks or a value its field does not take; false leaves both out and lists them in form.skipped',
          ),
        filename: resultName,
      },
      outputSchema: renderOutput,
      annotations: CREATES,
    },
    async (args) => {
      if (!args.fields && !args.flatten)
        return failure(new Error('Pass fields, or flatten alone'));
      return pdfTool(args as PdfArgs, (client, input, output) =>
        client.pdf.fill(input, {
          ...output,
          ...(args.fields ? { fields: args.fields } : {}),
          ...(args.flatten !== undefined ? { flatten: args.flatten } : {}),
          ...(args.strict !== undefined ? { strict: args.strict } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'get_render',
    {
      title: 'Get a render',
      description:
        'Returns the current state of a render: status (queued, rendering, succeeded or failed), download_url with expires_at, page_count, units and error, and the picture of a finished image render up to 2 MB. Use it to follow a render started with wait false, or to get a fresh link once the old one has expired; render, convert_to_pdf and the PDF tools already return this for the render they just made. Read-only and free; an unknown id returns an error.',
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
