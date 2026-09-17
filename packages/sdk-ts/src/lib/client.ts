/**
 * `@formfeed/sdk` (spec 10 §1): a fetch-based client for the public API. Runs in Node 18+, Deno,
 * Bun, Workers and browsers (with a test key). Retries 429 and 503 with the server's Retry-After
 * and jitter, generates an Idempotency-Key for every render, and turns RFC 9457 problems into
 * typed errors.
 */
export type Region = 'eu' | 'us';
export type Engine = 'jinja2' | 'liquid' | 'handlebars';
/**
 * PDF and image templates, HTML and URLs produce `pdf` or an image; a Word template produces `docx`
 * or `pdf`, a PowerPoint template `pptx` or `pdf`.
 */
export type OutputFormat = 'pdf' | 'png' | 'jpg' | 'webp' | 'docx' | 'pptx';
export type RenderStatus = 'queued' | 'rendering' | 'succeeded' | 'failed';

export interface FormfeedOptions {
  apiKey: string;
  /** Region of the API host; ignored when `baseUrl` is given. */
  region?: Region;
  /** Full base URL including `/v1`, for self-hosted or local gateways. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries on 429 and 503; 0 disables. */
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Headers sent with every request, after the SDK's own. The hosted MCP server uses it to act for
   * a signed-in member: `apiKey` carries the OAuth access token and `X-Formfeed-Workspace` the
   * workspace of the URL (spec 10 §3.1).
   */
  headers?: Record<string, string>;
}

export interface RenderRequest {
  template?: string;
  version?: string;
  html?: string;
  url?: string;
  engine?: Engine;
  data?: Record<string, unknown>;
  /** Left out, the template decides: PDF, or an image template's `settings.image.format`. */
  output?: OutputFormat;
  settings?: Record<string, unknown>;
  filename?: string;
  expires_in?: number | null;
  access?: 'public' | 'signed';
  mode?: 'sync' | 'async';
  locale?: string | null;
  webhook_url?: string | null;
  /** Signs the deliveries to `webhook_url`, the way an endpoint secret does; 16 to 200 characters. */
  webhook_secret?: string | null;
  meta?: Record<string, unknown>;
  region?: Region;
  dedupe?: boolean;
  /**
   * Decides a channel's canary split: renders with the same value (a customer or order id) land on the
   * same version. Not the Idempotency-Key, which would replay the first response for every render.
   */
  canary_key?: string | null;
  /** PDF post-processing: merge, watermark, password, applied in that order (0.5 units each). */
  post?: PostProcessing | null;
  /** Check `data` against the template's stored schema first; a mismatch throws `data_validation_error`. */
  validate_data?: boolean;
}

/**
 * Slug → data type of the workspace's templates. Empty here; the file `formfeed types` generates
 * augments it (`declare module '@formfeed/sdk' { interface FormfeedTemplates { invoice: InvoiceData } }`),
 * which makes `renders.create({ template: 'invoice', data })` check `data` at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-empty-interface
export interface FormfeedTemplates {}

/** The data type of template `T`: generated for known slugs, a plain record otherwise. */
export type TemplateData<T> = T extends keyof FormfeedTemplates ? FormfeedTemplates[T] : Record<string, unknown>;

/**
 * A render request whose `data` follows the template's generated type. A slug the generated file
 * does not know, a template id or a string variable keeps the untyped `Record<string, unknown>`.
 */
export type TypedRenderRequest<T extends string = string> = Omit<RenderRequest, 'template' | 'data'> & { template?: T } & (
    T extends keyof FormfeedTemplates ? { data: FormfeedTemplates[T] } : { data?: Record<string, unknown> }
  );

export type PdfPermission = 'print' | 'copy' | 'modify' | 'annotate';

/** A text or an image watermark; pass one of `text` and `image`. */
export interface WatermarkOptions {
  text?: string;
  /** A PNG or JPEG of the workspace file library: its id (`fil_…`) or its name. */
  image?: string;
  /** 0 to 1, default 0.2. */
  opacity?: number;
  /** Degrees clockwise as in CSS, default -45 (bottom left to top right). */
  rotation?: number;
  /** Hex colour such as `#cc0000`; grey by default. Text only. */
  color?: string;
}

export interface PostProcessing {
  /** PDFs appended after this document, in order: render ids, or file ids and names of library PDFs. */
  merge_after?: string[];
  watermark?: WatermarkOptions;
  password?: { user?: string; owner?: string; permissions?: PdfPermission[] };
}

/** Where the result of a PDF tool is stored, as for a render. */
export interface PdfOutputOptions {
  filename?: string;
  expires_in?: number | null;
  access?: 'public' | 'signed';
  meta?: Record<string, unknown>;
}

export interface ProtectOptions extends PdfOutputOptions {
  /** Needed to open the document. */
  user_password?: string;
  /** Lifts the restrictions; random when omitted. */
  owner_password?: string;
  /** What readers may do; everything not listed is forbidden. */
  permissions?: PdfPermission[];
}

export interface PdfInfo {
  source: string;
  page_count: number;
  pages: Array<{ width_pt: number; height_pt: number; width_mm: number; height_mm: number }>;
  encrypted: boolean;
  metadata: Record<string, unknown>;
}

