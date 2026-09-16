import { getEngine } from '../engines';
import type { EngineId, RenderContext } from '../types';
import { detectOfficeFormat } from './detect';
import { OfficeError } from './errors';
import { makeIdsUnique } from './ids';
import { applyStructure, dropTaggedFallbacks } from './structure';
import { normaliseTags, type OfficeDiagnostic } from './tags';
import { createNonce, fromTemplateOutput, toTemplateSource, type TextFlavour } from './template-text';
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

/** A template that cannot be filled as written; the diagnostics say where. */
export class OfficeTemplateError extends Error {
  constructor(
    message: string,
    readonly diagnostics: OfficeDiagnostic[],
    readonly part?: string,
  ) {
    super(message);
    this.name = 'OfficeTemplateError';
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

export async function renderOffice(file: Uint8Array, options: OfficeRenderOptions): Promise<OfficeRenderResult> {
  const { format, archive } = detectOfficeFormat(file);
  if ((format !== 'docx' && format !== 'pptx') || !archive)
    throw new OfficeError('file_type_unsupported', 'Office templates are Word (DOCX) or PowerPoint (PPTX) files');

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

    const structured = applyStructure(dropTaggedFallbacks(xml, entry.name), entry.name);
    const nonce = createNonce(options.random);
    const normal = normaliseTags(toTemplateSource(structured.xml, FLAVOUR[format], nonce, entry.name), entry.name);
    const partDiagnostics = [...structured.diagnostics, ...normal.diagnostics];
    if (INCLUDES.test(normal.template.source))
      partDiagnostics.push({
        severity: 'error',
        code: 'unsupported-in-office',
        message: 'Office templates cannot include partials; put the content into the document.',
        part: entry.name,
        paragraph: 1,
        text: INCLUDES.exec(normal.template.source)?.[0] ?? '',
      });
    diagnostics.push(...partDiagnostics.filter((d) => d.severity !== 'error'));
    const errors = partDiagnostics.filter((d) => d.severity === 'error');
    if (errors.length) throw new OfficeTemplateError(`${entry.name}: ${errors[0]!.message}`, errors, entry.name);

    const compiled = engine.compile(normal.template.source, { name: entry.name });
    const output = await engine.render(compiled, options.data, context);
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
