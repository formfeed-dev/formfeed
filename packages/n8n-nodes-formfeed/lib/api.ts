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
  return (custom ? custom : (HOSTS[credentials.region] ?? HOSTS.eu)).replace(
    /\/$/,
    '',
  );
}

/** PDF and image templates render pdf or an image; Word templates docx or pdf, PowerPoint pptx or pdf. */
export type OutputFormat = 'pdf' | 'png' | 'jpg' | 'webp' | 'docx' | 'pptx';

/**
 * The name of a downloaded document: the one the user chose, with the extension of what was
 * rendered (a Word template may render `docx` or `pdf`, and a name typed for one would mislead for
 * the other), else `<render id>.<output>`.
 */
export function downloadName(
  chosen: string | undefined,
  renderId: string,
  output: string | undefined,
): string {
  const extension = output || 'pdf';
  const name = chosen?.trim();
  if (!name) return `${renderId}.${extension}`;
  const stem = name.replace(/\.(pdf|png|jpe?g|webp|docx|pptx|zip)$/i, '');
  return `${stem}.${extension}`;
}

/**
 * The name the API gave a stored file, the last part of its link (`contract.zip`, `contract-3.png`),
 * or undefined for a link that names none.
 */
export function linkName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const last = new URL(url).pathname.split('/').pop();
    const name = last ? decodeURIComponent(last) : '';
    return name && !/[\\/]/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The PDF tools of plan 30 as the node calls them, with the path of each. */
export const PDF_TOOLS = {
  compress: '/pdf/compress',
  fill: '/pdf/fill',
  info: '/pdf/info',
  redact: '/pdf/redact',
  split: '/pdf/split',
  toImage: '/pdf/to-image',
} as const;
export type PdfTool = keyof typeof PDF_TOOLS;

/** A page selection as the API takes it: `1-3,5`, or `4-` for page 4 to the last. */
export const PAGE_SELECTION = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;

/** One entry per line, without the empty ones: page ranges, texts to redact. */
export function lines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** What every PDF tool takes besides the file: the stored source, the result's name, where it came from. */
export interface PdfToolInput {
  /** A render (`rnd_…`) or a PDF of the file library (its name or `fil_…`); without it the item's binary is uploaded. */
  source?: string;
  filename?: string;
}

function toolFields(input: PdfToolInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.source?.trim()) fields['source'] = input.source.trim();
  if (input.filename?.trim()) fields['filename'] = input.filename.trim();
  fields['meta'] = { source: 'n8n' };
  return fields;
}

/** `POST /pdf/split`: `every` pages each, or one part per line of `ranges`. */
export function splitFields(
  input: PdfToolInput & { every?: number; ranges?: string },
): Record<string, unknown> {
  const fields = toolFields(input);
  const ranges = lines(input.ranges);
  if (input.ranges !== undefined) {
    if (!ranges.length) throw new Error('Give at least one page range');
    const bad = ranges.find((range) => !PAGE_SELECTION.test(range));
    if (bad)
      throw new Error(
        `"${bad}" is no page selection; write it like 1-3,5 or 4-`,
      );
    fields['ranges'] = ranges;
  } else fields['every'] = input.every ?? 1;
  return fields;
}

/** `POST /pdf/to-image`: the pages, the format, the resolution and the JPEG quality, where given. */
export function toImageFields(
  input: PdfToolInput & {
    pages?: string;
    format?: string;
    dpi?: number;
    quality?: number;
  },
): Record<string, unknown> {
  const fields = toolFields(input);
  const pages = input.pages?.trim();
  if (pages) {
    if (!PAGE_SELECTION.test(pages))
      throw new Error(
        `"${pages}" is no page selection; write it like 1-3,5 or 2-`,
      );
    fields['pages'] = pages;
  }
  if (input.format) fields['format'] = input.format;
  if (input.dpi) fields['dpi'] = input.dpi;
  if (input.format === 'jpg' && input.quality)
    fields['quality'] = input.quality;
  return fields;
}

