/**
 * What Chromium's print does that Paged.js does not, for the paged preview (the editor's and
 * `formfeed dev`'s). Paged.js lays a page out in CSS columns, treats what reaches the second column
 * as the next page's, and rebuilds a table that goes on to the next page from its body alone.
 * Chromium repeats a table's head at the top of every page the table reaches and its footer group at
 * the foot of every page it goes on from, and keeps room for both. Without that, page 2 of an invoice
 * had no header row, its rows drifted by one a page, and at 120 lines the preview had five pages where
 * the PDF had six. And a `position: fixed` footer stood in the page's margin, where Chromium puts it
 * over the last row of a full page.
 *
 * Measured on 2026-10-18 against the PDFs of the blog post `page-breaks-in-tables` (21 tables, Paged.js
 * 0.4.3): Paged.js alone laid out 2 of them as the PDF does, with this runtime all 21. The render-worker's
 * `paged-preview.spec.ts` holds the preview to those PDFs.
 *
 * `pagedDocument` adds it after Paged.js's script; its `PagedConfig.before` calls
 * `formfeedMoveTableFeet` while the document is still the one the template wrote. Bundled by
 * `engine:frames`; keep it self-contained.
 */

/** The part of Paged.js this runtime uses (`window.Paged`, a UMD global of the polyfill). */
interface PagedChunker {
  source: ParentNode;
}
interface PagedGlobal {
  Handler: new (
    chunker: PagedChunker,
    polisher: unknown,
    caller: unknown,
  ) => { chunker: PagedChunker };
  registerHandlers: (...handlers: unknown[]) => void;
}
type PagedWindow = Window & {
  Paged?: PagedGlobal;
  formfeedMoveTableFeet?: () => void;
};

const isElement = (node: Node | null | undefined): node is Element =>
  !!node && node.nodeType === 1;
const elementOf = (node: Node | null | undefined): Element | null =>
  isElement(node) ? node : (node?.parentElement ?? null);

function section(table: Element, name: string): Element | null {
  for (let c = table.firstElementChild; c; c = c.nextElementSibling)
    if (c.nodeName === name) return c;
  return null;
}

/** Body rows of a table, not those of a nested one. */
const bodyRows = (table: Element): Element[] =>
  Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'));

/**
 * Chromium slices what an inline-level box holds at the page's edge instead of breaking it into
 * pages, so a table in one gets no repeated head and no row moves on (`inline-block-wrapper`).
 */
function inInlineBox(el: Element, win: Window): boolean {
  for (
    let p = el.parentElement;
    p && !p.classList.contains('pagedjs_page_content');
    p = p.parentElement
  ) {
    if (win.getComputedStyle(p).display.startsWith('inline')) return true;
  }
  return false;
}

/** Whether the page holds anything before `el`: a table that starts a page cannot move on from it. */
function contentBefore(el: Element, root: Node): boolean {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    for (let s = n.previousSibling; s; s = s.previousSibling) {
      if (isElement(s) || (s.textContent ?? '').trim()) return true;
    }
  }
  return false;
}

/** A copy of a head or footer group for another page: ids stay with the original, as Paged.js does. */
function repeated(group: Element): Element {
  const copy = group.cloneNode(true) as Element;
  for (const el of [copy, ...Array.from(copy.querySelectorAll('[id]'))]) {
    if (!el.id) continue;
    el.setAttribute('data-id', el.id);
    el.removeAttribute('id');
  }
  copy.setAttribute('data-ff-repeated', '');
  return copy;
}

/**
 * HTML lets a `tfoot` stand before the `tbody`. Chromium draws a footer group at the table's foot
 * wherever it stands; Paged.js lays it out where it stands and then laid the first page's rows out
 * twice. Moved to the end of its table it draws the same, before Paged.js takes the document. A
 * `tfoot` the template made a row group stays where it is, because that one prints where it stands.
 */
export function moveTableFeet(doc: Document, win: Window): void {
  for (const foot of Array.from(doc.querySelectorAll('table > tfoot'))) {
    let later = foot.nextElementSibling;
    while (later && later.nodeName !== 'TBODY' && later.nodeName !== 'TR')
      later = later.nextElementSibling;
    if (later && win.getComputedStyle(foot).display === 'table-footer-group')
      foot.parentNode?.appendChild(foot);
  }
}

/**
 * Paged.js's `renderNode` hook: the first node placed on a page in a table that goes on from the page
 * before gets the table's head in front of it, as Chromium prints it. The row it is in is at the top
 * of its page then, so a row taller than what is left may break there (Chromium's view), instead of
 * moving on to the next page and the next with `tr { break-inside: avoid }`.
 */
export function repeatHead(clone: Node, node: Node, win: Window): void {
  const el = elementOf(clone);
  const table = el?.closest('table');
  if (
    !el ||
    !table ||
    !table.hasAttribute('data-split-from') ||
    table.hasAttribute('data-ff-head')
  )
    return;
  table.setAttribute('data-ff-head', '');
  if (section(table, 'THEAD')) return;
  const source = elementOf(node)?.closest('table');
  const head = source && section(source, 'THEAD');
  if (!source || !head || inInlineBox(table, win)) return;
  const copy = repeated(head);
  let at = table.firstChild;
  while (at && (at.nodeName === 'CAPTION' || at.nodeName === 'COLGROUP'))
    at = at.nextSibling;
  table.insertBefore(copy, at);
  // `thead { display: block }` and the like are not repeated by Chromium either
  if (win.getComputedStyle(copy).display !== 'table-header-group') {
    copy.remove();
    return;
  }
  for (let s = source.firstElementChild; s; s = s.nextElementSibling) {
    if (s.nodeName === 'COLGROUP') table.insertBefore(s.cloneNode(true), copy);
  }
  const row = el.closest('tr');
  const group = row?.parentElement;
  if (
    row &&
    group &&
    group.parentElement === table &&
    group.nodeName !== 'THEAD'
  ) {
    row.style.breakInside = 'auto';
    row.removeAttribute('data-break-inside');
  }
}

