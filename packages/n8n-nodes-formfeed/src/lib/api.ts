/**
 * Pure helpers of the n8n node: everything that decides what to send, so the node classes stay
 * declarative and this part is unit tested without the n8n runtime.
 */

export type Region = 'eu' | 'us';

export interface FormfeedCredentials {
  apiKey: string;
  region: Region;
  baseUrl?: string;
}

const HOSTS: Record<Region, string> = {
  eu: 'https://api-eu.formfeed.dev/v1',
  us: 'https://api-us.formfeed.dev/v1',
};

/** The API base a credential points at; a custom base URL wins (staging, hybrid rendering). */
export function baseUrl(credentials: FormfeedCredentials): string {
  const custom = credentials.baseUrl?.trim();
  return (custom ? custom : HOSTS[credentials.region] ?? HOSTS.eu).replace(/\/$/, '');
}

/** PDF and image templates render pdf or an image; Word templates docx or pdf, PowerPoint pptx or pdf. */
export type OutputFormat = 'pdf' | 'png' | 'jpg' | 'webp' | 'docx' | 'pptx';

/**
 * The name of a downloaded document: the one the user chose, with the extension of what was
 * rendered (a Word template may render `docx` or `pdf`, and a name typed for one would mislead for
 * the other), else `<render id>.<output>`.
 */
export function downloadName(chosen: string | undefined, renderId: string, output: string | undefined): string {
  const extension = output || 'pdf';
  const name = chosen?.trim();
  if (!name) return `${renderId}.${extension}`;
  const stem = name.replace(/\.(pdf|png|jpe?g|webp|docx|pptx)$/i, '');
  return `${stem}.${extension}`;
}

/** The PDF's name for a converted file: `report.xlsx` becomes `report.pdf`. */
export function pdfNameFor(fileName: string | undefined): string {
  const stem = (fileName ?? '').trim().replace(/\.[^./\\]+$/, '');
  return `${stem || 'document'}.pdf`;
}

export interface ConvertInput {
  /** The render of a Word or PowerPoint template; without it, the item's binary is uploaded. */
  renderId?: string;
  pageRanges?: string;
  landscape?: boolean;
  singlePageSheets?: boolean;
  filename?: string;
}

/**
 * The fields of `POST /pdf/convert` besides the file: a JSON body for a render, form fields for an
 * upload (booleans and objects as text, the way the API reads a multipart request).
 */
export function convertFields(input: ConvertInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.renderId?.trim()) fields['source'] = input.renderId.trim();
  if (input.pageRanges?.trim()) fields['page_ranges'] = input.pageRanges.trim();
  if (input.landscape) fields['landscape'] = true;
  if (input.singlePageSheets) fields['single_page_sheets'] = true;
  if (input.filename?.trim()) fields['filename'] = pdfNameFor(input.filename);
  fields['meta'] = { source: 'n8n' };
  return fields;
}

/** Form field values of a multipart request: text as is, everything else as JSON text. */
export function formValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export interface RenderInput {
  source: 'template' | 'html' | 'url';
  template?: string;
  html?: string;
  url?: string;
  engine?: 'jinja2' | 'liquid' | 'handlebars';
  data?: Record<string, unknown>;
  output?: OutputFormat;
  filename?: string;
  locale?: string;
  mode?: 'sync' | 'async';
  webhookUrl?: string;
  settings?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** Builds the `POST /renders` body, leaving out what the user did not fill in. */
export function renderBody(input: RenderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.source === 'template') body['template'] = input.template;
  if (input.source === 'html') {
    body['html'] = input.html;
    body['engine'] = input.engine ?? 'jinja2';
  }
  if (input.source === 'url') body['url'] = input.url;
  if (input.data && Object.keys(input.data).length > 0) body['data'] = input.data;
  if (input.output) body['output'] = input.output;
  if (input.filename) body['filename'] = input.filename;
  if (input.locale) body['locale'] = input.locale;
  if (input.mode === 'async') body['mode'] = 'async';
  if (input.webhookUrl) body['webhook_url'] = input.webhookUrl;
  if (input.settings && Object.keys(input.settings).length > 0) body['settings'] = input.settings;
  body['meta'] = { source: 'n8n', ...(input.meta ?? {}) };
  return body;
}

export interface SchemaField {
  /** Dot path into the data object, e.g. `invoice.number`. */
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';
  required: boolean;
  description?: string;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
}

/**
 * Flattens a template's JSON Schema into the fields the node offers, so a user maps named fields
 * instead of pasting JSON (spec 10 §2). Arrays and free-form objects stay whole: their contents
 * come from an expression.
 */
export function schemaFields(schema: unknown, prefix = ''): SchemaField[] {
  const node = schema as JsonSchema | null;
  if (!node || typeof node !== 'object' || !node.properties) return [];
  const required = new Set(node.required ?? []);
  const fields: SchemaField[] = [];
  for (const [name, property] of Object.entries(node.properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const type = typeOf(property);
    if (type === 'object' && property.properties) {
      fields.push(...schemaFields(property, path));
      continue;
    }
    fields.push({
      path,
      type,
      required: required.has(name),
      ...(property.description ? { description: property.description } : {}),
    });
  }
  return fields;
}

function typeOf(property: JsonSchema): SchemaField['type'] {
  const raw = Array.isArray(property.type) ? property.type[0] : property.type;
  switch (raw) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'object':
    case 'array':
      return raw === 'integer' ? 'number' : raw;
    default:
      return property.properties ? 'object' : 'unknown';
  }
}

/** Turns the node's flat field mapping back into the nested `data` object the API expects. */
export function nestData(values: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    const parts = path.split('.');
    let target = data;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      target = (typeof next === 'object' && next !== null ? next : (target[part] = {})) as Record<string, unknown>;
    }
    target[parts[parts.length - 1] as string] = value;
  }
  return data;
}

/** Deep merge for the data object: the JSON field wins per leaf, not per branch. Arrays replace. */
export function mergeData(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeData(current, value)
        : value;
  }
  return out;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Events the trigger node can subscribe to; the API validates the same list. */
export const TRIGGER_EVENTS = [
  'render.completed',
  'render.failed',
  'job.completed',
  'job.failed',
  'quota.warning',
  'quota.exceeded',
] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** One name segment of the file library: a letter or digit, then letters, digits, dot, dash, underscore. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * The library name for an upload (spec 04 §2.3): the name the user typed when it is valid, else the
 * binary's file name cleaned up the way the API cleans a browser upload. Null when neither gives a
 * usable name, so the node can say so before the request.
 */
export function libraryName(typed: string | undefined, fileName: string | undefined): string | null {
  const chosen = typed?.trim();
  if (chosen) return NAME.test(chosen) && !chosen.split('/').includes('..') ? chosen : null;
  const cleaned = (fileName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''))
    .filter(Boolean)
    .join('/');
  return cleaned && NAME.test(cleaned) ? cleaned : null;
}
