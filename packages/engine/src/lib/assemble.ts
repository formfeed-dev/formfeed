import type { UaSetting } from './accessibility';
import type { PdfaSetting } from './pdfa';
import { brandCss, brandFontFamilies } from './brand';
import type { BrandContext } from './brand';
import type { EinvoiceOptionsInput } from './einvoice/schema';
import type { MarkdownSettings } from './markdown/settings';
import { getEngine } from './engines';
import { diagramsRuntime, fitRuntime } from './generated/frames';
import { escapeHtml } from './helpers';
import type { EngineId, RenderContext } from './types';

/** Template settings (spec 01 §3); every field optional, `defaultSettings()` fills the rest. */
export interface HeaderFooterSettings {
  html?: string;
  height?: string;
  padding?: string;
}

/** The side padding Formfeed gives header and footer unless the template sets its own. */
export const DEFAULT_CHROME_PADDING = '0 10mm';

export interface TemplateSettings {
  paper?: {
    format?: string;
    width?: string | null;
    height?: string | null;
    unit?: 'mm' | 'in' | 'px';
    landscape?: boolean;
  };
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /**
   * Header and footer span the full page width, as Chromium prints them; `padding` is the space
   * inside that box (CSS shorthand, default `0 10mm`, `0` for designs that run edge to edge).
   */
  header?: HeaderFooterSettings | null;
  footer?: HeaderFooterSettings | null;
  printBackground?: boolean;
  scale?: number;
  preferCssPageSize?: boolean;
  pageRanges?: string;
  waitFor?: {
    /**
     * `true` waits until the network has been idle for half a second, `false` only for the `load`
     * event. `'auto'`, the default, waits for `load` and then for the requests still in flight, and as
     * `true` does for a URL source or a document with code of its own (the render-worker's
     * `render/load-wait.ts`).
     */
    networkIdle?: boolean | 'auto';
    selector?: string | null;
    /**
     * A JavaScript expression or function (plan 32) that the render-worker evaluates in the page
     * until its value is truthy: a function is called, a promise counts by what it resolves to, and
     * an error counts as not yet. It shares `timeoutMs` with `selector`.
     */
    function?: string | null;
    /** How long `selector` and `function` may take together, in milliseconds. */
    timeoutMs?: number;
    delayMs?: number;
  };
  pdf?: {
    tagged?: boolean;
    outline?: boolean;
    /**
     * PDF/UA-1 (plan 21 §7): the render is checked against the machine-checkable rules of the
     * standard and calls itself PDF/UA-1 only when it passed. `true` is `{ check: 'strict' }`, which
     * fails a render whose file does not pass; `report` delivers it without the identifier. It
     * implies `tagged`. Read it through `resolveUa`.
     */
    ua?: UaSetting;
    /**
     * PDF/A (plan 26): the finished PDF is converted to PDF/A-2b or PDF/A-3b and held to it by the
     * validator; a file that fails fails the render, there is no mode that delivers it. `true` is
     * `'3b'`. An e-invoice is a PDF/A-3b already, so `'2b'` beside one is refused. Read it through
     * `resolvePdfa`.
     */
    pdfa?: PdfaSetting;
    metadata?: {
      title?: string;
      author?: string;
      subject?: string;
      keywords?: string;
    };
  };
  image?: {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    fullPage?: boolean;
    transparent?: boolean;
    clipSelector?: string | null;
  };
  /** Office templates (spec 22 §4.1): the output when a request names none. */
  office?: { output?: 'docx' | 'pptx' | 'pdf' };
  locale?: string;
  timezone?: string;
  currency?: string;
  tailwind?: boolean;
  watermark?: { text?: string; opacity?: number } | null;
  /**
   * The template is an invoice template (spec 17 §4.1): every PDF rendered from it carries the
   * e-invoice built from the `_invoice` block of the data. A request's `settings.einvoice` and
   * `post.einvoice` merge over this field by field (`resolveEinvoiceOptions`); `false` there
   * switches it off for one request.
   */
  einvoice?: EinvoiceOptionsInput | false | null;
  /**
   * A Markdown source (plan 29): its theme, what raw HTML becomes, line breaks and a stylesheet of
   * its own. Read it through `resolveMarkdown`; a stored template's is ignored.
   */
  markdown?: MarkdownSettings | null;
  /**
   * The visual editor's document (plan 16 §4.1, `DesignDocument` once `parseDesign` accepted it). It
   * is authoring data: nothing renders it, the version's HTML and CSS are what it emitted.
   */
  design?: unknown;
}