export interface Render {
  id: string;
  status: RenderStatus;
  output: string;
  download_url: string | null;
  expires_at: string | null;
  bytes: number | null;
  page_count: number | null;
  units: number;
  region: string;
  environment: 'live' | 'test';
  /** `channel`: the release channel the version came from; `canary` when the channel's canary share picked it. */
  template: { id: string; slug: string; version: number; channel?: string | null; canary?: boolean } | null;
  engine_version: string | null;
  template_checksum: string | null;
  output_sha256: string | null;
  deduplicated: boolean;
  timings: Record<string, number> | null;
  error: { code?: string; message?: string; [key: string]: unknown } | null;
  meta: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

export interface BatchRequest<T extends string = string> {
  /** Default template of the items; with a generated type for it, every item's `data` is checked. */
  template?: T;
  /** Default `canary_key` of the items; without one the whole batch lands on one version. */
  canary_key?: string;
  /** Default `output` of the items; an item's own wins, without either its template decides. */
  output?: OutputFormat;
  items: Array<Omit<RenderRequest, 'data'> & { data?: TemplateData<T> }>;
  zip?: boolean;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  meta?: Record<string, unknown>;
}

export interface Job {
  id: string;
  type: 'single' | 'batch';
  status: 'queued' | 'processing' | 'completed' | 'partially_failed' | 'failed';
  total: number;
  succeeded: number;
  failed: number;
  zip_url: string | null;
  zip_expires_at: string | null;
  items: Render[];
  meta: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

/** A file of the workspace library (`/files`); a template reaches it with `asset(name)`. */
export interface LibraryFile {
  id: string;
  name: string;
  content_type: string;
  bytes: number;
  sha256: string;
  /** The CDN URL, the same one `asset(name)` produces. */
  url: string;
  created_at: string;
  updated_at: string;
}

export interface FileUpload {
  /** The bytes: a Blob or File, a Uint8Array (Node's Buffer is one) or an ArrayBuffer. */
  data: Blob | Uint8Array | ArrayBuffer;
  /** The library name, e.g. `logo.png` or `brand/header.svg`. Uploading a name again replaces it. */
  name: string;
  /** Sent with the bytes; the API also goes by the extension when it is missing. */
  contentType?: string;
}

/** A Word, PowerPoint or other office file sent to the API: a template's file or a document to convert. */
export interface OfficeFileUpload {
  /** The bytes: a Blob or File, a Uint8Array (Node's Buffer is one) or an ArrayBuffer. */
  data: Blob | Uint8Array | ArrayBuffer;
  /** The file name, e.g. `offer.docx`; a File's own name when omitted. The API reads the type from the content. */
  name?: string;
}

export interface ConvertOptions extends PdfOutputOptions {
  /** Pages to convert, e.g. `1-3,5`; all when omitted. */
  page_ranges?: string;
  /** Landscape for spreadsheets and documents without their own page setup. */
  landscape?: boolean;
  /** Each spreadsheet sheet on one page. */
  single_page_sheets?: boolean;
}

export interface FileListOptions {
  /** Only names starting with this, e.g. `brand/`. */
  prefix?: string;
  limit?: number;
  cursor?: string | null;
}

/**
 * The organisation's brand kit (`GET /brand`): what templates see as `brand`, plus the page defaults
 * new templates start from. Unset values are `null`; `colors` is always an object.
 */
export interface Brand {
  version: number;
  name: string | null;
  /** Token → hex colour, e.g. `primary`; also `--brand-color-<token>` in the document. */
  colors: Record<string, string>;
  fonts: { heading: string | null; body: string | null };
  font_size: string | null;
  /** CDN URLs of the logos. */
  logo: { primary: string | null; inverse: string | null; mark: string | null };
  legal_footer: string | null;
  /** `{}` when unset. */
  page_defaults: {
    paper?: { format?: string; landscape?: boolean };
    margin?: { top?: string; right?: string; bottom?: string; left?: string };
  };
  updated_at: string | null;
}

/** A shared partial of the organisation (`/partials`), included by name from templates of its engine. */
export interface SharedPartial {
  /** Lowercase letters, digits, `-` and `_`; the API stores a name in lowercase. */
  name: string;
  engine: Engine;
  description: string | null;
  version: number;
  /** Only when read one by one (`partials.get`) and in the result of `partials.put`. */
  source?: string;
  created_at: string;
  updated_at: string;
}

export interface SharedPartialPut {
  engine: Engine;
  source: string;
  description?: string | null;
  /**
   * The version the change is based on; the API answers 409 `conflict` when the partial has another,
   * with the stored partial as `problem.current` (`null` when it was deleted).
   */
  base_version?: number;
}

export interface SharedPartialPutResult {
  partial: SharedPartial;
  /** `true` when the name did not exist before (201), `false` for an update (200). */
  created: boolean;
}

export type WebhookEnvironment = 'live' | 'test';

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  /** Render environments whose events the endpoint receives; both by default. Quota events are sent regardless. */
  environments?: WebhookEnvironment[];
  enabled: boolean;
  description: string | null;
  consecutive_failures: number;
  /** Only present in the response of `create`. */
  secret?: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookEndpointCreate {
  url: string;
  events?: string[];
  environments?: WebhookEnvironment[];
  description?: string | null;
}

export interface WebhookEndpointUpdate {
  url?: string;
  events?: string[];
  environments?: WebhookEnvironment[];
  enabled?: boolean;
  description?: string | null;
}

export interface ListenSessionOptions {
  /** Event types the session receives; all by default. */
  events?: string[];
  /** Include live-environment events (needs `webhook:manage`); test events only by default. */
  live?: boolean;
}

/**
 * A listen session (`POST /webhooks/listen`): receives the workspace's events like an endpoint and relays
 * them over `websocket_url`, which is valid for 60 seconds and needs no key. The SDK opens no socket.
 */
export interface ListenSession {
  id: string;
  /** Signs the session's deliveries. */
  secret: string;
  events: string[];
  environments: WebhookEnvironment[];
  expires_at: string;
  websocket_url: string;
}

export interface WebhookResend {
  delivery_id: string;
  event_id: string;
  event: string;
  endpoint_id: string;
}

/**
 * The stored request of a render (`GET /renders/{id}/input`). Template renders carry `template` and
 * `data`, ad-hoc renders `html` or `url`. Passwords of `post` are never included.
 */
export interface RenderInput {
  render_id: string;
  template?: { id: string; slug: string; version: number; channel?: string | null };
  html?: string;
  engine?: Engine;
  url?: string;
  data?: Record<string, unknown>;
  locale?: string | null;
  output?: OutputFormat;
  settings?: Record<string, unknown>;
  filename?: string;
  post?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  environment: 'live' | 'test';
  created_at: string;
}

/** `docx` and `pptx` templates are Word and PowerPoint files with tags in their text (Starter plan and above). */
export type TemplateKind = 'pdf' | 'image' | 'docx' | 'pptx';
export type OfficeTemplateKind = 'docx' | 'pptx';

/** The file of a Word or PowerPoint template version; download it with `templates.versions.file`. */
export interface TemplateFile {
  sha256: string;
  bytes: number;
  format: OfficeTemplateKind;
}
export type VersionStatus = 'draft' | 'published' | 'archived';

export interface Template {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: TemplateKind;
  engine: Engine;
  tags: string[];
  published_version: number | null;
  latest_version: number;
  created_at: string;
  updated_at: string;
}

/** A version as reads name it: `published`, `latest`, a version number or a channel name (its main version). */
export type VersionRef = string | number;

/** One finding of `templates.validate`. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location?: { line: number; column: number };
  /** Data errors only: where in the data, e.g. `data.invoice.lines[0].qty`. */
  path?: string;
  /** Word and PowerPoint templates only: the file part the tag is in, e.g. `word/document.xml`. */
  part?: string;
  /** Word and PowerPoint templates only: the 1-based paragraph in `part`. */
  paragraph?: number;
}

export interface TemplateValidation {
  /** `false` when at least one diagnostic is an error. */
  ok: boolean;
  template: { id: string; slug: string; version: number };
  diagnostics: Diagnostic[];
}

/** The files of a version as the editor and the CLI keep them. */
export interface TemplateFiles {
  html: string;
  css?: string;
  head?: string;
  settings?: Record<string, unknown>;
  sample_data?: Record<string, unknown>;
  /** Named sample data sets besides the default one, as the editor and the dev kit show them. */
  data_sets?: Record<string, unknown> | null;
  data_schema?: Record<string, unknown> | null;
  i18n?: Record<string, unknown> | null;
  /** Partials the template includes (`name` → source); `formfeed templates push` sends them. */
  partials?: Record<string, string> | null;
}

export interface TemplateVersion extends Partial<TemplateFiles> {
  id: string;
  number: number;
  status: VersionStatus;
  checksum: string;
  change_note: string | null;
  created_at: string;
  published_at: string | null;
  /** Publishing only: how the data schema changed against the version callers used before. */
  schema_check?: SchemaCheck;
  /** Word and PowerPoint templates: the version's file; `null` for other kinds. */
  source_file?: TemplateFile | null;
}

/** One difference between two data schemas, from the point of view of a caller sending data. */
export interface SchemaChange {
  /** Dotted field path (`customer.email`, `items[]`); empty for the data itself. */
  path: string;
  pointer: string;
  kind: string;
  breaking: boolean;
  message: string;
}

/**
 * The schema comparison publishing and channel moves run. `stored`: both versions store a schema and
 * breaking changes are refused unless `allowBreaking` is set. `inferred`: compared from sample data,
 * a warning only. `none`: nothing to compare.
 */
export interface SchemaCheck {
  source: 'stored' | 'inferred' | 'none';
  breaking: SchemaChange[];
  safe: SchemaChange[];
}

/** A release channel of a template (`published` or a named one such as `staging`). */
export interface Channel {
  name: string;
  version: number | null;
  canary: { version: number; percent: number } | null;
  /** The version before the last move; `rollback` returns to it. */
  previous_version: number | null;
  updated_at: string;
  /** Renders of the last 24 hours through this channel, per version (list only). */
  usage_24h?: Array<{ version: number; renders: number; failed: number }>;
  /** Writes only. */
  schema_check?: SchemaCheck;
}

export interface ChannelList {
  data: Channel[];
  /** The plan's allowance: named channels per template (`null` unlimited) and whether canaries are allowed. */
  limits: { channels: number | null; canary: boolean };
}

export interface ChannelMove {
  version: number;
  /** A second version that receives `percent` (1 to 50) of the channel's renders; `null` clears it. */
  canary?: { version: number; percent: number } | null;
}

export interface SchemaGuardOptions extends RequestOptions {
  /** Go ahead although the data schema breaks callers of the current version. */
  allowBreaking?: boolean;
}

export interface TemplateCreate extends TemplateFiles {
  name: string;
  slug: string;
  description?: string | null;
  kind: TemplateKind;
  engine: Engine;
  tags?: string[];
  publish?: boolean;
}

export interface TemplateVersionCreate extends TemplateFiles {
  change_note?: string;
  /** Checksum of the version the draft was based on; the API answers 409 when the latest differs. */
  base_checksum?: string;
  publish?: boolean;
  /** With `publish`: go ahead although the data schema breaks callers of the published version. */
  allow_breaking?: boolean;
}

/** What a Word or PowerPoint template has besides its file: no markup, no partials. */
type OfficeFields = Omit<TemplateFiles, 'html' | 'css' | 'head' | 'partials'>;

/** A Word or PowerPoint template, created from its file (up to 20 MB). */
export interface OfficeTemplateCreate extends OfficeFields {
  name: string;
  slug: string;
  description?: string | null;
  kind: OfficeTemplateKind;
  engine: Engine;
  tags?: string[];
  publish?: boolean;
  file: OfficeFileUpload;
}

/**
 * A new version of a Word or PowerPoint template: with `file`, the new document; without, the
 * latest version's file is kept and only data, schema or settings change.
 */
export interface OfficeVersionCreate extends OfficeFields {
  file?: OfficeFileUpload;
  change_note?: string;
  base_checksum?: string;
  publish?: boolean;
  allow_breaking?: boolean;
}

const isOfficeInput = (input: object): input is { file?: OfficeFileUpload } => 'file' in input;

/** The bytes of an upload as a Blob, named for the multipart part. */
function blobOf(file: OfficeFileUpload): { blob: Blob; name: string } {
  const blob = file.data instanceof Blob ? file.data : new Blob([file.data as BlobPart]);
  const own = typeof File !== 'undefined' && file.data instanceof File ? file.data.name : undefined;
  return { blob, name: file.name ?? own ?? 'document' };
}

/**
 * A multipart body the way the API reads it: the file as `file`, strings as they are, booleans
 * and numbers as text, objects and arrays as JSON text; `undefined` fields are left out.
 */
function multipart(fields: Record<string, unknown>, file: OfficeFileUpload): FormData {
  const form = new FormData();
  const { blob, name } = blobOf(file);
  form.set('file', blob, name);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.set(key, typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

export interface Usage {
  period: string;
  included: number;
  used: number;
  overage_used: number;
  overage_balance: number;
  daily: Array<{ date: string; units: number; renders: number }>;
  by_template: Array<{ template: string; units: number }>;
}

export interface RenderListOptions {
  template?: string;
  status?: RenderStatus;
  environment?: 'live' | 'test';
  /** ISO timestamps bounding `created_at`. */
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string | null;
}

export interface TemplateListOptions {
  kind?: TemplateKind;
  engine?: Engine;
  tag?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  request_id?: string;
  [key: string]: unknown;
}

export class FormfeedError extends Error {
  override readonly name = 'FormfeedError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly problem: Problem | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

const hosts: Record<Region, string> = {
  eu: 'https://api-eu.formfeed.dev/v1',
  us: 'https://api-us.formfeed.dev/v1',
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });

function randomKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Every call that creates a render carries an Idempotency-Key, so a retry cannot charge twice. */
const withKey = (options: RequestOptions): RequestOptions => ({ ...options, idempotencyKey: options.idempotencyKey ?? randomKey() });
const idOf = (source: { id: string } | string) => (typeof source === 'string' ? source : source.id);

export class Formfeed {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: FormfeedOptions) {
    if (!options.apiKey) throw new FormfeedError('invalid_request', 'apiKey is required', 0);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? hosts[options.region ?? 'eu']).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.extraHeaders = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    if (!this.fetchImpl) throw new FormfeedError('invalid_request', 'fetch is not available; pass options.fetch', 0);
  }

  readonly renders = {
    /** Renders a template, HTML or URL. Sync by default; `mode: 'async'` returns a queued render. */
    create: <T extends string = string>(request: TypedRenderRequest<T>, options: RequestOptions = {}): Promise<Render> =>
      this.request<Render>('POST', '/renders', request, {
        ...options,
        idempotencyKey: options.idempotencyKey ?? randomKey(),
      }),
    get: (id: string, options: RequestOptions = {}): Promise<Render> =>
      this.request<Render>('GET', `/renders/${encodeURIComponent(id)}`, undefined, options),
    /** Polls until the render succeeded or failed (async renders). */
    waitFor: async (id: string, options: WaitOptions = {}): Promise<Render> => {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const interval = options.intervalMs ?? 1000;
      for (;;) {
        const render = await this.renders.get(id, { signal: options.signal });
        if (render.status === 'succeeded' || render.status === 'failed') return render;
        if (Date.now() + interval > deadline)
          throw new FormfeedError('timeout', `render ${id} did not finish within the wait time`, 0);
        await sleep(interval, options.signal);
      }
    },
    /** Downloads the output of a finished render as bytes. */
    download: async (render: Render | string, options: RequestOptions = {}): Promise<Uint8Array> => {
      const target = typeof render === 'string' ? await this.renders.get(render, options) : render;
      if (!target.download_url)
        throw new FormfeedError('not_ready', `render ${target.id} has no output (${target.status})`, 0);
      const res = await this.fetchImpl(target.download_url, { signal: options.signal });
      if (!res.ok) throw new FormfeedError('download_failed', `download answered HTTP ${res.status}`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },
    /** Page of renders, newest first. */
    list: (
      query: RenderListOptions = {},
      options: RequestOptions = {},
    ): Promise<{ data: Render[]; next_cursor: string | null }> => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      const qs = params.toString();
      return this.request('GET', `/renders${qs ? `?${qs}` : ''}`, undefined, options);
    },
    /** Every render matching the query, following the cursor. */
    all: async (query: Omit<RenderListOptions, 'cursor'> = {}, options: RequestOptions = {}): Promise<Render[]> => {
      const out: Render[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: Render[]; next_cursor: string | null } = await this.renders.list({ ...query, cursor }, options);
        out.push(...page.data);
        cursor = page.next_cursor;
      } while (cursor);
      return out;
    },
    /** Removes the stored files of a render before they expire. Needs the `file:delete` scope. */
    deleteOutputs: (id: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/renders/${encodeURIComponent(id)}/outputs`, undefined, options),
    /**
     * The stored request of a render, to render it again. Needs `render:input`; throws
     * `render_input_expired` (410) when the workspace keeps no requests or the period ended.
     */
    input: (id: string, options: RequestOptions = {}): Promise<RenderInput> =>
      this.request<RenderInput>('GET', `/renders/${encodeURIComponent(id)}/input`, undefined, options),
    batch: <T extends string = string>(request: BatchRequest<T>, options: RequestOptions = {}): Promise<Job> =>
      this.request<Job>('POST', '/renders/batch', request, {
        ...options,
        idempotencyKey: options.idempotencyKey ?? randomKey(),
      }),
  };

  /**
   * PDF tools on the outputs of earlier renders (a `Render` or its id) and on PDFs of the file library
   * (a `LibraryFile`, its id or its name). merge, protect and watermark return a new render and cost
   * 0.5 units each on live keys; info is free.
   */
  readonly pdf = {
    merge: (sources: Array<Render | LibraryFile | string>, output: PdfOutputOptions = {}, options: RequestOptions = {}): Promise<Render> =>
      this.request<Render>('POST', '/pdf/merge', { ...output, sources: sources.map(idOf) }, withKey(options)),
    protect: (source: Render | string, protect: ProtectOptions, options: RequestOptions = {}): Promise<Render> =>
      this.request<Render>('POST', '/pdf/protect', { ...protect, source: idOf(source) }, withKey(options)),
    watermark: (source: Render | string, watermark: WatermarkOptions & PdfOutputOptions, options: RequestOptions = {}): Promise<Render> =>
      this.request<Render>('POST', '/pdf/watermark', { ...watermark, source: idOf(source) }, withKey(options)),
    info: (source: Render | string, options: RequestOptions = {}): Promise<PdfInfo> =>
      this.request<PdfInfo>('POST', '/pdf/info', { source: idOf(source) }, options),
    /**
     * Converts an office document to a PDF render (Starter plan and above): an uploaded file (Word,
     * Excel, PowerPoint, OpenDocument, RTF or HTML, up to 20 MB, not kept), or the output of a Word or
     * PowerPoint template render. Costs follow the PDF rule. A busy converter answers 503, which is
     * retried like any other.
     */
    convert: (
      source: { file: OfficeFileUpload } | Render | string,
      convert: ConvertOptions = {},
      options: RequestOptions = {},
    ): Promise<Render> => {
      if (typeof source === 'object' && 'file' in source)
        return this.request<Render>('POST', '/pdf/convert', multipart({ ...convert }, source.file), withKey(options));
      return this.request<Render>('POST', '/pdf/convert', { ...convert, source: idOf(source) }, withKey(options));
    },
  };

  /**
   * The workspace file library (`/files`): images and PDFs a template references by name with
   * `asset('logo.png')`, and the sources of image watermarks and merges. Needs `file:read`,
   * `file:write` or `file:delete`. Files are served without a signature, so keep confidential
   * documents out of it.
   */
  readonly files = {
    /** Uploads a file; the same name replaces the existing file in place and keeps its URL. */
    upload: (file: FileUpload, options: RequestOptions = {}): Promise<LibraryFile> => {
      const blob =
        file.data instanceof Blob
          ? file.data
          : new Blob([file.data as BlobPart], file.contentType ? { type: file.contentType } : {});
      const form = new FormData();
      form.set('file', blob, file.name);
      form.set('name', file.name);
      return this.request<LibraryFile>('POST', '/files', form, options);
    },
    /** Page of files, newest first. */
    list: (query: FileListOptions = {}, options: RequestOptions = {}): Promise<{ data: LibraryFile[]; next_cursor: string | null }> => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      const qs = params.toString();
      return this.request('GET', `/files${qs ? `?${qs}` : ''}`, undefined, options);
    },
    /** Every file matching the query, following the cursor. */
    all: async (query: Omit<FileListOptions, 'cursor'> = {}, options: RequestOptions = {}): Promise<LibraryFile[]> => {
      const out: LibraryFile[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: LibraryFile[]; next_cursor: string | null } = await this.files.list({ ...query, cursor }, options);
        out.push(...page.data);
        cursor = page.next_cursor;
      } while (cursor);
      return out;
    },
    get: (id: string, options: RequestOptions = {}): Promise<LibraryFile> =>
      this.request<LibraryFile>('GET', `/files/${encodeURIComponent(id)}`, undefined, options),
    /** Removes the file and its bytes; templates that name it render a missing image afterwards. */
    delete: (file: LibraryFile | string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/files/${encodeURIComponent(idOf(file))}`, undefined, options),
  };

