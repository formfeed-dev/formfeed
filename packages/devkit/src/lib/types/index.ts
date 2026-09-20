import { inferSchemaFromDataSets } from '@formfeed/engine';
import type { LocalTemplate } from '../project';
import type { TypeSource } from './model';

/**
 * The schema of a template folder: `schema.json` when it has one, else inferred over all its data
 * sets (a field only some sets carry is optional), marked as inferred so every field is optional.
 */
export function localTypeSource(tpl: LocalTemplate): TypeSource {
  if (tpl.dataSchema) return { slug: tpl.slug, schema: tpl.dataSchema, origin: 'local' };
  const sets = Object.values(tpl.dataSets);
  return {
    slug: tpl.slug,
    schema: inferSchemaFromDataSets(sets.length ? sets : [{}]) as Record<string, unknown>,
    origin: 'inferred',
  };
}

// The generation itself needs no template folder and so no engine; it lives in `generate.ts` and is
// re-exported here so importers of this barrel see no difference.
export { buildTypes, defaultTypesFile, generateTypes, pascalCase, relaxRequired, singular } from './generate';
export type { SchemaOrigin, TemplateTypes, TypeNode, TypeScriptOptions, TypeSource, TypesLanguage } from './generate';
