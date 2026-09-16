import { getEngine } from '../engines';
import { EngineSyntaxError, RenderError } from '../errors';
import type { EngineId, RenderContext, VariableRef } from '../types';
import { detectOfficeFormat } from './detect';
import { OfficeError } from './errors';
import { documentFonts, fontDiagnostics, type DocumentFont } from './fonts';
import { makeIdsUnique } from './ids';
import { applyStructure, dropTaggedFallbacks } from './structure';
import { listTags, normaliseTags, paragraphAtSource, type OfficeDiagnostic, type OfficeTag } from './tags';
import { createNonce, fromTemplateOutput, placeholderPattern, toTemplateSource, type TemplateSource, type TextFlavour } from './template-text';
import { assertWellFormed, tokenize } from './xml';
import { readText, writeZip, type ZipWriteEntry } from './zip';

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
    for (const v of analysis.variables) {
      const key = `${v.kind}:${v.path.join('.')}`;
      if (!variables.has(key)) variables.set(key, { path: v.path, kind: v.kind });
    }
  }
  const fonts = format === 'docx' ? documentFonts(archive) : [];
  if (options.installedFonts) diagnostics.push(...fontDiagnostics(fonts, options.installedFonts));
  return { format, tags, diagnostics, variables: [...variables.values()], fonts };
}

export async function renderOffice(file: Uint8Array, options: OfficeRenderOptions): Promise<OfficeRenderResult> {
  const { format, archive } = openTemplate(file);

  const engine = getEngine(options.engine);
  const context: RenderContext = { ...options.context, mode: 'office' };
  const diagnostics: OfficeDiagnostic[] = [];
  const warnings: string[] = [];
  const rewritten = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  let filledBytes = 0;
  let removedCharacters = 0;

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
      // the engine's line and column point into the extracted text, not the document: name the part
      if (e instanceof EngineSyntaxError || e instanceof RenderError)
        throw new OfficeTemplateError(`${entry.name}: ${e.message}`, [], entry.name, e);
      throw e;
    }
    const filled = fromTemplateOutput(output, normal.template, entry.name);
    const unique = makeIdsUnique(filled.xml);
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
  const entries: ZipWriteEntry[] = archive.entries.map((e) => {
    const data = rewritten.get(e.name);
    return data ? { name: e.name, data } : e;
  });
  return { bytes: rewritten.size ? writeZip(entries) : file, format, warnings, diagnostics };
}
