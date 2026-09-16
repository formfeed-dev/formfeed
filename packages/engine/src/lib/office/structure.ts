import type { OfficeDiagnostic } from './tags';
import { undoAutocorrect } from './tags';
import { decodeText, escapeText, tokenize, type XmlToken } from './xml';

/**
 * Structural tags (spec 22 §4.3 step 5). A block tag alone in its paragraph stands for the paragraph:
 * a loop repeats the paragraphs between its tags, not the text inside one. If that paragraph is also
 * the only content of its table row, the tag stands for the row, so a loop repeats the rows between.
 *
 * The rewrite happens on the part's XML before it becomes template text: the paragraph or row is
 * replaced by a `<ff:tag>` element holding only the tag. `toTemplateSource` reads that element's text
 * like a text element, and `fromTemplateOutput` removes the element again after rendering. Structure
 * the file format needs survives: a paragraph that carries a section break stays (empty), and a cell
 * never ends up without a paragraph.
 */
export const STRUCTURAL_ELEMENT = 'ff:tag';

export interface StructuredPart {
  xml: string;
  diagnostics: OfficeDiagnostic[];
}

export interface Span {
  name: string;
  start: number;
  end: number;
  parent: Span | null;
  children: Span[];
}

interface ParagraphInfo {
  span: Span;
  /** 1-based, in document order. */
  number: number;
  text: string;
  /** Anything visible besides text: a drawing, an object, a field, a break. */
  hasContent: boolean;
  /** The `w:pPr` element when it carries a section break, else null. */
  sectionProperties: string | null;
}

type Role = 'open' | 'close' | 'middle' | 'single';

const PARAGRAPH = new Set(['w:p', 'a:p']);
const ROW = new Set(['w:tr', 'a:tr']);
const CELL = new Set(['w:tc', 'a:tc']);
/** Elements that must hold at least one paragraph: Word cells and text boxes, PowerPoint text bodies. */
const BODIES = new Set(['w:tc', 'w:txbxContent', 'p:txBody', 'a:txBody']);
const TEXT = new Set(['w:t', 'a:t']);
const CONTENT = new Set(['w:drawing', 'w:pict', 'w:object', 'w:fldChar', 'w:fldSimple', 'w:br', 'w:tab', 'w:sym', 'a:br', 'a:fld', 'w:footnoteReference', 'w:endnoteReference']);

const JINJA_OPEN = /^(for|if|unless|case|capture|raw|with|macro|call|filter|block|tablerow|comment|autoescape)\b/;
const JINJA_CLOSE = /^end(for|if|unless|case|capture|raw|with|macro|call|filter|block|tablerow|comment|autoescape)\b/;
const JINJA_MIDDLE = /^(else|elif|elsif|when)\b/;

