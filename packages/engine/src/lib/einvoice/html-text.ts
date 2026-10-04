/**
 * The text of a rendered HTML document, for the display check before anything is rendered to PDF
 * (spec 17 §5.2, §8): the editor holds the preview's document against the invoice, and the CLI the
 * document it renders locally. The render itself checks the text of the finished PDF, which the
 * sidecar extracts; this is the early warning, and it reads the markup, not the page.
 *
 * So it does not know what CSS hides or generates. What it must get right is where one number ends
 * and the next begins: two table cells are two amounts, and an amount set in two `<span>`s is one.
 * Elements that flow in a line join their text; every other element ends the line.
 *
 * No DOM is used: the engine runs in a Worker and in Node as well as in the browser.
 */

/** Elements whose text runs on in the line they are in. */
const INLINE = new Set([
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
  'ins',
  'kbd',
  'label',
  'mark',
  'nobr',
  'output',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** Elements whose content is not text of the page. */
const SKIPPED = ['script', 'style', 'template', 'noscript', 'head', 'title'];

/**
 * The named references a rendered invoice plausibly contains, by code point (half of these
 * characters are invisible in an editor); anything else stays as written.
 */
const ENTITIES: Record<string, number> = {
  amp: 0x26,
  lt: 0x3c,
  gt: 0x3e,
  quot: 0x22,
  apos: 0x27,
  nbsp: 0xa0,
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
  shy: 0xad,
  minus: 0x2212,
  ndash: 0x2013,
  mdash: 0x2014,
  hyphen: 0x2010,
  euro: 0x20ac,
  pound: 0xa3,
  yen: 0xa5,
  cent: 0xa2,
  sect: 0xa7,
  middot: 0xb7,
  bull: 0x2022,
  times: 0xd7,
  auml: 0xe4,
  ouml: 0xf6,
  uuml: 0xfc,
  Auml: 0xc4,
  Ouml: 0xd6,
  Uuml: 0xdc,
  szlig: 0xdf,
  eacute: 0xe9,
  egrave: 0xe8,
  agrave: 0xe0,
  ccedil: 0xe7,
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (whole, reference: string) => {
      const code = reference.startsWith('#')
        ? reference[1] === 'x' || reference[1] === 'X'
          ? Number.parseInt(reference.slice(2), 16)
          : Number.parseInt(reference.slice(1), 10)
        : ENTITIES[reference];
      return code !== undefined &&
        Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

/**
 * The text a reader of `html` sees, as far as the markup says: comments, scripts and styles left
 * out, references decoded, and a line break wherever an element that is not inline starts or ends.
 */
export function htmlText(html: string): string {
  let source = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of SKIPPED)
    source = source.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'),
      '\n',
    );
  let out = '';
  let position = 0;
  // a tag, with quoted attribute values that may themselves hold a `>`
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    out += source.slice(position, match.index);
    position = match.index + match[0].length;
    const name = (match[1] ?? '').toLowerCase();
    if (name === 'br' || !INLINE.has(name)) out += '\n';
  }
  out += source.slice(position);
  return decodeEntities(out)
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}
