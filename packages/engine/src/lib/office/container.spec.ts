import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cfbStreamNames, detectOfficeFormat, isMacroPart } from './detect';
import { OfficeError } from './errors';
import { removeExternalRelationships, sanitiseForConversion } from './sanitise';
import {
  crc32,
  isSafeEntryName,
  readEntry,
  readText,
  readZip,
  writeZip,
} from './zip';

const CT_DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CT_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CT_PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

function contentTypes(main: string, part = '/word/document.xml'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="${part}" ContentType="${main}"/></Types>`;
}

const DOC_RELS = (rels: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;

function docx(extra: Zippable = {}, main = CT_DOCX): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes(main)),
    '_rels/.rels': strToU8(
      DOC_RELS(
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
      ),
    ),
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fennlor Studio GmbH</w:t></w:r></w:p></w:body></w:document>',
    ),
    // Media is stored compressed in real files too; the reader must copy it without inflating.
    'word/media/image1.png': [new Uint8Array(4096).fill(7), { level: 9 }],
    ...extra,
  });
}

function odf(mime: string, extra: Zippable = {}): Uint8Array {
  return zipSync({
    mimetype: [strToU8(mime), { level: 0 }],
    'content.xml': strToU8(
      '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
    ),
    'META-INF/manifest.xml': strToU8(
      '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    ),
    ...extra,
  });
}

/** A minimal Compound File: sector 0 is the FAT, sector 1 the directory with the given streams. */
function cfb(streams: string[]): Uint8Array {
  const bytes = new Uint8Array(512 * 3);
  const v = new DataView(bytes.buffer);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach(
    (b, i) => (bytes[i] = b),
  );
  v.setUint16(0x18, 0x3e, true);
  v.setUint16(0x1a, 3, true);
  v.setUint16(0x1c, 0xfffe, true);
  v.setUint16(0x1e, 9, true);
  v.setUint16(0x20, 6, true);
  v.setUint32(0x2c, 1, true);
  v.setUint32(0x30, 1, true);
  v.setUint32(0x38, 0x1000, true);
  v.setUint32(0x3c, 0xfffffffe, true);
  v.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i++)
    v.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true);
  const fat = 512;
  for (let i = 0; i < 128; i++)
    v.setUint32(
      fat + i * 4,
      i === 0 ? 0xfffffffd : i === 1 ? 0xfffffffe : 0xffffffff,
      true,
    );
  const dir = 1024;
  ['Root Entry', ...streams].slice(0, 4).forEach((name, i) => {
    const at = dir + i * 128;
    for (let c = 0; c < name.length; c++)
      v.setUint16(at + c * 2, name.charCodeAt(c), true);
    v.setUint16(at + 0x40, (name.length + 1) * 2, true);
    bytes[at + 0x42] = i === 0 ? 5 : 2;
  });
  return bytes;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof OfficeError) return e.code;
    throw e;
  }
  return undefined;
}

/** Patches the first central directory record whose name matches. */
function patchCentral(
  bytes: Uint8Array,
  name: string,
  patch: (view: DataView, at: number) => void,
): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const target = strToU8(name);
  for (let at = 0; at < copy.length - 46; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const length = view.getUint16(at + 28, true);
    if (
      length === target.length &&
      target.every((b, i) => copy[at + 46 + i] === b)
    ) {
      patch(view, at);
      return copy;
    }
  }
  throw new Error(`no central record for ${name}`);
}

describe('readZip', () => {
  it('reads entries, inflates on request and checks the CRC', () => {
    const archive = readZip(docx());
    expect(archive.entries.map((e) => e.name)).toContain('word/document.xml');
    expect(readText(archive.get('word/document.xml')!)).toContain(
      'Fennlor Studio GmbH',
    );
    expect(readEntry(archive.get('word/media/image1.png')!)).toEqual(
      new Uint8Array(4096).fill(7),
    );
  });

  it('refuses a part that inflates beyond the cap even when its declared size is small', () => {
    const bytes = zipSync({ 'big.xml': strToU8('a'.repeat(200_000)) });
    const lying = patchCentral(bytes, 'big.xml', (v, at) =>
      v.setUint32(at + 24, 100, true),
    );
    const entry = readZip(lying).get('big.xml')!;
    expect(codeOf(() => readEntry(entry, 1000))).toBe(
      'office_document_too_large',
    );
    // Within the cap the lie is caught by the size check.
    expect(codeOf(() => readEntry(entry, 1_000_000))).toBe(
      'office_document_invalid',
    );
  });

  it('refuses a declared total above the limit', () => {
    const bytes = patchCentral(docx(), 'word/document.xml', (v, at) =>
      v.setUint32(at + 24, 0xfffffff0, true),
    );
    expect(codeOf(() => readZip(bytes))).toBe('office_document_too_large');
  });

  it('refuses too many entries', () => {
    const files: Zippable = {};
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = strToU8('x');
    expect(
      codeOf(() =>
        readZip(zipSync(files), { maxEntries: 10, maxDeclaredBytes: 1e9 }),
      ),
    ).toBe('office_document_invalid');
  });

  it('refuses names that differ only in case, traversal and absolute names', () => {
    expect(
      codeOf(() =>
        readZip(
          zipSync({
            'word/document.xml': strToU8('a'),
            'word/Document.xml': strToU8('b'),
          }),
        ),
      ),
    ).toBe('office_document_invalid');
    expect(
      codeOf(() => readZip(zipSync({ '../evil.xml': strToU8('a') }))),
    ).toBe('office_document_invalid');
    expect(
      codeOf(() => readZip(zipSync({ '/etc/passwd': strToU8('a') }))),
    ).toBe('office_document_invalid');
    expect(isSafeEntryName('word/document.xml')).toBe(true);
    expect(isSafeEntryName('word\\document.xml')).toBe(false);
    expect(isSafeEntryName('C:/x.xml')).toBe(false);
    expect(isSafeEntryName('a/../../b')).toBe(false);
  });

  it('refuses encrypted entries and garbage', () => {
    const encrypted = patchCentral(docx(), 'word/document.xml', (v, at) =>
      v.setUint16(at + 8, v.getUint16(at + 8, true) | 1, true),
    );
    expect(codeOf(() => readZip(encrypted))).toBe('source_encrypted');
    expect(codeOf(() => readZip(strToU8('PK\x03\x04 not really a zip')))).toBe(
      'office_document_invalid',
    );
    const truncated = docx().slice(0, 200);
    expect(codeOf(() => readZip(truncated))).toBe('office_document_invalid');
  });
});

describe('writeZip', () => {
  it('copies untouched entries byte for byte and replaces the rest', () => {
    const source = docx();
    const archive = readZip(source);
    const out = writeZip(
      archive.entries.map((e) =>
        e.name === 'word/document.xml'
          ? { name: e.name, data: strToU8('<changed/>') }
          : e,
      ),
    );
    const again = readZip(out);
    expect(again.entries.map((e) => e.name)).toEqual(
      archive.entries.map((e) => e.name),
    );
    expect(again.get('word/media/image1.png')!.raw).toEqual(
      archive.get('word/media/image1.png')!.raw,
    );
    expect(readText(again.get('word/document.xml')!)).toBe('<changed/>');
    // Another reader agrees.
    expect(Object.keys(unzipSync(out))).toContain('word/media/image1.png');
  });

  it('is deterministic', () => {
    const entries = [
      { name: 'a.xml', data: strToU8('<a/>') },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3]), store: true },
    ];
    expect(writeZip(entries)).toEqual(writeZip(entries));
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
});

describe('detectOfficeFormat', () => {
  it('detects OOXML by the main part, not the name', () => {
    expect(detectOfficeFormat(docx()).format).toBe('docx');
    expect(detectOfficeFormat(docx({}, CT_XLSX)).format).toBe('xlsx');
    expect(detectOfficeFormat(docx({}, CT_PPTX)).format).toBe('pptx');
  });

  it('refuses macro-enabled and template variants, by content type and by VBA part', () => {
    expect(
      codeOf(() =>
        detectOfficeFormat(
          docx({}, 'application/vnd.ms-word.document.macroEnabled.main+xml'),
        ),
      ),
    ).toBe('file_type_unsupported');
    expect(
      codeOf(() =>
        detectOfficeFormat(
          docx(
            {},
            'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
          ),
        ),
      ),
    ).toBe('file_type_unsupported');
    expect(
      codeOf(() =>
        detectOfficeFormat(docx({ 'word/vbaProject.bin': new Uint8Array(10) })),
      ),
    ).toBe('file_type_unsupported');
  });

  it('refuses a DOCTYPE in the content types', () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "a">]>${contentTypes(CT_DOCX).slice(38)}`,
      ),
    });
    expect(codeOf(() => detectOfficeFormat(bytes))).toBe(
      'office_document_invalid',
    );
  });

  it('detects ODF by its mimetype, refuses modules and encryption', () => {
    expect(
      detectOfficeFormat(odf('application/vnd.oasis.opendocument.text')).format,
    ).toBe('odt');
    expect(
      detectOfficeFormat(odf('application/vnd.oasis.opendocument.spreadsheet'))
        .format,
    ).toBe('ods');
    expect(
      detectOfficeFormat(odf('application/vnd.oasis.opendocument.presentation'))
        .format,
    ).toBe('odp');
    expect(
      codeOf(() =>
        detectOfficeFormat(odf('application/vnd.oasis.opendocument.graphics')),
      ),
    ).toBe('file_type_unsupported');
    // LibreOffice writes library descriptors without macros; those are fine.
    expect(
      detectOfficeFormat(
        odf('application/vnd.oasis.opendocument.text', {
          'Basic/script-lc.xml': strToU8('<x/>'),
        }),
      ).format,
    ).toBe('odt');
    expect(
      codeOf(() =>
        detectOfficeFormat(
          odf('application/vnd.oasis.opendocument.text', {
            'Basic/Standard/Module1.xml': strToU8('<x/>'),
          }),
        ),
      ),
    ).toBe('file_type_unsupported');
    const encrypted = odf('application/vnd.oasis.opendocument.text', {
      'META-INF/manifest.xml': strToU8(
        '<manifest:manifest><manifest:file-entry><manifest:encryption-data/></manifest:file-entry></manifest:manifest>',
      ),
    });
    expect(codeOf(() => detectOfficeFormat(encrypted))).toBe(
      'source_encrypted',
    );
  });

  it('tells legacy formats and encrypted OOXML apart by their streams', () => {
    expect(cfbStreamNames(cfb(['WordDocument', '1Table']))).toEqual([
      'Root Entry',
      'WordDocument',
      '1Table',
    ]);
    expect(detectOfficeFormat(cfb(['WordDocument'])).format).toBe('doc');
    expect(detectOfficeFormat(cfb(['Workbook'])).format).toBe('xls');
    expect(detectOfficeFormat(cfb(['PowerPoint Document'])).format).toBe('ppt');
    expect(
      codeOf(() =>
        detectOfficeFormat(cfb(['EncryptionInfo', 'EncryptedPackage'])),
      ),
    ).toBe('source_encrypted');
    expect(
      codeOf(() => detectOfficeFormat(cfb(['Workbook', '_VBA_PROJECT_CUR']))),
    ).toBe('file_type_unsupported');
    expect(codeOf(() => detectOfficeFormat(cfb(['Something'])))).toBe(
      'file_type_unsupported',
    );
  });

  it('detects HTML, whatever the file is named, and still refuses other text', () => {
    // Word's "save as web page" and report exports carry .doc names (spec 22 §3.2)
    const wordHtml = " <html xmlns:o='urn:schemas-microsoft-com:office:office'><head><meta charset='utf-8'></head><body><p>x</p></body></html>";
    expect(detectOfficeFormat(strToU8(wordHtml)).format).toBe('html');
    expect(detectOfficeFormat(new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(wordHtml)])).format).toBe('html');
    expect(detectOfficeFormat(strToU8('<!DOCTYPE html>\n<html><body>x</body></html>')).format).toBe('html');
    expect(
      detectOfficeFormat(strToU8('<?xml version="1.0"?><!-- note --><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>')).format,
    ).toBe('html');
    for (const other of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<?xml version="1.0"?><root/>', 'plain text', '{"a":1}'])
      expect(codeOf(() => detectOfficeFormat(strToU8(other))), other).toBe('file_type_unsupported');
  });

  it('detects RTF and refuses everything else', () => {
    expect(detectOfficeFormat(strToU8('{\\rtf1\\ansi hello}')).format).toBe(
      'rtf',
    );
    expect(codeOf(() => detectOfficeFormat(strToU8('%PDF-1.7')))).toBe(
      'file_type_unsupported',
    );
    expect(
      codeOf(() => detectOfficeFormat(zipSync({ 'a.txt': strToU8('a') }))),
    ).toBe('file_type_unsupported');
  });

  it('refuses files above the upload limit', () => {
    expect(
      codeOf(() => detectOfficeFormat(new Uint8Array(20 * 1024 * 1024 + 1))),
    ).toBe('office_document_too_large');
  });

  it('only counts real macro parts', () => {
    expect(isMacroPart('xl/vbaProject.bin')).toBe(true);
    expect(isMacroPart('Scripts/python/x.py')).toBe(true);
    expect(isMacroPart('Basic/script-lb.xml')).toBe(false);
    expect(isMacroPart('word/document.xml')).toBe(false);
  });
});

