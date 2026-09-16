import { DEFAULT_CHROME_PADDING, type TemplateKind, type TemplateSettings } from './assemble';

/**
 * Preview documents shared by the web editor and `formfeed dev` (spec 06 §3, spec 15 §4): the
 * assembled document of `renderVersion` wrapped for the screen. Flow mode shows one page-wide
 * sheet with margins, header and footer emulated; paged mode lets Paged.js paginate with the
 * `@page` rule of the print reset and turns header and footer into running elements.
 */
export interface RenderedDraft {
  document: string;
  headerHtml?: string;
  footerHtml?: string;
  settings: TemplateSettings;
  kind: TemplateKind;
}

const paperSizes: Record<string, [string, string]> = {
  A4: ['210mm', '297mm'],
  A5: ['148mm', '210mm'],
  A3: ['297mm', '420mm'],
  Letter: ['8.5in', '11in'],
  Legal: ['8.5in', '14in'],
};

export function paperOf(settings: TemplateSettings): { width: string; height: string } {
  const paper = settings.paper ?? {};
  const size =
    paper.width && paper.height
      ? [paper.width, paper.height]
      : (paperSizes[paper.format ?? 'A4'] ?? paperSizes['A4']);
  const w = size?.[0] ?? '210mm';
  const h = size?.[1] ?? '297mm';
  return paper.landscape ? { width: h, height: w } : { width: w, height: h };
}

/** Chromium's header/footer placeholders replaced for the screen. */
export const pageNumberSpans = (html: string, page: string, total: string): string =>
  html
    .replace(/<span class="pageNumber"><\/span>/g, page)
    .replace(/<span class="totalPages"><\/span>/g, total);

/**
 * Click-to-source: the frame reports what was clicked so the editor can jump to the line that
 * produced it (spec 06 §3). `src` is the nearest `data-ff-src` position written by
 * `annotateSourcePositions` (`exact` when the clicked element carries it itself); tag, id, classes
 * and text remain for the editor's search when there is no position. Only descriptive attributes
 * and a short text excerpt travel.
 */
const inspectScript = `<script>
document.addEventListener('click', function (event) {
  var el = event.target;
  if (!el || el.nodeType !== 1) return;
  try {
    var annotated = el.closest ? el.closest('[data-ff-src]') : null;
    parent.postMessage({
      type: 'formfeed:inspect',
      src: annotated ? annotated.getAttribute('data-ff-src') : null,
      exact: annotated === el,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString().trim().split(' ').filter(Boolean),
      text: (el.textContent || '').trim().slice(0, 80),
    }, '*');
  } catch (e) {}
}, true);
</script>`;

/**
 * Page navigation for the paged preview (spec 06 §3): the editor asks for a page by index and the
 * frame scrolls to it, then reports which page is in view so the toolbar follows scrolling too.
 * The frame is sandboxed without same-origin, so this can only happen by message.
 */
const pageNavScript = `<script>
(function () {
  var pages = function () { return document.querySelectorAll('.pagedjs_page'); };
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'formfeed:goto-page') return;
    var page = pages()[(data.page || 1) - 1];
    if (page && page.scrollIntoView) page.scrollIntoView({ block: 'start' });
  });
  var current = 0;
  var report = function () {
    var list = pages();
    if (!list.length) return;
    var best = 1;
    var bestTop = Infinity;
    for (var i = 0; i < list.length; i++) {
      var top = Math.abs(list[i].getBoundingClientRect().top);
      if (top < bestTop) { bestTop = top; best = i + 1; }
    }
    if (best === current) return;
    current = best;
    try { parent.postMessage({ type: 'formfeed:page', page: best }, '*'); } catch (e) {}
  };
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; report(); });
  }, { passive: true });
})();
</script>`;

/**
 * Zoom gestures inside a preview frame: Ctrl+wheel (a touchpad pinch arrives as one too) and
 * Ctrl+plus/minus/0 would zoom the whole app, and the sandboxed frame's events never reach the app,
 * so the frame cancels them and asks the parent by message:
 * `{ type: 'formfeed:zoom', deltaY, deltaMode }` or `{ type: 'formfeed:zoom', step: 'in' | 'out' | 'reset' }`.
 * The office quick preview's frame uses the same script.
 */
export const zoomGestureScript = `<script>
(function () {
  var say = function (message) { try { parent.postMessage(message, '*'); } catch (e) {} };
  window.addEventListener('wheel', function (event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    say({ type: 'formfeed:zoom', deltaY: event.deltaY, deltaMode: event.deltaMode });
  }, { passive: false });
  window.addEventListener('keydown', function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    var step = event.key === '+' || event.key === '=' ? 'in' : event.key === '-' ? 'out' : event.key === '0' ? 'reset' : null;
    if (!step) return;
    event.preventDefault();
    say({ type: 'formfeed:zoom', step: step });
  });
})();
</script>`;

/**
 * Puts the preview's styles and scripts at the start of the head, after the leading meta tags and
 * before the template's own head. Text or a body element in the template's head makes the parser
 * close the head there, so anything appended before `</head>` would land in the body: Paged.js then
 * laid the running header out as ordinary content, on the first page only.
 */
function intoHead(document: string, markup: string): string {
  return document.replace(/<head[^>]*>(?:\s*<meta\b[^>]*>)*/i, (head) => `${head}\n${markup}`);
}

/**
 * Header and footer as Chromium prints them: across the whole page width, outside the page margins,
 * with the template's padding (default `0 10mm`) inside. The preview's box sits within the margins,
 * so it reaches out by them.
 */
