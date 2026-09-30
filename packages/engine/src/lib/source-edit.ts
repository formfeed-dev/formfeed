import {
  lineStarts,
  offsetOf,
  rawTextElements,
  Scanner,
  tagName,
} from './source-scan';
import type { EngineId } from './types';

/**
 * Editing text from the preview (plan 16 §3). An element whose content is literal text, output tags,
 * inline children and line breaks — nothing that decides what is printed — is an *editable region*:
 * the preview shows its text editable and everything else as atomic chips, and the edit comes back
 * here to be written into the source. Text the user did not change keeps its source bytes, so
 * indentation, line breaks and character references survive a one-word edit; changed text is
 * HTML-escaped, and a `{` that could open template syntax is written as `&#123;`. Every result is
 * parsed again and compared with what the user typed before it is returned.
 */

export type RegionRefusal =
  | 'not-an-element'
  | 'dynamic-tag'
  | 'void'
  | 'raw-text'
  | 'control-flow'
  | 'block-child'
  | 'unclosed'
  | 'no-text'
  | 'too-large';

export type ChipKind = 'expression' | 'element' | 'comment' | 'entity';

export type RegionPart =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'break'; start: number; end: number }
  | {
      kind: 'chip';
      start: number;
      end: number;
      chip: ChipKind;
      label: string;
      inner?: string;
    };

export interface EditableRegion {
  /** `t`: the whole content is one `t()` call, and the edit goes into the dictionary. */
  kind: 'text' | 't';
  tag: string;
  /** Offset of the start tag's `<`. */
  tagStart: number;
  /** First character of the content, and the `<` of the end tag. */
  start: number;
  end: number;
  /** After the end tag's `>`. */
  outerEnd: number;
  parts: RegionPart[];
  /** `t` regions: the dictionary key and each parameter's expression by name. */
  key?: string;
  params?: Record<string, string>;
}

/** What the preview shows and sends back: text, a chip by its index among the region's chips, a line break. */
export type EditItem =
  | { kind: 'text'; text: string }
  | { kind: 'chip'; index: number }
  | { kind: 'break' };

export interface RegionChip {
  index: number;
  kind: ChipKind;
  /** What the chip stands for: the expression, `<strong>`, a character reference. */
  label: string;
  source: string;
}

export type ApplyResult = { source: string } | { error: 'chips' | 'invalid' };

/** A region, or why the element at that place is none. */
export type RegionLookup = EditableRegion | { reason: RegionRefusal };

const MAX_REGION = 20_000;

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Children that may sit inside editable text as a chip; any other element makes the region code-only. */
const phrasingElements = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'img',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'svg',
  'time',
  'u',
  'var',
  'wbr',
]);

/** Named character references the region decodes into editable text; any other becomes a chip. */
const namedEntities: Record<string, number> = {
  amp: 38,
  lt: 60,
  gt: 62,
  quot: 34,
  apos: 39,
  nbsp: 160,
  shy: 173,
  ensp: 8194,
  emsp: 8195,
  thinsp: 8201,
  zwnj: 8204,
  zwj: 8205,
  ndash: 8211,
  mdash: 8212,
  lsquo: 8216,
  rsquo: 8217,
  sbquo: 8218,
  ldquo: 8220,
  rdquo: 8221,
  bdquo: 8222,
  laquo: 171,
  raquo: 187,
  lsaquo: 8249,
  rsaquo: 8250,
  hellip: 8230,
  bull: 8226,
  middot: 183,
  euro: 8364,
  pound: 163,
  yen: 165,
  cent: 162,
  copy: 169,
  reg: 174,
  trade: 8482,
  deg: 176,
  sect: 167,
  para: 182,
  times: 215,
  divide: 247,
  plusmn: 177,
  micro: 181,
  frac12: 189,
  frac14: 188,
  frac34: 190,
  sup2: 178,
  sup3: 179,
  dagger: 8224,
  Dagger: 8225,
  larr: 8592,
  rarr: 8594,
  uarr: 8593,
  darr: 8595,
  auml: 228,
  ouml: 246,
  uuml: 252,
  Auml: 196,
  Ouml: 214,
  Uuml: 220,
  szlig: 223,
  eacute: 233,
  egrave: 232,
  agrave: 224,
  aacute: 225,
  ccedil: 231,
  oacute: 243,
  iacute: 237,
  uacute: 250,
  ntilde: 241,
};

const entityPattern =
  /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;

