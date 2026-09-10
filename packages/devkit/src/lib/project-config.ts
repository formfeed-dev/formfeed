import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EngineId } from '@formfeed/engine';
import { DevkitError } from './errors';

/** `formfeed.json` of a project (spec 15 §2). */
export interface ProjectConfig {
  workspace?: string;
  region?: 'eu' | 'us';
  templatesDir: string;
  partialsDir: string;
  engine: EngineId;
  ignore: string[];
}

export interface Project {
  root: string;
  /** Null for an ad-hoc project built around a template folder without formfeed.json. */
  configPath: string | null;
  config: ProjectConfig;
  templatesDir: string;
  partialsDir: string;
}

export const defaultProjectConfig: ProjectConfig = {
  templatesDir: 'templates',
  partialsDir: 'partials',
  engine: 'jinja2',
  ignore: ['**/drafts/**'],
};

/** Walks up from `cwd` to the nearest `formfeed.json`. */
export function findProject(cwd: string = process.cwd()): Project | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'formfeed.json');
    if (existsSync(candidate)) return loadProject(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadProject(configPath: string): Project {
  let raw: Partial<ProjectConfig>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<ProjectConfig>;
  } catch {
    throw new DevkitError(`${configPath} is not valid JSON`);
  }
  const config: ProjectConfig = { ...defaultProjectConfig, ...raw };
  const root = dirname(configPath);
  return { root, configPath, config, templatesDir: resolve(root, config.templatesDir), partialsDir: resolve(root, config.partialsDir) };
}

/**
 * A project for one template folder when no formfeed.json is around (test helpers): the folder's
 * parent is the templates dir, `partials` next to it holds the partials.
 */
export function projectAround(templateFolder: string): Project {
  const dir = resolve(templateFolder);
  const found = findProject(dir);
  if (found) return found;
  const templatesDir = dirname(dir);
  const root = dirname(templatesDir);
  return {
    root,
    configPath: null,
    config: { ...defaultProjectConfig, templatesDir: templatesDir, partialsDir: join(root, 'partials') },
    templatesDir,
    partialsDir: join(root, 'partials'),
  };
}

export function writeProjectConfig(root: string, config: Partial<ProjectConfig>): string {
  const path = join(root, 'formfeed.json');
  const full = { ...defaultProjectConfig, ...config };
  writeFileSync(path, JSON.stringify(full, null, 2) + '\n');
  return path;
}
