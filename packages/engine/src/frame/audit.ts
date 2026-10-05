import {
  AUDIT_SEVERITY,
  AUDIT_SNIPPET_LENGTH,
  type AuditArgs,
  type AuditCode,
  type AuditFinding,
  type AuditLink,
  type AuditOptions,
  type AuditReport,
} from '../lib/accessibility';

/**
 * The accessibility audit (plan 21 §6): what a validator will fail a PDF/UA-1 file for, and what a
 * reader will stumble over although no rule fails, found in the rendered document before anything is
 * printed. A validator answers with object numbers of the file; this answers with the element, and
 * in the editor's previews with the template's line (`data-ff-src`).
 *
 * It runs in three places: the editor's flow and paged previews, the render-worker's page before
 * printing, and the dev server's preview. It also reads the links' names, which the worker gives to
 * the PDF's link annotations: a pass over the finished file would only know the address.
 *
 * Reading order is not on the list. It is the DOM's order whatever CSS `order` or positioning
 * shows, and no script can tell which of the two the author meant.
 *
 * Bundled by `engine:frames`; keep it self-contained.
 */

/** The preview's own header and footer boxes: Chromium prints the templates in a page of their own. */
const CHROME = '.formfeed-chrome, .ff-running-header, .ff-running-footer';
/** Chromium's placeholders in header and footer templates, and the previews' stand-ins for them. */
const PLACEHOLDERS =
  '.pageNumber, .totalPages, .date, .title, .url, .ff-page-no, .ff-page-total';
const NOT_CONTENT = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'head',
]);
/** More elements than this are not looked at one by one: the audit must not hold up a render. */
const MAX_ELEMENTS = 20_000;
const MAX_RUNNING = 10;
/** Words beside a page number that say nothing of their own. */
const PAGINATION_WORDS = new Set([
  'page',
  'pages',
  'of',
  'seite',
  'seiten',
  'von',
  'p',
  's',
]);

const collapse = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();
/** Text as it is compared: case and white space say nothing about whether the body holds it. */
const compact = (text: string): string =>
  text.replace(/\s+/g, '').toLowerCase();
const hasWord = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * What Paged.js writes onto a template's elements while it lays the pages out: a reference on every
 * one of them, and where it split, broke and counted. Read off its source (`setAttribute("data-…")`
 * and `dataset.…`), so a bump of Paged.js is a reason to look again.
 */
const PAGED_ATTRIBUTE =
  /^data-(ref|id|split-(from|to|original)|(previous-|next-)?break-(before|after|inside)|(align-)?last-split-element|nth-of-type|counter-.+|page(-number)?|undisplayed|after-page|following|has-notes|children|item-num)$/;

/**
 * An element's start tag as the author would recognise it, without what the editor added to it and,
 * on a page of the paged preview, without what Paged.js did: a finding once read
 * `<h3 data-ref="0add6264-…">`.
 */
export function startTag(element: Element): string {
  const clone = element.cloneNode(false) as Element;
  clone.removeAttribute('data-ff-src');
  clone.removeAttribute('data-ff-edit');
  const paged = element.closest('.pagedjs_page') !== null;
  for (const attribute of Array.from(clone.attributes))
    if (paged && PAGED_ATTRIBUTE.test(attribute.name))
      clone.removeAttribute(attribute.name);
    // an embedded image would be the whole snippet
    else if (attribute.value.length > 48)
      clone.setAttribute(attribute.name, `${attribute.value.slice(0, 40)}…`);
  const tag = clone.outerHTML.replace(
    new RegExp(`</${element.tagName}>$`, 'i'),
    '',
  );
  return tag.length > AUDIT_SNIPPET_LENGTH
    ? `${tag.slice(0, AUDIT_SNIPPET_LENGTH - 1)}…`
    : tag;
}

