// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient typings for deep imports must reach every consumer of the package
/// <reference path="./types/modules.d.ts" />
export * from './lib/types';
export { EngineSyntaxError, RenderError, RenderLimitError } from './lib/errors';
export { defaultLimits, depthGuard, enforceLimits } from './lib/limits';
export {
  DefaultHelperRegistry,
  builtinHelpers,
  chartMarkup,
  chartPayload,
  createHelperRegistry,
  defaultHelpers,
  epcPayload,
  escapeHtml,
  helperDocs,
  imageMarkup,
  qrSvg,
  toDate,
  toNumber,
} from './lib/helpers';
export {
  analyzeHandlebars,
  analyzeJinja2,
  analyzeLiquid,
  engineIds,
  engines,
  getEngine,
  handlebarsEngine,
  jinja2Engine,
  liquidEngine,
  liquidBuiltinFilters,
  nunjucksBuiltinFilters,
} from './lib/engines';
export { diffSchemas, inferSchema, inferSchemaFromDataSets, schemaPaths } from './lib/schema';
export { brandCss, emptyBrand, layeredPartials, normalisePartialName } from './lib/brand';
export type { BrandContext, SharedPartial } from './lib/brand';
export {
  mergeSampleData,
  mergeSnippetCss,
  mergeSnippetI18n,
  partialInclude,
  snippets,
  snippetsFor,
  snippetText,
} from './lib/snippets';
export { importApitemplate, slugFromName } from './lib/import/apitemplate';
export type { ApitemplateExport } from './lib/import/apitemplate';
export type { ImportNote, ImportResult, ImportSource } from './lib/import/common';
export { importPdfmonkey, strftimeToDateFns } from './lib/import/pdfmonkey';
export type { PdfmonkeyImportOptions, PdfmonkeySettings, PdfmonkeyTemplate } from './lib/import/pdfmonkey';
export { importJsreport, jsreportTemplates, readJsreportExport } from './lib/import/jsreport';
export type { JsreportBundle, JsreportImportOptions, JsreportTemplate } from './lib/import/jsreport';
export { convertScss, isScss } from './lib/import/scss';
export type { Snippet, SnippetGroup } from './lib/snippets';
export type { JsonSchema, SchemaChange, SchemaChangeKind, SchemaDiff } from './lib/schema';
export {
  assembleDocument,
  chartInitScript,
  defaultSettings,
  fontFaceCss,
  mergeSettings,
  pageSize,
  printReset,
  renderVersion,
} from './lib/assemble';
export type { ChartSpec, ImageOptions } from './lib/helpers';
export { flowDocument, pagedDocument, pageNumberSpans, paperOf } from './lib/preview';
export type { PagedOptions, RenderedDraft } from './lib/preview';
export {
  annotateSourcePositions,
  parseSourceAttribute,
  sourceAttribute,
} from './lib/source-positions';
export type { SourceFile, SourceLocation } from './lib/source-positions';
export type {
  AssembleExtras,
  AssembleInput,
  AssembleVendor,
  FontFace,
  RenderedDocument,
  TemplateKind,
  TemplateSettings,
  VersionSource,
} from './lib/assemble';
export {
  resolvePath,
  scanBlocks,
  jinjaTags,
  liquidTags,
} from './lib/analysis/tags';
