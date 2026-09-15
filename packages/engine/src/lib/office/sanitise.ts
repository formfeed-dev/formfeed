import { Inflate } from 'fflate';
import { detectOfficeFormat, hasDoctype, type OfficeFormat } from './detect';
import { OfficeError } from './errors';
import {
  decodeXml,
  readText,
  writeZip,
  type ZipArchive,
  type ZipEntry,
  type ZipWriteEntry,
} from './zip';

/**
 * Prepares a customer document for LibreOffice (spec 22 §2.1). Detection and the container checks
 * run first; then every XML part is checked for a DOCTYPE, and OOXML relationship parts lose their
 * external relationships except hyperlinks, so nothing in the document asks LibreOffice to load a
 * remote or local resource. The sidecar refuses such loads as well; this is the layer we control.
 */

export interface RemovedRelationship {
  part: string;
  id: string;
  type: string;
  target: string;
}

export interface SanitisedDocument {
  format: OfficeFormat;
  /** The input itself when nothing had to change. */
  bytes: Uint8Array;
  removed: RemovedRelationship[];
}

/** A DOCTYPE may only appear before the root element, so the first bytes of a part decide. */
const PROLOG_BYTES = 64 * 1024;

export function sanitiseForConversion(bytes: Uint8Array): SanitisedDocument {
  const { format, archive } = detectOfficeFormat(bytes);
  if (!archive) return { format, bytes, removed: [] };

  for (const entry of archive.entries)
    if (isXmlPart(entry.name) && hasDoctype(prolog(entry)))
      throw new OfficeError(
        'office_document_invalid',
        'The document declares a DOCTYPE',
        { entry: entry.name },
      );

  if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx')
    return { format, bytes, removed: [] };
  return stripExternalRelationships(format, bytes, archive);
}

function stripExternalRelationships(
  format: OfficeFormat,
  bytes: Uint8Array,
  archive: ZipArchive,
): SanitisedDocument {
  const removed: RemovedRelationship[] = [];
  const rewritten = new Map<string, Uint8Array>();
  for (const entry of archive.entries) {
    if (!entry.name.toLowerCase().endsWith('.rels')) continue;
    const xml = readText(entry, 4 * 1024 * 1024);
    const { xml: cleaned, removed: fromPart } =
      removeExternalRelationships(xml);
    if (!fromPart.length) continue;
    removed.push(...fromPart.map((r) => ({ part: entry.name, ...r })));
    rewritten.set(entry.name, new TextEncoder().encode(cleaned));
  }
  if (!removed.length) return { format, bytes, removed };
  const entries: ZipWriteEntry[] = archive.entries.map((entry) => {
    const data = rewritten.get(entry.name);
    return data ? { name: entry.name, data } : entry;
  });
  return { format, bytes: writeZip(entries), removed };
}

/**
 * Removes every `<Relationship TargetMode="External">` whose type is not a hyperlink. An allowlist,
 * not a list of loading types: a type we do not know is not one we let LibreOffice resolve.
 * References to a removed id stay in the source part; LibreOffice skips a relationship it cannot
 * find, which the sidecar tests keep proven.
 */
export function removeExternalRelationships(xml: string): {
  xml: string;
  removed: Omit<RemovedRelationship, 'part'>[];
} {
  const removed: Omit<RemovedRelationship, 'part'>[] = [];
  const out = xml.replace(
    /<(?:\w+:)?Relationship\b([^>]*?)(?:\/>|>\s*<\/(?:\w+:)?Relationship>)/g,
    (element, attrs: string) => {
      const attributes = parseAttributes(attrs);
      if ((attributes['TargetMode'] ?? '').toLowerCase() !== 'external')
        return element;
      const type = attributes['Type'] ?? '';
      if (/\/hyperlink$/i.test(type)) return element;
      removed.push({
        id: attributes['Id'] ?? '',
        type,
        target: (attributes['Target'] ?? '').slice(0, 300),
      });
      return '';
    },
  );
  return { xml: out, removed };
}

export function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    attributes[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '');
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (whole, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      const code = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

function isXmlPart(name: string): boolean {
  return /\.(xml|rels|vml)$/i.test(name);
}

class PrologComplete extends Error {}

/** Up to `PROLOG_BYTES` of a part, inflated without reading the rest. */
function prolog(entry: ZipEntry): string {
  if (entry.method === 0) return decodeXml(entry.raw.subarray(0, PROLOG_BYTES));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= PROLOG_BYTES) throw new PrologComplete();
  });
  try {
    inflate.push(entry.raw, true);
  } catch (e) {
    if (!(e instanceof PrologComplete))
      throw new OfficeError(
        'office_document_invalid',
        `Part ${entry.name} cannot be decompressed`,
        { entry: entry.name },
      );
  }
  const out = new Uint8Array(Math.min(total, PROLOG_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - at);
    out.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return decodeXml(out);
}