export type TemplateKind = 'pdf' | 'image';

export function defaultSettings(): Required<
  Pick<
    TemplateSettings,
    | 'paper'
    | 'margin'
    | 'printBackground'
    | 'scale'
    | 'preferCssPageSize'
    | 'locale'
    | 'timezone'
    | 'currency'
  >
> &
  TemplateSettings {
  return {
    paper: {
      format: 'A4',
      width: null,
      height: null,
      unit: 'mm',
      landscape: false,
    },
    margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    header: null,
    footer: null,
    printBackground: true,
    scale: 1,
    preferCssPageSize: false,
    pageRanges: '',
    waitFor: {
      networkIdle: 'auto',
      selector: null,
      function: null,
      timeoutMs: 5000,
      delayMs: 0,
    },
    pdf: { tagged: false, outline: false, metadata: { title: '', author: '' } },
    image: {
      width: 1200,
      height: 630,
      deviceScaleFactor: 2,
      format: 'png',
      quality: 90,
      fullPage: false,
      transparent: false,
      clipSelector: null,
    },
    locale: 'en-GB',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    tailwind: false,
    watermark: null,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge where `override` wins; `null` removes a section (e.g. `header: null`). */
export function mergeSettings(
  ...layers: Array<TemplateSettings | null | undefined>
): TemplateSettings {
  const out: Record<string, unknown> = {};
  const apply = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ) => {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && isPlainObject(target[key]))
        apply(target[key] as Record<string, unknown>, value);
      else if (isPlainObject(value)) target[key] = apply({}, value);
      else target[key] = value;
    }
    return target;
  };
  for (const layer of [defaultSettings(), ...layers])
    if (layer) apply(out, layer as Record<string, unknown>);
  return out as TemplateSettings;
}

/** `@page` size expression from the paper settings. */
export function pageSize(settings: TemplateSettings): string {
  const paper = settings.paper ?? {};
  if (paper.width && paper.height) return `${paper.width} ${paper.height}`;
  return `${paper.format ?? 'A4'}${paper.landscape ? ' landscape' : ''}`;
}

/**
 * The header and footer boxes of the previews (`preview.ts`). Chromium renders header and footer
 * templates in a page of their own that gets none of the reset, so the reset leaves them alone: a
 * header table's `padding` was ignored under `border-collapse: collapse` and its logo moved left.
 */
const outsideChrome =
  ':not(.ff-running-header *, .ff-running-footer *, .formfeed-chrome *)';

/**
 * Default print reset of spec 05 §5. Its element rules sit in `:where()`, so any rule of the template
 * wins over them, as it did when the template's styles simply came later.
 */
export function printReset(
  settings: TemplateSettings,
  kind: TemplateKind = 'pdf',
): string {
  const m = settings.margin ?? {};
  const page =
    kind === 'pdf'
      ? `@page { size: ${pageSize(settings)}; margin: ${m.top ?? '0'} ${m.right ?? '0'} ${m.bottom ?? '0'} ${m.left ?? '0'}; }\n`
      : '';
  return `${page}html, body { margin: 0; padding: 0; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:where(img, svg):where(${outsideChrome}) { max-width: 100%; }
.page-break, .new-page { break-after: page; }
.avoid-break { break-inside: avoid; }
:where(table):where(${outsideChrome}) { break-inside: auto; border-collapse: collapse; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
${kind === 'image' ? `html, body { width: ${settings.image?.width ?? 1200}px; min-height: ${settings.image?.height ?? 630}px; overflow: hidden; }\n` : ''}`;
}

/** An organisation font (spec 05 §6) reachable by URL from the preview frame or the worker. */
export interface FontFace {
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  format?: 'woff2' | 'woff' | 'ttf' | 'otf';
  url: string;
}

/** Browser-side vendor scripts the assembler wires in when the document needs them. */
export interface AssembleVendor {
  /** Chart.js UMD build: a URL the frame can load, or the source to inline (render-worker). */
  chartJs?: { src: string } | { inline: string };
  /** `@tailwindcss/browser` for the preview; the worker compiles Tailwind ahead and passes `extraCss`. */
  tailwind?: { src: string };
  /**
   * KaTeX's stylesheet for a Markdown document's formulas (plan 33, decision 11), with its fonts at
   * addresses the host serves: added before the theme where the document holds a formula.
   */
  katex?: { css: string };
  /**
   * Mermaid's browser build for a Markdown document's diagrams (plan 33, decisions 10 and 11), at an
   * address the host serves: added with the runner that draws them where the document holds one.
   */
  mermaid?: { src: string };
}