function chromeBoxStyle(settings: RenderedDraft['settings'], which: 'header' | 'footer'): string {
  const margin = settings.margin ?? {};
  const left = margin.left ?? '0px';
  const right = margin.right ?? '0px';
  const padding = settings[which]?.padding ?? DEFAULT_CHROME_PADDING;
  const height = settings[which]?.height;
  return `box-sizing:border-box;margin-left:calc(-1 * ${left});margin-right:calc(-1 * ${right});width:calc(100% + ${left} + ${right});padding:${padding};${height ? `height:${height};` : ''}`;
}

export function flowDocument(draft: RenderedDraft): string {
  const { settings, kind, headerHtml, footerHtml } = draft;
  const margin = settings.margin ?? {};
  const paper = paperOf(settings);
  const chrome =
    kind === 'pdf'
      ? `<style data-formfeed="preview">
html { background: #e5e7eb; }
body.formfeed-preview { box-sizing: border-box; width: ${paper.width}; min-height: ${paper.height}; margin: 24px auto; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.08); padding: ${margin.top ?? '0'} ${margin.right ?? '0'} ${margin.bottom ?? '0'} ${margin.left ?? '0'}; }
.formfeed-chrome { color: #6b7280; font: 10px/1.3 system-ui, sans-serif; }
</style>`
      : `<style data-formfeed="preview">html { background: #e5e7eb; } body.formfeed-preview { margin: 24px auto; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }</style>`;
  const header = headerHtml
    ? `<div class="formfeed-chrome" style="${chromeBoxStyle(settings, 'header')}margin-bottom:8px">${headerHtml}</div>`
    : '';
  const footer = footerHtml
    ? `<div class="formfeed-chrome" style="${chromeBoxStyle(settings, 'footer')}margin-top:8px">${pageNumberSpans(footerHtml, '1', '1')}</div>`
    : '';
  return intoHead(draft.document, `${chrome}${inspectScript}${zoomGestureScript}`)
    .replace(/(<body[^>]*>)/, `$1${header}`)
    .replace('</body>', `${footer}</body>`);
}

export interface PagedOptions {
  /** URL of the Paged.js polyfill the frame can load. */
  pagedScriptUrl: string;
}

/**
 * Charts are drawn after pagination (Paged.js clones the content into pages and a cloned canvas is
 * blank) and the page count is posted to the parent as `{ type: 'formfeed:pages', pages }`.
 */
export function pagedDocument(draft: RenderedDraft, options: PagedOptions): string {
  const { headerHtml, footerHtml, settings } = draft;
  const runningCss = `
@page { ${headerHtml ? '@top-center { content: element(ffHeader); }' : ''} ${footerHtml ? '@bottom-center { content: element(ffFooter); }' : ''} }
.ff-running-header { position: running(ffHeader); }
.ff-running-footer { position: running(ffFooter); }
.ff-running-header, .ff-running-footer { color: #6b7280; font: 10px/1.3 system-ui, sans-serif; }
/* Chromium prints the header at the top edge and the footer at the bottom edge; margin boxes centre */
.pagedjs_margin-top-center { align-items: flex-start !important; }
.pagedjs_margin-bottom-center { align-items: flex-end !important; }
.ff-running-header { ${chromeBoxStyle(settings, 'header')} }
.ff-running-footer { ${chromeBoxStyle(settings, 'footer')} }
.ff-page-no::after { content: counter(page); }
.ff-page-total::after { content: counter(pages); }
html { background: #e5e7eb; }
.pagedjs_pages { margin: 0 auto; }
.pagedjs_page { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.08); margin: 16px auto; }
`;
  // Paged.js turns CSS rules with `+` or `:nth-of-type` into `querySelectorAll` calls on the parsed
  // content without a try/catch. A stylesheet that is not really CSS turns into rules with invalid
  // selectors, e.g. the HTML error page Google Fonts sends for a family it does not have, which
  // apitemplate.io's autofonts script links for every font-family it sees ("' 0' is not a valid
  // selector"). One such selector threw and left the whole paged preview blank; here it matches
  // nothing and says so in the console.
  const selectorGuard = `<script>(function(){var q=DocumentFragment.prototype.querySelectorAll;DocumentFragment.prototype.querySelectorAll=function(s){try{return q.call(this,s);}catch(e){console.warn('formfeed paged preview: skipped a selector Paged.js could not use:',s);return q.call(this,':not(*)');}};})();</script>`;
  const config = `<script>window.PagedConfig = { auto: true, after: function (flow) { try { if (window.formfeedDrawCharts) window.formfeedDrawCharts(); } catch (e) {} try { parent.postMessage({ type: 'formfeed:pages', pages: flow.total }, '*'); } catch (e) {} } };</script>`;
  const script = `<script src="${options.pagedScriptUrl}"></script>`;
  const header = headerHtml
    ? `<div class="ff-running-header">${pageNumberSpans(headerHtml, '<span class="ff-page-no"></span>', '<span class="ff-page-total"></span>')}</div>`
    : '';
  const footer = footerHtml
    ? `<div class="ff-running-footer">${pageNumberSpans(footerHtml, '<span class="ff-page-no"></span>', '<span class="ff-page-total"></span>')}</div>`
    : '';
  return intoHead(
    draft.document,
    `<style data-formfeed="paged">${runningCss}</style>${selectorGuard}${config}${script}${inspectScript}${pageNavScript}${zoomGestureScript}`,
  ).replace(/(<body[^>]*>)/, `$1${header}${footer}`);
}
