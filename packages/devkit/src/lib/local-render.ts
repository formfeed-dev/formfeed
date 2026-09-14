import {
  EngineSyntaxError,
  defaultHelpers,
  defaultLimits,
  flowDocument,
  getEngine,
  mergeSettings,
  pagedDocument,
  renderVersion,
  type AssembleVendor,
  type BrandContext,
  type Diagnostic,
  type RenderContext,
  type RenderedDocument,
} from '@formfeed/engine';
import { readBrand } from './brand';
import type { Project } from './project-config';
import { partialResolver, type LocalTemplate } from './project';

/** The same diagnostics the editor shows: analysis of the body against the sample data plus compile errors. */
export function diagnose(tpl: LocalTemplate, sampleData: unknown): Diagnostic[] {
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
  const ctx = renderContext(project, tpl, options.assetBaseUrl, options.brand);
  if (options.locale) ctx.locale = options.locale;
  return renderVersion(
    { engine: tpl.meta.engine, html: tpl.html, css: tpl.css, head: tpl.head, settings: mergeSettings(tpl.settings), kind: tpl.meta.kind },
    data,
    ctx,
    options.mode,
    options.vendor ? { vendor: options.vendor } : {},
  );
}

/** Wraps a preview render for the screen the way the editor does. */
export function previewDocument(tpl: LocalTemplate, rendered: RenderedDocument, mode: 'flow' | 'paged', pagedScriptUrl: string): string {
  const draft = {
    document: rendered.document,
    headerHtml: rendered.headerHtml,
    footerHtml: rendered.footerHtml,
    settings: rendered.settings,
    kind: tpl.meta.kind,
  };
  return mode === 'paged' && tpl.meta.kind === 'pdf' ? pagedDocument(draft, { pagedScriptUrl }) : flowDocument(draft);
}
