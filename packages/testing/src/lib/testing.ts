import { basename, resolve } from 'node:path';
import {
  defaultData,
  diagnose,
  projectAround,
  readTemplate,
  renderLocal,
  type LocalTemplate,
  type Project,
} from '@formfeed/devkit';
import type { Diagnostic } from '@formfeed/engine';
import { Formfeed } from '@formfeed/sdk-ts';

/**
 * Test helpers of spec 15 §5 for Vitest and Jest. `loadTemplate` reads a template folder (with or
 * without a formfeed.json around it) and the matchers run the shared engine offline; the API-backed
 * matcher skips with a warning without a key unless FORMFEED_REQUIRE_API=1.
 */
export interface TemplateHandle {
  slug: string;
  dir: string;
  project: Project;
  files: LocalTemplate;
  /** Assembled print document for the data, as the API would render it. */
  render(data?: unknown): Promise<string>;
  /** Diagnostics of the editor: syntax errors, unknown filters, variables missing from the data. */
  analyze(data?: unknown): Diagnostic[];
  /** A data set from `data/<name>.json` (default: `default`). */
  data(name?: string): unknown;
}

export async function loadTemplate(folder: string): Promise<TemplateHandle> {
  const dir = resolve(folder);
  const project = projectAround(dir);
  const slug = basename(dir);
  const files = readTemplate(project, slug);
  return {
    slug,
    dir,
    project,
    files,
    render: async (data) => (await renderLocal(project, files, data ?? defaultData(files).data, { mode: 'print' })).document,
    analyze: (data) => diagnose(files, data ?? defaultData(files).data),
    data: (name) => defaultData(files, name).data,
  };
}

export interface MatcherResult {
  pass: boolean;
  message: () => string;
}

const describeDiagnostics = (list: Diagnostic[]) =>
  list.map((d) => `  ${d.severity} ${d.range.start.line}:${d.range.start.column} ${d.message} [${d.code}]`).join('\n');

async function renderOrError(tpl: TemplateHandle, data: unknown): Promise<{ html: string | null; error: string | null }> {
  try {
    return { html: await tpl.render(data), error: null };
  } catch (e) {
    return { html: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The API client of the API-backed matchers: from `FORMFEED_API_KEY`, null when unset. */
export function apiClient(env: NodeJS.ProcessEnv = process.env): Formfeed | null {
  const apiKey = env['FORMFEED_API_KEY'];
  if (!apiKey) return null;
  return new Formfeed({
    apiKey,
    region: (env['FORMFEED_REGION'] as 'eu' | 'us' | undefined) ?? 'eu',
    ...(env['FORMFEED_BASE_URL'] ? { baseUrl: env['FORMFEED_BASE_URL'] } : {}),
  });
}

export interface MatcherOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the API client (tests). */
  client?: Formfeed | null;
  warn?: (message: string) => void;
}

/** Matcher implementations; `expect.extend(matchers)` or the `@formfeed/testing/vitest` setup file registers them. */
export function createMatchers(options: MatcherOptions = {}) {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  return {
    async toRenderWithoutErrors(received: TemplateHandle, data?: unknown): Promise<MatcherResult> {
      const errors = received.analyze(data ?? received.data()).filter((d) => d.severity === 'error');
      if (errors.length) return { pass: false, message: () => `${received.slug} has ${errors.length} error(s):\n${describeDiagnostics(errors)}` };
      const { error } = await renderOrError(received, data ?? received.data());
      return { pass: error === null, message: () => (error ? `${received.slug} failed to render: ${error}` : `${received.slug} rendered without errors`) };
    },
    async toUseOnlyKnownVariables(received: TemplateHandle, data?: unknown): Promise<MatcherResult> {
      const missing = received.analyze(data ?? received.data()).filter((d) => d.code === 'unknown-variable' || /not in the sample data|missing from/i.test(d.message));
      return {
        pass: missing.length === 0,
        message: () => (missing.length ? `${received.slug} reads variables the data does not provide:\n${describeDiagnostics(missing)}` : `${received.slug} uses only known variables`),
      };
    },
    async toContainText(received: TemplateHandle, text: string, data?: unknown): Promise<MatcherResult> {
      const { html, error } = await renderOrError(received, data ?? received.data());
      if (error) return { pass: false, message: () => `${received.slug} failed to render: ${error}` };
      const visible = (html ?? '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
      const pass = visible.includes(text);
      return { pass, message: () => (pass ? `${received.slug} contains "${text}"` : `${received.slug} does not contain "${text}"`) };
    },
    /** True render through the API; skipped (pass with a warning) without a key unless FORMFEED_REQUIRE_API=1. */
    async toHavePageCount(received: TemplateHandle, expected: number, data?: unknown): Promise<MatcherResult> {
      const client = options.client === undefined ? apiClient(env) : options.client;
      if (!client) {
        if (env['FORMFEED_REQUIRE_API'] === '1')
          return { pass: false, message: () => 'toHavePageCount needs FORMFEED_API_KEY (FORMFEED_REQUIRE_API=1 forbids skipping)' };
        warn(`toHavePageCount skipped for ${received.slug}: no FORMFEED_API_KEY`);
        return { pass: true, message: () => 'skipped: no API key' };
      }
      const html = await received.render(data ?? received.data());
      const render = await client.renders.create({ html, settings: received.files.settings as Record<string, unknown>, output: 'pdf', meta: { source: '@formfeed/testing', template: received.slug } });
      const finished = render.status === 'succeeded' || render.status === 'failed' ? render : await client.renders.waitFor(render.id);
      if (finished.status !== 'succeeded') return { pass: false, message: () => `${received.slug}: render failed: ${JSON.stringify(finished.error)}` };
      const pass = finished.page_count === expected;
      return { pass, message: () => `${received.slug} rendered ${finished.page_count} page(s), expected ${expected}` };
    },
  };
}

export const matchers = createMatchers();

/** Type augmentation for `expect(template)`; import this module's types in the test setup. */
export interface FormfeedMatchers<R = unknown> {
  toRenderWithoutErrors(data?: unknown): Promise<R>;
  toUseOnlyKnownVariables(data?: unknown): Promise<R>;
  toContainText(text: string, data?: unknown): Promise<R>;
  toHavePageCount(pages: number, data?: unknown): Promise<R>;
}
