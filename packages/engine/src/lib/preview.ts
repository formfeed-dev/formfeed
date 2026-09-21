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

/**
 * Chromium's header/footer placeholders filled for the screen. Like Chromium, any element whose class
 * list names the placeholder counts, whatever else it carries (the editor adds `data-ff-src`), and
 * the element stays so its styling applies.
 */
export const pageNumberSpans = (html: string, page: string, total: string): string => {
  const fill = (source: string, name: string, value: string) =>
    source.replace(
      new RegExp(`<([a-z][a-z0-9]*)(\\s[^>]*?\\bclass=(["'])(?:[^"']*\\s)?${name}(?:\\s[^"']*)?\\3[^>]*)>[^<]*</\\1>`, 'gi'),
      (_match, tag: string, attrs: string) => `<${tag}${attrs}>${value}</${tag}>`,
    );
  return fill(fill(html, 'pageNumber', page), 'totalPages', total);
};

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

/** What the preview frame reports about content wider than the page, or `null` when nothing is. */
export interface PreviewOverflow {
  /** How far the widest element reaches past the right edge of the page's content area. */
  overflowMm: number;
  /**
   * The factor Chromium shrinks every page of the PDF by to fit that element: the content width
   * divided by the width the element needs.
   */
  scale: number;
  tag: string;
  /** `data-ff-src` of the element or its nearest annotated ancestor, as click-to-source reports it. */
  src: string | null;
}

/**
 * Content wider than the page (spec 06 §3). Chromium answers it by scaling the whole PDF down until
 * the widest element fits — every page, not only the one it is on — which no preview laid out at
 * 100 % shows. The frame measures instead and says so: `{ type: 'formfeed:overflow', overflow }`
 * with a `PreviewOverflow` or `null`. The paged preview measures once Paged.js is done, the flow
 * preview once its fonts are loaded. Header and footer boxes reach into the margins on purpose and
 * are skipped, as is anything inside a box that clips it. Millimetres come from a 100 mm reference
 * box measured in the frame, so the editor's zoom does not change them.
 */
function overflowScript(mode: 'paged' | 'flow'): string {
  return `<script>
(function () {
  var clipped = function (el, stop) {
    for (var p = el.parentElement; p && p !== stop; p = p.parentElement)
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    return false;
  };
  var measure = function () {
    try {
      var boxes = ${mode === 'paged' ? "document.querySelectorAll('.pagedjs_page_content')" : '[document.body]'};
      var worst = null;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i], rect = box.getBoundingClientRect(), style = getComputedStyle(box);
        var left = rect.left + parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0');
        var right = rect.right - parseFloat(style.paddingRight || '0') - parseFloat(style.borderRightWidth || '0');
        if (right - left <= 0) continue;
        var all = box.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          var el = all[j];
          // Paged.js wraps each page's content in a div of its own that spans its layout columns
          if (${mode === 'paged'} && el.parentElement === box && !el.className) continue;
          if (el.closest('.formfeed-chrome, .ff-running-header, .ff-running-footer, script, style, head')) continue;
          var over = el.getBoundingClientRect().right - right;
          if (over <= 1 || (worst && over <= worst.over)) continue;
          if (getComputedStyle(el).position === 'fixed' || clipped(el, box)) continue;
          worst = { over: over, width: right - left, el: el };
        }
      }
      var overflow = null;
      if (worst) {
        var ref = document.createElement('div');
        ref.style.cssText = 'position:absolute;visibility:hidden;width:100mm;height:0';
        document.body.appendChild(ref);
        var pxPerMm = ref.getBoundingClientRect().width / 100 || 1;
        ref.remove();
        var annotated = worst.el.closest('[data-ff-src]');
        overflow = {
          overflowMm: Math.round((worst.over / pxPerMm) * 10) / 10,
          scale: Math.round((worst.width / (worst.width + worst.over)) * 1000) / 1000,
          tag: worst.el.tagName.toLowerCase(),
          src: annotated ? annotated.getAttribute('data-ff-src') : null,
        };
      }
      parent.postMessage({ type: 'formfeed:overflow', overflow: overflow }, '*');
    } catch (e) {}
  };
  window.formfeedCheckOverflow = measure;
  ${mode === 'flow' ? "window.addEventListener('load', function () { (document.fonts ? document.fonts.ready : Promise.resolve()).then(measure); });" : ''}
})();
</script>`;
}

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