/** What a tag does to structure, or null when the text is not exactly one tag. */
export function blockRole(text: string): { role: Role; keyword: string } | null {
  const t = text.trim();
  let m = /^\{%-?\s*([\s\S]*?)\s*-?%\}$/.exec(t);
  if (m && !t.slice(2, -2).includes('%}')) {
    const body = m[1] ?? '';
    const word = /^\w+/.exec(body)?.[0] ?? '';
    if (JINJA_CLOSE.test(body)) return { role: 'close', keyword: word.slice(3) };
    if (JINJA_OPEN.test(body)) return { role: 'open', keyword: word };
    if (JINJA_MIDDLE.test(body)) return { role: 'middle', keyword: word };
    return { role: 'single', keyword: word };
  }
  if (/^\{#[\s\S]*#\}$/.test(t)) return { role: 'single', keyword: 'comment' };
  m = /^\{\{~?\s*([#^/]?)\s*([\w.-]*)[\s\S]*?~?\}\}$/.exec(t);
  if (m && t.indexOf('}}') === t.length - 2) {
    const sigil = m[1] ?? '';
    const word = m[2] ?? '';
    if (sigil === '#' || (sigil === '^' && word)) return { role: 'open', keyword: word };
    if (sigil === '/') return { role: 'close', keyword: word };
    if ((sigil === '^' && !word) || word === 'else') return { role: 'middle', keyword: 'else' };
  }
  return null;
}

/** Loops copy what is between their tags; these references cannot be copied (spec 22 §4.3 step 7). */
const REFERENCES = new Set(['w:footnoteReference', 'w:endnoteReference', 'w:commentRangeStart', 'w:commentReference']);
const LOOPS = new Set(['for', 'each', 'tablerow']);

/**
 * Text boxes carry a VML copy of their text in `mc:Fallback`, which would be filled on its own and
 * loop twice. A fallback holding a tag is removed; Word 2010 and later and LibreOffice read the choice.
 */
export function dropTaggedFallbacks(xml: string, part?: string): string {
  if (!xml.includes('mc:Fallback')) return xml;
  const tokens = tokenize(xml, part);
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'open' && t.name === 'mc:Fallback' && !t.selfClosing) {
      let depth = 1;
      let j = i + 1;
      let text = '';
      for (; j < tokens.length && depth > 0; j++) {
        const u = tokens[j]!;
        if (u.kind === 'open' && u.name === 'mc:Fallback' && !u.selfClosing) depth++;
        else if (u.kind === 'close' && u.name === 'mc:Fallback') depth--;
        else if (u.kind === 'text') text += decodeText(u.raw);
      }
      if (/\{\{|\{%|\{#/.test(text)) {
        i = j - 1;
        continue;
      }
    }
    out += t.raw;
  }
  return out;
}

export function applyStructure(xml: string, part: string): StructuredPart {
  const tokens = tokenize(xml, part);
  const root = buildSpans(tokens);
  const paragraphs = collectParagraphs(tokens, root);
  const diagnostics: OfficeDiagnostic[] = [];

  // Paragraphs that are exactly one block tag and nothing else.
  const structural = new Map<Span, { info: ParagraphInfo; role: Role; keyword: string; tag: string }>();
  for (const info of paragraphs) {
    if (info.hasContent) continue;
    const tag = undoAutocorrect(info.text);
    const role = blockRole(tag);
    if (role) structural.set(info.span, { info, ...role, tag: tag.trim() });
  }
  if (!structural.size) return { xml, diagnostics };

  // Rows whose only content is one structural paragraph.
  const replacedRows = new Map<Span, string>();
  const rowOf = new Map<Span, Span>();
  for (const [span, s] of structural) {
    const cell = ancestor(span, CELL);
    const row = cell && ancestor(cell, ROW);
    if (!row) continue;
    const others = paragraphs.filter((p) => p.span !== span && isInside(p.span, row));
    if (others.every((p) => p.text.trim() === '' && !p.hasContent)) {
      replacedRows.set(row, s.tag);
      rowOf.set(span, row);
    }
  }

  // The element a tag stands in for decides its parent; opening and closing tags must share it.
  const unitOf = (span: Span) => rowOf.get(span) ?? span;
  const stack: Array<{ keyword: string; parent: Span | null; paragraph: number; tag: string; after: number }> = [];
  for (const [span, s] of [...structural].sort((a, b) => a[0].start - b[0].start)) {
    const parent = unitOf(span).parent;
    if (s.role === 'open')
      stack.push({ keyword: s.keyword, parent, paragraph: s.info.number, tag: s.tag, after: unitOf(span).end });
    else if (s.role === 'close' || s.role === 'middle') {
      const open = s.role === 'close' ? stack.pop() : stack.at(-1);
      if (open && s.role === 'close' && LOOPS.has(open.keyword)) {
        const body = tokens.slice(open.after, unitOf(span).start);
        const reference = body.find((t) => t.kind === 'open' && REFERENCES.has(t.name));
        if (reference && reference.kind === 'open')
          diagnostics.push({
            severity: 'error',
            code: 'office-reference-in-loop',
            message: `The loop from paragraph ${open.paragraph} repeats a ${reference.name.includes('comment') ? 'comment' : 'footnote or endnote'}, which cannot be copied. Move it out of the loop.`,
            part,
            paragraph: open.paragraph,
            text: short(open.tag),
          });
      }
      if (open && open.parent !== parent)
        diagnostics.push({
          severity: 'error',
          code: 'office-block-unbalanced',
          message: `${short(open.tag)} (paragraph ${open.paragraph}) and ${short(s.tag)} are in different places: one in a table cell or text box, the other outside it. Put both in the same place.`,
          part,
          paragraph: s.info.number,
          text: short(s.tag),
        });
    }
  }

  // Replacements over token ranges.
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const element = (tag: string) => `<${STRUCTURAL_ELEMENT}>${escapeText(tag)}</${STRUCTURAL_ELEMENT}>`;
  for (const [row, tag] of replacedRows) replacements.push({ start: row.start, end: row.end, text: element(tag) });
  const cellsEmptied = new Map<Span, number>();
  for (const [span, s] of structural) {
    if (rowOf.has(span)) continue;
    const keep = s.info.sectionProperties;
    let text = element(s.tag);
    // A section break stays where it is: an opening tag goes after it, anything else before it.
    if (keep) text = s.role === 'open' ? `<w:p>${keep}</w:p>${text}` : `${text}<w:p>${keep}</w:p>`;
    replacements.push({ start: span.start, end: span.end, text });
    // the element that must keep a paragraph: a Word cell, or a PowerPoint text body
    const holder = span.parent && BODIES.has(span.parent.name) ? span.parent : null;
    if (holder && !keep) cellsEmptied.set(holder, (cellsEmptied.get(holder) ?? 0) + 1);
  }
  // A cell or text body whose every paragraph was a tag gets an empty one, or Word and PowerPoint
  // refuse the file. The empty paragraph goes last, after any properties the element starts with.
  for (const [holder, emptied] of cellsEmptied) {
    const total = paragraphs.filter((p) => p.span.parent === holder).length;
    if (emptied >= total) {
      const empty = holder.name.startsWith('w:') ? '<w:p/>' : '<a:p/>';
      replacements.push({ start: holder.end, end: holder.end - 1, text: empty });
    }
  }

  return { xml: rewrite(tokens, replacements), diagnostics };
}

/**
 * A loop over an empty list can leave a table without rows, which Word and PowerPoint refuse (spec 22
 * §4.3 step 5): such a Word table is removed, and so is the graphic frame of such a slide table.
 */
export function removeEmptyTables(xml: string): string {
  if (!xml.includes(':tbl')) return xml;
  const tokens = tokenize(xml);
  const root = buildSpans(tokens);
  const drop: Array<{ start: number; end: number; text: string }> = [];
  const walk = (span: Span) => {
    if ((span.name === 'w:tbl' || span.name === 'a:tbl') && !span.children.some((c) => ROW.has(c.name))) {
      let target: Span = span;
      for (let p = span.parent; p && span.name === 'a:tbl'; p = p.parent)
        if (p.name === 'p:graphicFrame') {
          target = p;
          break;
        }
      drop.push({ start: target.start, end: target.end, text: '' });
      return;
    }
    for (const child of span.children) walk(child);
  };
  walk(root);
  return drop.length ? rewrite(tokens, drop) : xml;
}

/** Builds the element tree; `start`/`end` are token indexes of the open and close tags. */
export function buildSpans(tokens: XmlToken[]): Span {
  const root: Span = { name: '#root', start: -1, end: tokens.length, parent: null, children: [] };
  const stack: Span[] = [root];
  tokens.forEach((token, index) => {
    if (token.kind === 'open') {
      const parent = stack.at(-1)!;
      const span: Span = { name: token.name, start: index, end: index, parent, children: [] };
      parent.children.push(span);
      if (!token.selfClosing) stack.push(span);
    } else if (token.kind === 'close') {
      const span = stack.pop();
      if (span) span.end = index;
    }
  });
  return root;
}

function collectParagraphs(tokens: XmlToken[], root: Span): ParagraphInfo[] {
  const out: ParagraphInfo[] = [];
  const walk = (span: Span) => {
    if (PARAGRAPH.has(span.name)) {
      let text = '';
      let hasContent = false;
      let sectionProperties: string | null = null;
      let inText = false;
      for (let i = span.start + 1; i < span.end; i++) {
        const t = tokens[i]!;
        if (t.kind === 'open') {
          if (TEXT.has(t.name) && !t.selfClosing) inText = true;
          else if (CONTENT.has(t.name)) hasContent = true;
          else if (t.name === 'w:sectPr') sectionProperties = '';
        } else if (t.kind === 'close' && TEXT.has(t.name)) inText = false;
        else if (t.kind === 'text' && inText) text += decodeText(t.raw);
      }
      if (sectionProperties !== null) sectionProperties = propertiesOf(tokens, span);
      out.push({ span, number: out.length + 1, text, hasContent, sectionProperties });
    }
    for (const child of span.children) walk(child);
  };
  walk(root);
  return out;
}

/** The raw `w:pPr` element of a paragraph. */
function propertiesOf(tokens: XmlToken[], paragraph: Span): string {
  const props = paragraph.children.find((c) => c.name === 'w:pPr');
  if (!props) return '';
  return tokens
    .slice(props.start, props.end + 1)
    .map((t) => t.raw)
    .join('');
}

function ancestor(span: Span, names: Set<string>): Span | null {
  for (let p = span.parent; p; p = p.parent) if (names.has(p.name)) return p;
  return null;
}

function isInside(span: Span, container: Span): boolean {
  return span.start > container.start && span.end < container.end;
}

/** Joins the tokens back, with the token ranges replaced; an empty range inserts before `start`. */
export function rewrite(tokens: XmlToken[], replacements: Array<{ start: number; end: number; text: string }>): string {
  const byStart = new Map<number, Array<{ end: number; text: string }>>();
  for (const r of replacements) {
    const list = byStart.get(r.start) ?? [];
    list.push({ end: r.end, text: r.text });
    byStart.set(r.start, list);
  }
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const here = byStart.get(i);
    if (here) {
      let skipTo = -1;
      for (const r of here) {
        out += r.text;
        if (r.end >= i) skipTo = Math.max(skipTo, r.end);
      }
      if (skipTo >= i) {
        i = skipTo;
        continue;
      }
    }
    out += tokens[i]!.raw;
  }
  return out;
}

function short(tag: string): string {
  const oneLine = tag.replace(/\s+/g, ' ').trim();
  return oneLine.length > 50 ? `${oneLine.slice(0, 47)}…` : oneLine;
}
