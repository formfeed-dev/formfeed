import { OfficeError } from './errors';

/**
 * A small XML tokenizer for office parts (spec 22 §4.3). Not a DOM: the rewrite has to keep every byte
 * it does not change (a DOM round trip reorders namespace declarations and quoting), and the engine runs
 * in browsers and Node without `DOMParser`. OOXML parts are machine-written XML without DTDs, which
 * keeps this small; anything outside that shape is refused rather than guessed at.
 */

export type XmlToken =
  | { kind: 'open'; raw: string; name: string; selfClosing: boolean }
  | { kind: 'close'; raw: string; name: string }
  | { kind: 'text'; raw: string }
  | { kind: 'cdata'; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'pi'; raw: string };

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;

const invalid = (message: string, part?: string) =>
  new OfficeError('office_document_invalid', part ? `${part}: ${message}` : message, part ? { entry: part } : {});

/** Splits XML into tokens whose `raw` strings concatenate back to the input exactly. */
export function tokenize(xml: string, part?: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf('<', at);
    if (lt === -1) {
      tokens.push({ kind: 'text', raw: xml.slice(at) });
      break;
    }
    if (lt > at) tokens.push({ kind: 'text', raw: xml.slice(at, lt) });
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw invalid('unterminated comment', part);
      tokens.push({ kind: 'comment', raw: xml.slice(lt, end + 3) });
      at = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw invalid('unterminated CDATA section', part);
      tokens.push({ kind: 'cdata', raw: xml.slice(lt, end + 3) });
      at = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw invalid('unterminated processing instruction', part);
      tokens.push({ kind: 'pi', raw: xml.slice(lt, end + 2) });
      at = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      throw invalid('declarations such as DOCTYPE are not allowed', part);
    } else {
      const end = tagEnd(xml, lt);
      if (end === -1) throw invalid('unterminated tag', part);
      const raw = xml.slice(lt, end + 1);
      if (raw[1] === '/') {
        const name = NAME.exec(raw.slice(2))?.[0];
        if (!name || raw.slice(2 + name.length, -1).trim() !== '') throw invalid(`malformed end tag ${raw.slice(0, 40)}`, part);
        tokens.push({ kind: 'close', raw, name });
      } else {
        const name = NAME.exec(raw.slice(1))?.[0];
        if (!name) throw invalid(`malformed tag ${raw.slice(0, 40)}`, part);
        tokens.push({ kind: 'open', raw, name, selfClosing: raw.endsWith('/>') });
      }
      at = end + 1;
    }
  }
  return tokens;
}

/** Index of the `>` that closes the tag starting at `start`, skipping quoted attribute values. */
function tagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    else if (c === '<') return -1;
  }
  return -1;
}

/**
 * Throws unless the tokens form one well-formed element: balanced tags, one root, valid entity
 * references in text and attributes, no characters XML 1.0 forbids.
 */
export function assertWellFormed(tokens: readonly XmlToken[], part?: string): void {
  const stack: string[] = [];
  let roots = 0;
  for (const token of tokens) {
    switch (token.kind) {
      case 'open': {
        checkAttributes(token.raw, part);
        if (stack.length === 0) roots++;
        if (!token.selfClosing) stack.push(token.name);
        break;
      }
      case 'close': {
        const open = stack.pop();
        if (open !== token.name) throw invalid(`</${token.name}> closes <${open ?? 'nothing'}>`, part);
        break;
      }
      case 'text':
        if (stack.length === 0 && token.raw.trim() !== '') throw invalid('text outside the root element', part);
        checkText(token.raw, part);
        break;
      default:
        break;
    }
  }
  if (stack.length) throw invalid(`<${stack.at(-1)}> is not closed`, part);
  if (roots !== 1) throw invalid(roots === 0 ? 'no root element' : 'more than one root element', part);
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ENTITY = /&(?:#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/y;

function checkText(text: string, part?: string): void {
  if (FORBIDDEN.test(text)) throw invalid('a character XML does not allow', part);
  if (text.includes('<')) throw invalid('unescaped < in text', part);
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    ENTITY.lastIndex = i;
    if (!ENTITY.test(text)) throw invalid(`invalid entity reference near "${text.slice(i, i + 12)}"`, part);
  }
}

function checkAttributes(raw: string, part?: string): void {
  const body = raw.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  const seen = new Set<string>();
  const rest = body.replace(/\s*([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_m, name: string, _q, dq?: string, sq?: string) => {
    if (seen.has(name)) throw invalid(`duplicate attribute ${name}`, part);
    seen.add(name);
    const value = dq ?? sq ?? '';
    checkText(value, part);
    return '';
  });
  if (rest.trim() !== '') throw invalid(`malformed attributes in ${raw.slice(0, 40)}`, part);
}

/** Text content as characters: entity references resolved. */
export function decodeText(raw: string): string {
  return raw.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

/** Characters as text content. `>` is escaped too, so `]]>` can never appear. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN_GLOBAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes the characters XML 1.0 forbids; `removed` counts them for the render's warnings. */
export function stripForbidden(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(FORBIDDEN_GLOBAL, () => {
    removed++;
    return '';
  });
  return { text: out, removed };
}