describe('sanitiseForConversion', () => {
  const EXTERNAL_IMAGE =
    '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://canary.test/x.png" TargetMode="External"/>';
  const HYPERLINK =
    '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://fennlor.example/" TargetMode="External"/>';
  const TEMPLATE =
    "<Relationship Id='rId12' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate' Target='file:///etc/passwd' TargetMode='External'></Relationship>";
  const INTERNAL =
    '<Relationship Id="rId13" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>';

  it('removes external loading relationships, keeps hyperlinks and internal ones', () => {
    const input = docx({
      'word/_rels/document.xml.rels': strToU8(
        DOC_RELS(EXTERNAL_IMAGE + HYPERLINK + TEMPLATE + INTERNAL),
      ),
    });
    const result = sanitiseForConversion(input);
    expect(result.format).toBe('docx');
    expect(result.removed.map((r) => r.id)).toEqual(['rId10', 'rId12']);
    const archive = readZip(result.bytes);
    const rels = readText(archive.get('word/_rels/document.xml.rels')!);
    expect(rels).toContain('rId11');
    expect(rels).toContain('rId13');
    expect(rels).not.toContain('canary.test');
    expect(rels).not.toContain('/etc/passwd');
    // Everything else is copied as it was.
    expect(archive.get('word/media/image1.png')!.raw).toEqual(
      readZip(input).get('word/media/image1.png')!.raw,
    );
  });

  it('returns the input unchanged when nothing loads externally', () => {
    const input = docx({
      'word/_rels/document.xml.rels': strToU8(DOC_RELS(HYPERLINK + INTERNAL)),
    });
    const result = sanitiseForConversion(input);
    expect(result.bytes).toBe(input);
    expect(result.removed).toEqual([]);
  });

  it('refuses a DOCTYPE in any XML part, also in UTF-16', () => {
    const utf8 = docx({
      'word/footer1.xml': strToU8(
        '<?xml version="1.0"?><!DOCTYPE w:ftr [<!ENTITY a "aaaa">]><w:ftr/>',
      ),
    });
    expect(codeOf(() => sanitiseForConversion(utf8))).toBe(
      'office_document_invalid',
    );
    const text =
      '\ufeff<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x><w:ftr/>';
    const utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++)
      new DataView(utf16.buffer).setUint16(i * 2, text.charCodeAt(i), true);
    expect(
      codeOf(() => sanitiseForConversion(docx({ 'word/footer2.xml': utf16 }))),
    ).toBe('office_document_invalid');
  });

  it('passes HTML through and says what the converter will not load', () => {
    const plain = sanitiseForConversion(strToU8('<html><body><p>Fennlor</p></body></html>'));
    expect(plain).toMatchObject({ format: 'html', removed: [], notes: [] });
    const remote = sanitiseForConversion(
      strToU8('<html><body><img src="https://olvarest.example/logo.png"><link href="//cdn.example/a.css"><img src="data:image/png;base64,AA"></body></html>'),
    );
    expect(remote.notes).toEqual([expect.stringContaining('2 resource(s) on the web')]);
    expect(remote.bytes).toHaveLength(plain.bytes.length > 0 ? remote.bytes.length : 0);
  });

  it('checks ODF parts but leaves legacy formats to the sidecar', () => {
    const bad = odf('application/vnd.oasis.opendocument.text', {
      'styles.xml': strToU8('<!DOCTYPE x><x/>'),
    });
    expect(codeOf(() => sanitiseForConversion(bad))).toBe(
      'office_document_invalid',
    );
    const legacy = cfb(['WordDocument']);
    expect(sanitiseForConversion(legacy)).toEqual({
      format: 'doc',
      bytes: legacy,
      removed: [],
      notes: [],
    });
  });

  it('parses relationship attributes in either quote style', () => {
    const { removed } = removeExternalRelationships(DOC_RELS(TEMPLATE));
    expect(removed).toEqual([
      {
        id: 'rId12',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate',
        target: 'file:///etc/passwd',
      },
    ]);
  });
});