const NBSP = String.fromCharCode(0xa0);
/** Stand-ins while diffing: a line break, and a chip the edit removed. */
const BREAK = String.fromCharCode(0xe000);
const REMOVED = String.fromCharCode(0xe001);
const CHIP_OPEN = String.fromCharCode(0xe002);
const CHIP_CLOSE = String.fromCharCode(0xe003);

/** The region whose start tag's `<` is at `line`/`column` (1-based, as `data-ff-src` names it). */
export function editableRegion(
  source: string,
  engine: EngineId,
  location: { line: number; column: number },
): RegionLookup {
  const offset = offsetOf(
    lineStarts(source),
    source.length,
    location.line,
    location.column,
  );
  return offset === null
    ? { reason: 'not-an-element' }
    : editableRegionAt(source, engine, offset);
}

/** The region whose start tag's `<` is at `at`. */
export function editableRegionAt(
  source: string,
  engine: EngineId,
  at: number,
): RegionLookup {
  const scanned = scanRegion(source, engine, at);
  if ('reason' in scanned) return scanned;
  const region: EditableRegion = { kind: 'text', ...scanned };
  const visible = region.parts.filter(
    (p) => !(p.kind === 'text' && !source.slice(p.start, p.end).trim()),
  );
  const only = visible.length === 1 ? visible[0] : undefined;
  if (only?.kind === 'chip' && only.chip === 'expression') {
    const call = translationCall(engine, only.inner ?? '');
    if (call)
      return { ...region, kind: 't', key: call.key, params: call.params };
  }
  const hasText = region.parts.some(
    (p) =>
      p.kind === 'text' &&
      decodeText(source.slice(p.start, p.end)).text.trim() !== '',
  );
  return hasText ? region : { reason: 'no-text' };
}

/**
 * The region again after the source changed around it (someone typed in the code editor while the
 * preview was being edited): found by its unique original markup, or null.
 */
export function findRegionAgain(
  source: string,
  engine: EngineId,
  outer: string,
): EditableRegion | null {
  const first = source.indexOf(outer);
  if (first < 0 || source.indexOf(outer, first + 1) >= 0) return null;
  const found = editableRegionAt(source, engine, first);
  return 'reason' in found ? null : found;
}

/** The chips of a region in order, with what they stand for. */
export function regionChips(
  source: string,
  region: EditableRegion,
): RegionChip[] {
  const chips: RegionChip[] = [];
  for (const part of region.parts)
    if (part.kind === 'chip')
      chips.push({
        index: chips.length,
        kind: part.chip,
        label: part.label,
        source: source.slice(part.start, part.end),
      });
  return chips;
}

/** What the preview shows while editing: decoded text (whitespace as written), chips and breaks. */
export function regionItems(
  source: string,
  region: EditableRegion,
): EditItem[] {
  const items: EditItem[] = [];
  let chip = 0;
  for (const part of region.parts) {
    if (part.kind === 'text')
      items.push({
        kind: 'text',
        text: decodeText(source.slice(part.start, part.end)).text,
      });
    else if (part.kind === 'break') items.push({ kind: 'break' });
    else items.push({ kind: 'chip', index: chip++ });
  }
  return items;
}

/**
 * Writes edited items back into the region. Chips may be deleted, never reordered or repeated. Text
 * between the same two chips is diffed against what it was, so only the changed stretch is
 * rewritten; if the result does not read back as the items (a kept `{` meeting a typed `%`), the
 * whole content is written anew with every brace escaped.
 */
