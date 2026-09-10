import type { Engine, EngineId } from '../types';
import { handlebarsEngine } from './handlebars';
import { jinja2Engine } from './jinja2';
import { liquidEngine } from './liquid';

export { analyzeHandlebars, handlebarsEngine } from './handlebars';
export { analyzeJinja2, jinja2Engine, nunjucksBuiltinFilters } from './jinja2';
export { analyzeLiquid, liquidBuiltinFilters, liquidEngine } from './liquid';

export const engines: Record<EngineId, Engine> = {
  jinja2: jinja2Engine,
  liquid: liquidEngine,
  handlebars: handlebarsEngine,
};

export const engineIds: EngineId[] = ['jinja2', 'liquid', 'handlebars'];

export function getEngine(id: EngineId | string): Engine {
  const engine = engines[id as EngineId];
  if (!engine)
    throw new Error(
      `Unknown template engine "${id}"; expected one of ${engineIds.join(', ')}`,
    );
  return engine;
}