  /** The organisation's brand kit, read-only through the API (it is edited in the app). Needs `template:read`. */
  readonly brand = {
    get: (options: RequestOptions = {}): Promise<Brand> => this.request<Brand>('GET', '/brand', undefined, options),
  };

  /**
   * Shared partials of the organisation. Renders use the current source, so a change reaches every
   * template that includes the partial without a new version. Needs `template:read` or `template:write`.
   */
  readonly partials = {
    /** Every shared partial, without its source. */
    list: async (options: RequestOptions = {}): Promise<SharedPartial[]> =>
      (await this.request<{ data: SharedPartial[] }>('GET', '/partials', undefined, options)).data,
    /** One partial with its source. */
    get: (name: string, options: RequestOptions = {}): Promise<SharedPartial> =>
      this.request<SharedPartial>('GET', `/partials/${encodeURIComponent(name)}`, undefined, options),
    /** Creates or replaces a partial; pass `base_version` to fail with 409 when it changed since you read it. */
    put: async (name: string, input: SharedPartialPut, options: RequestOptions = {}): Promise<SharedPartialPutResult> => {
      const { status, body } = await this.send<SharedPartial>('PUT', `/partials/${encodeURIComponent(name)}`, input, options);
      return { partial: body, created: status === 201 };
    },
    /** Removes a partial; templates that still include it fail to render afterwards. */
    delete: (name: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/partials/${encodeURIComponent(name)}`, undefined, options),
  };

  readonly jobs = {
    get: (id: string, options: RequestOptions = {}): Promise<Job> =>
      this.request<Job>('GET', `/jobs/${encodeURIComponent(id)}`, undefined, options),
    waitFor: async (id: string, options: WaitOptions = {}): Promise<Job> => {
      const deadline = Date.now() + (options.timeoutMs ?? 600_000);
      const interval = options.intervalMs ?? 2000;
      for (;;) {
        const job = await this.jobs.get(id, { signal: options.signal });
        if (job.status !== 'queued' && job.status !== 'processing') return job;
        if (Date.now() + interval > deadline)
          throw new FormfeedError('timeout', `job ${id} did not finish within the wait time`, 0);
        await sleep(interval, options.signal);
      }
    },
  };

  readonly webhooks = {
    list: async (options: RequestOptions = {}): Promise<WebhookEndpoint[]> =>
      (await this.request<{ data: WebhookEndpoint[] }>('GET', '/webhooks', undefined, options)).data,
    create: (input: WebhookEndpointCreate, options: RequestOptions = {}): Promise<WebhookEndpoint> =>
      this.request<WebhookEndpoint>('POST', '/webhooks', input, options),
    update: (id: string, patch: WebhookEndpointUpdate, options: RequestOptions = {}): Promise<WebhookEndpoint> =>
      this.request<WebhookEndpoint>('PUT', `/webhooks/${encodeURIComponent(id)}`, patch, options),
    delete: (id: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/webhooks/${encodeURIComponent(id)}`, undefined, options),
    test: (id: string, options: RequestOptions = {}): Promise<{ queued: boolean }> =>
      this.request<{ queued: boolean }>('POST', `/webhooks/${encodeURIComponent(id)}/test`, undefined, options),
    /**
     * Sends a stored event (`evt_…`) again as a new delivery to a registered endpoint (`webhook:manage`)
     * or a running listen session (`webhook:listen`).
     */
    resend: (eventId: string, endpointId: string, options: RequestOptions = {}): Promise<WebhookResend> =>
      this.request<WebhookResend>('POST', `/webhooks/events/${encodeURIComponent(eventId)}/resend`, { endpoint_id: endpointId }, options),
    /**
     * Listen sessions, what `formfeed listen` uses. Needs `webhook:listen`. Starting a session ends the
     * previous one of the same key; the WebSocket itself is up to the caller.
     */
    listen: {
      start: (input: ListenSessionOptions = {}, options: RequestOptions = {}): Promise<ListenSession> =>
        this.request<ListenSession>('POST', '/webhooks/listen', input, options),
      end: (id: string, options: RequestOptions = {}): Promise<void> =>
        this.request<void>('DELETE', `/webhooks/listen/${encodeURIComponent(id)}`, undefined, options),
    },
  };

