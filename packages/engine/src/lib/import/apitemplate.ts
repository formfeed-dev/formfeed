import { mapApitemplateSettings } from '@formfeed/api-types';
import { getEngine } from '../engines';
import type { TemplateSettings } from '../assemble';
import type { Diagnostic } from '../types';

/**
 * apitemplate.io importer (spec 10 §4, spec 05 §8): turns an exported template (HTML body, CSS,
 * settings, sample JSON) into a Formfeed draft and a report of what needs attention. The Jinja2
 * engine already carries the compatibility layer (string methods, `.items()`, filter aliases), so
 * the source is kept verbatim apart from placeholders in header and footer templates.
 */
export interface ApitemplateExport {
  name?: string;
  html: string;
  css?: string;
  /** apitemplate.io template settings (paper, margins, header/footer templates, image options). */
  settings?: Record<string, unknown> | null;
  /** Their sample JSON; a string is parsed. */
  sample_data?: unknown;
  /** Their template format; JPEG and PNG become image templates. */
  format?: string | null;
}

export interface ImportNote {
  code: string;
  message: string;
  line?: number;
  column?: number;
  /** Path under docs.formfeed.dev with the details. */
  docs?: string;
}

export interface ImportResult {
  name: string;
  slug: string;
  kind: 'pdf' | 'image';
  engine: 'jinja2';
  html: string;
  css: string;
  head: string;
  settings: TemplateSettings;
  sampleData: unknown;
  /** Compile or analysis errors: the draft is created, but it will not render as is. */
  errors: ImportNote[];
  /** Unknown filters, unsupported Python constructs, ignored settings. */
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

function parseSample(value: unknown): { data: unknown; error?: string } {
  if (value === undefined || value === null || value === '') return { data: {} };
  if (typeof value !== 'string') return { data: value };
  try {
    return { data: JSON.parse(value) };
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Python Jinja2 constructs Nunjucks does not run (spec 05 §8), found by pattern with a position. */
const pythonisms: Array<{ pattern: RegExp; code: string; message: string; docs: string }> = [
  {
    pattern: /\{\{[^}]*%\s*\(/,
    code: 'python-format-operator',
    message: 'Python "%" string formatting is not supported; use the format() shim or a filter such as number() or money().',
    docs: '/migrate/apitemplate-io#strings',
  },
  {
    pattern: /loop\.cycle\s*\(/,
    code: 'loop-cycle',
    message: '`loop.cycle()` is not available; use `cycler()` or `loop.index % n`.',
    docs: '/migrate/apitemplate-io#loops',
  },
  {
    pattern: /\{%-?\s*(macro|call|filter|autoescape)\b/,
    code: 'partial-support',
    message: 'Jinja2 macros, call blocks, filter blocks and autoescape blocks run with Nunjucks semantics; check the output.',
    docs: '/templates/languages#jinja2',
  },
  {
    pattern: /\bis\s+(divisibleby|sameas|escaped|mapping|sequence|callable)\b/,
    code: 'jinja-test',
    message: 'This Jinja2 test is not available; rewrite it with an expression (for example `x % 2 == 0`).',
    docs: '/migrate/apitemplate-io#tests',
  },
  {
    pattern: /\{%-?\s*(import|from)\b/,
    code: 'imports',
    message: 'Jinja2 imports refer to files apitemplate.io kept next to the template; move the macros into this template or a Formfeed partial.',
    docs: '/templates/languages#partials',
  },
];

function positionOf(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

function setInLoop(source: string): ImportNote[] {
  const notes: ImportNote[] = [];
  const forRe = /\{%-?\s*for\b[\s\S]*?\{%-?\s*endfor\s*-?%\}/g;
  for (const m of source.matchAll(forRe)) {
    const setAt = m[0].search(/\{%-?\s*set\s+\w+\s*=/);
    if (setAt >= 0) {
      const pos = positionOf(source, m.index + setAt);
      notes.push({
        code: 'set-in-loop',
        message:
          'A {% set %} inside a loop: in Python Jinja2 the value is lost after the loop, in Nunjucks it is kept. Check code that relies on either behaviour.',
        docs: '/migrate/apitemplate-io#loops',
        ...pos,
      });
    }
  }
  return notes;
}

function fromDiagnostic(d: Diagnostic): ImportNote {
  const docs =
    d.code === 'unknown-filter'
      ? '/templates/helpers'
      : d.code.startsWith('missing-')
        ? '/migrate/apitemplate-io#sample-data'
        : '/templates/languages#jinja2';
  return { code: d.code, message: d.message, line: d.range.start.line, column: d.range.start.column, docs };
}

export function importApitemplate(input: ApitemplateExport): ImportResult {
  const errors: ImportNote[] = [];
  const warnings: ImportNote[] = [];
  const changes: string[] = [];
  const name = (input.name ?? '').trim() || 'Imported template';
  const format = String(input.format ?? '').toUpperCase();
  const kind: 'pdf' | 'image' = format === 'JPEG' || format === 'PNG' || format === 'JPG' ? 'image' : 'pdf';
  if (kind === 'image') changes.push(`${format} template imported as an image template`);

  const mapped = mapApitemplateSettings(input.settings ?? undefined);
  const settings = mapped.settings as TemplateSettings;
  for (const note of mapped.notes) changes.push(note);
  for (const key of mapped.ignored)
    warnings.push({ code: 'setting-ignored', message: `Setting "${key}" has no Formfeed equivalent and was dropped.`, docs: '/migrate/apitemplate-io#settings' });
  if (settings.header?.html || settings.footer?.html) changes.push('header and footer templates moved to the Header and Footer tabs');
  if (kind === 'image' && !settings.image) {
    settings.image = { width: 1200, height: 630, deviceScaleFactor: 2, format: format === 'PNG' ? 'png' : 'jpeg' };
    changes.push('image size defaults to 1200 × 630 (change it in Settings)');
  }

  const sample = parseSample(input.sample_data);
  if (sample.error) warnings.push({ code: 'sample-json', message: `Sample data is not valid JSON (${sample.error}); the draft starts without sample data.`, docs: '/migrate/apitemplate-io#sample-data' });

  const html = input.html ?? '';
  const css = input.css ?? '';
  for (const rule of pythonisms) {
    const m = rule.pattern.exec(html);
    if (m) warnings.push({ code: rule.code, message: rule.message, docs: rule.docs, ...positionOf(html, m.index) });
  }
  warnings.push(...setInLoop(html));

  const engine = getEngine('jinja2');
  try {
    engine.compile(html, { name });
  } catch (e) {
    const err = e as { message: string; line?: number; column?: number };
    errors.push({ code: 'syntax-error', message: err.message, line: err.line, column: err.column, docs: '/templates/languages#jinja2' });
  }
  const analysis = engine.analyze(html, { sampleData: sample.data });
  for (const d of analysis.diagnostics) {
    const note = fromDiagnostic(d);
    if (d.severity === 'error') {
      if (!errors.some((x) => x.code === note.code && x.line === note.line)) errors.push(note);
    } else warnings.push(note);
  }
  const aliasHits = analysis.filters.filter((f) => ['currency_format', 'table', 'page_break', 'raw', 'translate'].includes(f.name));
  if (aliasHits.length) changes.push(`apitemplate.io filters kept through aliases: ${[...new Set(aliasHits.map((f) => f.name))].join(', ')}`);

  return {
    name,
    slug: slugFromName(name),
    kind,
    engine: 'jinja2',
    html,
    css,
    head: '',
    settings,
    sampleData: sample.data,
    errors,
    warnings,
    changes,
  };
}
