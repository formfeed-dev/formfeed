import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { readJsreportExport, type JsreportBundle, type PdfmonkeyTemplate } from '@formfeed/engine';
import { CliError, exitCodes } from './errors';

/**
 * The I/O around the importers in `@formfeed/engine` (spec 10 §4): PDFMonkey's API, the jsreport
 * export zip and an optional Sass compiler. The conversions themselves are the engine's, shared
 * with the app.
 */
const PDFMONKEY_API = 'https://api.pdfmonkey.io/api/v1';

export async function pdfmonkeyRequest(fetchImpl: typeof fetch, key: string, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${PDFMONKEY_API}${path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  } catch (e) {
    throw new CliError(`PDFMonkey is not reachable: ${e instanceof Error ? e.message : String(e)}`, exitCodes.network);
  }
  if (res.status === 401 || res.status === 403) throw new CliError('PDFMonkey rejected the API key (use a secret key from My account → API).', exitCodes.auth);
  if (res.status === 404) throw new CliError(`PDFMonkey has no ${path.split('?')[0]}.`, exitCodes.usage);
  if (!res.ok) throw new CliError(`PDFMonkey answered HTTP ${res.status}.`, exitCodes.network);
  return (await res.json()) as Record<string, unknown>;
}

/** Every template card of a workspace (their list endpoint needs the workspace id). */
export async function pdfmonkeyTemplateIds(fetchImpl: typeof fetch, key: string, workspaceId: string): Promise<Array<{ id: string; identifier: string; edition_mode?: string }>> {
  const out: Array<{ id: string; identifier: string; edition_mode?: string }> = [];
  for (let page = 1; page <= 20; page++) {
    const payload = await pdfmonkeyRequest(fetchImpl, key, `/document_template_cards?q[workspace_id]=${encodeURIComponent(workspaceId)}&q[folders]=all&page=${page}`);
    const batch = (Object.values(payload).find(Array.isArray) ?? []) as Array<Record<string, unknown>>;
    out.push(...batch.map((c) => ({ id: String(c['id']), identifier: String(c['identifier'] ?? c['id']), edition_mode: c['edition_mode'] as string | undefined })));
    const meta = payload['meta'] as { total_pages?: number } | undefined;
    if (!batch.length || !meta?.total_pages || page >= meta.total_pages) break;
  }
  return out;
}

export async function pdfmonkeyTemplate(fetchImpl: typeof fetch, key: string, id: string): Promise<PdfmonkeyTemplate> {
  const payload = await pdfmonkeyRequest(fetchImpl, key, `/document_templates/${encodeURIComponent(id)}`);
  return (payload['document_template'] ?? payload) as PdfmonkeyTemplate;
}

/**
 * `sass` from the user's project, when installed there: the CLI does not ship a Sass compiler
 * (5 MB for a one-off import); without it the engine converts the plain-CSS subset.
 */
export async function projectSassCompiler(cwd: string): Promise<((source: string) => string) | undefined> {
  try {
    const resolved = createRequire(join(cwd, 'package.json')).resolve('sass');
    type Sass = { compileString(source: string): { css: string } };
    // resolve() finds the CommonJS entry, whose functions arrive on `default` through import()
    const mod = (await import(pathToFileURL(resolved).href)) as Partial<Sass> & { default?: Sass };
    const sass = typeof mod.compileString === 'function' ? (mod as Sass) : mod.default;
    if (!sass) return undefined;
    return (source: string) => sass.compileString(source).css;
  } catch {
    return undefined;
  }
}

export function readJsreportFile(file: string): JsreportBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(readFileSync(file)), { filter: (f) => f.name.endsWith('.json') });
  } catch (e) {
    throw new CliError(`${file} is not a zip file (.jsrexport): ${e instanceof Error ? e.message : String(e)}`, exitCodes.usage);
  }
  try {
    return readJsreportExport(Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path, strFromU8(bytes)])));
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), exitCodes.usage);
  }
}

/** `name=file` pairs (`--snippet address=snippets/address.liquid`) as snippet code by name. */
export function readSnippets(pairs: string[], cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new CliError(`--snippet expects name=file, got "${pair}"`, exitCodes.usage);
    out[pair.slice(0, at)] = readFileSync(join(cwd, pair.slice(at + 1)), 'utf8');
  }
  return out;
}