export function applyRegionEdit(
  source: string,
  engine: EngineId,
  region: EditableRegion,
  items: EditItem[],
): ApplyResult {
  const chipParts = region.parts.filter(
    (p): p is Extract<RegionPart, { kind: 'chip' }> => p.kind === 'chip',
  );
  const kept: number[] = [];
  for (const item of items)
    if (item.kind === 'chip') {
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= chipParts.length
      )
        return { error: 'chips' };
      if (kept.length && item.index <= (kept[kept.length - 1] ?? -1))
        return { error: 'chips' };
      kept.push(item.index);
    }
  const breakSpelling =
    source.slice(...spanOf(region.parts.find((p) => p.kind === 'break'))) ||
    '<br>';

  // the new text between consecutive kept chips
  const newSegments: string[] = [''];
  for (const item of items) {
    if (item.kind === 'chip') newSegments.push('');
    else
      newSegments[newSegments.length - 1] +=
        item.kind === 'break'
          ? BREAK
          : item.text.replace(/[\uE000-\uE003]/g, '');
  }

  const pieces: string[] = [];
  let segStart = region.start;
  let partIndex = 0;
  for (let k = 0; k <= kept.length; k++) {
    const boundary = k < kept.length ? chipParts[kept[k] ?? 0] : undefined;
    const segEnd = boundary ? boundary.start : region.end;
    const segParts: RegionPart[] = [];
    while (
      partIndex < region.parts.length &&
      (region.parts[partIndex]?.start ?? Infinity) < segEnd
    )
      segParts.push(region.parts[partIndex++] as RegionPart);
    if (boundary) partIndex++;
    pieces.push(
      rewriteSegment(
        source,
        segStart,
        segEnd,
        segParts,
        newSegments[k] ?? '',
        breakSpelling,
      ),
    );
    if (boundary) {
      pieces.push(source.slice(boundary.start, boundary.end));
      segStart = boundary.end;
    }
  }
  const expected = flatExpected(
    items,
    chipParts.map((c) => source.slice(c.start, c.end)),
  );
  const attempt =
    source.slice(0, region.start) + pieces.join('') + source.slice(region.end);
  if (readsBack(attempt, engine, region.tagStart, expected))
    return { source: attempt };

  const whole = items
    .map((item) =>
      item.kind === 'chip'
        ? source.slice(chipParts[item.index]?.start, chipParts[item.index]?.end)
        : item.kind === 'break'
          ? breakSpelling
          : encodeText(item.text, true, true),
    )
    .join('');
  const rewritten =
    source.slice(0, region.start) + whole + source.slice(region.end);
  return readsBack(rewritten, engine, region.tagStart, expected)
    ? { source: rewritten }
    : { error: 'invalid' };
}

/** A dictionary text as items: `{name}` placeholders become chips, in order of appearance. */
export function translationItems(text: string): {
  items: EditItem[];
  names: string[];
} {
  const items: EditItem[] = [];
  const names: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (match.index > last)
      items.push({ kind: 'text', text: text.slice(last, match.index) });
    items.push({ kind: 'chip', index: names.length });
    names.push(match[1] ?? '');
    last = match.index + match[0].length;
  }
  if (last < text.length) items.push({ kind: 'text', text: text.slice(last) });
  return { items, names };
}

/** Edited dictionary items back into text: chips become their placeholders again, breaks spaces. */
export function translationText(items: EditItem[], names: string[]): string {
  return items
    .map((item) =>
      item.kind === 'chip'
        ? `{${names[item.index] ?? ''}}`
        : item.kind === 'break'
          ? ' '
          : item.text.replace(new RegExp(NBSP, 'g'), ' '),
    )
    .join('');
}

/**
 * The value each chip shows while editing, read off the element's rendered text: the text between
 * the chips must appear in it in order, and exactly one way of placing them must exist. Null when
 * there is none or more than one (an empty value, a value that repeats a literal): the chips then
 * show their labels.
 */
export function chipValues(
  rendered: string,
  items: EditItem[],
): string[] | null {
  const slots: string[] = [''];
  for (const item of items) {
    if (item.kind === 'chip') slots.push('');
    else if (item.kind === 'text') slots[slots.length - 1] += item.text;
  }
  const chips = slots.length - 1;
  if (!rendered.startsWith(slots[0] ?? '')) return null;
  let found: string[] | null = null;
  let solutions = 0;
  let steps = 0;
  const values: string[] = [];
  const place = (k: number, pos: number): void => {
    if (solutions > 1 || ++steps > 10_000) return;
    if (k === chips) {
      if (pos === rendered.length) {
        solutions++;
        found = [...values];
      }
      return;
    }
    const next = slots[k + 1] ?? '';
    const last = k + 1 === chips;
    for (let q = pos; q <= rendered.length; q++) {
      q = rendered.indexOf(next, q);
      if (q < 0) return;
      if (!last || q + next.length === rendered.length) {
        values[k] = rendered.slice(pos, q);
        place(k + 1, q + next.length);
        if (solutions > 1) return;
      }
    }
  };
  place(0, (slots[0] ?? '').length);
  return solutions === 1 && steps <= 10_000 ? found : null;
}

// --- reading --------------------------------------------------------------------------------------

interface Scanned {
  tag: string;
  tagStart: number;
  start: number;
  end: number;
  outerEnd: number;
  parts: RegionPart[];
}