  readonly templates = {
    list: (
      query: TemplateListOptions = {},
      options: RequestOptions = {},
    ): Promise<{ data: Template[]; next_cursor: string | null }> => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      const qs = params.toString();
      return this.request('GET', `/templates${qs ? `?${qs}` : ''}`, undefined, options);
    },
    /** Every template of the workspace, following the cursor. */
    all: async (query: Omit<TemplateListOptions, 'cursor'> = {}, options: RequestOptions = {}): Promise<Template[]> => {
      const out: Template[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: Template[]; next_cursor: string | null } = await this.templates.list({ ...query, cursor }, options);
        out.push(...page.data);
        cursor = page.next_cursor;
      } while (cursor);
      return out;
    },
    get: (idOrSlug: string, options: RequestOptions = {}): Promise<Template> =>
      this.request<Template>('GET', `/templates/${encodeURIComponent(idOrSlug)}`, undefined, options),
    /** A Word or PowerPoint template (`kind` `docx` or `pptx`) is created from its `file`, sent as multipart. */
    create: (input: TemplateCreate | OfficeTemplateCreate, options: RequestOptions = {}): Promise<Template> => {
      if (isOfficeInput(input) && input.file) {
        const { file, ...fields } = input;
        return this.request<Template>('POST', '/templates', multipart(fields, file), options);
      }
      return this.request<Template>('POST', '/templates', input, options);
    },
    update: (
      idOrSlug: string,
      patch: { name?: string; description?: string | null; tags?: string[] },
      options: RequestOptions = {},
    ): Promise<Template> => this.request<Template>('PUT', `/templates/${encodeURIComponent(idOrSlug)}`, patch, options),
    archive: (idOrSlug: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/templates/${encodeURIComponent(idOrSlug)}`, undefined, options),
    versions: {
      list: async (idOrSlug: string, options: RequestOptions = {}): Promise<TemplateVersion[]> =>
        (await this.request<{ data: TemplateVersion[] }>('GET', `/templates/${encodeURIComponent(idOrSlug)}/versions`, undefined, options)).data,
      /** `which`: 'published', 'latest', a version number or a channel name (its main version). Carries the files. */
      get: (idOrSlug: string, which: string | number = 'published', options: RequestOptions = {}): Promise<TemplateVersion> =>
        this.request<TemplateVersion>('GET', `/templates/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(String(which))}`, undefined, options),
      /** For a Word or PowerPoint template, pass `file` to replace the document; without it the latest file is kept. */
      create: (idOrSlug: string, input: TemplateVersionCreate | OfficeVersionCreate, options: RequestOptions = {}): Promise<TemplateVersion> => {
        const path = `/templates/${encodeURIComponent(idOrSlug)}/versions`;
        if (isOfficeInput(input)) {
          const { file, ...fields } = input;
          if (file) return this.request<TemplateVersion>('POST', path, multipart(fields, file), options);
          return this.request<TemplateVersion>('POST', path, fields, options);
        }
        return this.request<TemplateVersion>('POST', path, input, options);
      },
      /** The Word or PowerPoint file of a version (`which` as for `get`); needs `template:read`. */
      file: async (idOrSlug: string, which: string | number = 'published', options: RequestOptions = {}): Promise<Uint8Array> => {
        const path = `/templates/${encodeURIComponent(idOrSlug)}/versions/${encodeURIComponent(String(which))}/file`;
        return (await this.send<Uint8Array>('GET', path, undefined, options, 'bytes')).body;
      },
      /**
       * Publishes a version. When both versions store a data schema and the new one breaks callers of the
       * published one, the API refuses with `schema_breaking_change` unless `allowBreaking` is set.
       */
      publish: (idOrSlug: string, number: number, options: SchemaGuardOptions = {}): Promise<TemplateVersion> => {
        const { allowBreaking, ...rest } = options;
        return this.request<TemplateVersion>(
          'POST',
          `/templates/${encodeURIComponent(idOrSlug)}/versions/${number}/publish`,
          allowBreaking ? { allow_breaking: true } : undefined,
          rest,
        );
      },
    },
    /**
     * Release channels (`published` and named ones such as `staging`): a render with `version: 'staging'`
     * uses the version the channel points at. Moves reach renders within a minute.
     */
    channels: {
      list: (idOrSlug: string, options: RequestOptions = {}): Promise<ChannelList> =>
        this.request<ChannelList>('GET', `/templates/${encodeURIComponent(idOrSlug)}/channels`, undefined, options),
      /** Creates or moves a channel; on `published` this publishes. */
      set: (idOrSlug: string, name: string, move: ChannelMove, options: SchemaGuardOptions = {}): Promise<Channel> => {
        const { allowBreaking, ...rest } = options;
        return this.request<Channel>(
          'PUT',
          `/templates/${encodeURIComponent(idOrSlug)}/channels/${encodeURIComponent(name)}`,
          { ...move, ...(allowBreaking ? { allow_breaking: true } : {}) },
          rest,
        );
      },
      /** The canary becomes the main version. */
      promote: (idOrSlug: string, name: string, options: SchemaGuardOptions = {}): Promise<Channel> => this.channelAction(idOrSlug, name, 'promote', options),
      /** Back to the version before the last move. */
      rollback: (idOrSlug: string, name: string, options: SchemaGuardOptions = {}): Promise<Channel> => this.channelAction(idOrSlug, name, 'rollback', options),
      /** Refused with `channel_in_use` while renders of the last hour used the channel, unless `force`. */
      delete: (idOrSlug: string, name: string, options: RequestOptions & { force?: boolean } = {}): Promise<void> => {
        const { force, ...rest } = options;
        return this.request<void>(
          'DELETE',
          `/templates/${encodeURIComponent(idOrSlug)}/channels/${encodeURIComponent(name)}${force ? '?force=true' : ''}`,
          undefined,
          rest,
        );
      },
    },
    /**
     * The JSON Schema of the template's data: stored, else inferred from the sample data. Of the
     * published (else the latest) version, or of `version`: `published`, `latest`, a number or a
     * channel name.
     */
    schema: (idOrSlug: string, options: RequestOptions & { version?: VersionRef } = {}): Promise<Record<string, unknown>> => {
      const { version, ...rest } = options;
      const query = version === undefined ? '' : `?version=${encodeURIComponent(String(version))}`;
      return this.request<Record<string, unknown>>('GET', `/templates/${encodeURIComponent(idOrSlug)}/schema${query}`, undefined, rest);
    },
    /**
     * Checks a version with data without rendering: syntax, header and footer, missing partials,
     * runtime errors and the data against the stored schema. Free. Without `data`, the version's
     * sample data is checked. `version` takes a channel name too.
     */
    validate: (
      idOrSlug: string,
      input: { version?: VersionRef; data?: Record<string, unknown> } = {},
      options: RequestOptions = {},
    ): Promise<TemplateValidation> =>
      this.request<TemplateValidation>('POST', `/templates/${encodeURIComponent(idOrSlug)}/validate`, input, options),
  };

  readonly account = {
    get: (options: RequestOptions = {}): Promise<Record<string, unknown>> =>
      this.request<Record<string, unknown>>('GET', '/account', undefined, options),
    /** Units of the current period, or of `YYYY-MM`, with a daily series and a breakdown per template. */
    usage: (period = 'current', options: RequestOptions = {}): Promise<Usage> =>
      this.request<Usage>('GET', `/usage?period=${encodeURIComponent(period)}`, undefined, options),
  };

  /** Workspaces of the key's organisation. Needs `workspace:delete`, which no key has by default. */
  readonly workspaces = {
    /**
     * Deletes a workspace: it leaves the app and the API at once, its keys are revoked and its content
     * is removed after 30 days. The organisation's last workspace is refused with `last_workspace`.
     */
    delete: (id: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/workspaces/${encodeURIComponent(id)}`, undefined, options),
  };

  private channelAction(idOrSlug: string, name: string, action: 'promote' | 'rollback', options: SchemaGuardOptions): Promise<Channel> {
    const { allowBreaking, ...rest } = options;
    return this.request<Channel>(
      'POST',
      `/templates/${encodeURIComponent(idOrSlug)}/channels/${encodeURIComponent(name)}/${action}`,
      allowBreaking ? { allow_breaking: true } : undefined,
      rest,
    );
  }

  /** Raw request with auth, retries and problem mapping; use it for endpoints without a helper. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.send<T>(method, path, body, options)).body;
  }

  /**
   * `request` with the HTTP status, for endpoints whose answer depends on it (201 created, 200 updated).
   * `bytes` returns a successful body as bytes (file downloads); problems are JSON either way.
   */
  private async send<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
    as: 'json' | 'bytes' = 'json',
  ): Promise<{ status: number; body: T }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: as === 'bytes' ? '*/*' : 'application/json',
      'user-agent': 'formfeed-sdk-ts/0.3',
      ...this.extraHeaders,
    };
    // FormData brings its own multipart content type with the boundary; everything else is JSON.
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('request timed out')), this.timeoutMs);
      options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < this.maxRetries && !options.signal?.aborted) {
          attempt++;
          await sleep(this.backoff(attempt, null), options.signal);
          continue;
        }
        throw new FormfeedError('network_error', e instanceof Error ? e.message : String(e), 0);
      }
      clearTimeout(timer);
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        attempt++;
        await sleep(this.backoff(attempt, res.headers.get('retry-after')), options.signal);
        continue;
      }
      if (res.status === 204) return { status: 204, body: undefined as T };
      if (as === 'bytes' && res.ok) return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) as T };
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        if (res.ok) throw new FormfeedError('invalid_response', `the API answered HTTP ${res.status} with a body that is not JSON`, res.status);
      }
      if (!res.ok) {
        const problem = (json ?? {}) as Problem;
        throw new FormfeedError(
          problem.code ?? `http_${res.status}`,
          problem.detail ?? problem.title ?? `HTTP ${res.status}`,
          res.status,
          problem,
          res.headers.get('x-request-id'),
        );
      }
      return { status: res.status, body: json as T };
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const base = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 500 * 2 ** (attempt - 1);
    return Math.min(30_000, base + Math.random() * 250);
  }
}
