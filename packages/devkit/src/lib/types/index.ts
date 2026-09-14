import { inferSchemaFromDataSets } from '@formfeed/engine';
import type { LocalTemplate } from '../project';
import { emitPython } from './emit-python';
import { emitTypeScript, type TypeScriptOptions } from './emit-ts';
import { buildTypes, type TypeSource } from './model';

export type TypesLanguage = 'ts' | 'python';

export const defaultTypesFile: Record<TypesLanguage, string> = {
  ts: 'formfeed.d.ts',
  python: 'formfeed_templates.py',
};

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

/** The generated file for `sources` in `language`; the same input always gives the same bytes. */
export function generateTypes(sources: TypeSource[], language: TypesLanguage, options: TypeScriptOptions = {}): string {
  const reserved =
    language === 'python'
      ? ['TypedRenders', 'AsyncTypedRenders', 'Formfeed', 'AsyncFormfeed', 'Render', 'Any', 'Literal', 'Union', 'Never', 'NotRequired', 'TypedDict']
      : ['FormfeedTemplates'];
  const model = buildTypes(sources, reserved);
  return language === 'python' ? emitPython(model) : emitTypeScript(model, options);
}

export { buildTypes, pascalCase, relaxRequired, singular } from './model';
export type { SchemaOrigin, TemplateTypes, TypeNode, TypeSource } from './model';
export type { TypeScriptOptions } from './emit-ts';