export function audit(win: Window, options: AuditOptions = {}): AuditReport {
  const doc = win.document;
  const body = doc.body;
  const findings: AuditFinding[] = [];
  const seen = new Set<string>();
  const wanted = options.findings !== false;

  const add = (
    code: AuditCode,
    element: Element | null,
    args: AuditArgs = {},
  ) => {
    if (!wanted) return;
    const src =
      element?.closest('[data-ff-src]')?.getAttribute('data-ff-src') ?? null;
    const snippet = element ? startTag(element) : '';
    // Paged.js splits and clones elements across pages: one fault is one finding
    const key = `${code}|${src ?? snippet}|${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, severity: AUDIT_SEVERITY[code], src, snippet, args });
  };

  // --- what counts as content ------------------------------------------------------------------

  const hiddenCache = new WeakMap<Element, boolean>();
  /** Not painted at all: `display: none`, the `hidden` attribute, `visibility: hidden`. */
  const unpainted = (element: Element): boolean => {
    const known = hiddenCache.get(element);
    if (known !== undefined) return known;
    const style = win.getComputedStyle(element);
    const hidden =
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      (element.parentElement !== null &&
        element.parentElement !== doc.documentElement &&
        unpainted(element.parentElement));
    hiddenCache.set(element, hidden);
    return hidden;
  };
  /** Kept from assistive technology, which Chromium answers by not tagging it. */
  const silenced = (element: Element): boolean =>
    element.closest('[aria-hidden="true"]') !== null;
  const decorative = (element: Element): boolean =>
    /^(presentation|none)$/.test(element.getAttribute('role') ?? '');
  const inChrome = (element: Element): boolean =>
    element.closest(CHROME) !== null;
  const holdsText = (element: Element): boolean =>
    hasWord(element.textContent ?? '');

  /** The name ARIA gives an element, before its own content. */
  const labelOf = (element: Element): string => {
    const label = collapse(element.getAttribute('aria-label'));
    if (label) return label;
    return collapse(
      (element.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map(
          (id) => element.ownerDocument.getElementById(id)?.textContent ?? '',
        )
        .join(' '),
    );
  };

  /** A link's description (decision 7): its label, else its text, else the alt of an image in it. */
  const linkName = (link: Element): string =>
    labelOf(link) ||
    collapse(link.textContent) ||
    collapse(
      Array.from(link.querySelectorAll('img[alt]'))
        .map((image) => image.getAttribute('alt'))
        .join(' '),
    ) ||
    collapse(link.getAttribute('title'));
  const linkOf = (link: Element): AuditLink => {
    const written = link.getAttribute('href') ?? '';
    return {
      // a place in the document is a named destination in the PDF, an address everything else
      href: written.startsWith('#')
        ? written
        : ((link as HTMLAnchorElement).href ?? written),
      name: linkName(link),
    };
  };

  // --- the document ----------------------------------------------------------------------------

  if (!collapse(doc.title)) add('document-title', null);
  if (!collapse(doc.documentElement.getAttribute('lang')) && !options.locale)
    add('document-language', null);

  const pages =
    options.pages ??
    (options.pageHeight && options.pageHeight > 0
      ? Math.ceil(doc.documentElement.scrollHeight / options.pageHeight)
      : 1);

  // --- the body's elements ---------------------------------------------------------------------

  const links: AuditLink[] = [];
  const headings: Array<{ element: Element; level: number }> = [];
  const marked: Record<
    'masked-text' | 'filtered-text' | 'fixed-text',
    Element[]
  > = {
    'masked-text': [],
    'filtered-text': [],
    'fixed-text': [],
  };
  /** One finding for the outermost element a style applies to, not one per element inside it. */
  const once = (code: keyof typeof marked, element: Element) => {
    if (marked[code].some((outer) => outer.contains(element))) return;
    marked[code].push(element);
    add(code, element);
  };
  const generated = wanted && hasGeneratedContent(doc);

  const elements = body
    ? Array.from(body.querySelectorAll('*')).slice(0, MAX_ELEMENTS)
    : [];
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (NOT_CONTENT.has(tag) || inChrome(element) || unpainted(element))
      continue;

    if (tag === 'a' && element.hasAttribute('href')) {
      const link = linkOf(element);
      links.push(link);
      if (!link.name && !silenced(element)) add('link-name', element);
    }
    if (!wanted) continue;

    const style = win.getComputedStyle(element);
    const mask =
      style.getPropertyValue('mask-image') ||
      style.getPropertyValue('-webkit-mask-image');
    if (mask && mask !== 'none' && holdsText(element))
      once('masked-text', element);
    if (style.filter && style.filter !== 'none' && holdsText(element))
      once('filtered-text', element);
    if (style.position === 'fixed' && pages > 1 && holdsText(element))
      once('fixed-text', element);

    if (generated)
      for (const pseudo of ['::before', '::after']) {
        const text = generatedText(
          win.getComputedStyle(element, pseudo).content,
        );
        if (text) add('generated-text', element, { text });
      }

    if (silenced(element)) continue;

    if (tag === 'img' && !decorative(element)) {
      const named =
        element.hasAttribute('alt') ||
        labelOf(element) ||
        collapse(element.getAttribute('title'));
      if (!named) add('image-alt', element);
    } else if (
      tag === 'canvas' ||
      (element.getAttribute('role') === 'img' && tag !== 'img')
    ) {
      const named =
        labelOf(element) ||
        collapse(element.getAttribute('title')) ||
        collapse(element.querySelector(':scope > title')?.textContent);
      if (!named) add('figure-name', element, { tag });
    }

    const level = /^h[1-6]$/.test(tag)
      ? Number(tag[1])
      : element.getAttribute('role') === 'heading'
        ? Number(element.getAttribute('aria-level')) || 2
        : 0;
    if (level) headings.push({ element, level });

    if (tag === 'table' && !decorative(element))
      auditTable(element as HTMLTableElement, add);
  }

  // H1 first, and no level skipped on the way down (7.4.2-1); going up again skips nothing
  let previous = 0;
  for (const { element, level } of headings) {
    if (previous === 0 ? level !== 1 : level > previous + 1)
      add('heading-order', element, { level, previous });
    previous = level;
  }

  // --- header and footer -----------------------------------------------------------------------

  const templateLinks: AuditLink[] = [];
  const bodyText = wanted && body ? compact(contentText(body)) : '';
  let running = 0;
  for (const part of ['header', 'footer'] as const) {
    for (const root of templateRoots(doc, part, options[part])) {
      for (const link of Array.from(root.querySelectorAll('a[href]')))
        templateLinks.push(linkOf(link));
      if (!wanted) continue;
      for (const { text, element } of runningPieces(root)) {
        if (running >= MAX_RUNNING || bodyText.includes(compact(text)))
          continue;
        const before = findings.length;
        add('running-text', element, { text: text.slice(0, 80), part });
        if (findings.length > before) running++;
      }
    }
  }

  return { findings, links, templateLinks };
}

/**
 * Header or footer as elements: the preview's own boxes where the document holds them, else the
 * template parsed apart from the document, so nothing of it loads or runs.
 */
function templateRoots(
  doc: Document,
  part: 'header' | 'footer',
  html: string | undefined,
): Element[] {
  if (html !== undefined) {
    if (!html.trim()) return [];
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><body>${html}</body>`,
      'text/html',
    );
    return parsed.body ? [parsed.body] : [];
  }
  return Array.from(
    doc.querySelectorAll(
      `.ff-running-${part}, .formfeed-chrome[data-ff-chrome="${part}"]`,
    ),
  );
}