/**
 * A diagram's figure in either theme: on a line of its own, centred, on one page where it fits. The
 * print reset holds the picture to the page's width.
 */
const DIAGRAM_CSS =
  '.ff-diagram { margin: 1em 0; text-align: center; break-inside: avoid; }';

/**
 * Mermaid in the head and the runner at the end of the body (`frame/diagrams.ts`), where the HTML
 * holds a diagram's source and the host serves Mermaid. Both carry `data-formfeed`, so the
 * render-worker waits no longer for a document whose only scripts are these.
 */
function diagramParts(
  html: string,
  vendor: AssembleVendor | undefined,
): { style: string; head: string; body: string } {
  if (!vendor?.mermaid || !html.includes('data-ff-mermaid'))
    return { style: '', head: '', body: '' };
  return {
    // before the theme and the document's own CSS, which may restyle a figure
    style: `<style data-formfeed="diagrams">${DIAGRAM_CSS}</style>\n`,
    head: `<script data-formfeed="mermaid" src="${escapeHtml(vendor.mermaid.src)}"></script>
`,
    body: `<script data-formfeed="diagrams">${diagramsRuntime.replace(/<\/script/gi, '<\\/script')}</script>
`,
  };
}

/** Optional inputs that vary per host (preview frame vs. worker) rather than per template. */
export interface AssembleExtras {
  fonts?: FontFace[];
  vendor?: AssembleVendor;
  /** Stylesheet appended after the template CSS (compiled Tailwind in the worker). */
  extraCss?: string;
}

const fontFormats: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/**
 * `@font-face` rules for the organisation fonts a template refers to (spec 05 §6): a font is
 * injected when its family name appears anywhere in the template's CSS, head or HTML.
 */
export function fontFaceCss(
  fonts: FontFace[] | undefined,
  referencedIn: string,
): string {
  if (!fonts?.length) return '';
  const haystack = referencedIn.toLowerCase();
  return fonts
    .filter((f) => haystack.includes(f.family.toLowerCase()))
    .map((f) => {
      const format = fontFormats[f.format ?? 'woff2'] ?? f.format ?? 'woff2';
      return `@font-face { font-family: "${f.family.replace(/"/g, '')}"; font-weight: ${f.weight ?? 400}; font-style: ${f.style ?? 'normal'}; font-display: block; src: url("${f.url.replace(/"/g, '%22')}") format("${format}"); }`;
    })
    .join('\n');
}

/** Draws every `canvas[data-ff-chart]` placed by the `chart` helper; runs after the body is parsed. */
export function chartInitScript(): string {
  // `formfeedDrawCharts` is idempotent (Chart.getChart) so hosts that re-layout the DOM can call it
  // again: Paged.js clones the content into pages and a cloned canvas loses its bitmap, so the paged
  // preview skips the early draw (PagedConfig present) and draws in its `after` hook instead.
  return `<script data-formfeed="charts">window.formfeedDrawCharts=function(){if(typeof Chart==='undefined')return;var all=Chart.instances||{};for(var k in all){if(all[k]&&all[k].canvas&&!all[k].canvas.isConnected){try{all[k].destroy();}catch(e){}}}var cs=document.querySelectorAll('canvas[data-ff-chart]');for(var i=0;i<cs.length;i++){var c=cs[i];try{if(Chart.getChart(c))continue;var s=JSON.parse(c.getAttribute('data-ff-chart')||'{}');new Chart(c.getContext('2d'),s);c.setAttribute('data-ff-chart-ready','1');}catch(e){console.error('formfeed chart',e);}}};if(!window.PagedConfig){window.formfeedDrawCharts();}</script>`;
}

function chartScripts(
  html: string,
  vendor: AssembleVendor | undefined,
): { head: string; body: string } {
  if (!vendor?.chartJs || !html.includes('data-ff-chart'))
    return { head: '', body: '' };
  // `data-formfeed` on every script the engine writes: the render-worker waits less for a document
  // whose only scripts are these (`render/load-wait.ts`)
  const lib =
    'inline' in vendor.chartJs
      ? `<script data-formfeed="chartjs">${vendor.chartJs.inline}</script>`
      : `<script data-formfeed="chartjs" src="${escapeHtml(vendor.chartJs.src)}"></script>`;
  return {
    head: `${lib}
`,
    body: `${chartInitScript()}
`,
  };
}

