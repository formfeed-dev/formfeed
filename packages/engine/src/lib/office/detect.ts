import { OfficeError, officeLimits } from './errors';
import { isZip, readText, readZip, type ZipArchive } from './zip';

/**
 * What a customer file is, decided from its bytes (spec 22 §3.2). Gotenberg picks LibreOffice's
 * import filter by extension, so the worker sends every file under the extension found here and the
 * customer's own file name never reaches the sidecar.
 */
export const officeFormats = [
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'doc',
  'xls',
  'ppt',
  'rtf',
  'html',
] as const;
export type OfficeFormat = (typeof officeFormats)[number];

export type OoxmlFormat = 'docx' | 'xlsx' | 'pptx';
export type OdfFormat = 'odt' | 'ods' | 'odp';

export const officeContentTypes: Record<OfficeFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  html: 'text/html',
};

export interface DetectedOffice {
  format: OfficeFormat;
  /** The parsed container for ZIP-based formats, so callers do not read it twice. */
  archive: ZipArchive | null;
}

/** Main part content types (`[Content_Types].xml`) of the formats we accept. */
const OOXML_MAIN: Record<string, OoxmlFormat> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml':
    'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml':
    'pptx',
};

/** Main part types of related formats we name in the error instead of calling them unknown. */
const OOXML_REFUSED: Record<string, string> = {
  'application/vnd.ms-word.document.macroenabled.main+xml':
    'a macro-enabled Word document (.docm)',
  'application/vnd.ms-word.template.macroenabledtemplate.main+xml':
    'a macro-enabled Word template (.dotm)',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml':
    'a Word template (.dotx)',
  'application/vnd.ms-excel.sheet.macroenabled.main+xml':
    'a macro-enabled workbook (.xlsm)',
  'application/vnd.ms-excel.sheet.binary.macroenabled.main':
    'a binary workbook (.xlsb)',
  'application/vnd.ms-excel.template.macroenabled.main+xml':
    'a macro-enabled Excel template (.xltm)',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml':
    'an Excel template (.xltx)',
  'application/vnd.ms-powerpoint.presentation.macroenabled.main+xml':
    'a macro-enabled presentation (.pptm)',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml':
    'a macro-enabled slide show (.ppsm)',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml':
    'a slide show (.ppsx)',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml':
    'a PowerPoint template (.potx)',
};

const ODF_MIME: Record<string, OdfFormat> = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

const unsupported = (message: string, details: Record<string, unknown> = {}) =>
  new OfficeError('file_type_unsupported', message, details);

const ACCEPTED =
  'Accepted are DOCX, XLSX, PPTX, ODT, ODS, ODP, DOC, XLS, PPT, RTF and HTML';

export function detectOfficeFormat(bytes: Uint8Array): DetectedOffice {
  if (bytes.length > officeLimits.maxFileBytes)
    throw new OfficeError(
      'office_document_too_large',
      `The file is larger than ${officeLimits.maxFileBytes / 1024 / 1024} MB`,
      {
        bytes: bytes.length,
        limit: officeLimits.maxFileBytes,
      },
    );
  if (isZip(bytes)) return detectZip(bytes);
  if (isCfb(bytes)) return { format: detectCfb(bytes), archive: null };
  if (startsWithAscii(bytes, '{\\rtf')) return { format: 'rtf', archive: null };
  // Word's "save as web page" and many report exports are HTML under a .doc name; LibreOffice reads
  // them, and the name never decides the type here either.
  if (isHtml(bytes)) return { format: 'html', archive: null };
  throw unsupported(`The file is not an office document. ${ACCEPTED}.`);
}

function detectZip(bytes: Uint8Array): DetectedOffice {
  const archive = readZip(bytes);
  const macro = archive.entries.find((e) => isMacroPart(e.name));
  if (macro)
    throw unsupported('Macro-enabled documents are not accepted', {
      entry: macro.name,
    });

  const mimetype = archive.get('mimetype');
  if (mimetype) {
    const value = readText(mimetype, 1024).trim();
    const format = ODF_MIME[value];
    if (!format)
      throw unsupported(
        `OpenDocument type ${value.slice(0, 100)} is not accepted. ${ACCEPTED}.`,
      );
    const manifest = archive.get('META-INF/manifest.xml');
    if (manifest && readText(manifest, 1024 * 1024).includes('encryption-data'))
      throw new OfficeError(
        'source_encrypted',
        'The document is password-protected',
      );
    return { format, archive };
  }

  const types = archive.get('[Content_Types].xml');
  if (!types)
    throw unsupported(`The ZIP file is not an office document. ${ACCEPTED}.`);
  const xml = readText(types, 1024 * 1024);
  if (hasDoctype(xml))
    throw new OfficeError(
      'office_document_invalid',
      'The document declares a DOCTYPE',
    );
  const contentTypes = [...xml.matchAll(/ContentType\s*=\s*"([^"]*)"/g)].map(
    (m) => m[1]!.toLowerCase(),
  );
  const refused = contentTypes.find((t) => OOXML_REFUSED[t]);
  if (refused)
    throw unsupported(
      `The file is ${OOXML_REFUSED[refused]}, which is not accepted. ${ACCEPTED}.`,
    );
  const mains = [
    ...new Set(contentTypes.map((t) => OOXML_MAIN[t]).filter(Boolean)),
  ] as OoxmlFormat[];
  if (mains.length !== 1)
    throw unsupported(
      `The file is not a Word, Excel or PowerPoint document. ${ACCEPTED}.`,
    );
  return { format: mains[0]!, archive };
}