/**
 * Header and footer of the flow preview's page: in its top and bottom margin, from the page's edge,
 * as Chromium prints them and the paged preview shows them. The page is one tall sheet, so the
 * footer stands at the end of the content.
 */
function flowChromeStyle(settings: RenderedDraft['settings'], which: 'header' | 'footer'): string {
  const padding = settings[which]?.padding ?? DEFAULT_CHROME_PADDING;
  const height = settings[which]?.height;
  return `position:absolute;${which === 'header' ? 'top' : 'bottom'}:0;left:0;width:100%;box-sizing:border-box;padding:${padding};${height ? `height:${height};` : ''}`;
}

export function flowDocument(draft: RenderedDraft): string {
  const { settings, kind, headerHtml, footerHtml } = draft;
  const margin = settings.margin ?? {};
  const paper = paperOf(settings);
  const pdf = kind === 'pdf';
  const chrome = pdf
    ? `<style data-formfeed="preview">
html { background: #e5e7eb; }
body.formfeed-preview { position: relative; box-sizing: border-box; width: ${paper.width}; min-height: ${paper.height}; margin: 24px auto; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.08); padding: ${margin.top ?? '0'} ${margin.right ?? '0'} ${margin.bottom ?? '0'} ${margin.left ?? '0'}; }
.formfeed-chrome { color: #6b7280; font: 10px/1.3 system-ui, sans-serif; }
</style>`
    : `<style data-formfeed="preview">html { background: #e5e7eb; } body.formfeed-preview { margin: 24px auto; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }</style>`;
  const header = headerHtml
    ? `<div class="formfeed-chrome" style="${pdf ? flowChromeStyle(settings, 'header') : `${chromeBoxStyle(settings, 'header')}margin-bottom:8px`}">${headerHtml}</div>`
    : '';
  const footer = footerHtml
    ? `<div class="formfeed-chrome" style="${pdf ? flowChromeStyle(settings, 'footer') : `${chromeBoxStyle(settings, 'footer')}margin-top:8px`}">${pageNumberSpans(footerHtml, '1', '1')}</div>`
    : '';
  return intoHead(draft.document, `${chrome}${inspectScript}${zoomGestureScript}${pdf ? overflowScript('flow') : ''}`)
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
  // Paged.js's base stylesheet sets `.pagedjs_pagebox * { box-sizing: border-box }`, which reaches the
  // template's own elements: an element with a width and a padding came out smaller than in the PDF,
  // where they keep the browser's content-box (and a template's `* { … }` rule could not win against
  // it). The stylesheet is rewritten as it is inserted, before any layout, so the rule keeps to
  // Paged.js's own boxes.
  const boxSizingGuard = `<script>(function(){var rule='.pagedjs_pagebox *';var o=new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeName==='STYLE'&&n.textContent&&n.textContent.indexOf(rule)>=0){n.textContent=n.textContent.split(rule).join('.pagedjs_pagebox [class*="pagedjs_"]');o.disconnect();}});});});o.observe(document.documentElement,{childList:true,subtree:true});})();</script>`;
  const config = `<script>window.PagedConfig = { auto: true, after: function (flow) { try { if (window.formfeedDrawCharts) window.formfeedDrawCharts(); } catch (e) {} try { parent.postMessage({ type: 'formfeed:pages', pages: flow.total }, '*'); } catch (e) {} if (window.formfeedCheckOverflow) window.formfeedCheckOverflow(); } };</script>`;
  const script = `<script src="${options.pagedScriptUrl}"></script>`;
  const header = headerHtml
    ? `<div class="ff-running-header">${pageNumberSpans(headerHtml, '<span class="ff-page-no"></span>', '<span class="ff-page-total"></span>')}</div>`
    : '';
  const footer = footerHtml
    ? `<div class="ff-running-footer">${pageNumberSpans(footerHtml, '<span class="ff-page-no"></span>', '<span class="ff-page-total"></span>')}</div>`
    : '';
  return intoHead(
    draft.document,
    `<style data-formfeed="paged">${runningCss}</style>${selectorGuard}${boxSizingGuard}${overflowScript('paged')}${config}${script}${inspectScript}${pageNavScript}${zoomGestureScript}`,
  ).replace(/(<body[^>]*>)/, `$1${header}${footer}`);
}
