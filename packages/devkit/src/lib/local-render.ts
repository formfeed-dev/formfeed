import {
  EngineSyntaxError,
  analyzeOffice,
  defaultHelpers,
  defaultLimits,
  flowDocument,
  getEngine,
  isOfficeKind,
  mergeSettings,
  officeTextParts,
  pagedDocument,
  renderOffice,
  renderVersion,
  type AssembleVendor,
  type BrandContext,
  type Diagnostic,
  type OfficeImageHost,
  type OfficeRenderResult,
  type RenderContext,
  type RenderedDocument,
  type TemplateKind,
} from '@formfeed/engine';
import { readBrand } from './brand';
import { DevkitError } from './errors';
import type { Project } from './project-config';
import { partialResolver, type LocalTemplate } from './project';

/**
 * A finding of `diagnose`. Word and PowerPoint findings name the part and paragraph instead of a line
 * (their `range` is 1:1), because a line of the extracted text means nothing in the document.
 */
export type LocalDiagnostic = Diagnostic & { part?: string; paragraph?: number };

/** The same diagnostics the editor shows: analysis of the body against the sample data plus compile errors. */
export function diagnose(tpl: LocalTemplate, sampleData: unknown): LocalDiagnostic[] {
  if (tpl.file) return diagnoseOffice(tpl, tpl.file.bytes, sampleData);
  const engine = getEngine(tpl.meta.engine);
  const diagnostics: Diagnostic[] = [];
  try {
    engine.compile(tpl.html, { name: tpl.slug });
  } catch (e) {
    if (e instanceof EngineSyntaxError) {
      diagnostics.push({
        severity: 'error',
        code: 'syntax-error',
        message: e.message,
        range: { start: { line: e.line ?? 1, column: e.column ?? 1 }, end: { line: e.line ?? 1, column: (e.column ?? 1) + 1 } },
      });
    } else throw e;
  }
  diagnostics.push(...engine.analyze(tpl.html, { sampleData }).diagnostics);
  for (const [part, source] of [
    ['header', tpl.settings.header?.html],
    ['footer', tpl.settings.footer?.html],
  ] as const) {
    if (!source) continue;
    for (const d of engine.analyze(source, { sampleData }).diagnostics) diagnostics.push({ ...d, message: `${part}: ${d.message}` });
  }
  // an include without a file fails at render time, locally and after `push`
  for (const name of tpl.missingPartials)
    diagnostics.push({
      severity: 'error',
      code: 'missing-partial',
      message: `No partial "${name}" in the project's partials folder`,
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    });
  return diagnostics;
}

const nowhere = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

/** What the office template page lists: tag, structure and engine findings per part and paragraph. */
function diagnoseOffice(tpl: LocalTemplate, file: Uint8Array, sampleData: unknown): LocalDiagnostic[] {
  let analysis;
  try {
    analysis = analyzeOffice(file, { engine: tpl.meta.engine, sampleData });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return [{ severity: 'error', code: typeof code === 'string' ? code : 'office-document-invalid', message: e instanceof Error ? e.message : String(e), range: nowhere }];
  }
  return analysis.diagnostics.map((d) => ({
    severity: d.severity,
    code: d.code,
    message: d.text ? `${d.message} (${d.text})` : d.message,
    range: nowhere,
    part: d.part,
    paragraph: d.paragraph,
  }));
}

export interface OfficeLocalOptions {
  locale?: string;
  /** Where `asset()` resolves; the workspace library's CDN base for a document that leaves the machine. */
  assetBaseUrl?: string;
  brand?: BrandContext;
  /** Loads and draws pictures and codes; without one, only PNG and JPEG data URLs are placed. */
  images?: OfficeImageHost;
  /** For snapshots: the source of the engine's placeholder nonce, so repeated runs fill alike. */
  random?: () => number;
}

/** Fills a Word or PowerPoint template with the shared engine, as the render-worker does. */
export async function renderOfficeLocal(project: Project, tpl: LocalTemplate, data: unknown, options: OfficeLocalOptions = {}): Promise<OfficeRenderResult> {
  if (!tpl.file) throw new DevkitError(`${tpl.slug} is not a Word or PowerPoint template`, 'validation');
  const context = renderContext(project, tpl, options.assetBaseUrl, options.brand);
  if (options.locale) context.locale = options.locale;
  return renderOffice(tpl.file.bytes, { engine: tpl.meta.engine, data, context, images: options.images, random: options.random });
}

/**
 * An HTML template's snapshot: the assembled document, then the rendered header and footer under
 * `<!-- formfeed:header -->` and `<!-- formfeed:footer -->` lines when the template has them.
 * Chromium prints header and footer from templates of their own, outside the document, so a
 * snapshot of the document alone passed a changed footer unnoticed.
 */
export function htmlSnapshot(rendered: Pick<RenderedDocument, 'document' | 'headerHtml' | 'footerHtml'>): string {
  let snapshot = rendered.document;
  if (rendered.headerHtml) snapshot += `\n<!-- formfeed:header -->\n${rendered.headerHtml}`;
  if (rendered.footerHtml) snapshot += `\n<!-- formfeed:footer -->\n${rendered.footerHtml}`;
  return snapshot;
}

