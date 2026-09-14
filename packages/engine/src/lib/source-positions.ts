import type { EngineId } from './types';

/**
 * Click-to-source for the editor's previews (spec 06 §3): every HTML start tag written literally in
 * the template source gets `data-ff-src="<file>:<line>:<column>"` right after its tag name, so the
 * rendered element says where it came from instead of the editor searching the template for it.
 * Elements from a loop all point at the loop body, which is the line that wrote them.
 *
 * The annotation must never change what the template means: tags inside template syntax, in
 * blocks whose output is captured or filtered as a string (`{% set %}…{% endset %}`, `{% filter %}`,
 * `{% capture %}`), in raw and comment blocks, in `<script>`/`<style>`/`<textarea>`/`<title>` and
 * HTML comments, closing tags, declarations, tags whose name is built by template syntax and tags
 * that already carry the attribute stay untouched. Removing the attribute from the rendered output
 * gives the document of the original source. Preview only: saved versions, API renders and the
 * render-worker never see it.
 */
export type SourceFile = 'body' | 'header' | 'footer';

export const sourceAttribute = 'data-ff-src';

export interface SourceLocation {
  file: SourceFile;
  /** 1-based, as Monaco counts. */
  line: number;
  /** 1-based UTF-16 column of the tag's `<`. */
  column: number;
}

/** Parses a `data-ff-src` value; null when it is not one. */
export function parseSourceAttribute(value: string | null | undefined): SourceLocation | null {
  const match = /^(body|header|footer):(\d+):(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (line < 1 || column < 1) return null;
  return { file: match[1] as SourceFile, line, column };
}

export function annotateSourcePositions(source: string, engine: EngineId, file: SourceFile): string {
  const scanner = new Scanner(source, engine);
  const lines = lineStarts(source);
  const out: string[] = [];
  let copied = 0;
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '{') {
      i = scanner.skipTemplate(i) ?? i + 1;
      continue;
    }
    if (ch !== '<') {
      i++;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      i = scanner.skipTo(i + 4, '-->');
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      i = scanner.skipTo(i + 9, ']]>');
      continue;
    }
    const next = source[i + 1];
    if (next === '!' || next === '?') {
      i = scanner.tagEnd(i + 2);
      continue;
    }
    if (next === '/') {
      // a closing tag: nothing to annotate, its name is plain text
      i += 2;
      continue;
    }
    tagName.lastIndex = i + 1;
    const name = tagName.exec(source)?.[0];
    if (!name) {
      i++;
      continue;
    }
    const nameEnd = i + 1 + name.length;
    const end = scanner.tagEnd(nameEnd);
    const after = source[nameEnd];
    // `<h{{ level }}>` builds its name with template syntax: there is no safe place to insert
    const plainName = after === undefined || after === '>' || after === '/' || /\s/.test(after);
    if (plainName && !source.slice(nameEnd, end).toLowerCase().includes(sourceAttribute)) {
      const { line, column } = locate(lines, i);
      out.push(source.slice(copied, nameEnd), ` ${sourceAttribute}="${file}:${line}:${column}"`);
      copied = nameEnd;
    }
    i = end;
    if (rawTextElements.has(name.toLowerCase()) && source[end - 1] === '>')
      i = scanner.skipToClosingTag(end, name);
  }
  out.push(source.slice(copied));
  return out.join('');
}

const tagName = /[A-Za-z][^\s/>{}<"'=]*/y;

/** Elements whose content the HTML parser reads as text, so a `<b>` inside is not an element. */
const rawTextElements = new Set([
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

class Scanner {
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
      if (tag.keyword === keyword && this.captures(keyword, tag.rest ?? '')) depth++;
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
      if (s.startsWith('{{!--', at)) return { end: this.indexAfter(at + 5, '--}}') };
      if (s.startsWith('{{!', at)) return { end: this.indexAfter(at + 3, '}}') };
      if (s.startsWith('{{{', at)) return { end: this.expressionEnd(at + 3, '}}}') };
      if (s.startsWith('{{', at)) return { end: this.expressionEnd(at + 2, '}}') };
      return null;
    }
    if (this.engine === 'jinja2' && s.startsWith('{#', at))
      return { end: this.indexAfter(at + 2, '#}') };
    if (s.startsWith('{{', at)) return { end: this.expressionEnd(at + 2, '}}') };
    if (!s.startsWith('{%', at)) return null;
    // an inline comment (`{% # it's %}`) is prose: its apostrophes open no string
    const end = /^[-+~]?\s*#/.test(s.slice(at + 2, at + 64))
      ? this.indexAfter(at + 2, '%}')
      : this.expressionEnd(at + 2, '%}');
    const inner = /^[-+~]?\s*(\w+)([\s\S]*)$/.exec(s.slice(at + 2, Math.max(at + 2, end - 2)));
    const keyword = inner?.[1];
    if (!keyword) return { end };
    if (literalBlocks[this.engine].has(keyword)) {
      const close = new RegExp(`\\{%[-+~]?\\s*end${keyword}\\s*[-+~]?%\\}`, 'g');
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
    const name = s.slice(at + 4, openEnd - 4).trim().split(/\s/)[0] ?? '';
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
function lineStarts(source: string): number[] {
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

function locate(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}