export interface AssembleInput extends AssembleExtras {
  /** Rendered body HTML (engine output). */
  html: string;
  css?: string;
  head?: string;
  settings?: TemplateSettings;
  kind?: TemplateKind;
  /** Base URL for relative asset references (`<base href>`); omitted when undefined. */
  assetBaseUrl?: string;
  /** Brand kit whose `--brand-*` variables go before the reset and the template CSS (spec 18 §2.2). */
  brand?: BrandContext;
  /** Preview marks the document so the preview frame can style it; print is what Chromium gets. */
  mode?: 'preview' | 'print';
  title?: string;
  /** The theme of a Markdown document, between the print reset and the document's own CSS (plan 29). */
  theme?: string;
}

/** Produces the full document handed to Chromium or the preview frame (spec 05 §5). */
export function assembleDocument(input: AssembleInput): string {
  const settings = mergeSettings(input.settings);
  const kind = input.kind ?? 'pdf';
  const locale = settings.locale ?? 'en';
  const base = input.assetBaseUrl
    ? `<base href="${escapeHtml(input.assetBaseUrl.replace(/\/?$/, '/'))}">\n`
    : '';
  const title = input.title
    ? `<title>${escapeHtml(input.title)}</title>\n`
    : '';
  const fonts = fontFaceCss(
    input.fonts,
    `${input.css ?? ''}\n${input.head ?? ''}\n${input.html}\n${brandFontFamilies(input.brand)}`,
  );
  const fontStyle = fonts
    ? `<style data-formfeed="fonts">${fonts}</style>\n`
    : '';
  const brand = brandCss(input.brand);
  const brandStyle = brand
    ? `<style data-formfeed="brand">${brand}</style>\n`
    : '';
  const tailwind = settings.tailwind
    ? input.extraCss
      ? `<style data-formfeed="tailwind">${input.extraCss}</style>\n`
      : input.vendor?.tailwind
        ? `<script data-formfeed="tailwind" src="${escapeHtml(input.vendor.tailwind.src)}"></script>\n`
        : ''
    : input.extraCss
      ? `<style data-formfeed="extra">${input.extraCss}</style>\n`
      : '';
  const theme = input.theme
    ? `<style data-formfeed="markdown">${input.theme}</style>\n`
    : '';
  // KaTeX lays a formula out with its own stylesheet, so it comes before the theme and the
  // document's own CSS, which may restyle it. The print reset holds pictures to their box, and
  // KaTeX draws an accent such as `\vec`'s arrow in a box of no width, which took the arrow away.
  const katex =
    input.vendor?.katex && input.html.includes('class="katex')
      ? `<style data-formfeed="katex">${input.vendor.katex.css.replace(/<\/style/gi, '<\\/style')}\n.katex svg { max-width: none; }</style>\n`
      : '';
  const charts = chartScripts(input.html, input.vendor);
  const diagrams = diagramParts(input.html, input.vendor);
  // text that shrinks to fit its box (plan 16 §4.3); the render-worker calls it again before capturing
  const fit = input.html.includes('data-ff-fit')
    ? `<script data-formfeed="fit">${fitRuntime.replace(/<\/script/gi, '<\\/script')}</script>\n`
    : '';
  return `<!doctype html>
<html lang="${escapeHtml(locale.split('_')[0] ?? locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base}${title}${input.head ?? ''}
${fontStyle}${brandStyle}<style data-formfeed="reset">${printReset(settings, kind)}</style>
${katex}${diagrams.style}${theme}${tailwind}<style data-formfeed="template">${input.css ?? ''}</style>
${charts.head}${diagrams.head}</head>
<body class="formfeed-body formfeed-${kind}${input.mode === 'preview' ? ' formfeed-preview' : ''}">
${input.html}
${charts.body}${diagrams.body}${fit}</body>
</html>
`;
}

export interface VersionSource {
  engine: EngineId;
  html: string;
  css?: string;
  head?: string;
  settings?: TemplateSettings;
  kind?: TemplateKind;
}

export interface RenderedDocument {
  /** Complete HTML document. */
  document: string;
  /** Rendered header/footer HTML for Chromium's `headerTemplate`/`footerTemplate`, when configured. */
  headerHtml?: string;
  footerHtml?: string;
  /** PDF metadata title after template rendering. */
  title?: string;
  /**
   * The rest of the PDF metadata, rendered with the same data as the title. Until 2026-10-19 only
   * the title was, and a template's `{{ report.company }}` stood in a published PDF as its author.
   */
  metadata?: { author?: string; subject?: string; keywords?: string };
  settings: TemplateSettings;
  /** Font faces and extra CSS the header/footer templates need inlined (Chromium loads no external CSS there). */
  inlineCss: string;
}

