import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalisePartialName, type EngineId, type TemplateKind, type TemplateSettings } from '@formfeed/engine';
import type { TemplateVersion } from '@formfeed/sdk-ts';
import { DevkitError } from './errors';
import { collectPartials } from './partials';
import type { Project } from './project-config';

/**
 * The template folder of spec 15 §2. `template.json` (name, kind, engine, description, tags) is
 * the one addition to the spec's layout: `push` needs it to create a template that does not exist
 * remotely, `pull` writes it. Header and footer live in their own files and fold back into
 * `settings.header.html` / `settings.footer.html`, as the editor's tabs do.
 */
export interface TemplateMeta {
  name: string;
  kind: TemplateKind;
  engine: EngineId;
  description?: string | null;
  tags?: string[];
}

export interface LocalTemplate {
  slug: string;
  dir: string;
  meta: TemplateMeta;
  html: string;
  css: string;
  head: string;
  /** Settings with header/footer html folded in. */
  settings: TemplateSettings;
  /** `data/<name>.json`, `default` first when present. */
  dataSets: Record<string, unknown>;
  dataSchema: Record<string, unknown> | null;
  i18n: Record<string, Record<string, string>> | null;
  /** Partials the template includes, read from the project's folder; they travel with the version. */
  partials: Record<string, string>;
  /** Included names without a file; `validate` reports them and `push` refuses them. */
  missingPartials: string[];
  /**
   * Included names that are shared partials of the organisation (recorded in the state by
   * `formfeed partials pull|push`). They resolve live on the server, so they stay out of `partials`.
   */
  sharedPartials: string[];
}

export interface TemplateState {
  /** Checksum of the remote version the folder was pulled from or pushed as. */
  checksum: string;
  number: number;
  status: string;
  /** Hash of the local files at that moment; a different hash means local edits. */
  contentHash: string;
  syncedAt: string;
}

/** A shared partial of the organisation as last pulled or pushed (spec 18 §8). */
export interface SharedPartialState {
  /** The remote version; `partials push` sends it as `base_version`. */
  version: number;
  engine: EngineId;
  /** Hash of the local file at that moment; a different hash means local edits. */
  contentHash: string;
  syncedAt: string;
}

export interface ProjectState {
  templates: Record<string, TemplateState>;
  /** Shared partials by name; they live in `partialsDir` as `<name>.html`. */
  sharedPartials?: Record<string, SharedPartialState>;
}

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function readJson<T>(path: string, what: string): T | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new DevkitError(`${what} is not valid JSON: ${path} (${e instanceof Error ? e.message : e})`, 'validation');
  }
}

export function listTemplateSlugs(project: Project): string[] {
  if (!existsSync(project.templatesDir)) return [];
  return readdirSync(project.templatesDir)
    .filter((name) => existsSync(join(project.templatesDir, name, 'template.html')))
    .sort();
}

export function templateDir(project: Project, slug: string): string {
  return join(project.templatesDir, slug);
}

export function readTemplate(project: Project, slug: string): LocalTemplate {
  const dir = templateDir(project, slug);
  const html = readText(join(dir, 'template.html'));
  if (html === null) throw new DevkitError(`No template "${slug}" in ${project.templatesDir} (template.html missing)`);
  const metaFile = readJson<Partial<TemplateMeta>>(join(dir, 'template.json'), 'template.json') ?? {};
  const meta: TemplateMeta = {
    name: metaFile.name ?? titleFromSlug(slug),
    kind: metaFile.kind ?? 'pdf',
    engine: metaFile.engine ?? project.config.engine,
    description: metaFile.description ?? null,
    tags: metaFile.tags ?? [],
  };
  const settings: TemplateSettings = { ...(readJson<TemplateSettings>(join(dir, 'settings.json'), 'settings.json') ?? {}) };
  const header = readText(join(dir, 'header.html'));
  const footer = readText(join(dir, 'footer.html'));
  if (header !== null && header.trim()) settings.header = { ...(settings.header ?? {}), html: header };
  if (footer !== null && footer.trim()) settings.footer = { ...(settings.footer ?? {}), html: footer };
  const dataSets: Record<string, unknown> = {};
  const dataDir = join(dir, 'data');
  if (existsSync(dataDir)) {
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort()) {
      dataSets[basename(file, '.json')] = readJson<unknown>(join(dataDir, file), `data/${file}`);
    }
  }
  const { partials, missing, shared } = collectPartials(project, meta.engine, [html, settings.header?.html, settings.footer?.html]);
  return {
    slug,
    dir,
    meta,
    html,
    css: readText(join(dir, 'style.css')) ?? '',
    head: readText(join(dir, 'head.html')) ?? '',
    settings,
    dataSets,
    dataSchema: readJson<Record<string, unknown>>(join(dir, 'schema.json'), 'schema.json'),
    i18n: readJson<Record<string, Record<string, string>>>(join(dir, 'i18n.json'), 'i18n.json'),
    partials,
    missingPartials: missing,
    sharedPartials: shared,
  };
}

