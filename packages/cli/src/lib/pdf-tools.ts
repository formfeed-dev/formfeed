import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { InvalidArgumentError } from 'commander';
import type {
  FormFill,
  FormValue,
  PdfInfo,
  PdfSource,
  RedactRegion,
  Render,
} from '@formfeed/sdk-ts';
import { CliError, exitCodes } from './errors';

/** The PDF tools of `formfeed pdf` that make a render (plan 30); `info` makes none. */
export type PageTool = 'split' | 'compress' | 'to-image' | 'redact' | 'fill';

/** The API's limit for an uploaded PDF; a larger file is refused before it is read. */
export const PDF_UPLOAD_LIMIT = 100 * 1024 * 1024;

/** How every PDF tool's description names its source. */
export const PDF_SOURCE_HELP =
  'SOURCE is a PDF on this machine (uploaded and never stored), a render id (rnd_…) or a library file id (fil_…)';

/** A page selection as the API takes it: `1-3,5`, or `4-` for page 4 to the last. */
export const PAGE_SELECTION = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;

/**
 * The PDF a tool works on: a file on this machine, sent with the request, or a render or library
 * file of the workspace by its id. Anything else is a usage error that says which it can be.
 */
export function pdfSource(source: string, cwd: string): PdfSource {
  const path = resolve(cwd, source);
  if (existsSync(path) && statSync(path).isFile()) {
    if (statSync(path).size > PDF_UPLOAD_LIMIT)
      throw new CliError(
        `${path} is larger than 100 MB, the limit for the PDF tools`,
        exitCodes.usage,
      );
    return {
      file: { data: new Uint8Array(readFileSync(path)), name: basename(path) },
    };
  }
  if (/^(rnd|fil)_[A-Za-z0-9]+$/.test(source)) return source;
  throw new CliError(
    `No file ${path}, and ${source} is not a render id (rnd_…) or a library file id (fil_…)`,
    exitCodes.usage,
  );
}

const DONE: Partial<Record<PageTool, string>> = {
  compress: 'compressed',
  redact: 'redacted',
  fill: 'filled',
};

/**
 * Where a result goes without `--out`: in the working folder, under the name the API gave the file,
 * which is the last part of its link (`contract.zip`, `contract-1.pdf`, `contract-3.png`). compress,
 * redact and fill keep the source's own name, so theirs says what was done (`contract-redacted.pdf`)
 * and never replaces the source.
 */
export function resultFile(
  render: Render,
  tool: PageTool,
  cwd: string,
): string {
  let name = '';
  try {
    name = basename(
      decodeURIComponent(new URL(render.download_url ?? '').pathname),
    );
  } catch {
    name = '';
  }
  if (!name) name = `${render.id}.${render.output}`;
  const done = DONE[tool];
  return resolve(
    cwd,
    done ? name.replace(/(\.[^.]*)?$/, (ext = '') => `-${done}${ext}`) : name,
  );
}

/** What a result is, for the line the CLI prints: a PDF's pages, else its format. */
export function resultLine(render: Render): string {
  const what =
    render.output === 'pdf'
      ? `${render.page_count ?? '?'} page(s)`
      : render.output === 'zip'
        ? 'a ZIP'
        : `a ${render.output.toUpperCase()} picture`;
  return `${render.id}: ${what}, ${render.units} unit(s)`;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const REGION = new RegExp(`^(\\d+):${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`);

/** `--rect 1:52,88,200,16`: the page, then x, y, width and height in points from its top-left corner. */
export function parseRegion(value: string): RedactRegion {
  const match = REGION.exec(value.replace(/\s+/g, ''));
  const [page, x, y, width, height] = (match?.slice(1) ?? []).map(Number);
  if (
    page === undefined ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    page < 1 ||
    width <= 0 ||
    height <= 0
  )
    throw new InvalidArgumentError(
      '--rect is page:x,y,width,height in points from the top-left corner, e.g. 1:52,88,200,16',
    );
  return { page, x, y, width, height };
}

/** A whole number option within its bounds. */
export function wholeNumber(
  flag: string,
  min: number,
  max: number,
): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || n < min || n > max)
      throw new InvalidArgumentError(
        `${flag} is a whole number from ${min} to ${max}`,
      );
    return n;
  };
}

/** A repeatable option's values, in the order given. */
export const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