/** The text a screen reader would say of an element: no scripts, no styles, none of the previews' boxes. */
function contentText(root: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (
      NOT_CONTENT.has(element.tagName.toLowerCase()) ||
      element.matches(CHROME)
    )
      return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return out.join(' ');
}

/**
 * What a header or footer template says, in pieces a body could repeat: its texts, split where a
 * footer line strings several facts together. The page number and the words around it are not said
 * by the body and need not be.
 */
function runningPieces(
  root: Element,
): Array<{ text: string; element: Element }> {
  const pieces: Array<{ text: string; element: Element }> = [];
  const walk = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    if (NOT_CONTENT.has(tag) || element.matches(PLACEHOLDERS)) return;
    const paginated = Array.from(element.children).some((child) =>
      child.matches(PLACEHOLDERS),
    );
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) walk(child as Element);
      else if (child.nodeType === 3 && !paginated)
        for (const part of (child.nodeValue ?? '').split(
          /\s*[·•|]\s*|\s{2,}|\n/,
        )) {
          const text = collapse(part);
          const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
          if (words.some((word) => !PAGINATION_WORDS.has(word)))
            pieces.push({ text, element });
        }
    }
  };
  walk(root);
  return pieces;
}

/**
 * Rows of unequal length fail a data table (7.2-43); a table without header cells fails nothing and
 * leaves a reader with cells that belong to no column. Chromium takes a table without any header for
 * a layout table and tags no table at all, so only the second can be said of it.
 */
