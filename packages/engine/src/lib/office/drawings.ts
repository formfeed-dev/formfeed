import type { OfficeDrawingRequest } from '../types';
import { OfficeError } from './errors';
import { decodeText, escapeText, tokenize } from './xml';

/**
 * Drawings in office templates (spec 22 §4.4). In office mode, `qrcode`, `barcode`, `epcQr`, `image`
 * and `pageBreak` do not return markup: they register a request here and return a placeholder, which
 * passes through the engine and the restore as text. The post pass resolves the requests to PNG or
 * JPEG pictures (through the host: the worker's asset cache and Chromium, or the browser's fetch and
 * canvas) and replaces each placeholder with an inline picture in a run of its own.
 */

/** Opening and closing characters of a drawing placeholder; not the markup's U+E000/U+E001. */
const OPEN = String.fromCharCode(0xe002);
const CLOSE = String.fromCharCode(0xe003);

export const officeDrawingLimits = {
  /** Drawings per render. */
  maxDrawings: 50,
  /** Image bytes placed per render. */
  maxImageBytes: 20 * 1024 * 1024,
  /** Largest raster edge in pixels. */
  maxPixels: 2400,
};

/** What renders images for the post pass: the render-worker or the browser. */
export interface OfficeImageHost {
  /** Reads an image URL (never called for `data:` URLs, which are decoded here). */
  fetch(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Turns SVG or another format into a PNG. With `size`, the picture is drawn at that many pixels;
   * without, at its natural size.
   */
  toPng(input: { bytes: Uint8Array; contentType: string }, size?: { width: number; height: number }): Promise<Uint8Array>;
}

/** Collects the drawing requests of one render and hands out their placeholders. */
export class DrawingCollector {
  readonly requests: OfficeDrawingRequest[] = [];
  /** Set when a template asked for more drawings than allowed; the engines wrap the error thrown. */
  exceeded: OfficeError | null = null;

  constructor(readonly nonce: string) {}

  readonly register = (request: OfficeDrawingRequest): string => {
    if (this.requests.length >= officeDrawingLimits.maxDrawings) {
      this.exceeded = new OfficeError('office_document_too_large', `A document can hold at most ${officeDrawingLimits.maxDrawings} images and codes`, {
        limit: officeDrawingLimits.maxDrawings,
      });
      throw this.exceeded;
    }
    this.requests.push(request);
    return `${OPEN}${this.nonce}${this.requests.length - 1}${CLOSE}`;
  };

  pattern(): RegExp {
    return new RegExp(`${OPEN}${this.nonce}(\\d+)${CLOSE}`, 'g');
  }

  /** Indexes of the drawings a filled part uses, in order. */
  usedIn(xml: string): number[] {
    return [...xml.matchAll(this.pattern())].map((m) => Number(m[1]));
  }
}

/** A drawing ready to place. */
export type ResolvedDrawing =
  | { kind: 'picture'; media: string; widthEmu: number; heightEmu: number; alt: string; /** A size was asked for. */ sized: boolean }
  | { kind: 'page-break' }
  | { kind: 'nothing' };

export interface PreparedMedia {
  name: string;
  bytes: Uint8Array;
  extension: 'png' | 'jpeg';
}

const EMU_PER_PX = 9525;
const EMU_PER_UNIT: Record<string, number> = { px: EMU_PER_PX, pt: 12700, mm: 36000, cm: 360000, in: 914400 };

/** A size option in EMU: a number is pixels at 96 dpi, a string may carry `px`, `pt`, `mm`, `cm` or `in`. */
export function toEmu(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * EMU_PER_PX) : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|pt|mm|cm|in)?\s*$/i.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? Math.round(n * EMU_PER_UNIT[(m[2] ?? 'px').toLowerCase()]!) : null;
}

