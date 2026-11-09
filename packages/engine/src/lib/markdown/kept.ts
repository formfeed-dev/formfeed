/**
 * The HTML that helpers write in a Markdown render with an engine (plan 29 §5). The template renders
 * first and its text is read as Markdown afterwards, so a helper's HTML (`chart`, `image`,
 * `markdown`, `nl2br`, `pageBreak`) would meet the `safe` mode as raw HTML and be shown as text.
 * Instead each helper hands its HTML here and returns a placeholder, which passes through the
 * converter as text and is put back afterwards: as HTML where it stands in text, as text inside code
 * and attributes. The placeholder carries a nonce of the render, so data cannot forge one, as a
 * drawing's placeholder in a Word template cannot be (`office/drawings.ts`).
 */

/** Opening and closing characters of a placeholder; office drawings use U+E002 and U+E003. */
export const KEPT_OPEN = String.fromCharCode(0xe004);
export const KEPT_CLOSE = String.fromCharCode(0xe005);

/** What the converter needs to put the HTML back: the render's nonce and the HTML in order. */
export interface KeptHtml {
  readonly nonce: string;
  readonly html: readonly string[];
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Sixteen hexadecimal digits from the platform's random source (Web Crypto, also in Node). */
export function keptNonce(): string {
  const bytes = new Uint8Array(8);
  // the global, not `globalThis.crypto`: the Workers typings declare it a constant, which is no
  // property of `globalThis`, and the gateway type-checks this file
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

/** The placeholders of a nonce; the index is the HTML's position. */
export function keptPattern(nonce: string): RegExp {
  return new RegExp(`${KEPT_OPEN}${nonce}:(\\d+)${KEPT_CLOSE}`, 'g');
}

/** The same placeholders as a URL holds them, once markdown-it has percent-encoded an address. */
function encodedPattern(nonce: string): RegExp {
  return new RegExp(`%EE%80%84${nonce}:\\d+%EE%80%85`, 'gi');
}

/** Collects the HTML of one render's helpers and hands out their placeholders. */
export class KeptHtmlCollector implements KeptHtml {
  readonly html: string[] = [];
  private readonly pattern: RegExp;

  constructor(readonly nonce: string = keptNonce()) {
    this.pattern = keptPattern(nonce);
  }

  /**
   * Keeps a helper's HTML and returns its placeholder. HTML that holds a placeholder of its own (a
   * helper given another helper's result) gets that HTML back first, so the converter never has to
   * look twice.
   */
  readonly keep = (html: string): string => {
    const own = html.includes(KEPT_OPEN)
      ? html.replace(this.pattern, (_, i: string) => this.html[Number(i)] ?? '')
      : html;
    this.html.push(own);
    return `${KEPT_OPEN}${this.nonce}:${this.html.length - 1}${KEPT_CLOSE}`;
  };
}

/** Whether a text holds a placeholder of the render; cheap enough to ask of every token. */
export function holdsKept(text: string, kept: KeptHtml | undefined): boolean {
  return !!kept && kept.html.length > 0 && text.includes(KEPT_OPEN);
}

/**
 * Puts the kept HTML back into a text. `as: 'html'` writes it as markup (text and raw HTML of the
 * document), `as: 'text'` writes the markup as text (inside an attribute), `as: 'none'` removes the
 * placeholder (a title or an id, which take no markup).
 */
export function restoreKept(
  text: string,
  kept: KeptHtml | undefined,
  as: 'html' | 'text' | 'none',
  escape: (s: string) => string,
): string {
  if (!kept || !holdsKept(text, kept)) return text;
  return text.replace(keptPattern(kept.nonce), (_, i: string) => {
    if (as === 'none') return '';
    const html = kept.html[Number(i)] ?? '';
    return as === 'html' ? html : escape(html);
  });
}

/** Removes the placeholders an address percent-encoded, which name nothing once encoded. */
export function dropEncodedKept(
  html: string,
  kept: KeptHtml | undefined,
): string {
  if (!kept || kept.html.length === 0 || !html.includes('%EE%80%84'))
    return html;
  return html.replace(encodedPattern(kept.nonce), '');
}