/**
 * VBA projects in OOXML; Basic modules and scripts in ODF. LibreOffice may write the library
 * descriptors `Basic/script-lc.xml` and `script-lb.xml` into documents without any macro, so only a
 * module beside them counts.
 */
export function isMacroPart(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  if (base === 'vbaproject.bin' || base === 'vbadata.xml') return true;
  if (lower.startsWith('scripts/')) return !lower.endsWith('/');
  if (lower.startsWith('basic/'))
    return (
      !lower.endsWith('/') &&
      base !== 'script-lc.xml' &&
      base !== 'script-lb.xml'
    );
  return false;
}

/** A DOCTYPE anywhere in the text (entity expansion); the text is already decoded, UTF-16 included. */
export function hasDoctype(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml);
}

/**
 * HTML: a BOM, whitespace, comments and an XML declaration may come first, then `<!DOCTYPE html>` or
 * `<html>`. Deliberately narrow, so an SVG, an XML file or a text file is still refused.
 */
export function isHtml(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const head = new TextDecoder().decode(bytes.subarray(start, start + 4096));
  const withoutProlog = head.replace(/^\s+/, '').replace(/^<\?xml[^>]*\?>\s*/i, '');
  const withoutComments = withoutProlog.replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  return /^(?:<!doctype\s+html|<html[\s>])/i.test(withoutComments);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++)
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && CFB_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Legacy binary formats and encrypted OOXML share the Compound File container. Its directory names
 * the streams, and they tell the formats apart: `EncryptionInfo` is an encrypted OOXML package,
 * `WordDocument` a Word 97–2003 file, `Workbook` or `Book` Excel, `PowerPoint Document` PowerPoint.
 */
export function cfbStreamNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () =>
    new OfficeError(
      'office_document_invalid',
      'The compound document is corrupt',
    );
  const shift = view.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) throw invalid();
  const sectorSize = 1 << shift;
  const sectorAt = (sector: number) => (sector + 1) * sectorSize;
  const fatSectorCount = view.getUint32(0x2c, true);
  const firstDirSector = view.getUint32(0x30, true);
  const firstDifatSector = view.getUint32(0x44, true);
  const totalSectors = Math.ceil(bytes.length / sectorSize);
  if (fatSectorCount > totalSectors) throw invalid();

  // FAT sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++)
    fatSectors.push(view.getUint32(0x4c + i * 4, true));
  let difat = firstDifatSector;
  for (
    let guard = 0;
    fatSectors.length < fatSectorCount && difat < 0xfffffffa;
    guard++
  ) {
    if (guard > totalSectors || sectorAt(difat) + sectorSize > bytes.length)
      throw invalid();
    for (
      let i = 0;
      i < sectorSize / 4 - 1 && fatSectors.length < fatSectorCount;
      i++
    )
      fatSectors.push(view.getUint32(sectorAt(difat) + i * 4, true));
    difat = view.getUint32(sectorAt(difat) + sectorSize - 4, true);
  }
  const next = (sector: number): number => {
    const index = Math.floor(sector / (sectorSize / 4));
    const fat = fatSectors[index];
    if (fat === undefined || sectorAt(fat) + sectorSize > bytes.length)
      throw invalid();
    return view.getUint32(
      sectorAt(fat) + (sector % (sectorSize / 4)) * 4,
      true,
    );
  };

  const names: string[] = [];
  let sector = firstDirSector;
  for (let guard = 0; sector < 0xfffffffa; guard++) {
    if (guard > totalSectors || sectorAt(sector) + sectorSize > bytes.length)
      throw invalid();
    for (
      let at = sectorAt(sector);
      at < sectorAt(sector) + sectorSize;
      at += 128
    ) {
      const length = view.getUint16(at + 0x40, true);
      const type = bytes[at + 0x42];
      if (type === 0 || length < 2 || length > 64) continue;
      let name = '';
      for (let c = 0; c < length - 2; c += 2)
        name += String.fromCharCode(view.getUint16(at + c, true));
      names.push(name);
    }
    sector = next(sector);
  }
  return names;
}

function detectCfb(bytes: Uint8Array): OfficeFormat {
  const names = new Set(cfbStreamNames(bytes));
  if (names.has('EncryptionInfo') || names.has('EncryptedPackage'))
    throw new OfficeError(
      'source_encrypted',
      'The document is password-protected',
    );
  if (names.has('_VBA_PROJECT_CUR') || names.has('VBA') || names.has('Macros'))
    throw unsupported('Macro-enabled documents are not accepted');
  if (names.has('WordDocument')) return 'doc';
  if (names.has('Workbook') || names.has('Book')) return 'xls';
  if (names.has('PowerPoint Document')) return 'ppt';
  throw unsupported(
    `The compound file is not a Word, Excel or PowerPoint document. ${ACCEPTED}.`,
  );
}
