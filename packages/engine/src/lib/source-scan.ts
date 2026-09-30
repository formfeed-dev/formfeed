import type { EngineId } from './types';

/**
 * A template source read as HTML with template constructs in it: the scanner that finds start tags
 * for click-to-source (`source-positions.ts`) and the regions text can be edited in from the preview
 * (`source-edit.ts`). It knows each engine's delimiters, string literals inside expressions, raw and
 * comment blocks, and blocks whose output is captured as a string. Internal to the engine.
 */

export const tagName = /[A-Za-z][^\s/>{}<"'=]*/y;

/** Elements whose content the HTML parser reads as text, so a `<b>` inside is not an element. */
export const rawTextElements = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);

/** Blocks whose content the engine never parses: skipped up to their end tag. */
const literalBlocks: Record<EngineId, Set<string>> = {
  jinja2: new Set(['raw', 'verbatim']),
  liquid: new Set(['raw', 'comment']),
  handlebars: new Set(),
};

/** Blocks whose rendered content becomes a string the template can inspect or transform. */
const capturingBlocks: Record<EngineId, Set<string>> = {
  jinja2: new Set(['set', 'filter']),
  liquid: new Set(['capture']),
  handlebars: new Set(),
};

interface TemplateTag {
  end: number;
  keyword?: string;
  rest?: string;
}

/**
 * What a template construct is, for a reader that has to tell output from control flow: `output` is
 * a value printed in place (`{{ x }}`, `{{{ x }}}`, `{{t 'k'}}`), `comment` prints nothing, and
 * `statement` is everything that decides what is printed (`{% if %}`, `{{#each}}`, `{{else}}`,
 * `{{> partial}}`, raw blocks).
 */
export type TemplateConstruct =
  | { type: 'output'; end: number; inner: string }
  | { type: 'comment'; end: number }
  | { type: 'statement'; end: number; keyword?: string };

export class Scanner {
  private readonly n: number;
  private readonly escapes: boolean;

  constructor(
    private readonly source: string,
    private readonly engine: EngineId,
  ) {
    this.n = source.length;
    this.escapes = engine !== 'handlebars';
  }

  /** End of the template construct starting at `at` (with a capturing block's body), or null. */
  skipTemplate(at: number): number | null {
    const tag = this.templateTag(at);
    if (!tag) return null;
    if (tag.keyword && this.captures(tag.keyword, tag.rest ?? ''))
      return this.blockEnd(tag.end, tag.keyword);
    return tag.end;
  }

