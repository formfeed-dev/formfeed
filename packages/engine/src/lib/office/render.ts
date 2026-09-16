import { getEngine } from '../engines';
import { EngineSyntaxError, RenderError } from '../errors';
import { defaultHelpers, officeUnsupportedHelpers } from '../helpers';
import type { EngineId, RenderContext, VariableRef } from '../types';
import { detectOfficeFormat } from './detect';
import {
  DrawingCollector,
  DrawingResolver,
  highestDrawingId,
  inlinePicture,
  placeDrawings,
  relationshipIds,
  relsPathOf,
  textWidthEmu,
  withImageTypes,
  withRelationships,
  type OfficeImageHost,
} from './drawings';
import { OfficeError } from './errors';
import { documentFonts, fontDiagnostics, type DocumentFont } from './fonts';
import { makeIdsUnique } from './ids';
import { placeSlidePictures, slidePicture, slideSize } from './slides';
import { applyStructure, dropTaggedFallbacks, removeEmptyTables } from './structure';
import { listTags, normaliseTags, paragraphAtSource, type OfficeDiagnostic, type OfficeTag } from './tags';
import { createNonce, fromTemplateOutput, placeholderPattern, toTemplateSource, type TemplateSource, type TextFlavour } from './template-text';
import { assertWellFormed, tokenize } from './xml';
import { readText, writeZip, type ZipArchive, type ZipWriteEntry } from './zip';

/**
 * Fills an office template (spec 22 §4.3): the office counterpart of `renderVersion`, the same code in
 * the browser (quick preview) and the render-worker. Imports the template engines, so it lives in the
 * main entry, not in `@formfeed/engine/office`.
 */
export interface OfficeRenderOptions {
  engine: EngineId;
  data: unknown;
  /** Locale, helpers and limits as for HTML templates; `mode` is set to `office` here. */
  context: RenderContext;
  /** For tests: the source of the placeholder nonce. */
  random?: () => number;
  /**
   * Loads and draws pictures for `image`, `qrcode`, `barcode` and `epcQr` (spec 22 §4.4): the
   * render-worker's asset cache and Chromium, or the browser's fetch and canvas. Without one, only
   * PNG and JPEG data URLs are placed and everything else becomes a warning.
   */
  images?: OfficeImageHost;
}

export interface OfficeRenderResult {
  bytes: Uint8Array;
  format: 'docx' | 'pptx';
  warnings: string[];
  /** Info and warnings; errors throw `OfficeTemplateError` instead. */
  diagnostics: OfficeDiagnostic[];
}

/**
 * A template that cannot be filled as written; the diagnostics say where. An engine's syntax or
 * runtime error travels as `cause`, so callers can tell the two apart.
 */
export class OfficeTemplateError extends Error {
  constructor(
    message: string,
    readonly diagnostics: OfficeDiagnostic[],
    readonly part?: string,
    override readonly cause?: EngineSyntaxError | RenderError,
  ) {
    super(message);
    this.name = 'OfficeTemplateError';
  }

  /** `template_syntax_error` or `template_runtime_error`, as the API reports it. */
  get code(): 'template_syntax_error' | 'template_runtime_error' {
    return this.cause instanceof RenderError ? 'template_runtime_error' : 'template_syntax_error';
  }
}

/** Filled parts together may not exceed this before zipping (spec 22 §4.3 step 6). */
export const OFFICE_FILLED_MAX_BYTES = 50 * 1024 * 1024;

const PARTS: Record<'docx' | 'pptx', RegExp> = {
  docx: /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
  pptx: /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
};
const FLAVOUR: Record<'docx' | 'pptx', TextFlavour> = { docx: 'wordprocessing', pptx: 'drawing' };

