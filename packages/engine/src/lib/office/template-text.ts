import { OfficeError } from './errors';
import { assertWellFormed, decodeText, escapeText, stripForbidden, tokenize, type XmlToken } from './xml';

/**
 * How an office part becomes template source and back (spec 22 §4.3 steps 5–7).
 *
 * Only the characters of text elements (`w:t`, `a:t`) are template text, decoded. Every run of markup
 * between them becomes one placeholder, `U+E000 <nonce> <index> U+E001`, so the engine sees plain text
 * with opaque markers and renders with its escaping switched off. On the way back every text segment is
 * escaped and every placeholder restored. Whatever an expression prints therefore lands as text: `safe`,
 * `{{{ }}}`, `raw`, `{% echo %}` and `capture` cannot put markup into the document, and nothing is
 * escaped twice. The nonce is random per render, so data cannot forge a placeholder.
 */

export type TextFlavour = 'wordprocessing' | 'drawing';

const TEXT_ELEMENT: Record<TextFlavour, string> = { wordprocessing: 'w:t', drawing: 'a:t' };

export interface TemplateSource {
  /** The part as template text: decoded text of the text elements, placeholders for the markup. */
  source: string;
  markup: string[];
  nonce: string;
  flavour: TextFlavour;
}

export interface FilledPart {
  xml: string;
  /** Characters XML does not allow that values contained and that were removed. */
  removedCharacters: number;
}

const OPEN = '\uE000';
const CLOSE = '\uE001';

/** A nonce of letters only, so it never reads as a number next to the index. */
export function createNonce(random: () => number = Math.random): string {
  let nonce = '';
  for (let i = 0; i < 16; i++) nonce += String.fromCharCode(97 + Math.floor(random() * 26));
  return nonce;
}

export function toTemplateSource(xml: string, flavour: TextFlavour, nonce: string, part?: string): TemplateSource {
  const tokens = tokenize(xml, part);
  assertWellFormed(tokens, part);
  const textElement = TEXT_ELEMENT[flavour];
  const markup: string[] = [];
  let source = '';
  let pending = '';
  let inText = false;
  const flush = () => {
    if (!pending) return;
    source += `${OPEN}${nonce}${markup.length}${CLOSE}`;
    markup.push(pending);
    pending = '';
  };
  for (const token of tokens) {
    if (token.kind === 'text' && inText) {
      flush();
      source += decodeText(token.raw);
      continue;
    }
    pending += token.raw;
    if (token.kind === 'open' && token.name === textElement && !token.selfClosing) inText = true;
    else if (token.kind === 'close' && token.name === textElement) inText = false;
  }
  flush();
  return { source, markup, nonce, flavour };
}

/** Restores the markup into rendered output and turns line breaks and tabs from data into elements. */
export function fromTemplateOutput(output: string, template: TemplateSource, part?: string): FilledPart {
  const placeholder = new RegExp(`${OPEN}${template.nonce}(\\d+)${CLOSE}`, 'g');
  let xml = '';
  let removedCharacters = 0;
  let last = 0;
  for (const m of output.matchAll(placeholder)) {
    const { text, removed } = stripForbidden(output.slice(last, m.index));
    removedCharacters += removed;
    xml += escapeText(text);
    const piece = template.markup[Number(m[1])];
    if (piece === undefined) throw new OfficeError('office_document_invalid', `${part ?? 'part'}: unknown placeholder`);
    xml += piece;
    last = (m.index ?? 0) + m[0].length;
  }
  const { text, removed } = stripForbidden(output.slice(last));
  removedCharacters += removed;
  xml += escapeText(text);
  const laidOut = layoutText(xml, template.flavour, part);
  return { xml: laidOut, removedCharacters };
}

/**
 * Line breaks and tabs inside text elements become elements, text elements with leading or trailing
 * whitespace get `xml:space="preserve"`, and text that ended up outside a text element (possible only
 * when a template prints between runs) is refused, because Word rejects such a document.
 */
export function layoutText(xml: string, flavour: TextFlavour, part?: string): string {
  const tokens = tokenize(xml, part);
  const textElement = TEXT_ELEMENT[flavour];
  const out: string[] = [];
  let textOpenIndex = -1;
  let runProperties = '';
  let capturingProperties = false;
  for (const token of tokens) {
    if (flavour === 'drawing') trackRunProperties(token);
    if (token.kind === 'open' && token.name === textElement && !token.selfClosing) {
      textOpenIndex = out.length;
      out.push(token.raw);
      continue;
    }
    if (token.kind === 'close' && token.name === textElement) {
      textOpenIndex = -1;
      out.push(token.raw);
      continue;
    }
    if (token.kind !== 'text') {
      out.push(token.raw);
      continue;
    }
    if (textOpenIndex === -1) {
      if (token.raw.trim() !== '')
        throw new OfficeError('office_document_invalid', `${part ?? 'part'}: text outside a text element: "${token.raw.trim().slice(0, 40)}"`);
      out.push(token.raw);
      continue;
    }
    const text = token.raw.replace(/\r\n?/g, '\n');
    if (flavour === 'wordprocessing') {
      const pieces = text.split(/(\n|\t)/);
      if (pieces.length > 1 || /^\s|\s$/.test(text)) out[textOpenIndex] = preserveSpace(out[textOpenIndex]!);
      out.push(
        pieces
          .map((p) => (p === '\n' ? '</w:t><w:br/><w:t xml:space="preserve">' : p === '\t' ? '</w:t><w:tab/><w:t xml:space="preserve">' : p))
          .join(''),
      );
    } else {
      // DrawingML has no break inside a run: close the run, add a:br, and open a new run with the same properties.
      out.push(text.split('\n').join(`</a:t></a:r><a:br>${runProperties}</a:br><a:r>${runProperties}<a:t>`));
    }
  }
  return out.join('');

  function trackRunProperties(token: XmlToken): void {
    if (token.kind === 'open' && token.name === 'a:r') runProperties = '';
    if (token.kind === 'open' && token.name === 'a:rPr') {
      runProperties = token.raw;
      capturingProperties = !token.selfClosing;
      return;
    }
    if (capturingProperties) {
      runProperties += token.raw;
      if (token.kind === 'close' && token.name === 'a:rPr') capturingProperties = false;
    }
  }
}

function preserveSpace(openTag: string): string {
  return /\sxml:space\s*=/.test(openTag) ? openTag : openTag.replace(/^<([\w:]+)/, '<$1 xml:space="preserve"');
}
