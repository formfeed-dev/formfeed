import type { TemplateSettings } from '../assemble';
import {
  checkTemplate,
  lengthMm,
  notesFor,
  parseSample,
  positionOf,
  slugFromName,
  type ImportNote,
  type ImportResult,
} from './common';
import { convertScss } from './scss';

/**
 * PDFMonkey importer (spec 10 §4). A PDFMonkey code template is HTML with Ruby Liquid 4, a CSS or
 * SCSS stylesheet, sample data as a JSON string and settings, all returned by
 * `GET /api/v1/document_templates/{id}`. Formfeed's Liquid engine is LiquidJS with the shared
 * helpers, so the converter rewrites what differs:
 *
 * - `date` takes date-fns tokens here, strftime there; `in_time_zone` becomes `date`'s timezone.
 * - PDFMonkey's own filters map to helpers (`slice_by` → `chunk`, `with_delimiter` → `number`
 *   with a locale that has the same separators) or are reported: the engine runs with strict
 *   filters, so an unmapped one would fail the render.
 * - Ruby's lax parser accepts `| filter, key: value`; LiquidJS needs `| filter: key: value`.
 * - Snippets (`load_snippets` + `include`) and inline `{% partial %}` blocks are inlined, because
 *   stored partials do not take part in API renders.
 * - Settings: paper, orientation, margins (PDFMonkey's default is 10 mm), the simple
 *   left/center/right header and footer with `[page]`/`[topage]`, or the advanced HTML one.
 *
 * Builder templates (their visual builder) have an undocumented format and are not supported.
 */
export interface PdfmonkeyMargin {
  top?: number | string | null;
  right?: number | string | null;
  bottom?: number | string | null;
  left?: number | string | null;
}

export interface PdfmonkeyHeaderFooter {
  left?: string | null;
  center?: string | null;
  right?: string | null;
  /** "Advanced mode": full-width HTML with Liquid; overrides left/center/right. */
  content?: string | null;
}

export interface PdfmonkeySettings {
  paper_format?: string | null;
  paper_width?: number | string | null;
  paper_height?: number | string | null;
  orientation?: string | null;
  margin?: PdfmonkeyMargin | null;
  header?: PdfmonkeyHeaderFooter | null;
  footer?: PdfmonkeyHeaderFooter | null;
  inject_javascript?: boolean | null;
  use_emojis?: boolean | null;
  transparent_background?: boolean | null;
  use_paged?: boolean | null;
  use_forms?: boolean | null;
  [key: string]: unknown;
}

export interface PdfmonkeyTemplate {
  id?: string;
  identifier?: string | null;
  edition_mode?: string | null;
  output_type?: string | null;
  body?: string | null;
  body_draft?: string | null;
  scss_style?: string | null;
  scss_style_draft?: string | null;
  sample_data?: unknown;
  sample_data_draft?: unknown;
  settings?: PdfmonkeySettings | null;
  settings_draft?: PdfmonkeySettings | null;
}

export interface PdfmonkeyImportOptions {
  /** Import the unpublished draft instead of the published version. */
  draft?: boolean;
  /** Snippet code by name, for templates that `load_snippets`; PDFMonkey's API does not return it. */
  snippets?: Record<string, string>;
  /** A Sass compiler; without one, SCSS is converted as far as that works without (see scss.ts). */
  compileScss?: (source: string) => string;
}

const DOCS = '/migrate/pdfmonkey';

// --- strftime → date-fns --------------------------------------------------------------------

const strftime: Record<string, string> = {
  Y: 'yyyy',
  y: 'yy',
  m: 'MM',
  '-m': 'M',
  d: 'dd',
  '-d': 'd',
  e: 'd',
  H: 'HH',
  '-H': 'H',
  k: 'H',
  I: 'hh',
  '-I': 'h',
  l: 'h',
  M: 'mm',
  '-M': 'm',
  S: 'ss',
  '-S': 's',
  L: 'SSS',
  p: 'a',
  P: 'aaa',
  B: 'MMMM',
  b: 'MMM',
  h: 'MMM',
  A: 'EEEE',
  a: 'EEE',
  u: 'i',
  z: 'xx',
  F: 'yyyy-MM-dd',
  D: 'MM/dd/yy',
  T: 'HH:mm:ss',
  R: 'HH:mm',
  r: 'hh:mm:ss a',
};

