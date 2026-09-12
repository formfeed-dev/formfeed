import type { TemplateSettings } from '../assemble';
import {
  checkTemplate,
  lengthMm,
  mimeOf,
  notesFor,
  parseSample,
  slugFromName,
  toBase64,
  type ImportNote,
  type ImportResult,
} from './common';

/**
 * jsreport importer (spec 10 §4). jsreport is the open-source report server many teams run
 * themselves; its export (`.jsrexport`, a zip with one JSON file per entity) carries templates,
 * sample data, assets, components and scripts. Templates with the Handlebars engine and the
 * chrome-pdf or chrome-image recipe map almost one to one onto Formfeed: the header and footer are
 * Chromium header templates in both, and the chrome options are Formfeed's settings.
 *
 * - `{{asset}}` calls are resolved from the export: small files become data URIs or inline text.
 *   A larger one keeps its `{{asset}}` call and a warning: the helper resolves against the
 *   workspace file library, so the file has to be uploaded there under the same name.
 * - Child templates and components are inlined (stored partials do not take part in API renders).
 * - Custom helpers are JavaScript, which Formfeed does not run: each one is reported, and the
 *   engine's analysis marks every call to it.
 * - jsrender, EJS and Pug templates, scripts, pdf-utils operations and non-PDF recipes are reported.
 *
 * The caller unzips the export (`readJsreportExport` takes the file map), so the engine stays free
 * of a zip library.
 */
export interface JsreportEntity {
  _id?: string;
  shortid?: string;
  name?: string;
  folder?: { shortid?: string } | null;
  [key: string]: unknown;
}

export interface JsreportTemplate extends JsreportEntity {
  content?: string;
  engine?: string;
  recipe?: string;
  helpers?: string;
  chrome?: Record<string, unknown> | null;
  chromeImage?: Record<string, unknown> | null;
  data?: { shortid?: string } | null;
  scripts?: Array<{ shortid?: string }> | null;
  pdfOperations?: unknown[] | null;
  pdfMeta?: Record<string, unknown> | null;
  pdfPassword?: Record<string, unknown> | null;
  localization?: { language?: string } | null;
}

export interface JsreportBundle {
  templates: JsreportTemplate[];
  data: Array<JsreportEntity & { dataJson?: string }>;
  assets: Array<JsreportEntity & { content?: unknown; link?: string; isSharedHelper?: boolean }>;
  components: Array<JsreportEntity & { content?: string; helpers?: string; engine?: string }>;
  scripts: Array<JsreportEntity & { content?: string }>;
  folders: JsreportEntity[];
  /** jsreport version from metadata.json. */
  version?: string;
}

export interface JsreportImportOptions {
  /** Assets up to this size are inlined as data URIs (default 256 KB); larger ones become `{{asset}}`. */
  inlineAssetBytes?: number;
}

const DOCS = '/migrate/jsreport';
const COLLECTIONS = ['templates', 'data', 'assets', 'components', 'scripts', 'folders'] as const;

/**
 * The entities of an unzipped `.jsrexport`: file path → file text. Entity files are
 * `<collection>/<name>-<id>.json`; everything else (metadata, versions, settings) is ignored.
 */
export function readJsreportExport(files: Record<string, string>): JsreportBundle {
  const bundle: JsreportBundle = { templates: [], data: [], assets: [], components: [], scripts: [], folders: [] };
  for (const [path, text] of Object.entries(files)) {
    const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (normalized === 'metadata.json') {
      try {
        bundle.version = String((JSON.parse(text) as { reporterVersion?: string }).reporterVersion ?? '');
      } catch {
        // an unreadable metadata file does not stop the import
      }
      continue;
    }
    const collection = normalized.split('/')[0] as (typeof COLLECTIONS)[number];
    if (!COLLECTIONS.includes(collection) || !normalized.endsWith('.json')) continue;
    try {
      (bundle[collection] as JsreportEntity[]).push(JSON.parse(text) as JsreportEntity);
    } catch {
      // not an entity file
    }
  }
  if (!bundle.templates.length) throw new Error('No templates found: this does not look like a jsreport export (.jsrexport).');
  return bundle;
}

