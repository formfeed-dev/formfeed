import type { ResolvedDrawing } from './drawings';
import { buildSpans, rewrite, type Span } from './structure';
import { decodeText, escapeText, tokenize, type XmlToken } from './xml';

/**
 * Pictures on slides (spec 22 §10 step 7). A slide cannot hold a picture inside text, so a drawing
 * placeholder in a text box becomes a picture shape (`p:pic`) beside it:
 *
 * - a text box that holds nothing but drawings is replaced by them, placed in its box, so a member
 *   draws a box where the code goes and types `{{ qrcode(url) }}` into it;
 * - otherwise the placeholder is removed from the text and the picture is placed over the box, in
 *   front of the text;
 * - a picture without a size of its own is fitted into the box, keeping its aspect; several pictures
 *   share the box from top to bottom. A box that grows with its text (`a:spAutoFit`, PowerPoint's
 *   default for text boxes) is only as high as one line, so there the width alone decides;
 * - a shape whose position comes from the slide layout (no `a:xfrm` of its own) puts the pictures in
 *   the middle of the slide.
 */

export interface SlideBox {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

const attr = (raw: string, name: string): number | null => {
  const m = new RegExp(`\\s${name}="(-?\\d+)"`).exec(raw);
  return m ? Number(m[1]) : null;
};

/** `p:sldSz` of `ppt/presentation.xml`; 16:9 at 33.867 cm by 19.05 cm when it names none. */
export function slideSize(presentation: string | null): { cx: number; cy: number } {
  const size = /<p:sldSz\b[^>]*>/.exec(presentation ?? '')?.[0] ?? '';
  return { cx: attr(size, 'cx') ?? 12192000, cy: attr(size, 'cy') ?? 6858000 };
}

/** The box of a shape or graphic frame: `p:spPr/a:xfrm` or `p:xfrm`. */
function boxOf(container: Span, tokens: XmlToken[]): SlideBox | null {
  const xfrm =
    container.name === 'p:graphicFrame'
      ? container.children.find((c) => c.name === 'p:xfrm')
      : container.children.find((c) => c.name === 'p:spPr')?.children.find((c) => c.name === 'a:xfrm');
  if (!xfrm) return null;
  const off = xfrm.children.find((c) => c.name === 'a:off');
  const ext = xfrm.children.find((c) => c.name === 'a:ext');
  if (!off || !ext) return null;
  const o = tokens[off.start]!.raw;
  const e = tokens[ext.start]!.raw;
  const x = attr(o, 'x');
  const y = attr(o, 'y');
  const cx = attr(e, 'cx');
  const cy = attr(e, 'cy');
  return x === null || y === null || cx === null || cy === null ? null : { x, y, cx, cy };
}

/** A picture shape, with the namespaces it uses declared on itself. */
export function slidePicture(picture: Extract<ResolvedDrawing, { kind: 'picture' }>, rId: string, id: number, box: SlideBox): string {
  const alt = escapeText(picture.alt).replace(/"/g, '&quot;');
  return (
    `<p:pic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<p:nvPicPr><p:cNvPr id="${id}" name="Formfeed picture ${id}" descr="${alt}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `</p:pic>`
  );
}

/** Where each picture goes: its own size or fitted into its share of the box, centred in it. */
export function layoutPictures(
  pictures: ReadonlyArray<Extract<ResolvedDrawing, { kind: 'picture' }>>,
  box: SlideBox,
  growsWithText = false,
): SlideBox[] {
  const share = growsWithText ? Infinity : box.cy / pictures.length;
  let top = box.y;
  return pictures.map((p, i) => {
    let cx = p.widthEmu;
    let cy = p.heightEmu;
    if (!p.sized || cx > box.cx || cy > share) {
      const scale = Math.min(box.cx / cx, share / cy);
      if (!p.sized || scale < 1) {
        cx = Math.round(cx * scale);
        cy = Math.round(cy * scale);
      }
    }
    const y = growsWithText ? top : box.y + Math.round(i * share + (share - cy) / 2);
    top += cy;
    return { x: box.x + Math.round((box.cx - cx) / 2), y, cx, cy };
  });
}

/**
 * Replaces the drawing placeholders of a filled slide (or notes) part with picture shapes. `picture`
 * returns the placed markup for a resolved drawing, with its relationship and id.
 */
export function placeSlidePictures(
  xml: string,
  pattern: RegExp,
  drawingFor: (index: number) => ResolvedDrawing | undefined,
  pictureMarkup: (picture: Extract<ResolvedDrawing, { kind: 'picture' }>, box: SlideBox) => string,
  slide: { cx: number; cy: number },
): { xml: string; warnings: string[] } {
  const tokens = tokenize(xml);
  const root = buildSpans(tokens);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const warnings = new Set<string>();

  const containers: Span[] = [];
  const collect = (span: Span) => {
    if (span.name === 'p:sp' || span.name === 'p:graphicFrame') containers.push(span);
    else for (const child of span.children) collect(child);
  };
  collect(root);

  for (const container of containers) {
    const indexes: number[] = [];
    const edits: Array<{ at: number; raw: string }> = [];
    let text = '';
    let inText = false;
    for (let i = container.start + 1; i < container.end; i++) {
      const t = tokens[i]!;
      if (t.kind === 'open' && t.name === 'a:t' && !t.selfClosing) inText = true;
      else if (t.kind === 'close' && t.name === 'a:t') inText = false;
      else if (t.kind === 'text' && inText) {
        pattern.lastIndex = 0;
        if (!pattern.test(t.raw)) {
          text += decodeText(t.raw);
          continue;
        }
        const segments = t.raw.split(pattern);
        let kept = '';
        for (let s = 0; s < segments.length; s++) {
          if (s % 2 === 1) indexes.push(Number(segments[s]));
          else kept += segments[s];
        }
        text += decodeText(kept);
        edits.push({ at: i, raw: kept });
      }
    }
    if (!indexes.length) continue;

    const pictures: Array<Extract<ResolvedDrawing, { kind: 'picture' }>> = [];
    for (const index of indexes) {
      const drawing = drawingFor(index);
      if (drawing?.kind === 'picture') pictures.push(drawing);
      else if (drawing?.kind === 'page-break') warnings.add('Page breaks have no meaning on slides and were left out');
    }
    let box = boxOf(container, tokens);
    if (!box) {
      const cx = Math.min(slide.cx, Math.max(...pictures.map((p) => p.widthEmu), 1));
      const cy = Math.min(slide.cy, pictures.reduce((sum, p) => sum + p.heightEmu, 0) || 1);
      box = { x: Math.round((slide.cx - cx) / 2), y: Math.round((slide.cy - cy) / 2), cx, cy };
    }
    const autoFit = tokens.slice(container.start, container.end).some((t) => t.kind === 'open' && t.name === 'a:spAutoFit');
    const placed = layoutPictures(pictures, box, autoFit)
      .map((b, i) => pictureMarkup(pictures[i]!, b))
      .join('');
    const onlyPictures = container.name === 'p:sp' && text.trim() === '';
    if (onlyPictures) replacements.push({ start: container.start, end: container.end, text: placed });
    else {
      for (const edit of edits) replacements.push({ start: edit.at, end: edit.at, text: edit.raw });
      replacements.push({ start: container.end + 1, end: container.end, text: placed });
    }
  }
  return { xml: replacements.length ? rewrite(tokens, replacements) : xml, warnings: [...warnings] };
}