/** A strftime format as date-fns tokens; `unmapped` lists the directives without an equivalent. */
export function strftimeToDateFns(format: string): { format: string; unmapped: string[] } {
  let out = '';
  let literal = '';
  const unmapped: string[] = [];
  const flushLiteral = () => {
    if (!literal) return;
    out += /[A-Za-z']/.test(literal) ? `'${literal.replace(/'/g, "''")}'` : literal;
    literal = '';
  };
  for (let i = 0; i < format.length; i++) {
    const ch = format[i] ?? '';
    if (ch !== '%') {
      literal += ch;
      continue;
    }
    const flag = format[i + 1] === '-' ? '-' : '';
    const directive = format[i + 1 + flag.length] ?? '';
    i += flag.length + 1;
    if (directive === '%') {
      literal += '%';
      continue;
    }
    const token = strftime[`${flag}${directive}`] ?? strftime[directive];
    if (token) {
      flushLiteral();
      out += token;
    } else {
      unmapped.push(`%${flag}${directive}`);
      literal += `%${flag}${directive}`;
    }
  }
  flushLiteral();
  return { format: out, unmapped };
}

// --- Liquid dialect -------------------------------------------------------------------------

/** A Liquid string literal; Liquid has no escapes, so the other quote is used when needed. */
const quote = (value: string) => (value.includes('"') && !value.includes("'") ? `'${value}'` : `"${value}"`);

/** Rails number_with_delimiter options → the locale whose grouping and decimal marks match. */
function localeForSeparators(delimiter: string, separator: string): string | undefined {
  // a space or a no-break space as delimiter is the French grouping
  const key = `${delimiter.replace(/\u00a0/g, ' ')}|${separator}`;
  return (
    {
      ',|.': 'en-US',
      '.|,': 'de-DE',
      ' |,': 'fr-FR',
      "'|.": 'de-CH',
    } as Record<string, string>
  )[key];
}

function keywordArgs(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of args.matchAll(/([a-z_]\w*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s|]+)/g)) {
    const raw = m[2] ?? '';
    out[m[1] ?? ''] = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return out;
}

/** Filters PDFMonkey adds that have no helper: reported as errors with what to do instead. */
const unsupportedFilters: Record<string, string> = {
  to_sentence: 'use `join: ", "`, or `array_to_sentence_string` for "a, b, and c"',
  ensure_protocol: 'store the URL with its protocol, or prepend it with `prepend: "https:"`',
  format: 'use `number: 2` for decimals or `round: 2`; printf padding has no equivalent',
  parse_json: 'send the value as JSON in the payload instead of a string',
  in_time_zone: 'pass the zone to `date` as its second argument: `date: "dd.MM.yyyy", "Europe/Berlin"`',
};

interface DialectResult {
  source: string;
  errors: ImportNote[];
  warnings: ImportNote[];
  changes: Set<string>;
}

/** Applies `fn` to the inside of every `{{ … }}` and `{% … %}`, leaving the markup untouched. */
function mapLiquid(source: string, fn: (inner: string) => string): string {
  return source.replace(/(\{\{-?|\{%-?)([\s\S]*?)(-?\}\}|-?%\})/g, (_m, open: string, inner: string, close: string) => `${open}${fn(inner)}${close}`);
}

function convertDialect(source: string, changes: Set<string>): DialectResult {
  const errors: ImportNote[] = [];
  const warnings: ImportNote[] = [];

  let out = mapLiquid(source, (inner) => {
    let expr = inner;
    // Ruby accepts `| with_delimiter, precision: 2`; LiquidJS needs a colon after the filter name
    expr = expr.replace(/\|\s*([a-z_]\w*)\s*,\s*(?=[a-z_]\w*\s*:)/g, (_m, name: string) => {
      changes.add('filter arguments written with a colon (`| filter: key: value`) instead of a comma');
      return `| ${name}: `;
    });
    // `| in_time_zone: "X" | date: "fmt"` → `| date: "fmt", "X"`
    expr = expr.replace(
      /\|\s*in_time_zone\s*:\s*(["'])([^"']+)\1\s*\|\s*date\s*:\s*(["'])((?:(?!\3).)*)\3/g,
      (_m, _q: string, zone: string, _q2: string, fmt: string) => {
        changes.add('`in_time_zone` merged into `date` as its timezone argument');
        return `| date: ${quote(fmt)}, ${quote(zone)}`;
      },
    );
    // strftime → date-fns in `date` formats
    expr = expr.replace(/\|\s*date\s*:\s*(["'])((?:(?!\1).)*)\1/g, (m, _q: string, fmt: string) => {
      if (!fmt.includes('%')) return m;
      const converted = strftimeToDateFns(fmt);
      changes.add('date formats converted from strftime (%d.%m.%Y) to date-fns tokens (dd.MM.yyyy)');
      if (converted.unmapped.length)
        warnings.push({
          code: 'date-directive',
          message: `The date format "${fmt}" uses ${converted.unmapped.join(', ')}, which has no date-fns equivalent; it is kept literally.`,
          docs: `${DOCS}#dates`,
        });
      return `| date: ${quote(converted.format)}`;
    });
    // Ruby Time.parse understands "today"; the date helper understands "now"
    expr = expr.replace(/(["'])today\1(\s*\|\s*date\b)/g, '"now"$2');
    // `slice_by: n` is `chunk: n`
    expr = expr.replace(/\|\s*slice_by\b/g, () => {
      changes.add('`slice_by` renamed to `chunk`');
      return '| chunk';
    });
    // `entities` only worked around Chromium header encoding; Formfeed renders UTF-8 as is
    expr = expr.replace(/\s*\|\s*entities\b/g, () => {
      changes.add('`entities` removed: header and footer render UTF-8 directly');
      return '';
    });
    // `with_delimiter` → `number` with the locale that has the same separators
    expr = expr.replace(/\|\s*with_delimiter\b(\s*:\s*[^|]*)?/g, (m, args?: string) => {
      const opts = keywordArgs(args ?? '');
      const locale = localeForSeparators(opts['delimiter'] ?? ',', opts['separator'] ?? '.');
      if (!locale) {
        warnings.push({
          code: 'number-separators',
          message: `with_delimiter with delimiter "${opts['delimiter'] ?? ','}" and separator "${opts['separator'] ?? '.'}" has no matching locale; it was kept and will fail.`,
          docs: `${DOCS}#numbers`,
        });
        return m;
      }
      if (opts['strip_insignificant_zeros'] === 'true')
        warnings.push({
          code: 'number-strip-zeros',
          message: '`strip_insignificant_zeros` has no equivalent; `number` shows up to three decimals without fixed precision.',
          docs: `${DOCS}#numbers`,
        });
      changes.add('`with_delimiter` converted to `number` with a locale that has the same separators');
      const decimals = opts['strip_insignificant_zeros'] === 'true' ? 'nil' : (opts['precision'] ?? 'nil');
      return `| number: ${decimals}, ${quote(locale)} `;
    });
    return expr;
  });

  // reports on what stays
  for (const [filter, instead] of Object.entries(unsupportedFilters))
    errors.push(
      ...notesFor(out, new RegExp(`\\|\\s*${filter}\\b`), {
        code: 'pdfmonkey-filter',
        message: `PDFMonkey's \`${filter}\` filter has no Formfeed equivalent: ${instead}.`,
        docs: `${DOCS}#filters`,
      }),
    );
  warnings.push(
    ...notesFor(out, /\|\s*divided_by\s*:\s*-?\d+\s*(?=[|}%]|-?%\}|-?\}\})/, {
      code: 'integer-division',
      message:
        'PDFMonkey (Ruby Liquid) divides two integers without remainder: `7 | divided_by: 2` is 3 there and 3.5 here. Add `| floor` if the template relies on it.',
      docs: `${DOCS}#numbers`,
    }),
  );
  out = out.replace(/\[%\s*data_form_field[^\]]*\]/g, (m) => {
    warnings.push({ code: 'pdf-forms', message: 'PDF form markers are not supported; the marker is kept as text.', docs: `${DOCS}#forms`, ...positionOf(out, out.indexOf(m)) });
    return m;
  });
  return { source: out, errors, warnings, changes };
}

