import { emitPython } from './emit-python';
import { emitTypeScript, type TypeScriptOptions } from './emit-ts';
import { buildTypes, type TypeSource } from './model';

/**
 * `formfeed types` without the file system (spec 19 §2): a schema in, a generated file out. Apart
 * from `index.ts`, which reads template folders and therefore brings the engine with it, so the
 * landing site's browser tool can emit exactly what the CLI emits. `@formfeed/devkit/emit` in this
 * workspace; the published package exposes the same functions from its single entry.
 */
export type TypesLanguage = 'ts' | 'python';

export const defaultTypesFile: Record<TypesLanguage, string> = {
  ts: 'formfeed.d.ts',
  python: 'formfeed_templates.py',
};

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