function auditTable(
  table: HTMLTableElement,
  add: (code: AuditCode, element: Element | null, args?: AuditArgs) => void,
): void {
  const rows = Array.from(table.rows);
  const headed =
    table.querySelector('th, [role="columnheader"], [role="rowheader"]') !==
    null;
  if (!headed) {
    if (rows.length >= 2) add('table-headers', table);
    return;
  }
  const widths = rowWidths(rows);
  const other = widths.find((width) => width !== widths[0]);
  if (other !== undefined)
    add('table-rows', table, { first: widths[0] ?? 0, other });
  // Rows that are even in the markup can still come out uneven: Chromium writes no TD for a data
  // cell without content (measured: empty, white space, a decoration, an image with an empty alt),
  // while a non-breaking space is enough and header cells are always written. One finding a table,
  // at its first such cell.
  const empty = rows.flatMap((row) =>
    Array.from(row.cells).filter(
      (cell) => cell.tagName === 'TD' && isEmptyCell(cell),
    ),
  );
  if (empty[0]) add('table-cell-empty', empty[0], { count: empty.length });
}

/** What makes a cell one a reader is given: an element that is tagged whatever its text. */
const CELL_CONTENT =
  'img[alt]:not([alt=""]), svg, canvas, input, select, textarea, button, meter, progress';

/** A cell with nothing but collapsible white space: a non-breaking or zero-width space is content. */
function isEmptyCell(cell: Element): boolean {
  return (
    !/[^ \t\n\r\f]/.test(cell.textContent ?? '') &&
    cell.querySelector(CELL_CONTENT) === null
  );
}

/** How many columns each row spans, counting cells that reach down from the rows above. */
export function rowWidths(rows: HTMLTableRowElement[]): number[] {
  let carried: number[] = [];
  return rows.map((row) => {
    const next: number[] = [];
    let column = 0;
    const skipCarried = () => {
      while ((carried[column] ?? 0) > 0) {
        next[column] = carried[column]! - 1;
        column++;
      }
    };
    for (const cell of Array.from(row.cells)) {
      skipCarried();
      const down = Math.max(1, cell.rowSpan || 1) - 1;
      for (let i = Math.max(1, cell.colSpan || 1); i > 0; i--)
        next[column++] = down;
    }
    skipCarried();
    // cells that reach down further right than this row's own cells
    for (let i = column; i < carried.length; i++)
      if ((carried[i] ?? 0) > 0) {
        next[i] = carried[i]! - 1;
        column = i + 1;
      }
    carried = next;
    return column;
  });
}

/** Whether any stylesheet writes `content` into a `::before` or `::after`: the reason to look at all. */
function hasGeneratedContent(doc: Document): boolean {
  const inRules = (rules: CSSRuleList | undefined): boolean => {
    for (const rule of Array.from(rules ?? [])) {
      const styled = rule as CSSStyleRule;
      if (
        styled.selectorText &&
        /::?(before|after)/.test(styled.selectorText) &&
        styled.style?.content
      )
        return true;
      if (
        (rule as CSSGroupingRule).cssRules &&
        inRules((rule as CSSGroupingRule).cssRules)
      )
        return true;
    }
    return false;
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      if (inRules(sheet.cssRules)) return true;
    } catch {
      // a stylesheet from another origin keeps its rules to itself: look, to be sure
      return true;
    }
  }
  return false;
}

/**
 * The words of a computed `content` value, or '' when it generates none: its strings, and its
 * counters as they are written, because the number they come to is not in the style.
 */
export function generatedText(content: string | null | undefined): string {
  if (!content || content === 'none' || content === 'normal') return '';
  const strings = (content.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((quoted) =>
    quoted.slice(1, -1).replace(/\\(.)/g, '$1'),
  );
  if (/\bcounters?\(/.test(content)) return collapse(content).slice(0, 80);
  const text = collapse(strings.join(''));
  return hasWord(text) ? text.slice(0, 80) : '';
}