// --- snippets and partials ------------------------------------------------------------------

/** Splits `a: 1, b: "x, y"` at top-level commas. */
function splitParams(params: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of params.matchAll(/([A-Za-z_]\w*)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]+)/g))
    out.push([m[1] ?? '', (m[2] ?? '').trim()]);
  return out;
}

function inlineIncludes(
  source: string,
  blocks: Map<string, string>,
  errors: ImportNote[],
  changes: Set<string>,
): string {
  let out = source;
  for (let depth = 0; depth < 6; depth++) {
    let inlined = false;
    out = out.replace(/\{%-?\s*include\s+(["'])([^"']+)\1\s*(?:,\s*([\s\S]*?))?\s*-?%\}/g, (m, _q: string, name: string, params?: string) => {
      const body = blocks.get(name);
      if (body === undefined) return m;
      inlined = true;
      changes.add('snippets and partials inlined into the template');
      const assigns = splitParams(params ?? '')
        .map(([k, v]) => `{% assign ${k} = ${v} %}`)
        .join('');
      return `${assigns}${body}`;
    });
    if (!inlined) break;
  }
  for (const m of out.matchAll(/\{%-?\s*include\s+(["'])([^"']+)\1/g))
    errors.push({
      code: 'snippet-missing',
      message: `The snippet "${m[2]}" is not part of the template; paste its code in the import dialog (Snippets) or with --snippet ${m[2]}=file.liquid.`,
      docs: `${DOCS}#snippets`,
      ...positionOf(out, m.index ?? 0),
    });
  return out;
}

// --- settings -------------------------------------------------------------------------------

const cssPaperFormats: Record<string, string> = { a3: 'A3', a4: 'A4', a5: 'A5', letter: 'Letter' };
/** ISO sizes CSS has no keyword for, in millimetres. */
const isoSizes: Record<string, [number, number]> = { a0: [841, 1189], a1: [594, 841], a2: [420, 594], a6: [105, 148] };

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function simpleHeaderFooter(part: PdfmonkeyHeaderFooter, margin: { left: string; right: string }): string | undefined {
  const cells = (['left', 'center', 'right'] as const).map((side) => part[side] ?? '');
  if (!cells.some((c) => c.trim())) return undefined;
  const cell = (text: string, align: string) =>
    `<div style="flex: 1; text-align: ${align}">${escapeHtml(text)
      .replace(/\[page\]/g, '<span class="pageNumber"></span>')
      .replace(/\[topage\]/g, '<span class="totalPages"></span>')}</div>`;
  return `<div style="display: flex; width: 100%; font-size: 10px; padding: 0 ${margin.right} 0 ${margin.left}">${cell(cells[0] ?? '', 'left')}${cell(cells[1] ?? '', 'center')}${cell(cells[2] ?? '', 'right')}</div>`;
}

function mapSettings(
  input: PdfmonkeySettings,
  kind: 'pdf' | 'image',
  warnings: ImportNote[],
  changes: Set<string>,
): { settings: TemplateSettings; header?: string; footer?: string } {
  const settings: TemplateSettings = {};
  const format = String(input.paper_format ?? 'a4').toLowerCase();
  if (format === 'custom') {
    const width = lengthMm(input.paper_width);
    const height = lengthMm(input.paper_height);
    if (width && height) settings.paper = { width, height };
    else warnings.push({ code: 'setting-ignored', message: 'Custom paper size without width and height; A4 is used.', docs: `${DOCS}#settings` });
  } else if (cssPaperFormats[format]) settings.paper = { format: cssPaperFormats[format] };
  else if (isoSizes[format]) {
    const [w, h] = isoSizes[format] ?? [210, 297];
    settings.paper = { width: `${w}mm`, height: `${h}mm` };
    changes.add(`${format.toUpperCase()} kept as its size in millimetres`);
  } else warnings.push({ code: 'setting-ignored', message: `Paper format "${input.paper_format}" is unknown; A4 is used.`, docs: `${DOCS}#settings` });
  if (String(input.orientation ?? '').toLowerCase() === 'landscape') settings.paper = { ...settings.paper, landscape: true };

  // PDFMonkey's margins are millimetres and default to 10 when empty
  const m = input.margin ?? {};
  const margin = {
    top: lengthMm(m.top) ?? '10mm',
    right: lengthMm(m.right) ?? '10mm',
    bottom: lengthMm(m.bottom) ?? '10mm',
    left: lengthMm(m.left) ?? '10mm',
  };
  settings.margin = margin;
  changes.add('paper, orientation and margins mapped (empty PDFMonkey margins are 10 mm)');

  let header: string | undefined;
  let footer: string | undefined;
  for (const [key, part] of [
    ['header', input.header],
    ['footer', input.footer],
  ] as const) {
    if (!part) continue;
    const html = part.content?.trim() ? part.content : simpleHeaderFooter(part, margin);
    if (!html) continue;
    if (key === 'header') header = html;
    else footer = html;
    changes.add(
      part.content?.trim()
        ? 'header and footer HTML moved to the Header and Footer tabs'
        : 'simple header and footer rebuilt as HTML with page numbers; check the font size',
    );
  }

  if (kind === 'image') {
    settings.image = { width: 1200, height: 630, deviceScaleFactor: 2, format: 'png', ...(input.transparent_background ? { transparent: true } : {}) };
    changes.add('image size defaults to 1200 × 630 (PDFMonkey sets it per request; change it in Settings)');
  }
  if (input.inject_javascript)
    warnings.push({
      code: 'inject-javascript',
      message: 'PDFMonkey exposed the payload to scripts as `$docPayload`; Formfeed does not. Render the values into the markup, or write them into a script tag with the json filter.',
      docs: `${DOCS}#javascript`,
    });
  if (input.use_paged)
    warnings.push({ code: 'paged-js', message: 'The template waited for Paged.js; check page breaks and margin boxes in the true render.', docs: `${DOCS}#paged-js` });
  if (input.use_forms) warnings.push({ code: 'pdf-forms', message: 'PDF form fields are not supported.', docs: `${DOCS}#forms` });
  if (input.use_emojis) changes.add('`use_emojis` dropped: emoji render with the system emoji font');
  return { settings, header, footer };
}

// --- markup checks --------------------------------------------------------------------------

function convertMarkup(html: string, settings: TemplateSettings, warnings: ImportNote[], changes: Set<string>): string {
  let out = html;
  const tailwind = /<script\b[^>]*\bsrc=["'][^"']*tailwind[^"']*["'][^>]*>\s*<\/script>\s*|<link\b[^>]*\bhref=["'][^"']*tailwind[^"']*\.css["'][^>]*>\s*/gi;
  if (tailwind.test(out)) {
    out = out.replace(tailwind, '');
    settings.tailwind = true;
    changes.add('Tailwind script removed and Tailwind mode switched on (Formfeed compiles the classes)');
  }
  warnings.push(
    ...notesFor(out, /pagedjs|paged\.polyfill/i, {
      code: 'paged-js',
      message: 'The template loads Paged.js; Formfeed paginates with Chromium, so check running headers and margin boxes in the true render.',
      docs: `${DOCS}#paged-js`,
    }, { once: true }),
    ...notesFor(out, /qr-code-styling|@bitjson\/qr-code|qrcode(\.min)?\.js|qrcodejs/i, {
      code: 'qr-library',
      message: 'A JavaScript QR library is loaded; the `qrcode` helper renders QR codes without scripts: `<img src="{{ url | qrcode }}">`.',
      docs: '/templates/helpers#qrcode',
    }, { once: true }),
    ...notesFor(out, /\$docPayload/, {
      code: 'inject-javascript',
      message: '`$docPayload` is not defined in Formfeed; render the values into the markup or write them into a script tag with the json filter.',
      docs: `${DOCS}#javascript`,
    }, { once: true }),
  );
  return out;
}

// --- entry point ----------------------------------------------------------------------------

export function importPdfmonkey(
  input: PdfmonkeyTemplate | { document_template: PdfmonkeyTemplate },
  options: PdfmonkeyImportOptions = {},
): ImportResult {
  const tpl: PdfmonkeyTemplate = 'document_template' in input ? input.document_template : input;
  const errors: ImportNote[] = [];
  const warnings: ImportNote[] = [];
  const changes = new Set<string>();
  const pick = <T>(published: T | null | undefined, draft: T | null | undefined): T | null | undefined => {
    const empty = (v: unknown) => v === undefined || v === null || v === '';
    if (options.draft) return empty(draft) ? published : draft;
    if (empty(published) && !empty(draft)) {
      changes.add('the template was never published; the draft was imported');
      return draft;
    }
    return published;
  };

  const name = (tpl.identifier ?? '').trim() || 'Imported template';
  const kind: 'pdf' | 'image' = String(tpl.output_type ?? '').toLowerCase() === 'image' ? 'image' : 'pdf';
  if (tpl.edition_mode === 'builder')
    errors.push({
      code: 'builder-template',
      message: 'This is a PDFMonkey Builder template; its format is not documented, so only code templates can be imported. Recreate it in the Formfeed editor.',
      docs: DOCS,
    });

  const mapped = mapSettings(pick(tpl.settings, tpl.settings_draft) ?? {}, kind, warnings, changes);
  const settings = mapped.settings;

  // snippets and inline partials, then the dialect of the body and the header and footer
  let body = String(pick(tpl.body, tpl.body_draft) ?? '');
  const blocks = new Map<string, string>(Object.entries(options.snippets ?? {}));
  body = body.replace(/\{%-?\s*partial\s+(["'])([^"']+)\1\s*-?%\}([\s\S]*?)\{%-?\s*endpartial\s*-?%\}/g, (_m, _q: string, partialName: string, content: string) => {
    blocks.set(partialName, content);
    return '';
  });
  body = body.replace(/\{%-?\s*load_snippets\b[\s\S]*?-?%\}/g, () => {
    changes.add('`load_snippets` removed');
    return '';
  });
  body = inlineIncludes(body, blocks, errors, changes);

  const converted = convertDialect(body, changes);
  errors.push(...converted.errors);
  warnings.push(...converted.warnings);
  const html = convertMarkup(converted.source, settings, warnings, changes);
  for (const key of ['header', 'footer'] as const) {
    const part = mapped[key];
    if (!part) continue;
    const result = convertDialect(inlineIncludes(part, blocks, errors, changes), changes);
    settings[key] = { html: result.source };
    errors.push(...result.errors.map((n) => ({ ...n, message: `${key}: ${n.message}` })));
    warnings.push(...result.warnings.map((n) => ({ ...n, message: `${key}: ${n.message}` })));
  }

  const scss = convertScss(String(pick(tpl.scss_style, tpl.scss_style_draft) ?? ''), options.compileScss);
  warnings.push(...scss.warnings);
  for (const change of scss.changes) changes.add(change);

  const sample = parseSample(pick(tpl.sample_data, tpl.sample_data_draft));
  if (sample.error)
    warnings.push({ code: 'sample-json', message: `Sample data is not valid JSON (${sample.error}); the draft starts without sample data.`, docs: `${DOCS}#sample-data` });

  const checked = checkTemplate('liquid', html, sample.data, name, {
    syntax: '/templates/languages#liquid',
    filters: `${DOCS}#filters`,
    sampleData: `${DOCS}#sample-data`,
  });
  // the analyser's unknown-filter error and LiquidJS's "undefined filter" parse error on a line that
  // already carries the PDFMonkey explanation add nothing
  const explained = new Set(errors.filter((e) => e.code === 'pdfmonkey-filter').map((e) => e.line));
  const generic = (e: ImportNote) => e.code === 'unknown-filter' || (e.code === 'syntax-error' && /undefined filter/i.test(e.message));
  errors.push(...checked.errors.filter((e) => !(generic(e) && explained.has(e.line))));
  warnings.push(...checked.warnings);

  return {
    source: 'pdfmonkey',
    name,
    slug: slugFromName(name),
    kind,
    engine: 'liquid',
    html,
    css: scss.css,
    head: '',
    settings,
    sampleData: sample.data,
    errors,
    warnings,
    changes: [...changes],
  };
}
