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
  removeExternalRelationships,
  sanitiseForConversion,
  type RemovedRelationship,
  type SanitisedDocument,
} from './sanitise';
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
