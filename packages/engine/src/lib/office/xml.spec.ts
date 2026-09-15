import { describe, expect, it } from 'vitest';
import { OfficeError } from './errors';
import { assertWellFormed, decodeText, escapeText, stripForbidden, tokenize } from './xml';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof OfficeError ? e.code : String(e);
  }
  return undefined;
};

const DOC =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p w14:paraId=\'1A2B\'><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">R&amp;D &gt; 5 </w:t></w:r></w:p><!-- note --></w:body></w:document>';

describe('tokenize', () => {
  it('round-trips a part byte for byte', () => {
    const tokens = tokenize(DOC);
    expect(tokens.map((t) => t.raw).join('')).toBe(DOC);
    expect(tokens.filter((t) => t.kind === 'open').map((t) => (t.kind === 'open' ? t.name : ''))).toEqual([
      'w:document',
      'w:body',
      'w:p',
      'w:r',
      'w:rPr',
      'w:b',
      'w:t',
    ]);
    expect(tokens.find((t) => t.kind === 'comment')?.raw).toBe('<!-- note -->');
  });

  it('keeps a > inside a quoted attribute value in the tag', () => {
    const tokens = tokenize('<a title="x > y"/>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'open', name: 'a', selfClosing: true });
  });

  it('refuses declarations and unterminated constructs', () => {
    expect(code(() => tokenize('<!DOCTYPE x><x/>'))).toBe('office_document_invalid');
    expect(code(() => tokenize('<x><!-- open'))).toBe('office_document_invalid');
    expect(code(() => tokenize('<x attr="1"'))).toBe('office_document_invalid');
    expect(code(() => tokenize('<x></ y>'))).toBe('office_document_invalid');
  });
});

describe('assertWellFormed', () => {
  it('accepts a real part', () => {
    expect(() => assertWellFormed(tokenize(DOC))).not.toThrow();
  });

  it('refuses what Word would refuse', () => {
    const bad = [
      '<a><b></a></b>',
      '<a>',
      '<a/><b/>',
      '<a>R&D</a>',
      '<a>&nbsp;</a>',
      '<a x="1" x="2"/>',
      '<a x="&bad;"/>',
      '<a>\u0001</a>',
      '<a>\uD800</a>',
      'text<a/>',
    ];
    for (const xml of bad) expect(code(() => assertWellFormed(tokenize(xml))), xml).toBe('office_document_invalid');
    expect(() => assertWellFormed(tokenize('<a>😀 &#x1F600; &#9;</a>'))).not.toThrow();
  });
});

describe('text helpers', () => {
  it('decodes and escapes text', () => {
    expect(decodeText('R&amp;D &lt;b&gt; &quot;q&quot; &apos;s&apos; &#x41;&#66; &unknown;')).toBe(`R&D <b> "q" 's' AB &unknown;`);
    expect(escapeText('R&D <b> ]]>')).toBe('R&amp;D &lt;b&gt; ]]&gt;');
    expect(decodeText(escapeText('a & b < c > d'))).toBe('a & b < c > d');
  });

  it('strips characters XML forbids and counts them', () => {
    expect(stripForbidden('a\u0000b\u0007c\td\ne\uFFFF😀\uDC00')).toEqual({ text: 'abc\td\ne😀', removed: 4 });
  });
});