/**
 * The filled parts of a Word or PowerPoint document as readable text for snapshots: each part's XML,
 * one element per line and indented, text kept beside its element, under a `--- <part> ---` line.
 */
export function officeSnapshot(filled: Uint8Array): string {
  return officeTextParts(filled)
    .map((part) => `--- ${part.name} ---\n${prettyXml(part.xml)}`)
    .join('\n');
}

/** Indents XML one element per line; text and the closing tag stay on the line of their element. */
export function prettyXml(xml: string): string {
  const lines: string[] = [];
  let depth = 0;
  let open = false; // the last line is an opening tag whose element is still open
  for (const token of xml.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      if (open && lines.length) lines[lines.length - 1] += token;
      else lines.push('  '.repeat(depth) + token);
      open = false;
    } else if (token.startsWith('<?') || token.startsWith('<!')) {
      lines.push('  '.repeat(depth) + token);
      open = false;
    } else if (token.startsWith('<')) {
      lines.push('  '.repeat(depth) + token);
      open = !token.endsWith('/>');
      if (open) depth++;
    } else if (token.trim() || open) {
      // text belongs to the element it stands in
      if (lines.length) lines[lines.length - 1] += token;
      else lines.push(token);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * `assetBaseUrl` is where `asset()` and relative image paths resolve: the dev server's `/files`
 * locally, the workspace library's CDN base when the document goes to the API. Without it the
 * references stay relative, which keeps snapshots independent of any host.
 */
export function renderContext(project: Project, tpl: LocalTemplate, assetBaseUrl?: string, brand?: BrandContext): RenderContext {
  const settings = mergeSettings(tpl.settings);
  return {
    locale: settings.locale ?? 'en',
    timezone: settings.timezone ?? 'UTC',
    currency: settings.currency ?? 'EUR',
    partials: partialResolver(project),
    helpers: defaultHelpers(),
    limits: defaultLimits,
    i18n: tpl.i18n ?? undefined,
    assetBaseUrl,
    // the organisation's kit from `formfeed brand pull`, else the empty kit the server uses too
    brand: brand ?? readBrand(project),
  };
}

export interface LocalRenderOptions {
  mode: 'preview' | 'print';
  locale?: string;
  vendor?: AssembleVendor;
  /** Where `asset()` and relative image paths resolve (see `renderContext`). */
  assetBaseUrl?: string;
  /** The template's `brand`; `.formfeed/brand.json` (`readBrand`) when left out. */
  brand?: BrandContext;
}

/** Assembles the complete document with the shared engine; no browser involved. */
export async function renderLocal(project: Project, tpl: LocalTemplate, data: unknown, options: LocalRenderOptions): Promise<RenderedDocument> {
  const kind = htmlKind(tpl);
  const ctx = renderContext(project, tpl, options.assetBaseUrl, options.brand);
  if (options.locale) ctx.locale = options.locale;
  return renderVersion(
    { engine: tpl.meta.engine, html: tpl.html, css: tpl.css, head: tpl.head, settings: mergeSettings(tpl.settings), kind },
    data,
    ctx,
    options.mode,
    options.vendor ? { vendor: options.vendor } : {},
  );
}

/**
 * The settings to send with a locally rendered document as a raw-HTML render. The API uses
 * `header.html`, `footer.html` and the PDF title of such a render verbatim, so they must be the
 * filled parts, not the template's source; the inline CSS travels with them, because Chromium loads
 * no stylesheet in its header and footer templates.
 */
export function renderedSettings(rendered: RenderedDocument): Record<string, unknown> {
  const style = rendered.inlineCss ? `<style>${rendered.inlineCss}</style>` : '';
  const part = (settings: { html?: string } | undefined, html: string | undefined) =>
    settings?.html ? { ...settings, html: `${style}${html ?? ''}` } : settings;
  const { settings } = rendered;
  return {
    ...settings,
    ...(settings.header ? { header: part(settings.header, rendered.headerHtml) } : {}),
    ...(settings.footer ? { footer: part(settings.footer, rendered.footerHtml) } : {}),
    ...(settings.pdf?.metadata?.title !== undefined
      ? { pdf: { ...settings.pdf, metadata: { ...settings.pdf.metadata, title: rendered.title ?? '' } } }
      : {}),
  };
}

/** The kind of an HTML template; Word and PowerPoint templates go through `renderOfficeLocal`. */
function htmlKind(tpl: LocalTemplate): TemplateKind {
  if (isOfficeKind(tpl.meta.kind)) throw new DevkitError(`${tpl.slug} is a ${tpl.meta.kind} template; fill it with renderOfficeLocal`, 'validation');
  return tpl.meta.kind;
}

/** Wraps a preview render for the screen the way the editor does. */
export function previewDocument(tpl: LocalTemplate, rendered: RenderedDocument, mode: 'flow' | 'paged', pagedScriptUrl: string): string {
  const kind = htmlKind(tpl);
  const draft = {
    document: rendered.document,
    headerHtml: rendered.headerHtml,
    footerHtml: rendered.footerHtml,
    settings: rendered.settings,
    kind,
  };
  return mode === 'paged' && kind === 'pdf' ? pagedDocument(draft, { pagedScriptUrl }) : flowDocument(draft);
}
