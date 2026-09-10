import { getEngine } from '../engines';
import type { TemplateSettings } from '../assemble';
import type { Diagnostic, EngineId } from '../types';

/**
 * What every importer shares (spec 10 §4): the result shape the app and the CLI turn into a draft,
 * the notes of the report, and the final check that compiles and analyses the converted template
 * against its sample data, so the report shows exactly what the editor would.
 */
export type ImportSource = 'apitemplate' | 'pdfmonkey' | 'jsreport';

export interface ImportNote {
  code: string;
  message: string;
  line?: number;
  column?: number;
  /** Path under docs.formfeed.dev with the details. */
  docs?: string;
}

export interface ImportResult {
  source: ImportSource;
  name: string;
  slug: string;
  kind: 'pdf' | 'image';
  engine: EngineId;
  html: string;
  css: string;
  head: string;
  settings: TemplateSettings;
  sampleData: unknown;
  /** Compile or analysis errors: the draft is created, but it will not render as is. */
  errors: ImportNote[];
  /** Unknown filters, unsupported constructs, ignored settings. */
  warnings: ImportNote[];
  /** What the importer changed or mapped. */
  changes: string[];
}

export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length >= 2 ? slug : `imported-${Date.now().toString(36)}`;
}

export function parseSample(value: unknown): { data: unknown; error?: string } {
  if (value === undefined || value === null || value === '') return { data: {} };
  if (typeof value !== 'string') return { data: value };
  try {
    return { data: JSON.parse(value) };
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export function positionOf(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

/** Every match of `pattern` in `source` as a note with its position. */
export function notesFor(
  source: string,
  pattern: RegExp,
  note: Omit<ImportNote, 'line' | 'column'>,
  { once = false }: { once?: boolean } = {},
): ImportNote[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const out: ImportNote[] = [];
  for (const m of source.matchAll(global)) {
    out.push({ ...note, ...positionOf(source, m.index ?? 0) });
    if (once) break;
  }
  return out;
}

/** Docs pages the generic diagnostics point at, per importer. */
export interface CheckDocs {
  syntax: string;
  filters: string;
  sampleData: string;
}

/**
 * Compiles and analyses the converted template with the engine it will run on. Errors stop the
 * render (the draft is still created); everything else is a warning. Duplicates of one error at
 * the same line are dropped, since compile and analyse often report the same syntax error.
 */
export function checkTemplate(
  engineId: EngineId,
  html: string,
  sampleData: unknown,
  name: string,
  docs: CheckDocs,
): { errors: ImportNote[]; warnings: ImportNote[] } {
  const errors: ImportNote[] = [];
  const warnings: ImportNote[] = [];
  const engine = getEngine(engineId);
  try {
    engine.compile(html, { name });
  } catch (e) {
    const err = e as { message: string; line?: number; column?: number };
    errors.push({ code: 'syntax-error', message: err.message, line: err.line, column: err.column, docs: docs.syntax });
  }
  const fromDiagnostic = (d: Diagnostic): ImportNote => ({
    code: d.code,
    message: d.message,
    line: d.range.start.line,
    column: d.range.start.column,
    docs: d.code === 'unknown-filter' ? docs.filters : d.code.startsWith('missing-') ? docs.sampleData : docs.syntax,
  });
  for (const d of engine.analyze(html, { sampleData }).diagnostics) {
    const note = fromDiagnostic(d);
    if (d.severity === 'error') {
      if (!errors.some((x) => x.code === note.code && x.line === note.line)) errors.push(note);
    } else warnings.push(note);
  }
  return { errors, warnings };
}

/** `210`, `210mm`, `8.5in` → a CSS length; bare numbers are millimetres. */
export function lengthMm(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}mm`;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}mm`;
  if (/^-?\d+(\.\d+)?(mm|cm|in|px|pt)$/i.test(text)) return text.toLowerCase();
  return undefined;
}

/** A binary value as base64: a base64 string, a serialised Node Buffer, or a byte array. */
export function toBase64(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const bytes =
    value instanceof Uint8Array
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
        ? Uint8Array.from((value as { data: number[] }).data)
        : Array.isArray(value)
          ? Uint8Array.from(value as number[])
          : undefined;
  if (!bytes) return undefined;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const mimeByExtension: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css',
  js: 'text/javascript',
  html: 'text/html',
  json: 'application/json',
  txt: 'text/plain',
};

export function mimeOf(name: string): string {
  return mimeByExtension[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