/**
 * Paged.js's `onOverflow` hook, where the page's last content is settled: a table row that does not
 * fit moves on, also one a wrapper with `overflow` clips at the page's foot, which Paged.js would
 * keep; a table with a footer group keeps room for its copy (`data-ff-foot`, filled in by
 * `repeatFoot`); and a head with no row under it at the foot of a page moves on with its table, and a
 * heading kept to that by `break-after: avoid` with both. Returns the range, changed or not.
 */
export function settleTable(
  overflow: Range,
  rendered: Node,
  bottom: number,
  source: ParentNode,
  win: Window,
): Range | undefined {
  const start = overflow.startContainer;
  const at = isElement(start)
    ? (start.childNodes[overflow.startOffset] ?? start)
    : start;
  const el = elementOf(at);
  if (!el) return undefined;
  const row =
    el.nodeName === 'TBODY' ? el.querySelector('tr') : el.closest('tr');
  const table = row?.closest('table');
  const group = row?.parentElement;
  if (
    !row ||
    !table ||
    !group ||
    group.nodeName === 'THEAD' ||
    group.nodeName === 'TFOOT'
  )
    return undefined;
  if (inInlineBox(table, win)) return undefined;
  const rows = bodyRows(table);
  const index = rows.indexOf(row);
  if (index < 0) return undefined;
  let keep = index;
  let footHeight = 0;
  if (index > 0 && (at === row || at === group)) {
    const original = source.querySelector(
      `[data-ref="${table.getAttribute('data-ref') ?? ''}"]`,
    );
    const foot = original && section(original, 'TFOOT');
    if (foot) {
      const probe = foot.cloneNode(true) as Element;
      table.appendChild(probe);
      if (win.getComputedStyle(probe).display === 'table-footer-group')
        footHeight = probe.getBoundingClientRect().height;
      probe.remove();
    }
    // Paged.js's own measure: a box fits when its floored bottom is not below the rounded page end
    const end = Math.round(bottom);
    const fits = (r: Element | undefined) =>
      !r || Math.floor(r.getBoundingClientRect().bottom) + footHeight <= end;
    while (keep > 0 && !fits(rows[keep - 1])) keep--;
  }
  if (keep === 0) {
    if (table.hasAttribute('data-split-from') || !section(table, 'THEAD'))
      return undefined;
    const before = table.previousElementSibling;
    const from =
      table.getAttribute('data-previous-break-after') === 'avoid' && before
        ? before
        : table;
    if (!contentBefore(from, rendered)) return undefined;
    overflow.setStartBefore(from);
    return overflow;
  }
  const first = rows[keep];
  if (keep < index && first) overflow.setStartBefore(first);
  if (footHeight) table.setAttribute('data-ff-foot', '');
  return overflow;
}

/** Paged.js's `afterOverflowRemoved` hook: the footer group's copy at the foot of the page `settleTable` kept room on. */
export function repeatFoot(rendered: ParentNode, source: ParentNode): void {
  const table = rendered.querySelector('table[data-ff-foot]');
  if (!table) return;
  table.removeAttribute('data-ff-foot');
  const original = source.querySelector(
    `[data-ref="${table.getAttribute('data-ref') ?? ''}"]`,
  );
  const foot = original && section(original, 'TFOOT');
  if (foot) table.appendChild(repeated(foot));
}

/**
 * Paged.js's `afterPageLayout` hook. Paged.js puts a copy of every `position: fixed` element on every
 * page, as Chromium prints it, but measures it from the whole sheet: a footer with `bottom: 0` stood in
 * the bottom margin. Chromium measures it from the page area inside the margins, where it covers the
 * last row of a full page (the post's `fixed-footer` case). The copies move into a layer laid over
 * that area; clicks go through the layer to the page, and still reach the copies.
 */
export function anchorFixed(pageElement: Element): void {
  const box = pageElement.querySelector('.pagedjs_pagebox');
  if (!box) return;
  const fixed = Array.from(box.children).filter(
    (c) =>
      !(c.getAttribute('class') ?? '').includes('pagedjs_') &&
      !c.hasAttribute('data-ff-fixed'),
  );
  if (!fixed.length) return;
  const layer = box.ownerDocument.createElement('div');
  layer.setAttribute('data-ff-fixed', '');
  layer.setAttribute(
    'style',
    'grid-column: center; grid-row: page; position: relative; pointer-events: none;',
  );
  for (const el of fixed) {
    if ('style' in el) (el as HTMLElement).style.pointerEvents = 'auto';
    layer.appendChild(el);
  }
  box.appendChild(layer);
}

export function installPagedPrint(win: PagedWindow): void {
  win.formfeedMoveTableFeet = () => moveTableFeet(win.document, win);
  const Paged = win.Paged;
  if (!Paged?.Handler) return;
  class FormfeedTables extends Paged.Handler {
    renderNode(clone: Node, node: Node): void {
      repeatHead(clone, node, win);
    }
    onOverflow(
      overflow: Range | undefined,
      rendered: Node,
      bounds: DOMRect,
    ): Range | undefined {
      return overflow
        ? settleTable(
            overflow,
            rendered,
            bounds.bottom,
            this.chunker.source,
            win,
          )
        : undefined;
    }
    afterOverflowRemoved(_removed: unknown, rendered: ParentNode): void {
      repeatFoot(rendered, this.chunker.source);
    }
    afterPageLayout(pageElement: Element): void {
      anchorFixed(pageElement);
    }
  }
  Paged.registerHandlers(FormfeedTables);
}
