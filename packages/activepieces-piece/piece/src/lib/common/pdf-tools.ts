/**
 * What the PDF tool actions send besides the file (plan 30), kept free of the Activepieces runtime
 * like `utils.ts`, so the tests hold every request to the API's contract.
 */

/** The PDF tools as the piece calls them, with the path of each. */
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

/** A file prop's value as far as the tools use it. */
export interface PdfFile {
  filename: string;
  data: Buffer;
}

/** The PDF a tool works on: exactly one of a file of an earlier step and a stored PDF. */
export function pdfSourceOf(
  file: PdfFile | null | undefined,
  stored: string | null | undefined,
): { file?: PdfFile; source?: string } {
  const source = stored?.trim();
  if (Boolean(file) === Boolean(source))
    throw new Error('Provide either a PDF file or a stored PDF.');
  return file ? { file } : { source };
}

/** A switch as a flow hands it over: a checkbox's boolean, or the text of a mapped value. */
const truthy = (value: unknown): boolean => value === true || value === 'true';

/** The entries of a list prop, trimmed and without the empty ones; one mapped value is a list of one. */
export function listOf(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return values.map((entry) => String(entry).trim()).filter(Boolean);
}

/** What every PDF tool takes besides the file: a stored source, the result's name, where it came from. */
export interface PdfToolInput {
  /** A render (`rnd_…`) or a PDF of the file library (its name or `fil_…`); without it the file is uploaded. */
  source?: string;
  filename?: string;
}

function toolFields(input: PdfToolInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.source?.trim()) fields['source'] = input.source.trim();
  if (input.filename?.trim()) fields['filename'] = input.filename.trim();
  fields['meta'] = { source: 'activepieces' };
  return fields;
}

function wholeNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${label} is a whole number from ${min} to ${max}`);
  return n;
}

/** `POST /pdf/split`: one part per page selection, else `every` pages each (one when empty). */
export function splitFields(
  input: PdfToolInput & { every?: unknown; ranges?: unknown },
): Record<string, unknown> {
  const fields = toolFields(input);
  const ranges = listOf(input.ranges);
  const bad = ranges.find((range) => !PAGE_SELECTION.test(range));
  if (bad)
    throw new Error(`"${bad}" is no page selection; write it like 1-3,5 or 4-`);
  if (ranges.length) fields['ranges'] = ranges;
  else
    fields['every'] = wholeNumber(input.every, 'Pages per part', 1, 1000) ?? 1;
  return fields;
}

/** `POST /pdf/to-image`: the pages, the format, the resolution, and the JPEG quality for JPEG. */
export function toImageFields(
  input: PdfToolInput & {
    pages?: string;
    format?: string;
    dpi?: unknown;
    quality?: unknown;
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
  if (input.format === 'png' || input.format === 'jpg')
    fields['format'] = input.format;
  const dpi = wholeNumber(input.dpi, 'The resolution', 36, 300);
  if (dpi) fields['dpi'] = dpi;
  const quality = wholeNumber(input.quality, 'The JPEG quality', 1, 100);
  if (quality && input.format === 'jpg') fields['quality'] = quality;
  return fields;
}

/** A rectangle entry of Redact PDF, as the array prop hands it over. */
export interface RectangleEntry {
  page?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function rectangleOf(entry: RectangleEntry, n: number) {
  const points = (value: unknown, label: string, positive: boolean) => {
    const v = Number(value);
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      !Number.isFinite(v) ||
      v < 0 ||
      (positive && v === 0)
    )
      throw new Error(
        `Rectangle ${n}: ${label} is a number of points${positive ? ' above 0' : ''}`,
      );
    return v;
  };
  const page = Number(entry.page ?? 1);
  if (!Number.isInteger(page) || page < 1)
    throw new Error(`Rectangle ${n}: the page is a whole number from 1`);
  return {
    page,
    x: points(entry.x ?? 0, 'X', false),
    y: points(entry.y ?? 0, 'Y', false),
    width: points(entry.width, 'the width', true),
    height: points(entry.height, 'the height', true),
  };
}

/**
 * `POST /pdf/redact`: rectangles and texts, how a text is found, and the box over each removed
 * place: black by default, another colour, or none (`null`).
 */
export function redactFields(
  input: PdfToolInput & {
    texts?: unknown;
    rectangles?: unknown;
    matchCase?: unknown;
    wholeWords?: unknown;
    drawBox?: unknown;
    boxColor?: string;
  },
): Record<string, unknown> {
  const fields = toolFields(input);
  const entries = (
    Array.isArray(input.rectangles) ? input.rectangles : []
  ) as RectangleEntry[];
  const rectangles = entries
    .filter(
      (entry) =>
        entry &&
        Object.values(entry).some(
          (v) => v !== undefined && v !== null && v !== '',
        ),
    )
    .map((entry, i) => rectangleOf(entry, i + 1));
  const texts = listOf(input.texts);
  if (!rectangles.length && !texts.length)
    throw new Error('Give at least one rectangle or one text to remove');
  if (rectangles.length) fields['regions'] = rectangles;
  if (texts.length) fields['text'] = texts;
  if (truthy(input.matchCase)) fields['match_case'] = true;
  if (truthy(input.wholeWords)) fields['whole_words'] = true;
  const color = input.boxColor?.trim();
  if (input.drawBox === false || input.drawBox === 'false')
    fields['fill'] = null;
  else if (color) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(color))
      throw new Error('The box color is a hex color such as #000000');
    fields['fill'] = color;
  }
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
 * The values of a fill from the entries of the Fields prop: `true` and `false` set a check box, a
 * JSON list such as `["a","b"]` chooses several options of a list box, anything else is the text it
 * reads. An entry without a value leaves its field as it is; a name given twice keeps its last value.
 */
export function fillValues(entries: unknown): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const entry of (Array.isArray(entries) ? entries : []) as Array<{
    name?: unknown;
    value?: unknown;
  }>) {
    const name = String(entry?.name ?? '').trim();
    const raw = entry?.value;
    if (!name || raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'boolean' || typeof raw === 'number') {
      values[name] = raw;
      continue;
    }
    const value = String(raw);
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
    flatten?: unknown;
    lenient?: unknown;
  },
): Record<string, unknown> {
  const fields = toolFields(input);
  const flatten = truthy(input.flatten);
  if (!Object.keys(input.values).length && !flatten)
    throw new Error('Give at least one field, or flatten the form');
  if (Object.keys(input.values).length) fields['fields'] = input.values;
  if (flatten) fields['flatten'] = true;
  if (truthy(input.lenient)) fields['strict'] = false;
  return fields;
}

/** `POST /pdf/compress` takes the source and the result's name only. */
export const compressFields = (input: PdfToolInput): Record<string, unknown> =>
  toolFields(input);

/** `POST /pdf/info` takes the source only; it makes no render. */
export const infoFields = (input: PdfToolInput): Record<string, unknown> =>
  input.source?.trim() ? { source: input.source.trim() } : {};
