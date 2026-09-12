/**
 * `@formfeed/sdk` (spec 10 §1): a fetch-based client for the public API. Runs in Node 18+, Deno,
 * Bun, Workers and browsers (with a test key). Retries 429 and 503 with the server's Retry-After
 * and jitter, generates an Idempotency-Key for every render, and turns RFC 9457 problems into
 * typed errors.
 */
export type Region = 'eu' | 'us';
export type Engine = 'jinja2' | 'liquid' | 'handlebars';
export type OutputFormat = 'pdf' | 'png' | 'jpg' | 'webp';
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
}

export interface RenderRequest {
  template?: string;
  version?: string;
  html?: string;
  url?: string;
  engine?: Engine;
  data?: Record<string, unknown>;
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
  /** PDF post-processing: merge, watermark, password, applied in that order (0.5 units each). */
  post?: PostProcessing | null;
}

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
  template: { id: string; slug: string; version: number } | null;
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

export interface BatchRequest {
  template?: string;
  items: RenderRequest[];
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

export interface FileListOptions {
  /** Only names starting with this, e.g. `brand/`. */
  prefix?: string;
  limit?: number;
  cursor?: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  description: string | null;
  consecutive_failures: number;
  /** Only present in the response of `create`. */
  secret?: string;
  created_at: string;
  updated_at: string;
}

export type TemplateKind = 'pdf' | 'image';
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

  constructor(options: FormfeedOptions) {
    if (!options.apiKey) throw new FormfeedError('invalid_request', 'apiKey is required', 0);
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? hosts[options.region ?? 'eu']).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!this.fetchImpl) throw new FormfeedError('invalid_request', 'fetch is not available; pass options.fetch', 0);
  }

  readonly renders = {
    /** Renders a template, HTML or URL. Sync by default; `mode: 'async'` returns a queued render. */
    create: (request: RenderRequest, options: RequestOptions = {}): Promise<Render> =>
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
    batch: (request: BatchRequest, options: RequestOptions = {}): Promise<Job> =>
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
    create: (
      input: { url: string; events?: string[]; description?: string | null },
      options: RequestOptions = {},
    ): Promise<WebhookEndpoint> => this.request<WebhookEndpoint>('POST', '/webhooks', input, options),
    update: (
      id: string,
      patch: { url?: string; events?: string[]; enabled?: boolean; description?: string | null },
      options: RequestOptions = {},
    ): Promise<WebhookEndpoint> =>
      this.request<WebhookEndpoint>('PUT', `/webhooks/${encodeURIComponent(id)}`, patch, options),
    delete: (id: string, options: RequestOptions = {}): Promise<void> =>
      this.request<void>('DELETE', `/webhooks/${encodeURIComponent(id)}`, undefined, options),
    test: (id: string, options: RequestOptions = {}): Promise<{ queued: boolean }> =>
      this.request<{ queued: boolean }>('POST', `/webhooks/${encodeURIComponent(id)}/test`, undefined, options),
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
    create: (input: TemplateCreate, options: RequestOptions = {}): Promise<Template> =>
      this.request<Template>('POST', '/templates', input, options),
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
      /** `which`: 'published', 'latest' or a version number. Carries the files. */
      get: (idOrSlug: string, which: 'published' | 'latest' | number = 'published', options: RequestOptions = {}): Promise<TemplateVersion> =>
        this.request<TemplateVersion>('GET', `/templates/${encodeURIComponent(idOrSlug)}/versions/${which}`, undefined, options),
      create: (idOrSlug: string, input: TemplateVersionCreate, options: RequestOptions = {}): Promise<TemplateVersion> =>
        this.request<TemplateVersion>('POST', `/templates/${encodeURIComponent(idOrSlug)}/versions`, input, options),
      publish: (idOrSlug: string, number: number, options: RequestOptions = {}): Promise<TemplateVersion> =>
        this.request<TemplateVersion>('POST', `/templates/${encodeURIComponent(idOrSlug)}/versions/${number}/publish`, undefined, options),
    },
    schema: (idOrSlug: string, options: RequestOptions = {}): Promise<Record<string, unknown>> =>
      this.request<Record<string, unknown>>('GET', `/templates/${encodeURIComponent(idOrSlug)}/schema`, undefined, options),
  };

  readonly account = {
    get: (options: RequestOptions = {}): Promise<Record<string, unknown>> =>
      this.request<Record<string, unknown>>('GET', '/account', undefined, options),
    /** Units of the current period, or of `YYYY-MM`, with a daily series and a breakdown per template. */
    usage: (period = 'current', options: RequestOptions = {}): Promise<Usage> =>
      this.request<Usage>('GET', `/usage?period=${encodeURIComponent(period)}`, undefined, options),
  };

  /** Raw request with auth, retries and problem mapping; use it for endpoints without a helper. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      'user-agent': 'formfeed-sdk-ts/0.1',
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
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : null;
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
      return json as T;
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const base = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 500 * 2 ** (attempt - 1);
    return Math.min(30_000, base + Math.random() * 250);
  }
}
