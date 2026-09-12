import { getEngine, type EngineId } from '@formfeed/engine';
import { partialResolver } from './project';
import type { Project } from './project-config';

/**
 * The partials a template includes, read from the project's `partials/` folder. They travel with
 * the version (`formfeed templates push`), so a published template resolves `{% include %}` in the
 * API and the editor, not only in the CLI.
 *
 * Includes nest, so every partial is analysed in turn; a name that has no file is reported instead
 * of failing, and `validate` and `push` show it.
 */
export interface CollectedPartials {
  /** name → source, the shape the API stores. */
  partials: Record<string, string>;
  /** Names no file in the partials folder matches. */
  missing: string[];
}

/** Names a source includes, or none when it does not parse (the syntax error is reported elsewhere). */
function includeNames(engine: EngineId, source: string): string[] {
  try {
    return getEngine(engine)
      .analyze(source)
      .includes.map((include) => include.name);
  } catch {
    return [];
  }
}

export function collectPartials(project: Project, engine: EngineId, sources: Array<string | undefined>): CollectedPartials {
  const resolve = partialResolver(project);
  const partials: Record<string, string> = {};
  const missing = new Set<string>();
  const queue = sources.filter((source): source is string => Boolean(source));
  const seen = new Set<string>();
  while (queue.length) {
    for (const name of includeNames(engine, queue.shift() as string)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const source = resolve(name);
      if (source === undefined) {
        missing.add(name);
        continue;
      }
      partials[name] = source;
      queue.push(source);
    }
  }
  return { partials, missing: [...missing].sort() };
}