/** Natural size in pixels of a PNG, JPEG, GIF or SVG; null when it cannot be read. */
export function imageSize(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes) && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes.length >= 10)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (isJpeg(bytes)) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const length = view.getUint16(at + 2);
      // SOF0..SOF15 except DHT, JPG and DAC carry the frame size
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + length;
    }
    return null;
  }
  if (contentType.includes('svg')) return svgSize(new TextDecoder().decode(bytes));
  return null;
}

/** Width and height of an SVG from its attributes, else from its viewBox. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const length = (value: string | undefined) => {
    const emu = value ? toEmu(value) : null;
    return emu ? emu / EMU_PER_PX : null;
  };
  const width = length(attr('width'));
  const height = length(attr('height'));
  if (width && height) return { width, height };
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box[2]! > 0 && box[3]! > 0) {
    const ratio = box[3]! / box[2]!;
    if (width) return { width, height: width * ratio };
    if (height) return { width: height / ratio, height };
    return { width: box[2]!, height: box[3]! };
  }
  return null;
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Decodes a `data:` URL; null for anything else. */
export function decodeDataUrl(url: string): { bytes: Uint8Array; contentType: string } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const contentType = m[1] || 'text/plain';
  if (/;base64/i.test(m[2]!)) {
    const binary = atob(m[3]!.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3]!)), contentType };
}

/**
 * Turns the requests into pictures: fetched or decoded, converted to PNG where Word needs it, sized
 * (the given size, else the natural size at 96 dpi, never wider than `maxWidthEmu`), and shared when
 * the same picture appears again. A picture that cannot be read becomes nothing and a warning.
 */
export class DrawingResolver {
  readonly media: PreparedMedia[] = [];
  readonly warnings: string[] = [];
  private readonly resolved = new Map<number, Promise<ResolvedDrawing>>();
  private readonly byKey = new Map<string, Promise<{ media: PreparedMedia; width: number; height: number } | null>>();
  private imageBytes = 0;

  constructor(
    private readonly requests: readonly OfficeDrawingRequest[],
    private readonly host: OfficeImageHost | undefined,
    private readonly mediaPrefix: string,
  ) {}

  resolve(index: number, maxWidthEmu: number): Promise<ResolvedDrawing> {
    let pending = this.resolved.get(index);
    if (!pending) {
      pending = this.resolveOne(this.requests[index], maxWidthEmu);
      this.resolved.set(index, pending);
    }
    return pending;
  }