/** A rectangle as a viewer shows the page: points from its top-left corner, y running down. */
export interface RedactRectangle {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `POST /pdf/redact`: the rectangles and the texts (one per line), how a text is found, and the box
 * over each removed place: black by default, another colour, or none (`null`).
 */
export function redactFields(
  input: PdfToolInput & {
    rectangles?: RedactRectangle[];
    texts?: string;
    matchCase?: boolean;
    wholeWords?: boolean;
    drawBox?: boolean;
    boxColour?: string;
  },
): Record<string, unknown> {
  const fields = toolFields(input);
  const rectangles = input.rectangles ?? [];
  const texts = lines(input.texts);
  if (!rectangles.length && !texts.length)
    throw new Error('Give at least one rectangle or one text to remove');
  if (rectangles.length) fields['regions'] = rectangles;
  if (texts.length) fields['text'] = texts;
  if (input.matchCase) fields['match_case'] = true;
  if (input.wholeWords) fields['whole_words'] = true;
  if (input.drawBox === false) fields['fill'] = null;
  else if (input.boxColour && !/^#?0{6}$/.test(input.boxColour.trim()))
    fields['fill'] = input.boxColour.trim();
  return fields;
}

/** A form field's value as `/pdf/fill` takes it. */
export type FormValue = string | number | boolean | string[];

/** A list box's several options written as a JSON list, `["a","b"]`, or nothing. */
function optionList(value: string): string[] | undefined {
  if (!/^\s*\[/.test(value)) return undefined;
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) && list.every((v) => typeof v === 'string')
      ? list
      : undefined;
  } catch {
    // not JSON, so it is the text it reads
    return undefined;
  }
}

/**
 * The values of a fill, from the name and value pairs of the node's fields: `true` and `false` set a
 * check box, a JSON list such as `["a","b"]` chooses several options of a list box, anything else is
 * the text it reads. A name given twice keeps its last value.
 */
export function fillValues(
  pairs: Array<{ name?: string; value?: string }>,
): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const pair of pairs) {
    const name = pair.name?.trim();
    if (!name) continue;
    const value = pair.value ?? '';
    values[name] =
      value === 'true'
        ? true
        : value === 'false'
          ? false
          : (optionList(value) ?? value);
  }
  return values;
}

/** `POST /pdf/fill`: the values, `flatten`, and `strict: false` for a lenient fill. */
export function fillFields(
  input: PdfToolInput & {
    values: Record<string, FormValue>;
    flatten?: boolean;
    lenient?: boolean;
  },
): Record<string, unknown> {
  const fields = toolFields(input);
  if (!Object.keys(input.values).length && !input.flatten)
    throw new Error('Give at least one field, or flatten the form');
  if (Object.keys(input.values).length) fields['fields'] = input.values;
  if (input.flatten) fields['flatten'] = true;
  if (input.lenient) fields['strict'] = false;
  return fields;
}

/** `POST /pdf/compress` takes the source and the result's name only. */
export function compressFields(input: PdfToolInput): Record<string, unknown> {
  return toolFields(input);
}

/** `POST /pdf/info` takes the source only; it makes no render. */
export function infoFields(input: PdfToolInput): Record<string, unknown> {
  return input.source?.trim() ? { source: input.source.trim() } : {};
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
  /** `published` (the default, left out), a release channel, `latest` or a version number. */
  version?: string;
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
  /** Post-processing, such as `{ einvoice: {} }` for a ZUGFeRD / Factur-X invoice. */
  post?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** Builds the `POST /renders` body, leaving out what the user did not fill in. */
export function renderBody(input: RenderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.source === 'template') {
    body['template'] = input.template;
    if (input.version && input.version !== 'published')
      body['version'] = input.version;
  }
  if (input.source === 'html') {
    body['html'] = input.html;
    body['engine'] = input.engine ?? 'jinja2';
  }
  if (input.source === 'url') body['url'] = input.url;
  if (input.data && Object.keys(input.data).length > 0)
    body['data'] = input.data;
  if (input.output) body['output'] = input.output;
  if (input.filename) body['filename'] = input.filename;
  if (input.locale) body['locale'] = input.locale;
  if (input.mode === 'async') body['mode'] = 'async';
  if (input.webhookUrl) body['webhook_url'] = input.webhookUrl;
  if (input.settings && Object.keys(input.settings).length > 0)
    body['settings'] = input.settings;
  if (input.post && Object.keys(input.post).length > 0)
    body['post'] = input.post;
  body['meta'] = { source: 'n8n', ...(input.meta ?? {}) };
  return body;
}