/** The sample data set the preview and validation use: `default`, else the first file, else `{}`. */
export function defaultData(tpl: LocalTemplate, name?: string): { name: string; data: unknown } {
  const names = Object.keys(tpl.dataSets);
  const chosen = name ?? (names.includes('default') ? 'default' : names[0]);
  if (name && !(name in tpl.dataSets))
    throw new DevkitError(`Data set "${name}" not found; available: ${names.join(', ') || 'none'}`);
  return chosen ? { name: chosen, data: tpl.dataSets[chosen] } : { name: 'empty', data: {} };
}

export function writeTemplate(
  project: Project,
  slug: string,
  meta: TemplateMeta,
  version: Pick<TemplateVersion, 'html' | 'css' | 'head' | 'settings' | 'sample_data' | 'data_schema' | 'i18n'> & {
    data_sets?: Record<string, unknown> | null;
    partials?: Record<string, string> | null;
  },
): string {
  const dir = templateDir(project, slug);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const settings = { ...(version.settings ?? {}) } as TemplateSettings;
  const header = settings.header?.html ?? '';
  const footer = settings.footer?.html ?? '';
  if (settings.header) settings.header = stripHtml(settings.header);
  if (settings.footer) settings.footer = stripHtml(settings.footer);
  writeFileSync(join(dir, 'template.json'), JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(join(dir, 'template.html'), version.html ?? '');
  writeOrRemove(join(dir, 'style.css'), version.css ?? '');
  writeOrRemove(join(dir, 'head.html'), version.head ?? '');
  writeOrRemove(join(dir, 'header.html'), header);
  writeOrRemove(join(dir, 'footer.html'), footer);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  writeFileSync(join(dir, 'data', 'default.json'), JSON.stringify(version.sample_data ?? {}, null, 2) + '\n');
  for (const [name, data] of Object.entries(version.data_sets ?? {}))
    if (name !== 'default' && /^[\w.-]+$/.test(name))
      writeFileSync(join(dir, 'data', `${name}.json`), JSON.stringify(data ?? {}, null, 2) + '\n');
  writeOrRemove(join(dir, 'schema.json'), version.data_schema ? JSON.stringify(version.data_schema, null, 2) + '\n' : '');
  writeOrRemove(join(dir, 'i18n.json'), version.i18n ? JSON.stringify(version.i18n, null, 2) + '\n' : '');
  writePartials(project, version.partials ?? null);
  return dir;
}

/** A partial name is a path inside the partials folder: relative, no `..`, no backslash. */
const partialName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

/**
 * Writes the partials of a pulled version into the project's folder (`name` or `name.html`, the
 * two spellings `partialResolver` reads). Returns the files whose content changed, so `pull` can
 * say that a partial shared with another template was replaced.
 */
export function writePartials(project: Project, partials: Record<string, string> | null): string[] {
  const changed: string[] = [];
  for (const [name, source] of Object.entries(partials ?? {})) {
    if (!partialName.test(name)) continue; // the API validates as well; never write outside the folder
    const path = join(project.partialsDir, name.includes('.') ? name : `${name}.html`);
    if (readText(path) === source) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    changed.push(path);
  }
  return changed;
}

function stripHtml<T extends { html?: string }>(part: T): Omit<T, 'html'> | null {
  const { html: _html, ...rest } = part;
  void _html;
  return Object.keys(rest).length ? rest : null;
}

function writeOrRemove(path: string, content: string): void {
  if (content) writeFileSync(path, content);
  else if (existsSync(path)) rmSync(path);
}

/** Files of a push request: what the API's TemplateVersionCreate takes. */
export function versionPayload(tpl: LocalTemplate) {
  const sample = tpl.dataSets['default'] ?? Object.values(tpl.dataSets)[0] ?? {};
  // `default` travels as `sample_data` (what the API renders); the rest as named sets, the same
  // ones the editor shows.
  const named = Object.fromEntries(
    Object.entries(tpl.dataSets).filter(([name]) => name !== 'default'),
  );
  return {
    html: tpl.html,
    css: tpl.css,
    head: tpl.head,
    settings: tpl.settings as Record<string, unknown>,
    sample_data: (sample ?? {}) as Record<string, unknown>,
    data_sets: named as Record<string, unknown>,
    data_schema: tpl.dataSchema,
    i18n: tpl.i18n,
    // only when the template includes one, so a project without partials sends what it always sent
    ...(Object.keys(tpl.partials).length ? { partials: tpl.partials } : {}),
  };
}

/** Stable hash of the local files; compared with the state to detect local edits. */
export function contentHash(tpl: LocalTemplate): string {
  const payload = versionPayload(tpl);
  const parts: unknown[] = [payload.html, payload.css, payload.head, payload.settings, payload.sample_data, payload.data_sets, payload.data_schema, payload.i18n];
  // appended only when there are partials, so hashes recorded before they existed still match
  if (payload.partials) parts.push(payload.partials);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

const statePath = (project: Project) => join(project.root, '.formfeed', 'state.json');

export function readState(project: Project): ProjectState {
  return readJson<ProjectState>(statePath(project), '.formfeed/state.json') ?? { templates: {} };
}

export function writeState(project: Project, state: ProjectState): void {
  mkdirSync(join(project.root, '.formfeed'), { recursive: true });
  writeFileSync(statePath(project), JSON.stringify(state, null, 2) + '\n');
}

export function recordSync(project: Project, slug: string, version: Pick<TemplateVersion, 'checksum' | 'number' | 'status'>, tpl: LocalTemplate): void {
  const state = readState(project);
  state.templates[slug] = {
    checksum: version.checksum,
    number: version.number,
    status: version.status,
    contentHash: contentHash(tpl),
    syncedAt: new Date().toISOString(),
  };
  writeState(project, state);
}

export function titleFromSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolves `{% include %}` / partials from the project's partials folder (`name` or `name.html`).
 * A name that matches a shared partial of the state only after normalisation (`Letterhead.j2` for
 * `letterhead`) falls back to that partial's file, the way the server matches shared partials.
 */
export function partialResolver(project: Project): (name: string) => string | undefined {
  let shared: Set<string> | null = null;
  return (name: string) => {
    for (const candidate of [name, `${name}.html`]) {
      const path = join(project.partialsDir, candidate);
      if (existsSync(path) && statSync(path).isFile()) return readFileSync(path, 'utf8');
    }
    shared ??= new Set(Object.keys(readState(project).sharedPartials ?? {}));
    const normalised = normalisePartialName(name);
    if (!shared.has(normalised)) return undefined;
    return readText(sharedPartialPath(project, normalised)) ?? undefined;
  };
}

/** Where a shared partial lives locally: `<partialsDir>/<name>.html`. */
export function sharedPartialPath(project: Project, name: string): string {
  return join(project.partialsDir, `${name}.html`);
}

/** Normalised names of the shared partials recorded for one engine; other engines' partials never resolve. */
export function sharedPartialNames(project: Project, engine: EngineId): Set<string> {
  return new Set(
    Object.entries(readState(project).sharedPartials ?? {})
      .filter(([, partial]) => partial.engine === engine)
      .map(([name]) => normalisePartialName(name)),
  );
}

export const partialContentHash = (source: string): string => createHash('sha256').update(source).digest('hex');

/** Records a pulled or pushed shared partial with the remote version and the hash of `source`. */
export function recordSharedPartial(project: Project, name: string, remote: { version: number; engine: EngineId }, source: string): void {
  const state = readState(project);
  state.sharedPartials = {
    ...(state.sharedPartials ?? {}),
    [name]: { version: remote.version, engine: remote.engine, contentHash: partialContentHash(source), syncedAt: new Date().toISOString() },
  };
  writeState(project, state);
}
