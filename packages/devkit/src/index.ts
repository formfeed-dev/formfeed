export { DevkitError } from './lib/errors';
export { defaultProjectConfig, findProject, isIgnored, loadProject, projectAround, writeProjectConfig } from './lib/project-config';
export type { Project, ProjectConfig } from './lib/project-config';
export {
  contentHash,
  defaultData,
  listTemplateSlugs,
  officeVersionPayload,
  partialContentHash,
  partialResolver,
  readState,
  readTemplate,
  recordSharedPartial,
  recordSync,
  sharedPartialNames,
  sharedPartialPath,
  templateDir,
  templateFileName,
  titleFromSlug,
  versionPayload,
  writePartials,
  writeState,
  writeTemplate,
} from './lib/project';
export type { LocalOfficeFile, LocalTemplate, ProjectState, SharedPartialState, TemplateMeta, TemplateState } from './lib/project';
export { brandFromJson, brandPath, readBrand, writeBrand } from './lib/brand';
export { collectPartials } from './lib/partials';
export type { CollectedPartials } from './lib/partials';
export { diagnose, officeSnapshot, prettyXml, previewDocument, renderContext, renderLocal, renderOfficeLocal, renderedSettings } from './lib/local-render';
export type { LocalDiagnostic, OfficeLocalOptions } from './lib/local-render';
export { contentTypeFor, listLocalFiles, localFilePath, sha256File, writeLocalFile } from './lib/files';
export type { LocalFile, LocalFileListing } from './lib/files';
export type { LocalRenderOptions } from './lib/local-render';
export { parseRedactPath, redactData, redactString } from './lib/redact';
export { defaultTypesFile, generateTypes, localTypeSource } from './lib/types';
export type { SchemaOrigin, TypeScriptOptions, TypeSource, TypesLanguage } from './lib/types';