/** A party of an e-invoice as the node's fields hold it; the API names the fields that are missing. */
export interface InvoicePartyFields {
  name?: string;
  street?: string;
  postcode?: string;
  city?: string;
  country?: string;
  vatId?: string;
  /** The register entry: a company number, a SIREN. */
  legalRegistration?: string;
  /** Register court, capital and the like (the seller only). */
  legalInfo?: string;
  /** Where the party receives e-invoices: an e-mail address, or a Peppol id with its scheme in the JSON field. */
  electronicAddress?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface InvoiceLineFields {
  name?: string;
  description?: string;
  quantity?: number;
  /** UN/ECE Recommendation 20: C62 a piece, HUR an hour, DAY a day. */
  unitCode?: string;
  netPrice?: number;
  netAmount?: number;
  vatCategory?: string;
  vatRate?: number;
}

export interface InvoiceBreakdownFields {
  vatCategory?: string;
  vatRate?: number;
  basis?: number;
  amount?: number;
  exemptionReason?: string;
}

/** The fields of the node's Create E-Invoice operation (spec 17 §4.3). */
export interface InvoiceFields {
  number?: string;
  issueDate?: string;
  currency?: string;
  /** UNTDID 1001: 380 an invoice, 381 a credit note. */
  typeCode?: string;
  buyerReference?: string;
  orderReference?: string;
  note?: string;
  seller?: InvoicePartyFields;
  buyer?: InvoicePartyFields;
  lines?: InvoiceLineFields[];
  breakdown?: InvoiceBreakdownFields[];
  totals?: {
    lineNet?: number;
    taxBasis?: number;
    taxTotal?: number;
    grand?: number;
    prepaid?: number;
    due?: number;
  };
  payment?: {
    meansCode?: string;
    iban?: string;
    bic?: string;
    reference?: string;
    terms?: string;
    dueDate?: string;
  };
}

/** A day as the block takes it: n8n's date fields give a timestamp, of which the date counts. */
export function isoDay(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(text);
  return day ? day[1] : text;
}

/** Leaves out what the user left empty, so the API sees only what was filled in. */
function filled(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v !== undefined &&
        v !== '' &&
        !(isPlainObject(v) && Object.keys(v).length === 0),
    ),
  );
}

function party(
  fields: InvoicePartyFields | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const block = filled({
    name: fields.name?.trim(),
    vat_id: fields.vatId?.trim(),
    legal_registration: fields.legalRegistration?.trim(),
    legal_info: fields.legalInfo?.trim(),
    electronic_address: fields.electronicAddress?.trim(),
    address: filled({
      street: fields.street?.trim(),
      postcode: fields.postcode?.trim(),
      city: fields.city?.trim(),
      country: fields.country?.trim().toUpperCase(),
    }),
    contact: filled({
      name: fields.contactName?.trim(),
      phone: fields.contactPhone?.trim(),
      email: fields.contactEmail?.trim(),
    }),
  });
  return Object.keys(block).length > 0 ? block : undefined;
}

/**
 * The `_invoice` block of an e-invoice from the node's fields (spec 17 §4.3): the same shape the API
 * documents, with the lines numbered in order. Nothing is computed: the totals and the VAT breakdown
 * are the source system's, and the API refuses a total that does not add up to the cent.
 */