  private async resolveOne(request: OfficeDrawingRequest | undefined, maxWidthEmu: number): Promise<ResolvedDrawing> {
    if (!request) return { kind: 'nothing' };
    if (request.kind === 'page-break') return { kind: 'page-break' };
    const wantW = toEmu(request.width);
    const wantH = toEmu(request.height);
    const source =
      request.kind === 'svg'
        ? { bytes: new TextEncoder().encode(request.svg), contentType: 'image/svg+xml', label: 'a code' }
        : { url: request.url, label: request.url.startsWith('data:') ? 'an embedded image' : request.url };
    const key = `${request.kind === 'svg' ? request.svg : request.url}\u0000${wantW ?? ''}x${wantH ?? ''}`;
    let prepared = this.byKey.get(key);
    if (!prepared) {
      prepared = this.prepare(source, wantW, wantH).catch((e: unknown) => {
        // limits, and a host that says the machine (not the picture) failed, end the render
        if (e instanceof OfficeError || (e as { fatal?: unknown }).fatal === true) throw e;
        this.warnings.push(`Could not place ${source.label}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      this.byKey.set(key, prepared);
    }
    const picture = await prepared;
    if (!picture) return { kind: 'nothing' };
    let widthEmu = wantW ?? picture.width * EMU_PER_PX;
    let heightEmu = wantH ?? picture.height * EMU_PER_PX;
    if (wantW && !wantH) heightEmu = Math.round((wantW * picture.height) / picture.width);
    if (wantH && !wantW) widthEmu = Math.round((wantH * picture.width) / picture.height);
    if (widthEmu > maxWidthEmu) {
      heightEmu = Math.round((heightEmu * maxWidthEmu) / widthEmu);
      widthEmu = maxWidthEmu;
    }
    return {
      kind: 'picture',
      media: picture.media.name,
      widthEmu: Math.round(widthEmu),
      heightEmu: Math.round(heightEmu),
      alt: request.alt ?? '',
      sized: wantW !== null || wantH !== null,
    };
  }

  private async prepare(
    source: { bytes: Uint8Array; contentType: string; label: string } | { url: string; label: string },
    wantW: number | null,
    wantH: number | null,
  ): Promise<{ media: PreparedMedia; width: number; height: number } | null> {
    let input: { bytes: Uint8Array; contentType: string };
    if ('url' in source) {
      const data = decodeDataUrl(source.url);
      if (data) input = data;
      else {
        if (!/^https?:\/\//i.test(source.url)) throw new Error('only http(s) and data URLs can be placed');
        if (!this.host) throw new Error('images are not loaded here');
        input = await this.host.fetch(source.url);
      }
    } else input = source;

    const natural = imageSize(input.bytes, input.contentType);
    let bytes: Uint8Array;
    let extension: 'png' | 'jpeg';
    let size: { width: number; height: number } | null;
    if (isPng(input.bytes) || isJpeg(input.bytes)) {
      bytes = input.bytes;
      extension = isPng(input.bytes) ? 'png' : 'jpeg';
      size = natural;
    } else {
      if (!this.host) throw new Error('pictures are not drawn here');
      // SVG is drawn at twice its displayed size, so codes stay sharp in print
      let raster: { width: number; height: number } | undefined;
      if (natural) {
        const w = wantW ? wantW / EMU_PER_PX : wantH ? ((wantH / EMU_PER_PX) * natural.width) / natural.height : natural.width;
        const h = (w * natural.height) / natural.width;
        const scale = Math.min(2, officeDrawingLimits.maxPixels / Math.max(w, h));
        raster = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
      }
      bytes = await this.host.toPng(input, raster);
      extension = 'png';
      // the displayed size is the natural one, not the doubled raster
      size = natural ?? imageSize(bytes, 'image/png');
    }
    if (!size || !size.width || !size.height) throw new Error('its size cannot be read');
    this.imageBytes += bytes.length;
    if (this.imageBytes > officeDrawingLimits.maxImageBytes)
      throw new OfficeError('office_document_too_large', `The images of a document may take at most ${officeDrawingLimits.maxImageBytes / 1024 / 1024} MB`, {
        limit: officeDrawingLimits.maxImageBytes,
      });
    const media: PreparedMedia = { name: `${this.mediaPrefix}${this.media.length + 1}.${extension}`, bytes, extension };
    this.media.push(media);
    return { media, width: size.width, height: size.height };
  }
}

/** The text width of a Word part's last section in EMU; 16 cm when it names none. */
export function textWidthEmu(xml: string): number {
  const sections = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)];
  const last = sections.at(-1)?.[0] ?? '';
  const attr = (element: string, name: string) =>
    Number(new RegExp(`<w:${element}\\b[^>]*\\sw:${name}="(\\d+)"`).exec(last)?.[1] ?? NaN);
  const width = attr('pgSz', 'w') - attr('pgMar', 'left') - attr('pgMar', 'right');
  // twips: 1/1440 inch = 635 EMU
  return Number.isFinite(width) && width > 0 ? width * 635 : 16 * 360000;
}

/** A picture in a run, as Word writes one (`wp:inline`); namespaces are declared on the elements. */
export function inlinePicture(picture: Extract<ResolvedDrawing, { kind: 'picture' }>, rId: string, id: number): string {
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const name = `Formfeed picture ${id}`;
  const alt = escapeText(picture.alt).replace(/"/g, '&quot;');
  const { widthEmu: cx, heightEmu: cy } = picture;
  return (
    `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${name}" descr="${alt}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${a}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

/** The highest drawing id of a part, so new pictures start after it. */
export function highestDrawingId(xml: string): number {
  let highest = 0;
  for (const m of xml.matchAll(/<(?:wp:docPr|pic:cNvPr|p:cNvPr)\b[^>]*\sid="(\d+)"/g)) highest = Math.max(highest, Number(m[1]));
  return highest;
}

/**
 * Replaces the drawing placeholders of a filled Word part. A placeholder inside `w:t` splits its run:
 * the text before stays in the run, the picture (or page break) gets a run of its own with the same
 * run properties, and the text after continues in a copy of the run.
 */
export function placeDrawings(xml: string, pattern: RegExp, markupFor: (index: number) => string): string {
  const tokens = tokenize(xml);
  const out: string[] = [];
  let runOpen: string | null = null;
  let runProps = '';
  let inProps = false;
  let textOpen: number | null = null;
  for (const t of tokens) {
    if (t.kind === 'open' && t.name === 'w:r' && !t.selfClosing) {
      runOpen = t.raw;
      runProps = '';
    } else if (t.kind === 'close' && t.name === 'w:r') runOpen = null;
    else if (t.kind === 'open' && t.name === 'w:rPr' && runOpen !== null) {
      inProps = !t.selfClosing;
      runProps = t.raw;
      out.push(t.raw);
      continue;
    } else if (inProps) {
      runProps += t.raw;
      if (t.kind === 'close' && t.name === 'w:rPr') inProps = false;
      out.push(t.raw);
      continue;
    }
    if (t.kind === 'open' && t.name === 'w:t' && !t.selfClosing) textOpen = out.length;
    if (t.kind === 'close' && t.name === 'w:t') textOpen = null;
    if (t.kind === 'text' && textOpen !== null && runOpen !== null) {
      pattern.lastIndex = 0;
      if (pattern.test(t.raw)) {
        const segments = t.raw.split(pattern);
        let text = segments[0]!;
        for (let s = 1; s < segments.length; s += 2) {
          const index = Number(segments[s]);
          text +=
            `</w:t></w:r><w:r>${runProps}${markupFor(index)}</w:r>` +
            `${runOpen}${runProps}<w:t xml:space="preserve">` +
            segments[s + 1];
        }
        out[textOpen] = withPreserve(out[textOpen]!);
        out.push(text);
        continue;
      }
    }
    out.push(t.raw);
  }
  return out.join('');
}

function withPreserve(openTag: string): string {
  return /\sxml:space=/.test(openTag) ? openTag : openTag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
}

/** Adds image relationships to a part's `.rels` (created when the part has none). */
export function withRelationships(rels: string | null, relationships: Array<{ id: string; target: string }>): string {
  const type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const added = relationships.map((r) => `<Relationship Id="${r.id}" Type="${type}" Target="${escapeText(r.target)}"/>`).join('');
  if (!rels)
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${added}</Relationships>`;
  const end = rels.lastIndexOf('</Relationships>');
  if (end === -1) {
    // an empty `<Relationships/>`
    return rels.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1>${added}</Relationships>`);
  }
  return rels.slice(0, end) + added + rels.slice(end);
}

/** Relationship ids a `.rels` already uses. */
export function relationshipIds(rels: string | null): Set<string> {
  return new Set([...(rels ?? '').matchAll(/\sId="([^"]+)"/g)].map((m) => decodeText(m[1]!)));
}

/** `[Content_Types].xml` with defaults for the picture formats it lacks. */
export function withImageTypes(contentTypes: string, extensions: ReadonlySet<'png' | 'jpeg'>): string {
  let out = contentTypes;
  for (const ext of extensions) {
    if (new RegExp(`<Default\\b[^>]*Extension="${ext}"`, 'i').test(out)) continue;
    out = out.replace(/<Types\b[^>]*>/, (open) => `${open}<Default Extension="${ext}" ContentType="image/${ext}"/>`);
  }
  return out;
}

/** `word/document.xml` → `word/_rels/document.xml.rels`. */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
