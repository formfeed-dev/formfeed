import { mapApitemplateSettings } from '@formfeed/api-types';
import type { TemplateSettings } from '../assemble';
import { checkTemplate, parseSample, positionOf, slugFromName, type ImportNote, type ImportResult } from './common';

export { slugFromName } from './common';
export type { ImportNote, ImportResult } from './common';

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

export function importApitemplate(input: ApitemplateExport): ImportResult {
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

  const checked = checkTemplate('jinja2', html, sample.data, name, {
    syntax: '/templates/languages#jinja2',
    filters: '/templates/helpers',
    sampleData: '/migrate/apitemplate-io#sample-data',
  });
  warnings.push(...checked.warnings);
  const aliasHits = /\|\s*(currency_format|table|page_break|raw|translate)\b/g;
  const aliases = [...new Set([...html.matchAll(aliasHits)].map((m) => m[1]))];
  if (aliases.length) changes.push(`apitemplate.io filters kept through aliases: ${aliases.join(', ')}`);

  return {
    source: 'apitemplate',
    name,
    slug: slugFromName(name),
    kind,
    engine: 'jinja2',
    html,
    css,
    head: '',
    settings,
    sampleData: sample.data,
    errors: checked.errors,
    warnings,
    changes,
  };
}