/**
 * What a template version's code produced (plan 27 §5.1): the body, the header, the footer and the
 * metadata, each rendered with the same engine and data. This is the only step of a render that runs
 * template code; `assembleVersion` makes the document from it without running any, so a host can
 * render the parts in a sandbox and assemble outside it, once or twice (Tailwind needs the classes
 * the parts wrote before the document gets its stylesheet).
 */
export interface VersionParts {
  html: string;
  headerHtml?: string;
  footerHtml?: string;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
}

/** The context a version renders in: the settings' locale, time zone and currency win over the host's. */
function versionContext(
  settings: TemplateSettings,
  ctx: RenderContext,
): RenderContext {
  return {
    ...ctx,
    locale: settings.locale ?? ctx.locale,
    timezone: settings.timezone ?? ctx.timezone,
    currency: settings.currency ?? ctx.currency,
  };
}

/**
 * Renders the parts of a template version. Header and footer are rendered without autoescape
 * differences: they are HTML by definition.
 */
export async function renderVersionParts(
  version: VersionSource,
  data: unknown,
  ctx: RenderContext,
): Promise<VersionParts> {
  const engine = getEngine(version.engine);
  const settings = mergeSettings(version.settings);
  const renderCtx = versionContext(settings, ctx);
  const renderPart = async (source: string | undefined | null, name: string) =>
    source
      ? engine.render(engine.compile(source, { name }), data, renderCtx)
      : undefined;
  const meta = settings.pdf?.metadata;
  const [html, headerHtml, footerHtml, title, author, subject, keywords] =
    await Promise.all([
      engine.render(
        engine.compile(version.html, { name: 'template' }),
        data,
        renderCtx,
      ),
      renderPart(settings.header?.html, 'header'),
      renderPart(settings.footer?.html, 'footer'),
      renderPart(meta?.title, 'title'),
      renderPart(meta?.author, 'author'),
      renderPart(meta?.subject, 'subject'),
      renderPart(meta?.keywords, 'keywords'),
    ]);
  return { html, headerHtml, footerHtml, title, author, subject, keywords };
}

/** What `assembleVersion` takes of the render context: nothing in it runs template code. */
export type AssembleContext = Pick<RenderContext, 'assetBaseUrl' | 'brand'>;

/** Assembles a version's document from its rendered parts (spec 05 §5); runs no template code. */
export function assembleVersion(
  version: VersionSource,
  parts: VersionParts,
  ctx: AssembleContext,
  mode: 'preview' | 'print' = 'print',
  extras: AssembleExtras = {},
): RenderedDocument {
  const settings = mergeSettings(version.settings);
  const { html, headerHtml, footerHtml } = parts;
  const title = parts.title?.trim() || undefined;
  const metadata = Object.fromEntries(
    Object.entries({
      author: parts.author,
      subject: parts.subject,
      keywords: parts.keywords,
    })
      .map(([key, value]) => [key, value?.trim()])
      .filter(([, value]) => value),
  ) as RenderedDocument['metadata'];
  const inlineCss = [
    fontFaceCss(
      extras.fonts,
      `${version.css ?? ''}\n${version.head ?? ''}\n${html}\n${headerHtml ?? ''}\n${footerHtml ?? ''}\n${brandFontFamilies(ctx.brand)}`,
    ),
    brandCss(ctx.brand),
    extras.extraCss ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    document: assembleDocument({
      html,
      css: version.css,
      head: version.head,
      settings,
      kind: version.kind,
      assetBaseUrl: ctx.assetBaseUrl,
      brand: ctx.brand,
      mode,
      title,
      ...extras,
    }),
    headerHtml,
    footerHtml,
    title,
    metadata,
    settings,
    inlineCss,
  };
}

/**
 * Renders a template version end to end: its parts (`renderVersionParts`), then the document
 * (`assembleVersion`).
 */
export async function renderVersion(
  version: VersionSource,
  data: unknown,
  ctx: RenderContext,
  mode: 'preview' | 'print' = 'print',
  extras: AssembleExtras = {},
): Promise<RenderedDocument> {
  const parts = await renderVersionParts(version, data, ctx);
  return assembleVersion(version, parts, ctx, mode, extras);
}