function folderPath(bundle: JsreportBundle, entity: JsreportEntity): string {
  const parts: string[] = [];
  let shortid = entity.folder?.shortid;
  for (let guard = 0; shortid && guard < 20; guard++) {
    const folder = bundle.folders.find((f) => f.shortid === shortid);
    if (!folder) break;
    parts.unshift(folder.name ?? '');
    shortid = folder.folder?.shortid;
  }
  return parts.filter(Boolean).join('/');
}

function pathOf(bundle: JsreportBundle, entity: JsreportEntity): string {
  const folder = folderPath(bundle, entity);
  return folder ? `${folder}/${entity.name ?? ''}` : (entity.name ?? '');
}

/** The templates of an export for a picker: name, folder path, engine and recipe. */
export function jsreportTemplates(bundle: JsreportBundle): Array<{ ref: string; name: string; path: string; engine: string; recipe: string }> {
  return bundle.templates
    .map((t) => ({ ref: t.shortid ?? t._id ?? t.name ?? '', name: t.name ?? '', path: pathOf(bundle, t), engine: t.engine ?? '', recipe: t.recipe ?? '' }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Finds an entity by path (`folder/name`, with or without a leading `/` or `./`) or by bare name. */
function byPath<T extends JsreportEntity>(bundle: JsreportBundle, list: T[], ref: string): T | undefined {
  const wanted = ref.replace(/^\.?\/+/, '');
  return list.find((e) => pathOf(bundle, e) === wanted) ?? list.find((e) => e.name === wanted.split('/').pop());
}

function decodeText(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Asset content as base64; a string that is not base64 is plain text (fs-store keeps files as they are). */
function assetBase64(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const compact = content.replace(/\s/g, '');
    if (compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return compact;
    return toBase64(new TextEncoder().encode(content));
  }
  return toBase64(content);
}

/** Handlebars would evaluate `{{` in inlined text; `\{{` prints it literally. */
const escapeMustaches = (text: string) => text.replace(/\{\{/g, '\\{{');

function resolveAssets(
  source: string,
  bundle: JsreportBundle,
  options: Required<JsreportImportOptions>,
  warnings: ImportNote[],
  changes: Set<string>,
): string {
  // jsreport 3 `{{asset "name" "encoding"}}` (also triple-stash) and jsreport 2 `{#asset name @encoding=x}`
  const v3 = /\{\{\{?\s*asset\s+(["'])([^"']+)\1(?:\s+(["'])([^"']+)\3)?\s*\}?\}\}/g;
  const v2 = /\{#asset\s+([^\s}]+)(?:\s+@encoding=(\w+))?\s*\}/g;
  const replace = (whole: string, ref: string, encoding = 'utf8'): string => {
    const asset = byPath(bundle, bundle.assets, ref);
    if (!asset) {
      warnings.push({ code: 'asset-missing', message: `The asset "${ref}" is not in the export. Upload it to the workspace file library under that name, or replace the call with a full https URL.`, docs: `${DOCS}#assets` });
      return `{{asset "${ref}"}}`;
    }
    if (encoding === 'link' || (!asset.content && asset.link)) {
      if (asset.link && /^https?:\/\//.test(asset.link)) return asset.link;
      warnings.push({ code: 'asset-link', message: `The asset "${ref}" is linked from the jsreport server, which this import cannot read. Upload the file to the workspace file library under that name, or replace the call with a full https URL.`, docs: `${DOCS}#assets` });
      return `{{asset "${asset.name}"}}`;
    }
    const base64 = assetBase64(asset.content);
    if (base64 === undefined) return whole;
    const bytes = Math.floor((base64.length * 3) / 4);
    if (encoding === 'utf8' || encoding === 'string') {
      changes.add('text assets (CSS, scripts, snippets) inlined');
      return escapeMustaches(decodeText(base64));
    }
    if (bytes > options.inlineAssetBytes) {
      warnings.push({
        code: 'asset-large',
        message: `The asset "${asset.name}" (${Math.round(bytes / 1024)} KB) is larger than the inline limit. Upload it to the workspace file library under that name, import with a higher inline limit, or replace the call with a full https URL.`,
        docs: `${DOCS}#assets`,
      });
      return `{{asset "${asset.name}"}}`;
    }
    changes.add('binary assets (images, fonts) inlined as data URIs');
    return encoding === 'base64' ? base64 : `data:${mimeOf(asset.name ?? '')};base64,${base64}`;
  };
  return source
    .replace(v3, (whole, _q: string, ref: string, _q2?: string, encoding?: string) => replace(whole, ref, encoding))
    .replace(v2, (whole, ref: string, encoding?: string) => replace(whole, ref, encoding));
}

function inlineChildren(
  source: string,
  bundle: JsreportBundle,
  errors: ImportNote[],
  warnings: ImportNote[],
  changes: Set<string>,
): string {
  let out = source;
  for (let depth = 0; depth < 6; depth++) {
    const before = out;
    // `{{childTemplate "name"}}` and jsreport 2 `{#child name}`
    out = out.replace(/\{\{\{?\s*childTemplate\s+(["'])([^"']+)\1[^}]*\}?\}\}|\{#child\s+([^\s}]+)[^}]*\}/g, (whole, _q?: string, v3?: string, v2?: string) => {
      const ref = v3 ?? v2 ?? '';
      const child = byPath(bundle, bundle.templates, ref);
      if (!child?.content) {
        errors.push({ code: 'child-missing', message: `The child template "${ref}" is not in the export.`, docs: `${DOCS}#child-templates` });
        return whole;
      }
      changes.add('child templates inlined');
      return child.content;
    });
    // `{{component "./name" prop=value}}`
    out = out.replace(/\{\{\{?\s*component\s+(["'])([^"']+)\1([^}]*)\}?\}\}/g, (whole, _q: string, ref: string, props: string) => {
      const component = byPath(bundle, bundle.components, ref);
      if (!component?.content) {
        errors.push({ code: 'component-missing', message: `The component "${ref}" is not in the export.`, docs: `${DOCS}#components` });
        return whole;
      }
      if (props.trim())
        warnings.push({
          code: 'component-props',
          message: `The component "${ref}" received properties (${props.trim()}); it was inlined with the surrounding data, so reference those values directly.`,
          docs: `${DOCS}#components`,
        });
      if (component.helpers?.trim())
        warnings.push({ code: 'custom-helpers', message: `The component "${ref}" has JavaScript helpers, which Formfeed does not run.`, docs: `${DOCS}#helpers` });
      changes.add('components inlined');
      return component.content;
    });
    if (out === before) break;
  }
  return out;
}

/** Names of the functions a jsreport helpers script defines. */
export function helperNames(script: string): string[] {
  const names = new Set<string>();
  for (const m of script.matchAll(/(?:^|[\s;])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1] ?? '');
  for (const m of script.matchAll(/(?:^|[\s;])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) names.add(m[1] ?? '');
  names.delete('');
  return [...names];
}

function mapChrome(
  template: JsreportTemplate,
  kind: 'pdf' | 'image',
  warnings: ImportNote[],
  changes: Set<string>,
): TemplateSettings {
  const settings: TemplateSettings = {};
  const chrome = template.chrome ?? {};
  const str = (key: string) => (typeof chrome[key] === 'string' && (chrome[key] as string).trim() ? (chrome[key] as string).trim() : undefined);
  const paper: NonNullable<TemplateSettings['paper']> = {};
  const format = str('format');
  if (format) paper.format = format.charAt(0).toUpperCase() + format.slice(1).toLowerCase();
  const width = lengthMm(str('width'));
  const height = lengthMm(str('height'));
  if (width && height) {
    paper.width = width;
    paper.height = height;
  }
  if (chrome['landscape'] === true || chrome['landscape'] === 'true') paper.landscape = true;
  if (Object.keys(paper).length) settings.paper = paper;

  const margin: NonNullable<TemplateSettings['margin']> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const value = lengthMm(str(`margin${side[0]?.toUpperCase()}${side.slice(1)}`));
    if (value) margin[side] = value;
  }
  if (Object.keys(margin).length) settings.margin = margin;

  const showHeaderFooter = chrome['displayHeaderFooter'] === true || chrome['displayHeaderFooter'] === 'true';
  if (showHeaderFooter) {
    const header = str('headerTemplate');
    const footer = str('footerTemplate');
    if (header) settings.header = { html: header };
    if (footer) settings.footer = { html: footer };
    if (header || footer) changes.add('Chromium header and footer templates moved to the Header and Footer tabs');
  }
  if (chrome['printBackground'] !== undefined) settings.printBackground = chrome['printBackground'] === true || chrome['printBackground'] === 'true';
  if (chrome['scale'] !== undefined && Number.isFinite(Number(chrome['scale']))) settings.scale = Number(chrome['scale']);
  const ranges = str('pageRanges');
  if (ranges) settings.pageRanges = ranges;
  if (chrome['waitForNetworkIdle'] === true || chrome['waitForNetworkIdle'] === 'true') settings.waitFor = { networkIdle: true };
  if (chrome['waitForJS'] === true || chrome['waitForJS'] === 'true')
    warnings.push({
      code: 'wait-for-js',
      message: 'The template sets window.JSREPORT_READY_TO_START; Formfeed waits for a CSS selector instead (Settings → Wait for).',
      docs: `${DOCS}#settings`,
    });
  if (str('mediaType') === 'screen') warnings.push({ code: 'setting-ignored', message: 'mediaType "screen" is not supported; Formfeed prints with the print media type.', docs: `${DOCS}#settings` });

  if (kind === 'image') {
    const img = template.chromeImage ?? {};
    const type = String(img['type'] ?? 'png').toLowerCase();
    settings.image = {
      width: Number(img['viewportWidth'] ?? 0) || 1200,
      height: Number(img['viewportHeight'] ?? 0) || 630,
      format: type === 'jpeg' || type === 'jpg' ? 'jpeg' : 'png',
      ...(Number.isFinite(Number(img['quality'])) && img['quality'] !== undefined ? { quality: Number(img['quality']) } : {}),
      ...(img['fullPage'] === true ? { fullPage: true } : {}),
      ...(img['omitBackground'] === true ? { transparent: true } : {}),
    };
    changes.add('chrome-image options mapped to the image settings');
  }

  const meta = template.pdfMeta ?? {};
  const metadata = Object.fromEntries(
    (['title', 'author', 'subject', 'keywords'] as const).filter((k) => typeof meta[k] === 'string' && meta[k]).map((k) => [k, String(meta[k])]),
  );
  if (Object.keys(metadata).length) {
    settings.pdf = { metadata };
    changes.add('PDF metadata (pdfMeta) mapped');
  }
  changes.add('chrome-pdf options mapped: paper, orientation, margins, background, scale, page ranges');
  return settings;
}

export function importJsreport(bundle: JsreportBundle, ref: string, options: JsreportImportOptions = {}): ImportResult {
  const opts: Required<JsreportImportOptions> = { inlineAssetBytes: options.inlineAssetBytes ?? 256 * 1024 };
  const template = bundle.templates.find((t) => t.shortid === ref || t._id === ref) ?? byPath(bundle, bundle.templates, ref);
  if (!template) throw new Error(`No template "${ref}" in the export.`);
  const errors: ImportNote[] = [];
  const warnings: ImportNote[] = [];
  const changes = new Set<string>();
  const name = (template.name ?? '').trim() || 'Imported template';

  const engine = String(template.engine ?? 'handlebars').toLowerCase();
  if (engine !== 'handlebars' && engine !== 'none')
    errors.push({
      code: 'unsupported-engine',
      message: `The template uses the ${engine} engine; Formfeed runs Handlebars, Liquid and Jinja2. It was imported as Handlebars and needs rewriting.`,
      docs: `${DOCS}#engines`,
    });
  if (engine === 'none') changes.add('template without an engine imported as Handlebars');

  const recipe = String(template.recipe ?? 'chrome-pdf').toLowerCase();
  const kind: 'pdf' | 'image' = recipe === 'chrome-image' ? 'image' : 'pdf';
  if (!['chrome-pdf', 'chrome-image', 'html'].includes(recipe))
    errors.push({
      code: 'unsupported-recipe',
      message: `The ${recipe} recipe has no Formfeed equivalent; the template was imported as a PDF template.`,
      docs: `${DOCS}#recipes`,
    });
  if (recipe === 'html') changes.add('html recipe imported as a PDF template');

  const settings = mapChrome(template, kind, warnings, changes);

  let html = inlineChildren(template.content ?? '', bundle, errors, warnings, changes);
  html = resolveAssets(html, bundle, opts, warnings, changes);
  for (const key of ['header', 'footer'] as const) {
    const part = settings[key]?.html;
    if (part) settings[key] = { html: resolveAssets(inlineChildren(part, bundle, errors, warnings, changes), bundle, opts, warnings, changes) };
  }
  // `{{toJS value}}` writes a value into a script; `json` does the same
  html = html.replace(/\{\{\{?\s*toJS\s+([^}]+?)\s*\}?\}\}/g, (_m, value: string) => {
    changes.add('`toJS` replaced by `json`');
    return `{{{json ${value}}}}`;
  });

  const helperSources = [
    template.helpers ?? '',
    ...bundle.assets.filter((a) => a.isSharedHelper).map((a) => {
      const b64 = assetBase64(a.content);
      return b64 ? decodeText(b64) : '';
    }),
  ].filter((s) => s.trim());
  const helpers = helperSources.flatMap(helperNames);
  if (helpers.length)
    warnings.push({
      code: 'custom-helpers',
      message: `The template defines JavaScript helpers (${helpers.join(', ')}); Formfeed does not run custom code. Replace each call with a built-in helper, or compute the value before sending the data.`,
      docs: `${DOCS}#helpers`,
    });
  warnings.push(
    ...notesFor(html, /\{\{\{?\s*(pdfAddPageItem|pdfCreatePagesGroup|pdfFormField|module)\b/, {
      code: 'jsreport-helper',
      message: 'A jsreport system helper (pdf-utils or module) has no Formfeed equivalent.',
      docs: `${DOCS}#helpers`,
    }),
  );
  if (template.scripts?.length)
    warnings.push({ code: 'scripts', message: 'The template runs jsreport scripts (beforeRender/afterRender); load that data in your application and send it with the render request.', docs: `${DOCS}#scripts` });
  if (template.pdfOperations?.length)
    warnings.push({ code: 'pdf-operations', message: 'pdf-utils operations (merge, append, headers from another template) are not imported.', docs: `${DOCS}#pdf-utils` });
  if (template.pdfPassword && Object.values(template.pdfPassword).some(Boolean))
    warnings.push({ code: 'pdf-password', message: 'PDF password protection is not imported.', docs: `${DOCS}#settings` });
  if (template.localization?.language)
    warnings.push({ code: 'localization', message: 'jsreport localization files are not imported; use the template dictionaries and the `t` helper.', docs: '/templates/helpers#t' });

  const dataEntity = template.data?.shortid ? bundle.data.find((d) => d.shortid === template.data?.shortid) : undefined;
  const sample = parseSample(dataEntity?.dataJson);
  if (sample.error) warnings.push({ code: 'sample-json', message: `The sample data is not valid JSON (${sample.error}).`, docs: `${DOCS}#sample-data` });
  if (dataEntity) changes.add(`sample data "${dataEntity.name}" became the default data set`);

  if (new TextEncoder().encode(html).length > 1_000_000)
    errors.push({ code: 'too-large', message: 'The template is larger than 1 MB after inlining its assets; upload the large files as workspace assets and reference them with {{asset "name"}}.', docs: `${DOCS}#assets` });

  const checked = checkTemplate('handlebars', html, sample.data, name, {
    syntax: '/templates/languages#handlebars',
    filters: `${DOCS}#helpers`,
    sampleData: `${DOCS}#sample-data`,
  });
  errors.push(...checked.errors);
  warnings.push(...checked.warnings);

  return {
    source: 'jsreport',
    name,
    slug: slugFromName(name),
    kind,
    engine: 'handlebars',
    html,
    css: '',
    head: '',
    settings,
    sampleData: sample.data,
    errors,
    warnings,
    changes: [...changes],
  };
}
