// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient typings for deep imports must reach every consumer of the package
/// <reference path="./types/modules.d.ts" />
export * from './lib/types';
export { EngineSyntaxError, RenderError, RenderLimitError } from './lib/errors';
export { defaultLimits, depthGuard, enforceLimits } from './lib/limits';
export {
  DefaultHelperRegistry,
  EPC_MAX_BYTES,
  builtinHelpers,
  chartMarkup,
  chartPayload,
  createHelperRegistry,
  defaultHelpers,
  epcPayload,
  escapeHtml,
  helperDocs,
  ibanChecksum,
  imageMarkup,
  normaliseIban,
  qrSvg,
  svgDataUri,
  toDate,
  toNumber,
  validateEpc,
} from './lib/helpers';
export type {
  EpcInput,
  EpcPayment,
  EpcProblem,
  QrOptions,
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
export {
  diffSchemas,
  inferSchema,
  inferSchemaFromDataSets,
  schemaPaths,
} from './lib/schema';
export {
  defaultOutput,
  imageOutput,
  isOfficeKind,
  isOutputFormat,
  officeKinds,
  outputFormats,
  outputsForKind,
  type OfficeKind,
  type OutputFormat,
} from './lib/output';
export {
  brandCss,
  emptyBrand,
  layeredPartials,
  normalisePartialName,
} from './lib/brand';
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
export {
  apitemplateRegions,
  importApitemplate,
  importApitemplateFromApi,
  isApitemplateHtmlTemplate,
  isApitemplateRegion,
  slugFromName,
  splitApitemplateCss,
} from './lib/import/apitemplate';
export type {
  ApitemplateApiTemplate,
  ApitemplateExport,
  ApitemplateListItem,
  ApitemplateRegion,
} from './lib/import/apitemplate';
export type {
  ImportNote,
  ImportResult,
  ImportSource,
} from './lib/import/common';
export { importPdfmonkey, strftimeToDateFns } from './lib/import/pdfmonkey';
export type {
  PdfmonkeyImportOptions,
  PdfmonkeySettings,
  PdfmonkeyTemplate,
} from './lib/import/pdfmonkey';
export {
  importJsreport,
  jsreportTemplates,
  readJsreportExport,
} from './lib/import/jsreport';
export type {
  JsreportBundle,
  JsreportImportOptions,
  JsreportTemplate,
} from './lib/import/jsreport';
export { convertScss, isScss } from './lib/import/scss';
export type { Snippet, SnippetGroup } from './lib/snippets';
export type {
  JsonSchema,
  SchemaChange,
  SchemaChangeKind,
  SchemaDiff,
} from './lib/schema';
export {
  DEFAULT_CHROME_PADDING,
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
export {
  canvasDocument,
  flowDocument,
  pagedDocument,
  pageNumberSpans,
  paperOf,
  zoomGestureScript,
} from './lib/preview';
export type {
  PagedOptions,
  PreviewOptions,
  PreviewOverflow,
  RenderedDraft,
} from './lib/preview';
export {
  annotateSourcePositions,
  editAttribute,
  parseSourceAttribute,
  sourceAttribute,
} from './lib/source-positions';
export type {
  AnnotateOptions,
  SourceFile,
  SourceLocation,
} from './lib/source-positions';
export {
  applyRegionEdit,
  chipValues,
  editableRegion,
  editableRegionAt,
  findRegionAgain,
  regionChips,
  regionItems,
  regionPosition,
  translationItems,
  translationText,
} from './lib/source-edit';
export type {
  ApplyResult,
  ChipKind,
  EditableRegion,
  EditItem,
  RegionChip,
  RegionLookup,
  RegionPart,
  RegionRefusal,
} from './lib/source-edit';
export { resolveTranslation, translationTarget } from './lib/translation';
// named, not `export *`: tsx compiles this file as CommonJS for scripts outside a module package, and
// Node's import of CommonJS finds no names behind a star re-export
export {
  DESIGN_LIMITS,
  DESIGN_VERSION,
  dataPathPattern,
  defaultLayer,
  designBytes,
  designOutputHash,
  designStarters,
  emitDesign,
  emptyDesign,
  genericFamily,
  googleFont,
  googleFonts,
  googleFontsUrl,
  imageIsEmpty,
  layerIdPattern,
  nearestWeight,
  nextLayerId,
  parseDesign,
} from './lib/design';
export type {
  BarcodeLayer,
  BarcodeSymbology,
  Binding,
  CanvasSize,
  DesignDocument,
  DesignLayer,
  DesignStarter,
  EmittedDesign,
  FontChoice,
  GoogleFont,
  ImageLayer,
  ImageSource,
  LayerBase,
  LayerType,
  Paint,
  ParsedDesign,
  QrLayer,
  Shadow,
  ShapeLayer,
  Stroke,
  TextFormat,
  TextItem,
  TextLayer,
  TextStyle,
} from './lib/design';
// The e-invoice module (spec 17) is `@formfeed/engine/einvoice` inside the workspace, which the
// gateway imports without the template engines; the published package and the app have this entry
// only, so everything they use is named here too.
export {
  CII_GUIDELINES,
  CODE_LIST_RELEASE,
  DISPLAY_TERMS,
  EINVOICE_FLAVOURS,
  EINVOICE_FLAVOUR_NAMES,
  EINVOICE_MAX_MESSAGES,
  EINVOICE_PROFILES,
  EINVOICE_PROFILE_NAMES,
  EINVOICE_SPEC_VERSIONS,
  EINVOICE_XML_NAME,
  EN16931_TERMS,
  INVOICE_DATA_KEY,
  VAT_CATEGORIES,
  capMessages,
  carriesTerm,
  checkInvoice,
  defaultEinvoiceOptions,
  displayCheck,
  displayMissingText,
  einvoiceOptionsSchema,
  einvoiceResult,
  einvoiceXml,
  htmlText,
  invoiceAmountText,
  invoiceLineOf,
  invoicePathSegments,
  invoiceSchema,
  invoiceSkeleton,
  invoiceToCii,
  locateJsonPath,
  resolveEinvoiceOptions,
  shownAmounts,
} from './lib/einvoice';
export type {
  CheckOptions,
  DisplayCheck,
  DisplayValue,
  EinvoiceDisplay,
  EinvoiceFlavour,
  EinvoiceMessage,
  EinvoiceOptions,
  EinvoiceOptionsInput,
  EinvoiceProfile,
  EinvoiceResult,
  EinvoiceTerm,
  EinvoiceValidation,
  EinvoiceXml,
  Identifier,
  Invoice,
  InvoiceAddress,
  InvoiceAllowance,
  InvoiceBreakdown,
  InvoiceCheck,
  InvoiceInput,
  InvoiceLine,
  InvoiceParty,
  InvoiceProblem,
  InvoiceProblemCode,
  InvoiceTax,
  JsonLocation,
  ResolvedEinvoice,
  VatCategory,
} from './lib/einvoice';
// PDF/UA (plan 21) is `@formfeed/engine/accessibility` inside the workspace, for the gateway's sake
// like the e-invoice module; named here too for the published package and the app.
export {
  ACCESSIBILITY_HEADER_LENGTH,
  ACCESSIBILITY_MAX_ELEMENTS,
  ACCESSIBILITY_MAX_FAILURES,
  AUDIT_CODES,
  AUDIT_RULES,
  AUDIT_SEVERITY,
  AUDIT_SNIPPET_LENGTH,
  AUDIT_TITLES,
  PDFUA_STANDARD,
  UA_CHECKS,
  UA_REFUSALS,
  accessibilityHeader,
  accessibilityHeaderValue,
  accessibilityResult,
  auditMessage,
  isUaSetting,
  resolveUa,
} from './lib/accessibility';
export type {
  AccessibilityFailure,
  AccessibilityResult,
  AccessibilityWarning,
  AuditArgs,
  AuditCode,
  AuditFinding,
  AuditLink,
  AuditOptions,
  AuditReport,
  AuditSeverity,
  UaCheck,
  UaOptions,
  UaSetting,
  ValidatorFailure,
  ValidatorVerdict,
} from './lib/accessibility';
export {
  staticAudit,
  staticAuditDiagnostics,
} from './lib/accessibility/static';
export type {
  StaticAuditDiagnostic,
  StaticAuditInput,
} from './lib/accessibility/static';
export { auditRuntime } from './lib/generated/frames';
export { encodeTemplateText } from './lib/source-edit';
export type { Dictionaries } from './lib/translation';
export type {
  AssembleExtras,
  AssembleInput,
  AssembleVendor,
  FontFace,
  HeaderFooterSettings,
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
export {
  OFFICE_FILLED_MAX_BYTES,
  OfficeTemplateError,
  analyzeOffice,
  officeTextParts,
  renderOffice,
  type OfficeAnalysis,
  type OfficeAnalysisDiagnostic,
  type OfficeRenderOptions,
  type OfficeRenderResult,
} from './lib/office/render';
export type { OfficeTag } from './lib/office/tags';
export { starterDocument } from './lib/office/starter';
export { starterPresentation } from './lib/office/starter-pptx';
export {
  officeDrawingLimits,
  type OfficeImageHost,
} from './lib/office/drawings';
