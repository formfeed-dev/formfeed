import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What decides the requests of the Formfeed piece, kept free of the Activepieces runtime so it is
 * unit tested on its own.
 */

export type OutputFormat = 'pdf' | 'png' | 'jpg' | 'webp' | 'docx' | 'pptx';

export interface RenderInput {
  template?: string;
  /** `published` (the default, left out), a release channel, `latest` or a version number. */
  version?: string;
  html?: string;
  url?: string;
  engine?: string;
  data?: Record<string, unknown>;
  output?: string;
  filename?: string;
  locale?: string;
  settings?: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Builds the `POST /renders` body, leaving out what the user did not fill in. */
export function renderBody(input: RenderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.template) {
    body['template'] = input.template;
    if (input.version && input.version !== 'published') body['version'] = input.version;
  }
  if (input.html) {
    body['html'] = input.html;
    body['engine'] = input.engine || 'jinja2';
  }
  if (input.url) body['url'] = input.url;
  if (input.data && Object.keys(input.data).length > 0) body['data'] = input.data;
  if (input.output) body['output'] = input.output;
  if (input.filename) body['filename'] = input.filename;
  if (input.locale) body['locale'] = input.locale;
  if (input.settings && Object.keys(input.settings).length > 0) body['settings'] = input.settings;
  body['meta'] = { source: 'activepieces' };
  return body;
}

/** A JSON prop arrives as an object, or as text when it was typed or mapped as text. */
export function parseObject(value: unknown, label = 'Data'): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
    return parsed;
  }
  throw new Error(`${label} must be a JSON object`);
}

/** Deep merge for the data object: the JSON value wins per leaf, not per branch. Arrays replace. */
export function mergeData(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeData(current, value) : value;
  }
  return out;
}

export interface SchemaField {
  /** The template data path joined with `__`: `invoice__number`. */
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

interface JsonSchema {
  type?: string | string[];
  description?: string;
  title?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

/**
 * The fields a template's JSON Schema turns into, so a flow maps named fields instead of writing
 * JSON (spec 10 §2). Nested objects become `__`-joined keys; lists stay in the Data prop.
 */
export function schemaFields(schema: unknown, prefix: string[] = []): SchemaField[] {
  if (!isPlainObject(schema) || !isPlainObject(schema['properties'])) return [];
  const node = schema as JsonSchema;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const fields: SchemaField[] = [];
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (!isPlainObject(value)) continue;
    const property = value as JsonSchema;
    const path = [...prefix, name];
    const type = Array.isArray(property.type) ? property.type.find((t) => t !== 'null') : property.type;
    if (type === 'object' && isPlainObject(property.properties)) {
      fields.push(...schemaFields(property, path));
      continue;
    }
    if (type === 'array' || type === 'object') continue;
    fields.push({
      key: path.join('__'),
      label: property.title ?? path.join('.'),
      type: type === 'number' || type === 'integer' ? 'number' : type === 'boolean' ? 'boolean' : 'text',
      description: property.description ?? `\`${path.join('.')}\` in the template data.`,
      required: required.has(name),
    });
  }
  return fields;
}

/** Collects the dynamic fields of a run back into the nested data object. */
export function dataFromFields(values: Record<string, unknown> | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const parts = key.split('__');
    let target = data;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      target = isPlainObject(next) ? next : (target[part] = {}) as Record<string, unknown>;
    }
    target[parts[parts.length - 1] as string] = value;
  }
  return data;
}

/** A channel as `GET /templates/{id}/channels` lists it. */
export interface ChannelSummary {
  name: string;
  version: number | null;
  canary?: { version: number; percent: number } | null;
}

/**
 * The version choices of a template: `published` and its release channels with the version each
 * renders, or nothing while the template has no channel besides `published`.
 */
export function versionOptions(channels: ChannelSummary[]): Array<{ label: string; value: string }> {
  if (!channels.some((channel) => channel.name !== 'published')) return [];
  return channels.map((channel) => {
    const canary = channel.canary ? `, canary v${channel.canary.version} at ${channel.canary.percent} %` : '';
    return {
      label: channel.version === null ? `${channel.name} (nothing published yet)` : `${channel.name} (v${channel.version}${canary})`,
      value: channel.name,
    };
  });
}

/** Whether a render or batch has stopped changing. */
export const isFinished = (status: string | undefined): boolean =>
  ['succeeded', 'failed', 'completed', 'partially_failed'].includes(status ?? '');

/**
 * The name of a saved document: the one chosen, with the extension of what was rendered (a Word
 * template renders `docx` or `pdf`), else `<render id>.<output>`.
 */
export function downloadName(chosen: string | undefined, renderId: string, output: string | undefined): string {
  const extension = output || 'pdf';
  const name = (chosen ?? '').trim().replace(/[/\\]/g, '-');
  if (!name) return `${renderId}.${extension}`;
  return `${name.replace(/\.(pdf|png|jpe?g|webp|docx|pptx)$/i, '')}.${extension}`;
}

/** The PDF's name for a converted file: `report.xlsx` becomes `report.pdf`. */
export function pdfNameFor(fileName: string | undefined): string {
  const stem = (fileName ?? '').trim().replace(/\.[^./\\]+$/, '');
  return `${stem || 'document'}.pdf`;
}

export interface ConvertInput {
  renderId?: string;
  pageRanges?: string;
  landscape?: boolean;
  singlePageSheets?: boolean;
  filename?: string;
}

/** The fields of `POST /pdf/convert` besides the file. */
export function convertFields(input: ConvertInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.renderId?.trim()) fields['source'] = input.renderId.trim();
  if (input.pageRanges?.trim()) fields['page_ranges'] = input.pageRanges.trim();
  if (input.landscape) fields['landscape'] = true;
  if (input.singlePageSheets) fields['single_page_sheets'] = true;
  if (input.filename?.trim()) fields['filename'] = pdfNameFor(input.filename);
  fields['meta'] = { source: 'activepieces' };
  return fields;
}

/** A form field value of a multipart request: text as is, everything else as JSON text. */
export const formValue = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** Webhook signatures older than this are refused, as the SDKs do. */
const TOLERANCE_SECONDS = 300;

/**
 * Checks `Webhook-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>` against the
 * raw body, the scheme of the Formfeed SDKs (spec 04 §2.4).
 */
export function verifySignature(
  secret: string | null | undefined,
  header: unknown,
  rawBody: unknown,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || typeof header !== 'string' || typeof rawBody !== 'string') return false;
  const parts = new Map(
    header.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = (parts.get('v1') ?? '').toLowerCase();
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}

/** A header of a webhook delivery, whichever case the server kept. */
export function headerValue(headers: Record<string, unknown> | undefined, name: string): unknown {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}
