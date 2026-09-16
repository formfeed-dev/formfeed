/**
 * `@formfeed/engine/office`: the office container code of spec 22 (ZIP, format detection, the checks
 * and the sanitiser of §2.1). No template engine is imported here, so the gateway Worker can use it
 * without bundling Nunjucks, Liquid or Handlebars.
 */
export { OfficeError, officeLimits, type OfficeErrorCode } from './errors';
export {
  cfbStreamNames,
  detectOfficeFormat,
  hasDoctype,
  isHtml,
  isMacroPart,
  officeContentTypes,
  officeFormats,
  type DetectedOffice,
  type OdfFormat,
  type OfficeFormat,
  type OoxmlFormat,
} from './detect';
export {
  parseAttributes,
  remoteResourceCount,
  removeExternalRelationships,
  sanitiseForConversion,
  type RemovedRelationship,
  type SanitisedDocument,
} from './sanitise';
export {
  createNonce,
  fromTemplateOutput,
  layoutText,
  toTemplateSource,
  type FilledPart,
  type TemplateSource,
  type TextFlavour,
} from './template-text';
export { assertWellFormed, decodeText, escapeText, stripForbidden, tokenize, type XmlToken } from './xml';
export {
  crc32,
  decodeXml,
  isSafeEntryName,
  isZip,
  readEntry,
  readText,
  readZip,
  writeZip,
  type ZipArchive,
  type ZipEntry,
  type ZipLimits,
  type ZipWriteEntry,
} from './zip';
