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

const HIDDEN_WRAPPER = 'apitemplate-is-content-hidden';

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

  const noSample = input.sample_data === undefined || input.sample_data === null || (typeof input.sample_data === 'string' && !input.sample_data.trim());
  if (noSample) changes.push('no sample data: the preview stays empty and missing fields are not checked until you add some');
  const sample = parseSample(input.sample_data);
  if (sample.error) warnings.push({ code: 'sample-json', message: `Sample data is not valid JSON (${sample.error}); the draft starts without sample data.`, docs: '/migrate/apitemplate-io#sample-data' });

  const html = input.html ?? '';
  let css = input.css ?? '';
  // apitemplate.io's visual editor wraps each `{% for %}`/`{% endfor %}` in an element of this class
  // (table rows of empty cells, too) and hides it with its own stylesheet; without the rule every
  // loop iteration adds an empty row or block to the document
  if (html.includes(HIDDEN_WRAPPER)) {
    css = `.${HIDDEN_WRAPPER} { display: none !important; }\n${css}`;
    changes.push(`elements of the editor class "${HIDDEN_WRAPPER}" are hidden by a rule added to the CSS`);
  }
  for (const rule of pythonisms) {
    const m = rule.pattern.exec(html);
    if (m) warnings.push({ code: rule.code, message: rule.message, docs: rule.docs, ...positionOf(html, m.index) });
  }
  warnings.push(...setInLoop(html));

  // without sample data every variable would count as missing
  const checked = checkTemplate('jinja2', html, noSample ? undefined : sample.data, name, {
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

// --- apitemplate.io API v2 --------------------------------------------------------------------

/**
 * apitemplate.io's regional API hosts (their "Regional API endpoints"). The key works in the
 * region its account lives in; the importer only ever contacts these hosts.
 */
export const apitemplateRegions = {
  default: 'https://rest.apitemplate.io',
  de: 'https://rest-de.apitemplate.io',
  us: 'https://rest-us.apitemplate.io',
  au: 'https://rest-au.apitemplate.io',
  alt: 'https://rest-alt.apitemplate.io',
  'alt-de': 'https://rest-alt-de.apitemplate.io',
  'alt-us': 'https://rest-alt-us.apitemplate.io',
} as const;
export type ApitemplateRegion = keyof typeof apitemplateRegions;

export function isApitemplateRegion(value: unknown): value is ApitemplateRegion {
  return typeof value === 'string' && Object.hasOwn(apitemplateRegions, value);
}

/** One entry of `GET /v2/list-templates`. */
export interface ApitemplateListItem {
  template_id: string;
  name?: string | null;
  status?: string | null;
  /** `PDF` or `JPEG`. */
  format?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  group_name?: string | null;
}

/** `GET /v2/get-template` (experimental on their side): the HTML body, CSS and print settings. */
export interface ApitemplateApiTemplate {
  status?: string | null;
  template_id?: string | null;
  body?: string | null;
  css?: string | null;
  /** A JSON string in their API; an object is accepted too. */
  settings?: string | Record<string, unknown> | null;
}

/**
 * Only PDF templates carry HTML; apitemplate.io's image templates are layer designs that
 * `get-template` does not return.
 */
export function isApitemplateHtmlTemplate(item: Pick<ApitemplateListItem, 'format'>): boolean {
  return !item.format || String(item.format).toUpperCase() === 'PDF';
}

/**
 * Converts a template read through apitemplate.io's API. Their API has no sample data, so the
 * draft starts without; a template without a body (an image template, or an editor the API does
 * not serve) becomes a result with an error and no HTML, which callers skip.
 */
export function importApitemplateFromApi(item: ApitemplateListItem, template: ApitemplateApiTemplate): ImportResult {
  let settings: Record<string, unknown> | null = null;
  let settingsError: string | undefined;
  if (typeof template.settings === 'string' && template.settings.trim()) {
    try {
      const parsed: unknown = JSON.parse(template.settings);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch (e) {
      settingsError = e instanceof Error ? e.message : String(e);
    }
  } else if (template.settings && typeof template.settings === 'object') settings = template.settings;

  const name = (item.name ?? '').trim() || item.template_id;
  const html = typeof template.body === 'string' ? template.body : '';
  const result = importApitemplate({ name, html, css: template.css ?? '', settings, format: item.format });
  if (settingsError)
    result.warnings.unshift({
      code: 'settings-json',
      message: `apitemplate.io returned settings that are not valid JSON (${settingsError}); the draft uses the default paper and margins.`,
      docs: '/migrate/apitemplate-io#settings',
    });
  if (!html.trim())
    result.errors.unshift({
      code: 'no-body',
      message: `apitemplate.io returned no HTML for template ${item.template_id}. Copy it from their editor and import it by hand.`,
      docs: '/migrate/apitemplate-io#import-templates',
    });
  return result;
}
