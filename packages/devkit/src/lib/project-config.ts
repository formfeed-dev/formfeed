import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { EngineId } from '@formfeed/engine';
import { DevkitError } from './errors';

/** `formfeed.json` of a project (spec 15 §2). */
export interface ProjectConfig {
  workspace?: string;
  region?: 'eu' | 'us';
  templatesDir: string;
  partialsDir: string;
  /** The local copy of the workspace file library (`formfeed files push|pull`). */
  filesDir: string;
  engine: EngineId;
  ignore: string[];
  /** Defaults of `formfeed types` (spec 19 §2.1). */
  types?: {
    lang?: 'ts' | 'python';
    /** Relative to the project root; `formfeed.d.ts` or `formfeed_templates.py` when left out. */
    out?: string;
    /** The module the TypeScript file augments; `@formfeed/sdk`. */
    sdkModule?: string;
  };
  /** Defaults of `formfeed renders pull` (spec 20 §3.3). */
  pull?: {
    /** Data paths redacted on every pull (`customer.*`, `items[].name`); `--redact` paths replace them, `--no-redact` skips them. */
    redact?: string[];
  };
}

export interface Project {
  root: string;
  /** Null for an ad-hoc project built around a template folder without formfeed.json. */
  configPath: string | null;
  config: ProjectConfig;
  templatesDir: string;
  partialsDir: string;
  filesDir: string;
}

export const defaultProjectConfig: ProjectConfig = {
  templatesDir: 'templates',
  partialsDir: 'partials',
  filesDir: 'files',
  engine: 'jinja2',
  ignore: ['**/drafts/**'],
};

/**
 * A glob of `ignore` as a regular expression: `**` spans folders, `*` and `?` stay within one, and a
 * pattern without a slash matches a name at any depth, as in `.gitignore`.
 */
function globRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob.includes('/')) glob = `**/${glob}`;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source.replace(/^\//, '')}$`);
}

/**
 * Whether a path of the project matches one of `ignore`. The path is taken relative to the project
 * root; a folder also matches as `<folder>/` and through the files in it, so `**\/drafts/**` and
 * `templates/wip-*` both catch `templates/wip-offer`.
 */
export function isIgnored(project: Project, path: string, folder = false): boolean {
  const patterns = project.config.ignore ?? [];
  if (!patterns.length) return false;
  const rel = relative(project.root, resolve(project.root, path)).split(sep).join('/');
  const candidates = folder ? [rel, `${rel}/`, `${rel}/x`] : [rel];
  return patterns.some((p) => {
    const re = globRegExp(p);
    return candidates.some((c) => re.test(c));
  });
}

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
  return {
    root,
    configPath,
    config,
    templatesDir: resolve(root, config.templatesDir),
    partialsDir: resolve(root, config.partialsDir),
    filesDir: resolve(root, config.filesDir),
  };
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
    config: { ...defaultProjectConfig, templatesDir: templatesDir, partialsDir: join(root, 'partials'), filesDir: join(root, 'files') },
    templatesDir,
    partialsDir: join(root, 'partials'),
    filesDir: join(root, 'files'),
  };
}

export function writeProjectConfig(root: string, config: Partial<ProjectConfig>): string {
  const path = join(root, 'formfeed.json');
  const full = { ...defaultProjectConfig, ...config };
  writeFileSync(path, JSON.stringify(full, null, 2) + '\n');
  return path;
}