export function invoiceBlock(fields: InvoiceFields): Record<string, unknown> {
  const lines = (fields.lines ?? []).map((line, index) =>
    filled({
      id: String(index + 1),
      name: line.name?.trim(),
      description: line.description?.trim(),
      quantity: line.quantity,
      unit_code: line.unitCode?.trim(),
      net_price: line.netPrice,
      net_amount: line.netAmount,
      // a category without VAT (O) has no rate
      tax: filled({
        category: line.vatCategory,
        rate: line.vatCategory === 'O' ? undefined : line.vatRate,
      }),
    }),
  );
  const breakdown = (fields.breakdown ?? []).map((row) =>
    filled({
      category: row.vatCategory,
      rate: row.vatCategory === 'O' ? undefined : row.vatRate,
      basis: row.basis,
      amount: row.amount,
      exemption_reason: row.exemptionReason?.trim(),
    }),
  );
  const totals = fields.totals ?? {};
  const payment = fields.payment ?? {};
  return filled({
    number: fields.number?.trim(),
    issue_date: isoDay(fields.issueDate),
    type_code: fields.typeCode,
    currency: fields.currency?.trim().toUpperCase(),
    buyer_reference: fields.buyerReference?.trim(),
    order_reference: fields.orderReference?.trim(),
    note: fields.note?.trim(),
    seller: party(fields.seller),
    buyer: party(fields.buyer),
    lines: lines.length > 0 ? lines : undefined,
    tax: breakdown.length > 0 ? { breakdown } : undefined,
    totals: filled({
      line_net: totals.lineNet,
      tax_basis: totals.taxBasis,
      tax_total: totals.taxTotal,
      grand: totals.grand,
      prepaid: totals.prepaid,
      due: totals.due,
    }),
    payment: filled({
      means_code: payment.meansCode,
      iban: payment.iban?.trim(),
      bic: payment.bic?.trim(),
      reference: payment.reference?.trim(),
      terms: payment.terms?.trim(),
      due_date: isoDay(payment.dueDate),
    }),
  });
}

/** `post.einvoice` from the node's options, leaving the API's defaults (EN 16931, Factur-X) unsaid. */
export function einvoiceOptions(options: {
  profile?: string;
  flavour?: string;
  storeXml?: boolean;
  strictDisplayCheck?: boolean;
}): Record<string, unknown> {
  return filled({
    profile:
      options.profile && options.profile !== 'en16931'
        ? options.profile
        : undefined,
    flavour:
      options.flavour && options.flavour !== 'factur-x'
        ? options.flavour
        : undefined,
    xml: options.storeXml ? 'both' : undefined,
    display_check: options.strictDisplayCheck ? 'strict' : undefined,
  });
}

/** A channel as `GET /templates/{id}/channels` lists it; what the version dropdown shows. */
export interface ChannelSummary {
  name: string;
  version: number | null;
  canary?: { version: number; percent: number } | null;
}

/** The version dropdown: `published` and the channels, each with the version it renders. */
export function channelOptions(
  channels: ChannelSummary[],
): Array<{ name: string; value: string; description: string }> {
  return channels.map((channel) => {
    const canary = channel.canary
      ? `, canary v${channel.canary.version} at ${channel.canary.percent} %`
      : '';
    // the built-in channel reads as the node's other labels do; the others are the names users gave them
    const label = channel.name === 'published' ? 'Published' : channel.name;
    return {
      name:
        channel.version === null
          ? `${label} (nothing published yet)`
          : `${label} (v${channel.version}${canary})`,
      value: channel.name,
      description:
        channel.name === 'published'
          ? 'The published version, the default'
          : `The release channel ${channel.name}`,
    };
  });
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
export function nestData(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    const parts = path.split('.');
    let target = data;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      target = (
        typeof next === 'object' && next !== null ? next : (target[part] = {})
      ) as Record<string, unknown>;
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

/** An RFC 9457 problem as the API answers a refused request (`errors` names each field and rule). */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  errors?: { path?: string; message?: string; rule?: string }[];
  [key: string]: unknown;
}

/**
 * The problem the API answered with, from the error n8n's request helper throws: it keeps the parsed
 * body as `context.data`, while its message is n8n's sentence for the status ("Your request is
 * invalid or could not be processed by the service"), which names neither the field nor the rule.
 */
export function problemOf(error: unknown): Problem | undefined {
  const context = isPlainObject(error) ? error['context'] : undefined;
  const data = isPlainObject(context) ? context['data'] : undefined;
  return isPlainObject(data) &&
    (typeof data['code'] === 'string' || typeof data['detail'] === 'string')
    ? (data as Problem)
    : undefined;
}

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
export function libraryName(
  typed: string | undefined,
  fileName: string | undefined,
): string | null {
  const chosen = typed?.trim();
  if (chosen)
    return NAME.test(chosen) && !chosen.split('/').includes('..')
      ? chosen
      : null;
  const cleaned = (fileName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) =>
      part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''),
    )
    .filter(Boolean)
    .join('/');
  return cleaned && NAME.test(cleaned) ? cleaned : null;
}