const isFormValue = (value: unknown): value is FormValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  (Array.isArray(value) && value.every((v) => typeof v === 'string'));

/**
 * The values for `formfeed pdf fill`: the JSON object of `--data` first, then each `--field
 * name=value` over it. A `--field` value is text, but for `true` and `false`, which are a check box's
 * state; a list box's several options go in `--data`.
 */
export function fillValues(
  data: unknown,
  fields: string[],
): Record<string, FormValue> {
  if (
    data !== undefined &&
    (data === null || typeof data !== 'object' || Array.isArray(data))
  )
    throw new CliError(
      '--data holds a JSON object of values by field name',
      exitCodes.usage,
    );
  const values: Record<string, FormValue> = {};
  for (const [name, value] of Object.entries(
    (data ?? {}) as Record<string, unknown>,
  )) {
    if (!isFormValue(value))
      throw new CliError(
        `--data: the value for ${JSON.stringify(name)} is no text, number, true, false or list of options`,
        exitCodes.usage,
      );
    values[name] = value;
  }
  for (const field of fields) {
    const at = field.indexOf('=');
    if (at < 1)
      throw new CliError(`--field ${field} is not name=value`, exitCodes.usage);
    const value = field.slice(at + 1);
    values[field.slice(0, at)] =
      value === 'true' ? true : value === 'false' ? false : value;
  }
  return values;
}

/** What a fill did, as lines: filled fields, then what was left out and what no viewer ran. */
export function formLines(form: FormFill | null | undefined): string[] {
  if (!form) return [];
  return [
    `filled ${form.filled} field(s)` +
      (form.xfa_removed ? ', the XFA part removed' : ''),
    ...form.skipped.map(
      (s) =>
        `skip   ${s.field}: ${
          s.reason === 'unknown'
            ? 'the form has no field of this name'
            : 'the field does not take the value'
        }`,
    ),
    ...form.warnings.map(
      (w) =>
        `warn   ${w.field}: ${
          w.code === 'calculation_not_run'
            ? 'its value comes from a calculation, which did not run'
            : w.code === 'format_not_applied'
              ? 'its display format was not applied'
              : w.code
        }`,
    ),
  ];
}

const mm = (n: number) => Math.round(n);
const shownValue = (value: unknown): string =>
  value === null || value === undefined
    ? '-'
    : typeof value === 'string'
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? value.map((v) => JSON.stringify(v)).join(', ')
        : String(value);

/** `formfeed pdf info` for a person: pages and sizes, encryption, metadata, then the form's fields. */
export function infoLines(info: PdfInfo): string[] {
  const sizes = [
    ...new Set(
      info.pages.map(
        (page) => `${mm(page.width_mm)} x ${mm(page.height_mm)} mm`,
      ),
    ),
  ];
  const lines = [
    `${info.source}: ${info.page_count} page(s)` +
      (sizes.length === 1
        ? `, ${sizes[0]}`
        : sizes.length > 1
          ? `, ${sizes.length} page sizes`
          : '') +
      (info.encrypted ? ', password-protected' : ''),
  ];
  for (const key of ['title', 'author', 'subject', 'creator', 'producer']) {
    const value = info.metadata[key];
    if (typeof value === 'string' && value)
      lines.push(`${key.padEnd(9)} ${value}`);
  }
  const form = info.form;
  if (form === undefined) return lines;
  if (form === null) {
    lines.push('form      not read: the file needs a password to open');
    return lines;
  }
  if (form.type === null) {
    lines.push('form      none');
    return lines;
  }
  lines.push(
    `form      ${form.type}, ${form.fields.length} field(s)` +
      (form.signed ? ', signed' : ''),
  );
  const width = Math.min(
    40,
    Math.max(0, ...form.fields.map((field) => field.name.length)),
  );
  for (const field of form.fields) {
    const notes = [
      field.required ? 'required' : '',
      field.readonly ? 'read-only' : '',
      field.calculated ? 'calculated' : '',
      field.options ? `options: ${field.options.join(', ')}` : '',
      field.label ? `label: ${field.label}` : '',
    ].filter(Boolean);
    lines.push(
      `  ${field.name.padEnd(width)}  ${field.type.padEnd(8)}  ${shownValue(field.value)}` +
        (notes.length ? `  (${notes.join('; ')})` : ''),
    );
  }
  return lines;
}