  /** The construct starting at `at` and what kind it is, or null when `{` starts none. */
  classify(at: number): TemplateConstruct | null {
    const s = this.source;
    const tag = this.templateTag(at);
    if (!tag) return null;
    if (this.engine === 'handlebars') {
      if (s.startsWith('{{{{', at)) return { type: 'statement', end: tag.end };
      if (s.startsWith('{{!', at)) return { type: 'comment', end: tag.end };
      if (s.startsWith('{{{', at))
        return {
          type: 'output',
          end: tag.end,
          inner: s.slice(at + 3, tag.end - 3),
        };
      const inner = s.slice(at + 2, tag.end - 2);
      const head = inner.replace(/^~?\s*/, '');
      if (/^[#/^>*]/.test(head) || /^else(?:\s|~?$)/.test(head))
        return { type: 'statement', end: tag.end };
      return { type: 'output', end: tag.end, inner };
    }
    if (s.startsWith('{#', at)) return { type: 'comment', end: tag.end };
    if (s.startsWith('{{', at))
      return {
        type: 'output',
        end: tag.end,
        inner: s.slice(at + 2, tag.end - 2),
      };
    // an inline Liquid comment (`{% # note %}`) prints nothing
    if (/^\{%[-+~]?\s*#/.test(s.slice(at, at + 64)))
      return { type: 'comment', end: tag.end };
    const end =
      tag.keyword && this.captures(tag.keyword, tag.rest ?? '')
        ? this.blockEnd(tag.end, tag.keyword)
        : tag.end;
    return { type: 'statement', end, keyword: tag.keyword };
  }

  /** Index after `close`, stepping over template constructs; the end of the source when missing. */
  skipTo(from: number, close: string): number {
    let j = from;
    while (j < this.n) {
      if (this.source.startsWith(close, j)) return j + close.length;
      j = this.source[j] === '{' ? (this.skipTemplate(j) ?? j + 1) : j + 1;
    }
    return this.n;
  }

  /** Index after the `>` that ends a tag, stepping over quoted values and template constructs. */
  tagEnd(from: number): number {
    const s = this.source;
    let j = from;
    let lastSignificant = '';
    while (j < this.n) {
      const ch = s[j] ?? '';
      if (ch === '{') {
        const end = this.skipTemplate(j);
        if (end !== null) {
          j = end;
          lastSignificant = '}';
          continue;
        }
      }
      if ((ch === '"' || ch === "'") && lastSignificant === '=') {
        j = this.skipTo(j + 1, ch);
        lastSignificant = ch;
        continue;
      }
      if (ch === '>') return j + 1;
      if (!/\s/.test(ch)) lastSignificant = ch;
      j++;
    }
    return this.n;
  }

  /** Index of the `</name` that closes a raw text element. */
  skipToClosingTag(from: number, name: string): number {
    const s = this.source;
    const lower = name.toLowerCase();
    let j = from;
    while (j < this.n) {
      if (
        s[j] === '<' &&
        s[j + 1] === '/' &&
        s.slice(j + 2, j + 2 + lower.length).toLowerCase() === lower &&
        !/[^\s/>]/.test(s[j + 2 + lower.length] ?? '>')
      )
        return j;
      j = s[j] === '{' ? (this.skipTemplate(j) ?? j + 1) : j + 1;
    }
    return this.n;
  }

  private captures(keyword: string, rest: string): boolean {
    if (!capturingBlocks[this.engine].has(keyword)) return false;
    // `{% set x = 1 %}` is a statement; only `{% set x %}…{% endset %}` has a body
    return keyword !== 'set' || !rest.includes('=');
  }

  private blockEnd(from: number, keyword: string): number {
    let depth = 1;
    let j = from;
    while (j < this.n) {
      if (this.source[j] !== '{') {
        j++;
        continue;
      }
      const tag = this.templateTag(j);
      if (!tag) {
        j++;
        continue;
      }
      if (tag.keyword === keyword && this.captures(keyword, tag.rest ?? ''))
        depth++;
      else if (tag.keyword === `end${keyword}` && --depth === 0) return tag.end;
      j = tag.end;
    }
    return this.n;
  }

  private templateTag(at: number): TemplateTag | null {
    const s = this.source;
    if (s[at] !== '{') return null;
    if (this.engine === 'handlebars') {
      if (s.startsWith('{{{{', at)) return { end: this.handlebarsRawBlock(at) };
      if (s.startsWith('{{!--', at))
        return { end: this.indexAfter(at + 5, '--}}') };
      if (s.startsWith('{{!', at))
        return { end: this.indexAfter(at + 3, '}}') };
      if (s.startsWith('{{{', at))
        return { end: this.expressionEnd(at + 3, '}}}') };
      if (s.startsWith('{{', at))
        return { end: this.expressionEnd(at + 2, '}}') };
      return null;
    }
    if (this.engine === 'jinja2' && s.startsWith('{#', at))
      return { end: this.indexAfter(at + 2, '#}') };
    if (s.startsWith('{{', at))
      return { end: this.expressionEnd(at + 2, '}}') };
    if (!s.startsWith('{%', at)) return null;
    // an inline comment (`{% # it's %}`) is prose: its apostrophes open no string
    const end = /^[-+~]?\s*#/.test(s.slice(at + 2, at + 64))
      ? this.indexAfter(at + 2, '%}')
      : this.expressionEnd(at + 2, '%}');
    const inner = /^[-+~]?\s*(\w+)([\s\S]*)$/.exec(
      s.slice(at + 2, Math.max(at + 2, end - 2)),
    );
    const keyword = inner?.[1];
    if (!keyword) return { end };
    if (literalBlocks[this.engine].has(keyword)) {
      const close = new RegExp(
        `\\{%[-+~]?\\s*end${keyword}\\s*[-+~]?%\\}`,
        'g',
      );
      close.lastIndex = end;
      const match = close.exec(s);
      return { end: match ? match.index + match[0].length : this.n, keyword };
    }
    return { end, keyword, rest: inner?.[2] ?? '' };
  }

  /** `{{{{raw}}}} … {{{{/raw}}}}`: the content is never parsed. */
  private handlebarsRawBlock(at: number): number {
    const s = this.source;
    const openEnd = this.indexAfter(at + 4, '}}}}');
    const name =
      s
        .slice(at + 4, openEnd - 4)
        .trim()
        .split(/\s/)[0] ?? '';
    if (!name || name.startsWith('/')) return openEnd;
    return this.indexAfter(openEnd, `{{{{/${name}}}}}`);
  }

  private indexAfter(from: number, close: string): number {
    const index = this.source.indexOf(close, from);
    return index < 0 ? this.n : index + close.length;
  }

  /** End of an expression or statement; a `close` inside a string literal does not end it. */
  private expressionEnd(from: number, close: string): number {
    const s = this.source;
    let quote: string | null = null;
    for (let j = from; j < this.n; j++) {
      const ch = s[j];
      if (quote) {
        if (this.escapes && ch === '\\') j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (s.startsWith(close, j)) return j + close.length;
    }
    // an unbalanced quote (an apostrophe in a Liquid `{% # comment %}`): the first close ends it
    return this.indexAfter(from, close);
  }
}

/** Offsets where lines start; `\r\n`, `\n` and a lone `\r` all end a line, as in Monaco. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 13) {
      if (source.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (ch === 10) starts.push(i + 1);
  }
  return starts;
}

export function locate(
  starts: number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

/** The offset of a 1-based line and column, or null when the source has no such place. */
export function offsetOf(
  starts: number[],
  sourceLength: number,
  line: number,
  column: number,
): number | null {
  const start = starts[line - 1];
  if (start === undefined || column < 1) return null;
  const offset = start + column - 1;
  const next = starts[line] ?? sourceLength + 1;
  return offset < next ? offset : null;
}