/** Tags that insert other templates; they would put HTML into the document (spec 22 §4.5). */
const INCLUDES = /\{%-?\s*(?:include|render|extends|import|from)\b|\{\{~?\s*>/;

/** A part as template text, with what the structure rules, the tag normalisation and the include check found. */
function preparePart(xml: string, name: string, format: 'docx' | 'pptx', random?: () => number): { template: TemplateSource; diagnostics: OfficeDiagnostic[] } {
  const structured = applyStructure(dropTaggedFallbacks(xml, name), name);
  const normal = normaliseTags(toTemplateSource(structured.xml, FLAVOUR[format], createNonce(random), name), name);
  const diagnostics = [...structured.diagnostics, ...normal.diagnostics];
  const include = INCLUDES.exec(normal.template.source);
  if (include)
    diagnostics.push({
      severity: 'error',
      code: 'unsupported-in-office',
      message: 'Office templates cannot include partials; put the content into the document.',
      part: name,
      paragraph: paragraphAtSource(normal.template, include.index),
      text: include[0],
    });
  return { template: normal.template, diagnostics };
}

function openTemplate(file: Uint8Array) {
  const { format, archive } = detectOfficeFormat(file);
  if ((format !== 'docx' && format !== 'pptx') || !archive)
    throw new OfficeError('file_type_unsupported', 'Office templates are Word (DOCX) or PowerPoint (PPTX) files');
  return { format, archive };
}

/** A diagnostic of the office template page: the office checks' codes, or an engine's. */
export type OfficeAnalysisDiagnostic = Omit<OfficeDiagnostic, 'code'> & { code: string };

export interface OfficeAnalysis {
  format: 'docx' | 'pptx';
  /** Every tag, in part and document order. */
  tags: OfficeTag[];
  /** Structure, tag and engine diagnostics, and the fonts the converter replaces. */
  diagnostics: OfficeAnalysisDiagnostic[];
  /** Data paths the template reads, for the schema and data panels. */
  variables: Array<Pick<VariableRef, 'path' | 'kind'>>;
  fonts: DocumentFont[];
}

/**
 * `analyze` over an office template (spec 22 §4.3, §6): what the office template page lists. The
 * engine analyses each part's template text, and its positions are turned into paragraphs, because
 * a line of the extracted text means nothing to someone looking at the document. Throws `OfficeError`
 * for a file that is not a Word or PowerPoint template.
 */
export function analyzeOffice(
  file: Uint8Array,
  options: { engine: EngineId; sampleData?: unknown; installedFonts?: readonly string[] },
): OfficeAnalysis {
  const { format, archive } = openTemplate(file);
  const engine = getEngine(options.engine);
  const registry = defaultHelpers();
  const tags: OfficeTag[] = [];
  const diagnostics: OfficeAnalysisDiagnostic[] = [];
  const variables = new Map<string, Pick<VariableRef, 'path' | 'kind'>>();
  for (const entry of archive.entries) {
    if (!PARTS[format].test(entry.name)) continue;
    const xml = readText(entry);
    if (!/\{\{|\{%|\{#/.test(xml)) continue;
    const part = preparePart(xml, entry.name, format);
    diagnostics.push(...part.diagnostics);
    tags.push(...listTags(part.template, entry.name));
    const analysis = engine.analyze(part.template.source, { sampleData: options.sampleData });
    const lineStarts = [0];
    for (let i = 0; i < part.template.source.length; i++) if (part.template.source[i] === '\n') lineStarts.push(i + 1);
    for (const d of analysis.diagnostics) {
      const offset = (lineStarts[d.range.start.line - 1] ?? 0) + d.range.start.column - 1;
      const end = (lineStarts[d.range.end.line - 1] ?? 0) + d.range.end.column - 1;
      diagnostics.push({
        severity: d.severity,
        code: d.code,
        message: d.message,
        part: entry.name,
        paragraph: paragraphAtSource(part.template, offset),
        text: part.template.source.slice(offset, Math.max(offset, end)).replace(placeholderPattern(part.template.nonce), '').slice(0, 60),
      });
    }
    for (const f of analysis.filters) {
      const name = registry.get(f.name)?.name ?? f.name;
      if (!officeUnsupportedHelpers.has(name)) continue;
      diagnostics.push({
        severity: 'error',
        code: 'unsupported-in-office',
        message: `${name}() is not supported in office templates; it returns HTML.`,
        part: entry.name,
        paragraph: paragraphAtSource(part.template, (lineStarts[f.range.start.line - 1] ?? 0) + f.range.start.column - 1),
        text: f.name,
      });
    }
    for (const v of analysis.variables) {
      const key = `${v.kind}:${v.path.join('.')}`;
      if (!variables.has(key)) variables.set(key, { path: v.path, kind: v.kind });
    }
  }
  const fonts = format === 'docx' ? documentFonts(archive) : [];
  if (options.installedFonts) diagnostics.push(...fontDiagnostics(fonts, options.installedFonts));
  return { format, tags, diagnostics, variables: [...variables.values()], fonts };
}

/**
 * The parts a template can fill (body, headers, footers and notes of Word; slides and notes of
 * PowerPoint) with their XML, in archive order: what the dev kit's snapshots compare.
 */
export function officeTextParts(file: Uint8Array): Array<{ name: string; xml: string }> {
  const { format, archive } = openTemplate(file);
  return archive.entries.filter((e) => PARTS[format].test(e.name)).map((e) => ({ name: e.name, xml: readText(e) }));
}

export async function renderOffice(file: Uint8Array, options: OfficeRenderOptions): Promise<OfficeRenderResult> {
  const { format, archive } = openTemplate(file);

  const engine = getEngine(options.engine);
  const drawings = new DrawingCollector(createNonce(options.random));
  const context: RenderContext = { ...options.context, mode: 'office', drawing: drawings.register };
  // a filled document used as a template again already holds `formfeed` pictures
  const media = format === 'docx' ? 'word/media/formfeed' : 'ppt/media/formfeed';
  const prefix = archive.entries.some((e) => e.name.startsWith(media)) ? `${media}-${drawings.nonce}-` : media;
  const resolver = new DrawingResolver(drawings.requests, options.images, prefix);
  const slide = format === 'pptx' ? slideSize(archive.get('ppt/presentation.xml') ? readText(archive.get('ppt/presentation.xml')!) : null) : null;
  const diagnostics: OfficeDiagnostic[] = [];
  const warnings: string[] = [];
  const rewritten = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  let filledBytes = 0;
  let removedCharacters = 0;
  /** Image relationships to add, per part. */
  const relationships = new Map<string, Array<{ id: string; target: string }>>();

  for (const entry of archive.entries) {
    if (!PARTS[format].test(entry.name)) continue;
    const xml = readText(entry);
    if (!/\{\{|\{%|\{#/.test(xml)) continue;

    const normal = preparePart(xml, entry.name, format, options.random);
    const partDiagnostics = normal.diagnostics;
    diagnostics.push(...partDiagnostics.filter((d) => d.severity !== 'error'));
    const errors = partDiagnostics.filter((d) => d.severity === 'error');
    if (errors.length) throw new OfficeTemplateError(`${entry.name}: ${errors[0]!.message}`, errors, entry.name);

    let output: string;
    try {
      output = await engine.render(engine.compile(normal.template.source, { name: entry.name }), options.data, context);
    } catch (e) {
      if (drawings.exceeded) throw drawings.exceeded;
      // the engine's line and column point into the extracted text, not the document: name the part
      if (e instanceof RenderError && e.message.includes('is not supported in office templates'))
        throw new OfficeTemplateError(`${entry.name}: ${e.message}`, [
          { severity: 'error', code: 'unsupported-in-office', message: e.message, part: entry.name, paragraph: 1, text: '' },
        ], entry.name, e);
      if (e instanceof EngineSyntaxError || e instanceof RenderError)
        throw new OfficeTemplateError(`${entry.name}: ${e.message}`, [], entry.name, e);
      throw e;
    }
    const filled = fromTemplateOutput(output, normal.template, entry.name);
    const used = drawings.usedIn(filled.xml);
    let placed = filled.xml;
    if (used.length) {
      const pictures = await placePictures(filled.xml, entry.name, used, drawings, resolver, archive, relationships, slide);
      placed = pictures.xml;
      warnings.push(...pictures.warnings.filter((w) => !warnings.includes(w)));
    }
    const unique = makeIdsUnique(removeEmptyTables(placed));
    try {
      assertWellFormed(tokenize(unique, entry.name), entry.name);
    } catch (e) {
      // The template produced broken structure (a block that opens in one element and closes in another).
      throw new OfficeTemplateError(`${entry.name}: the filled part is not valid (${(e as Error).message})`, [], entry.name);
    }
    removedCharacters += filled.removedCharacters;
    const bytes = encoder.encode(unique);
    filledBytes += bytes.length;
    if (filledBytes > OFFICE_FILLED_MAX_BYTES)
      throw new OfficeError('office_document_too_large', `The filled document is larger than ${OFFICE_FILLED_MAX_BYTES / 1024 / 1024} MB`, {
        limit: OFFICE_FILLED_MAX_BYTES,
      });
    rewritten.set(entry.name, bytes);
  }

  if (removedCharacters) warnings.push(`Removed ${removedCharacters} character(s) from the data that documents cannot contain`);
  warnings.push(...resolver.warnings);
  if (resolver.media.length) {
    for (const [part, added] of relationships) {
      const path = relsPathOf(part);
      const existing = archive.get(path);
      rewritten.set(path, encoder.encode(withRelationships(existing ? readText(existing) : null, added)));
    }
    const types = archive.get('[Content_Types].xml')!;
    rewritten.set('[Content_Types].xml', encoder.encode(withImageTypes(readText(types), new Set(resolver.media.map((m) => m.extension)))));
  }
  const names = new Set(archive.entries.map((e) => e.name));
  const entries: ZipWriteEntry[] = archive.entries.map((e) => {
    const data = rewritten.get(e.name);
    return data ? { name: e.name, data } : e;
  });
  // new parts: relationships of parts that had none, and the pictures (stored, they are compressed already)
  for (const [name, data] of rewritten) if (!names.has(name)) entries.push({ name, data });
  for (const media of resolver.media) entries.push({ name: media.name, data: media.bytes, store: true });
  return { bytes: rewritten.size ? writeZip(entries) : file, format, warnings, diagnostics };
}

/**
 * Resolves the drawings a part uses and puts them in place: inline pictures in Word, picture shapes on
 * slides; a relationship per picture (shared by every use of that picture in the part) and ids after
 * the part's highest.
 */
async function placePictures(
  xml: string,
  part: string,
  used: readonly number[],
  drawings: DrawingCollector,
  resolver: DrawingResolver,
  archive: ZipArchive,
  relationships: Map<string, Array<{ id: string; target: string }>>,
  slide: { cx: number; cy: number } | null,
): Promise<{ xml: string; warnings: string[] }> {
  const width = slide ? slide.cx : textWidthEmu(xml);
  const resolved = new Map(await Promise.all([...new Set(used)].map(async (i) => [i, await resolver.resolve(i, width)] as const)));
  const existing = archive.get(relsPathOf(part));
  const taken = relationshipIds(existing ? readText(existing) : null);
  const added = relationships.get(part) ?? [];
  relationships.set(part, added);
  const byMedia = new Map(added.map((r) => [r.target, r.id]));
  let nextId = highestDrawingId(xml);
  const relFor = (media: string): string => {
    // targets are relative to the part's folder: `media/x.png` from `word/document.xml`,
    // `../media/x.png` from `ppt/slides/slide1.xml`
    const target = relativeTarget(part, media);
    let id = byMedia.get(target);
    if (!id) {
      let n = added.length + 1;
      while (taken.has(`rIdFormfeed${n}`)) n++;
      id = `rIdFormfeed${n}`;
      taken.add(id);
      added.push({ id, target });
      byMedia.set(target, id);
    }
    return id;
  };
  if (slide)
    return placeSlidePictures(
      xml,
      drawings.pattern(),
      (index) => resolved.get(index),
      (picture, box) => slidePicture(picture, relFor(picture.media), ++nextId, box),
      slide,
    );
  return {
    xml: placeDrawings(xml, drawings.pattern(), (index) => {
      const drawing = resolved.get(index);
      if (!drawing || drawing.kind === 'nothing') return '';
      if (drawing.kind === 'page-break') return '<w:br w:type="page"/>';
      return inlinePicture(drawing, relFor(drawing.media), ++nextId);
    }),
    warnings: [],
  };
}

/** A package path relative to the folder of `from`. */
function relativeTarget(from: string, to: string): string {
  const base = from.split('/').slice(0, -1);
  const target = to.split('/');
  let common = 0;
  while (common < base.length && base[common] === target[common]) common++;
  return [...base.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}