function scanRegion(
  source: string,
  engine: EngineId,
  at: number,
): Scanned | { reason: RegionRefusal } {
  if (source[at] !== '<') return { reason: 'not-an-element' };
  tagName.lastIndex = at + 1;
  const name = tagName.exec(source)?.[0];
  if (!name) return { reason: 'not-an-element' };
  const nameEnd = at + 1 + name.length;
  if (!plainNameEnd(source[nameEnd])) return { reason: 'dynamic-tag' };
  const tag = name.toLowerCase();
  const scanner = new Scanner(source, engine);
  const start = scanner.tagEnd(nameEnd);
  if (voidElements.has(tag) || source[start - 2] === '/')
    return { reason: 'void' };
  if (rawTextElements.has(tag)) return { reason: 'raw-text' };

  const parts: RegionPart[] = [];
  let textStart = start;
  const flush = (to: number) => {
    if (to > textStart) parts.push({ kind: 'text', start: textStart, end: to });
  };
  let i = start;
  while (i < source.length) {
    if (i - start > MAX_REGION) return { reason: 'too-large' };
    const ch = source[i];
    if (ch === '{') {
      const construct = scanner.classify(i);
      if (!construct) {
        i++;
        continue;
      }
      if (construct.type === 'statement') return { reason: 'control-flow' };
      flush(i);
      parts.push(
        construct.type === 'output'
          ? {
              kind: 'chip',
              chip: 'expression',
              label: expressionLabel(construct.inner),
              inner: construct.inner,
              start: i,
              end: construct.end,
            }
          : {
              kind: 'chip',
              chip: 'comment',
              label: 'comment',
              start: i,
              end: construct.end,
            },
      );
      i = textStart = construct.end;
      continue;
    }
    if (ch === '&') {
      entityPattern.lastIndex = i;
      const match = entityPattern.exec(source);
      if (
        match &&
        entityChar(match[1] ?? '') === null &&
        !(match[1] ?? '').startsWith('#')
      ) {
        flush(i);
        parts.push({
          kind: 'chip',
          chip: 'entity',
          label: match[0],
          start: i,
          end: i + match[0].length,
        });
        i = textStart = i + match[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch !== '<') {
      i++;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = scanner.skipTo(i + 4, '-->');
      flush(i);
      parts.push({
        kind: 'chip',
        chip: 'comment',
        label: 'comment',
        start: i,
        end,
      });
      i = textStart = end;
      continue;
    }
    const next = source[i + 1];
    if (next === '/') {
      tagName.lastIndex = i + 2;
      const closing = tagName.exec(source)?.[0];
      if (closing?.toLowerCase() !== tag) return { reason: 'unclosed' };
      flush(i);
      return {
        tag,
        tagStart: at,
        start,
        end: i,
        outerEnd: scanner.tagEnd(i + 2 + closing.length),
        parts,
      };
    }
    if (next === '!' || next === '?') return { reason: 'block-child' };
    tagName.lastIndex = i + 1;
    const child = tagName.exec(source)?.[0];
    if (!child) {
      // `a < b`: a `<` that starts no tag is text
      i++;
      continue;
    }
    const childNameEnd = i + 1 + child.length;
    if (!plainNameEnd(source[childNameEnd])) return { reason: 'dynamic-tag' };
    const childTag = child.toLowerCase();
    const childStartEnd = scanner.tagEnd(childNameEnd);
    if (childTag === 'br') {
      flush(i);
      parts.push({ kind: 'break', start: i, end: childStartEnd });
      i = textStart = childStartEnd;
      continue;
    }
    if (rawTextElements.has(childTag)) return { reason: 'raw-text' };
    if (!phrasingElements.has(childTag)) return { reason: 'block-child' };
    let childEnd: number | null = childStartEnd;
    if (!voidElements.has(childTag) && source[childStartEnd - 2] !== '/') {
      childEnd = matchingEnd(source, scanner, childStartEnd, childTag);
      if (childEnd === null) return { reason: 'unclosed' };
    }
    flush(i);
    parts.push({
      kind: 'chip',
      chip: 'element',
      label: `<${childTag}>`,
      start: i,
      end: childEnd,
    });
    i = textStart = childEnd;
  }
  return { reason: 'unclosed' };
}

function plainNameEnd(after: string | undefined): boolean {
  return (
    after === undefined || after === '>' || after === '/' || /\s/.test(after)
  );
}

/** After the `>` of the end tag that closes an element named `name` whose start tag ends at `from`. */
function matchingEnd(
  source: string,
  scanner: Scanner,
  from: number,
  name: string,
): number | null {
  let depth = 1;
  let j = from;
  while (j < source.length) {
    const ch = source[j];
    if (ch === '{') {
      j = scanner.skipTemplate(j) ?? j + 1;
      continue;
    }
    if (ch !== '<') {
      j++;
      continue;
    }
    if (source.startsWith('<!--', j)) {
      j = scanner.skipTo(j + 4, '-->');
      continue;
    }
    if (source[j + 1] === '/') {
      tagName.lastIndex = j + 2;
      const closing = tagName.exec(source)?.[0];
      const end = scanner.tagEnd(j + 2);
      if (closing?.toLowerCase() === name && --depth === 0) return end;
      j = end;
      continue;
    }
    tagName.lastIndex = j + 1;
    const opening = tagName.exec(source)?.[0];
    if (!opening) {
      j++;
      continue;
    }
    const end = scanner.tagEnd(j + 1 + opening.length);
    const lower = opening.toLowerCase();
    if (lower === name && source[end - 2] !== '/') depth++;
    j = rawTextElements.has(lower) ? scanner.skipToClosingTag(end, lower) : end;
  }
  return null;
}

/** An output tag as a chip names it: the expression without delimiters and whitespace control. */
function expressionLabel(inner: string): string {
  const label = inner
    .replace(/^[-~+&]?\s*/, '')
    .replace(/\s*[-~+]?$/, '')
    .replace(/\s+/g, ' ');
  return label.length > 60 ? `${label.slice(0, 59)}…` : label;
}

/** `t('key', { n: x })`, `'key' | t: n: x` or `t 'key' n=x`: the key and the parameters, or null. */
function translationCall(
  engine: EngineId,
  inner: string,
): { key: string; params: Record<string, string> } | null {
  const expression = inner.replace(/^[-~+]?\s*/, '').replace(/\s*[-~+]?$/, '');
  let match: RegExpExecArray | null;
  if (engine === 'jinja2') {
    match =
      /^(?:t|translate)\(\s*(['"])((?:(?!\1).)*)\1\s*(?:,\s*\{([\s\S]*)\}\s*)?\)$/.exec(
        expression,
      );
    return match
      ? { key: match[2] ?? '', params: parseParams(match[3] ?? '', ':', ',') }
      : null;
  }
  if (engine === 'liquid') {
    match =
      /^(['"])((?:(?!\1).)*)\1\s*\|\s*(?:t|translate)\b\s*(?::\s*([\s\S]*))?$/.exec(
        expression,
      );
    return match
      ? { key: match[2] ?? '', params: parseParams(match[3] ?? '', ':', ',') }
      : null;
  }
  match = /^(?:t|translate)\s+(['"])((?:(?!\1).)*)\1([\s\S]*)$/.exec(
    expression,
  );
  return match
    ? { key: match[2] ?? '', params: parseParams(match[3] ?? '', '=', ' ') }
    : null;
}

/** `a: x, b: y` or `a=x b=y` into name → expression, splitting only outside strings and brackets. */
function parseParams(
  text: string,
  assign: string,
  separator: string,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const piece of splitTopLevel(text, separator)) {
    const at = piece.indexOf(assign);
    if (at <= 0) continue;
    const name = piece
      .slice(0, at)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (/^[\w-]+$/.test(name)) params[name] = piece.slice(at + 1).trim();
  }
  return params;
}

function splitTopLevel(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (
      depth === 0 &&
      (separator === ' ' ? /\s/.test(ch) : ch === separator)
    ) {
      if (current.trim()) pieces.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}

// --- text -----------------------------------------------------------------------------------------

function entityChar(reference: string): string | null {
  if (reference.startsWith('#')) {
    const code =
      reference[1] === 'x' || reference[1] === 'X'
        ? parseInt(reference.slice(2), 16)
        : parseInt(reference.slice(1), 10);
    return Number.isFinite(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : null;
  }
  const code = namedEntities[reference];
  return code === undefined ? null : String.fromCharCode(code);
}

/** Text as the browser shows it, with the source offset of every character (and of the end). */
function decodeText(raw: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '&') {
      entityPattern.lastIndex = i;
      const match = entityPattern.exec(raw);
      const decoded = match ? entityChar(match[1] ?? '') : null;
      if (match && decoded !== null) {
        for (let u = 0; u < decoded.length; u++) map.push(i);
        text += decoded;
        i += match[0].length;
        continue;
      }
    }
    text += raw[i];
    map.push(i);
    i++;
  }
  map.push(raw.length);
  return { text, map };
}

/**
 * Typed text for the source: `&`, `<` and `>` escaped, a non-breaking space kept only where the text
 * already had one (the browser types one for a space that would collapse), and a `{` that could
 * start template syntax written as `&#123;` — every one with `allBraces`, the fallback.
 */
function encodeText(
  text: string,
  keepNbsp: boolean,
  allBraces = false,
): string {
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k] ?? '';
    const next = text[k + 1];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === NBSP) out += keepNbsp ? '&nbsp;' : ' ';
    else if (
      ch === '{' &&
      (allBraces ||
        next === undefined ||
        next === '{' ||
        next === '%' ||
        next === '#')
    )
      out += '&#123;';
    // Nunjucks reads a `#}` in plain text as the end of a comment and refuses the template
    else if (ch === '#' && next === '}') out += '&#35;';
    else out += ch;
  }
  return out;
}

/**
 * Literal text for a template's HTML, as the design emitter writes it: escaped like an edit from the
 * preview, so a `{` that could open template syntax is written as `&#123;`.
 */
export function encodeTemplateText(text: string): string {
  return encodeText(text, true);
}

// --- writing --------------------------------------------------------------------------------------

function spanOf(part: RegionPart | undefined): [number, number] {
  return part ? [part.start, part.end] : [0, 0];
}

/** One stretch between kept chips: the old text (breaks and removed chips as stand-ins) diffed against the new. */
function rewriteSegment(
  source: string,
  segStart: number,
  segEnd: number,
  parts: RegionPart[],
  next: string,
  breakSpelling: string,
): string {
  let old = '';
  const map: number[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      const decoded = decodeText(source.slice(part.start, part.end));
      old += decoded.text;
      for (let k = 0; k < decoded.text.length; k++)
        map.push(part.start + (decoded.map[k] ?? 0));
    } else {
      old += part.kind === 'break' ? BREAK : REMOVED;
      map.push(part.start);
    }
  }
  map.push(segEnd);
  if (old === next) return source.slice(segStart, segEnd);
  let prefix = 0;
  const limit = Math.min(old.length, next.length);
  while (prefix < limit && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  // never split a surrogate pair
  if (prefix > 0 && isHighSurrogate(old.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isLowSurrogate(old.charCodeAt(old.length - suffix)))
    suffix--;
  const from = map[prefix] ?? segEnd;
  const to = map[old.length - suffix] ?? segEnd;
  const middle = next.slice(prefix, next.length - suffix);
  const keepNbsp = old.slice(prefix, old.length - suffix).includes(NBSP);
  const written = middle
    .split(BREAK)
    .map((text) => encodeText(text, keepNbsp))
    .join(breakSpelling);
  return source.slice(segStart, from) + written + source.slice(to, segEnd);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function flatExpected(items: EditItem[], chipSources: string[]): string {
  return items
    .map((item) =>
      item.kind === 'chip'
        ? CHIP_OPEN + (chipSources[item.index] ?? '') + CHIP_CLOSE
        : item.kind === 'break'
          ? BREAK
          : item.text.replace(/[\uE000-\uE003]/g, ''),
    )
    .join('')
    .replace(new RegExp(NBSP, 'g'), ' ');
}

/** Whether the region at `tagStart` of `source` holds exactly the expected text, chips and breaks. */
function readsBack(
  source: string,
  engine: EngineId,
  tagStart: number,
  expected: string,
): boolean {
  const scanned = scanRegion(source, engine, tagStart);
  if ('reason' in scanned) return false;
  // a kept `#` meeting a typed `}` would end a comment that never started (see encodeText)
  if (
    engine === 'jinja2' &&
    scanned.parts.some(
      (p) => p.kind === 'text' && source.slice(p.start, p.end).includes('#}'),
    )
  )
    return false;
  const flat = scanned.parts
    .map((part) =>
      part.kind === 'text'
        ? decodeText(source.slice(part.start, part.end)).text
        : part.kind === 'break'
          ? BREAK
          : CHIP_OPEN + source.slice(part.start, part.end) + CHIP_CLOSE,
    )
    .join('')
    .replace(new RegExp(NBSP, 'g'), ' ');
  return flat === expected;
}
