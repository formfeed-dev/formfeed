import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { importApitemplate, type EngineId, type TemplateKind } from '@formfeed/engine';
import type { FormfeedError, TemplateVersion } from '@formfeed/sdk-ts';
import {
  createClient,
  defaultProjectConfig,
  loadUserConfig,
  requireProject,
  resolveSettings,
  saveUserConfig,
  userConfigPath,
  writeProjectConfig,
  type GlobalFlags,
  type Settings,
} from './lib/config';
import { deviceLogin } from './lib/device-login';
import { startDevServer } from './lib/dev-server';
import { formatDiff } from './lib/diff';
import { CliError, exitCodes } from './lib/errors';
import { emit, formatDiagnostic, printer, reportError, table, type Printer } from './lib/output';
import { contentHash, defaultData, diagnose, listTemplateSlugs, readState, readTemplate, recordSync, renderLocal, templateDir, titleFromSlug, versionPayload, writeTemplate, type LocalTemplate, type TemplateMeta } from '@formfeed/devkit';

/**
 * Command tree of spec 15 §3. `buildProgram()` is exported for tests: commands never call
 * `process.exit`; they throw `CliError` (or SDK errors) and `run()` maps those to exit codes.
 */
export interface ProgramContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Called by `dev` once listening (tests close the server through it). */
  onServer?: (server: { url: string; close(): Promise<void> }) => void;
  /** Runs git for `ci preview`; injected in tests. Returns stdout, or null when git is unavailable. */
  git?: (args: string[], cwd: string) => string | null;
  /** Waits between device-login polls; injected in tests so they do not sleep. */
  wait?: (ms: number) => Promise<void>;
}

const VERSION = '0.1.0';

export function buildProgram(ctx: ProgramContext = {}): Command {
  const program = new Command('formfeed')
    .description('Formfeed: templates as files, offline validation and preview, renders through the API.')
    .version(VERSION)
    .option('--api-key <key>', 'API key (overrides the stored login)')
    .option('--base-url <url>', 'API base URL (staging, self-hosted)')
    .option('--workspace <org/workspace>', 'workspace slug pair')
    .option('--region <region>', 'eu or us')
    .option('--json', 'machine-readable output')
    .option('--ci', 'never prompt; implied by CI=1')
    .option('--verbose', 'more output')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => (ctx.out ?? ((t: string) => process.stdout.write(t)))(s.replace(/\n$/, '')),
      writeErr: (s) => (ctx.err ?? ((t: string) => process.stderr.write(t)))(s.replace(/\n$/, '')),
    });

  const settings = (): Settings => resolveSettings(program.opts<GlobalFlags>(), ctx.cwd, ctx.env);
  const p = (): Printer => printer(Boolean(program.opts<GlobalFlags>().json), { out: ctx.out, err: ctx.err });
  const client = (s: Settings) => createClient(s, ctx.fetch);

  // --- auth -----------------------------------------------------------------------------------
  program
    .command('login [key]')
    .description('Sign in: opens the browser for device authorisation, or stores a key with --api-key')
    .option('--no-browser', 'print the URL instead of opening a browser')
    .action(async (key: string | undefined, opts: { browser?: boolean }) => {
      const s = settings();
      const apiKey = program.opts<GlobalFlags>().apiKey ?? key;
      const printer = p();

      const finish = (resolved: string, note?: string) => async () => {
        const c = createClient({ ...s, apiKey: resolved }, ctx.fetch);
        const account = await c.account.get();
        const path = saveUserConfig(
          { ...loadUserConfig(ctx.env), apiKey: resolved, ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}), region: s.region },
          ctx.env,
        );
        emit(printer, { ok: true, account, config: path }, () => [
          ...(note ? [note] : []),
          `Signed in to ${(account['organization'] as { name?: string })?.name ?? 'organisation'} / ${(account['workspace'] as { name?: string })?.name ?? 'workspace'} (${(account['environment'] as string) ?? ''} key)`,
          `Key stored in ${path}`,
        ]);
      };

      if (apiKey) {
        await finish(apiKey)();
        return;
      }

      const approval = await deviceLogin({
        baseUrl: apiBaseUrl(s),
        clientName: `Formfeed CLI on ${hostName(ctx.env)}`,
        fetch: ctx.fetch ?? globalThis.fetch,
        wait: ctx.wait,
        onCode: (start) => {
          printer.err(`Open ${start.verification_uri} and enter the code ${start.user_code}`);
          if (opts.browser !== false && !s.ci) openBrowser(start.verification_uri_complete);
          printer.err('Waiting for approval…');
        },
      });
      await finish(approval.api_key, `Approved for ${approval.organization.name} / ${approval.workspace.name}`)();
    });

  program
    .command('logout')
    .description('Remove the stored key')
    .action(() => {
      const user = loadUserConfig(ctx.env);
      delete user.apiKey;
      const path = saveUserConfig(user, ctx.env);
      emit(p(), { ok: true, config: path }, () => [`Key removed from ${path}`]);
    });

  program
    .command('whoami')
    .description('Show the workspace, plan and usage of the current key')
    .action(async () => {
      const s = settings();
      const account = await client(s).account.get();
      const ws = account['workspace'] as { name?: string; slug?: string; region?: string };
      const org = account['organization'] as { name?: string; slug?: string };
      const plan = account['plan'] as { name?: string };
      const units = account['units'] as { used?: number; included?: number };
      emit(p(), account, () => [
        `${org.name} (${org.slug}) / ${ws.name} (${ws.slug}), region ${ws.region}`,
        `Plan ${plan.name}: ${units.used ?? 0} of ${units.included ?? 0} units used this period`,
        `Key environment: ${String(account['environment'])}`,
      ]);
    });

  // --- config ---------------------------------------------------------------------------------
  const config = program.command('config').description('Read or write the user config');
  config
    .command('list')
    .description('Show the effective settings and where they come from')
    .action(() => {
      const s = settings();
      emit(
        p(),
        { apiKey: s.apiKey ? `${s.apiKey.slice(0, 12)}…` : null, baseUrl: s.baseUrl, workspace: s.workspace, region: s.region, project: s.project?.configPath ?? null, userConfig: userConfigPath(ctx.env) },
        () =>
          table([
            ['api key', s.apiKey ? `${s.apiKey.slice(0, 12)}…` : '(none)'],
            ['base url', s.baseUrl ?? '(default)'],
            ['workspace', s.workspace ?? '(none)'],
            ['region', s.region],
            ['project', s.project?.configPath ?? '(none)'],
            ['user config', userConfigPath(ctx.env)],
          ]),
      );
    });
  config
    .command('get <key>')
    .description('Read a user config value (apiKey, baseUrl, workspace, region)')
    .action((key: string) => {
      const user = loadUserConfig(ctx.env) as Record<string, unknown>;
      const value = key === 'apiKey' && typeof user[key] === 'string' ? `${String(user[key]).slice(0, 12)}…` : user[key];
      emit(p(), { [key]: value ?? null }, () => [value === undefined ? '' : String(value)]);
    });
  config
    .command('set <key> <value>')
    .description('Write a user config value')
    .action((key: string, value: string) => {
      if (!['apiKey', 'baseUrl', 'workspace', 'region'].includes(key))
        throw new CliError(`Unknown config key ${key}; use apiKey, baseUrl, workspace or region`, exitCodes.usage);
      const user = loadUserConfig(ctx.env) as Record<string, unknown>;
      user[key] = value;
      const path = saveUserConfig(user, ctx.env);
      emit(p(), { ok: true, config: path }, () => [`${key} saved in ${path}`]);
    });

  // --- project --------------------------------------------------------------------------------
  program
    .command('init [dir]')
    .description('Create formfeed.json and the folder layout; --from-workspace pulls the existing templates')
    .option('--engine <id>', 'default engine for new templates (jinja2, liquid, handlebars)', parseEngine)
    .option('--workspace <org/workspace>', 'workspace to bind')
    .option('--from-workspace', 'pull the published templates of the workspace after creating the layout')
    .action(async (dir: string | undefined, opts: { engine?: EngineId; workspace?: string; fromWorkspace?: boolean }) => {
      const root = resolve(ctx.cwd ?? process.cwd(), dir ?? '.');
      mkdirSync(root, { recursive: true });
      if (existsSync(join(root, 'formfeed.json'))) throw new CliError(`${join(root, 'formfeed.json')} exists already`, exitCodes.usage);
      const engine = opts.engine ?? defaultProjectConfig.engine;
      const configPath = writeProjectConfig(root, { engine, ...(opts.workspace ? { workspace: opts.workspace } : {}) });
      mkdirSync(join(root, defaultProjectConfig.templatesDir), { recursive: true });
      mkdirSync(join(root, defaultProjectConfig.partialsDir), { recursive: true });
      const created: string[] = [configPath];
      if (opts.fromWorkspace) {
        const s = resolveSettings(program.opts<GlobalFlags>(), root, ctx.env);
        const project = requireProject(s);
        const pulled = await pullTemplates(client(s), project, undefined, false);
        created.push(...pulled.map((x) => x.dir));
      } else {
        const project = requireProject(resolveSettings(program.opts<GlobalFlags>(), root, ctx.env));
        created.push(writeStarter(project, engine));
      }
      emit(p(), { ok: true, root, created }, () => [`Created ${configPath}`, ...created.slice(1).map((c) => `  ${c}`), 'Next: formfeed dev <slug>']);
    });

  // --- templates ------------------------------------------------------------------------------
  const templates = program.command('templates').description('Templates of the workspace as files');
  templates
    .command('list')
    .description('Remote templates with published version and status')
    .action(async () => {
      const s = settings();
      const rows = await client(s).templates.all();
      emit(p(), rows, () =>
        table(
          rows.map((t) => [t.slug, t.kind, t.engine, t.published_version ? `v${t.published_version}` : 'draft', `v${t.latest_version}`, t.updated_at.slice(0, 10)]),
          ['slug', 'kind', 'engine', 'published', 'latest', 'updated'],
        ),
      );
    });

  templates
    .command('pull [slug]')
    .description('Download published versions into files (--draft for the latest drafts)')
    .option('--draft', 'pull the latest version even when it is a draft')
    .action(async (slug: string | undefined, opts: { draft?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const pulled = await pullTemplates(client(s), project, slug, Boolean(opts.draft));
      emit(p(), pulled, () => pulled.map((x) => `pulled ${x.slug} v${x.number} (${x.status}) -> ${x.dir}`));
    });

  templates
    .command('push [slug]')
    .description('Create draft versions from local files; --publish publishes them')
    .option('--publish', 'publish the new version')
    .option('--message <note>', 'change note')
    .option('--dry-run', 'show what would change without pushing')
    .option('--force', 'push even when the remote changed since the last pull')
    .action(async (slug: string | undefined, opts: { publish?: boolean; message?: string; dryRun?: boolean; force?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const slugs = slug ? [slug] : listTemplateSlugs(project);
      if (slugs.length === 0) throw new CliError(`No templates in ${project.templatesDir}`, exitCodes.usage);
      const state = readState(project);
      const c = opts.dryRun ? null : client(s);
      const results: Array<Record<string, unknown>> = [];
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const known = state.templates[one];
        const changed = !known || known.contentHash !== contentHash(tpl);
        if (opts.dryRun) {
          results.push({ slug: one, status: known ? (changed ? 'modified' : 'unchanged') : 'new' });
          continue;
        }
        if (known && !changed && !opts.publish) {
          results.push({ slug: one, status: 'unchanged' });
          continue;
        }
        const version = await pushTemplate(c!, project, tpl, {
          publish: Boolean(opts.publish),
          message: opts.message,
          baseChecksum: opts.force ? undefined : known?.checksum,
        });
        results.push({ slug: one, status: version.status, number: version.number, checksum: version.checksum });
      }
      emit(p(), results, () =>
        results.map((r) =>
          r['number'] ? `${r['slug']}: v${r['number']} ${r['status']}` : `${r['slug']}: ${r['status']}`,
        ),
      );
    });

  templates
    .command('diff [slug]')
    .description('Show local changes against the latest remote version')
    .action(async (slug: string | undefined) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const slugs = slug ? [slug] : listTemplateSlugs(project);
      const out: string[] = [];
      const json: Array<{ slug: string; changed: string[] }> = [];
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        let remote: TemplateVersion | null = null;
        try {
          remote = await c.templates.versions.get(one, 'latest');
        } catch (e) {
          if ((e as FormfeedError).status !== 404) throw e;
        }
        if (!remote) {
          out.push(`${one}: not on the server yet`);
          json.push({ slug: one, changed: ['*'] });
          continue;
        }
        const local = versionPayload(tpl);
        const files: Array<[string, string, string]> = [
          ['template.html', remote.html ?? '', local.html],
          ['style.css', remote.css ?? '', local.css],
          ['head.html', remote.head ?? '', local.head],
          ['settings.json', JSON.stringify(remote.settings ?? {}, null, 2), JSON.stringify(local.settings, null, 2)],
          ['data/default.json', JSON.stringify(remote.sample_data ?? {}, null, 2), JSON.stringify(local.sample_data, null, 2)],
        ];
        const changed: string[] = [];
        for (const [file, a, b] of files) {
          const lines = formatDiff(`${one}/${file}`, a, b);
          if (lines.length) {
            changed.push(file);
            out.push(...lines);
          }
        }
        if (!changed.length) out.push(`${one}: no changes against v${remote.number}`);
        json.push({ slug: one, changed });
      }
      emit(p(), json, () => out);
    });

  // --- validate / render / dev ----------------------------------------------------------------
  program
    .command('validate [slug]')
    .description('Compile locally and print diagnostics; exit 1 on errors')
    .option('--data <name>', 'data set to check against (default: default)')
    .action((slug: string | undefined, opts: { data?: string }) => {
      const s = settings();
      const project = requireProject(s);
      const slugs = slug ? [slug] : listTemplateSlugs(project);
      if (slugs.length === 0) throw new CliError(`No templates in ${project.templatesDir}`, exitCodes.usage);
      const report: Array<{ slug: string; diagnostics: ReturnType<typeof diagnose> }> = [];
      let errors = 0;
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const set = defaultData(tpl, opts.data);
        const diagnostics = diagnose(tpl, set.data);
        errors += diagnostics.filter((d) => d.severity === 'error').length;
        report.push({ slug: one, diagnostics });
      }
      emit(p(), { ok: errors === 0, errors, templates: report }, () => [
        ...report.flatMap((r) => r.diagnostics.map((d) => formatDiagnostic(`${r.slug}/template.html`, d))),
        errors === 0 ? `${report.length} template(s) valid` : `${errors} error(s)`,
      ]);
      if (errors > 0) throw new CliError(`${errors} error(s) found`, exitCodes.validation, { silent: true });
    });

  program
    .command('render <slug>')
    .description('True render through the API from the local files (test keys are free)')
    .option('--data <name-or-file>', 'data set name or a JSON file')
    .option('--out <file>', 'output file (default: <slug>.<ext>)')
    .option('--output <format>', 'pdf, png or jpg', parseOutput)
    .option('--remote', 'render the published remote version instead of local files')
    .action(async (slug: string, opts: { data?: string; out?: string; output?: 'pdf' | 'png' | 'jpg'; remote?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const tpl = readTemplate(project, slug);
      const data = loadData(project.root, tpl, opts.data);
      const output = opts.output ?? (tpl.meta.kind === 'image' ? 'png' : 'pdf');
      const render = opts.remote
        ? await c.renders.create({ template: slug, data: data as Record<string, unknown>, output })
        : await (async () => {
            const rendered = await renderLocal(project, tpl, data, { mode: 'print' });
            return c.renders.create({ html: rendered.document, settings: rendered.settings as Record<string, unknown>, output, meta: { source: 'formfeed render', template: slug } });
          })();
      const finished = render.status === 'succeeded' || render.status === 'failed' ? render : await c.renders.waitFor(render.id);
      if (finished.status !== 'succeeded') throw new CliError(`render ${finished.id} failed: ${JSON.stringify(finished.error)}`, exitCodes.network, finished);
      const bytes = await c.renders.download(finished);
      const file = resolve(ctx.cwd ?? process.cwd(), opts.out ?? `${slug}.${output}`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      emit(p(), { ...finished, file }, () => [`${finished.id}: ${finished.page_count ?? '?'} page(s), ${finished.units} unit(s) -> ${file}`]);
    });

  program
    .command('dev [slug]')
    .description('Local preview with hot reload (http://localhost:4400)')
    .option('--port <n>', 'port', (v) => Number(v), 4400)
    .option('--host <host>', 'bind address', '127.0.0.1')
    .option('--data <name>', 'initial data set')
    .option('--locale <tag>', 'initial locale')
    .option('--open', 'open the browser')
    .action(async (slug: string | undefined, opts: { port: number; host: string; data?: string; locale?: string; open?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const slugs = listTemplateSlugs(project);
      const chosen = slug ?? slugs[0];
      if (!chosen) throw new CliError(`No templates in ${project.templatesDir}; run formfeed init or pull`, exitCodes.usage);
      if (!slugs.includes(chosen) && !existsSync(templateDir(project, chosen)))
        throw new CliError(`No template "${chosen}"; available: ${slugs.join(', ')}`, exitCodes.usage);
      const apiClient = s.apiKey ? client(s) : null;
      const server = await startDevServer({ project, slug: chosen, port: opts.port, host: opts.host, data: opts.data, locale: opts.locale, client: apiClient, log: (l) => p().err(l) });
      p().out(`formfeed dev: ${chosen} on ${server.url}${apiClient ? '' : ' (no API key: true render disabled)'}`);
      if (opts.open) void import('node:child_process').then(({ exec }) => exec(`${process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open'} ${server.url}`));
      ctx.onServer?.(server);
      if (!ctx.onServer) await new Promise<void>((resolveWait) => process.once('SIGINT', () => void server.close().then(resolveWait)));
    });

  // --- test / ci ------------------------------------------------------------------------------
  program
    .command('test [slug]')
    .description('Run every data set through compile and analysis and compare approved snapshots')
    .option('--data <name>', 'only this data set')
    .option('-u, --update-snapshots', 'write the current output as the approved snapshot')
    .action(async (slug: string | undefined, opts: { data?: string; updateSnapshots?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const slugs = slug ? [slug] : listTemplateSlugs(project);
      if (slugs.length === 0) throw new CliError(`No templates in ${project.templatesDir}`, exitCodes.usage);

      const results: TestResult[] = [];
      const lines: string[] = [];
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const names = Object.keys(tpl.dataSets);
        const chosen = opts.data ? [opts.data] : names.length > 0 ? names : ['empty'];
        for (const name of chosen) {
          const data = defaultData(tpl, names.includes(name) ? name : undefined).data;
          const diagnostics = diagnose(tpl, data);
          const errors = diagnostics.filter((d) => d.severity === 'error');
          if (errors.length > 0) {
            results.push({ slug: one, data: name, status: 'failed', errors: errors.length });
            lines.push(...errors.map((d) => formatDiagnostic(`${one}/template.html`, d)));
            continue;
          }
          const rendered = await renderLocal(project, tpl, data, { mode: 'preview' });
          const file = snapshotPath(project, one, name);
          if (opts.updateSnapshots) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, rendered.document);
            results.push({ slug: one, data: name, status: 'written' });
          } else if (!existsSync(file)) {
            results.push({ slug: one, data: name, status: 'no-snapshot' });
          } else if (readFileSync(file, 'utf8') === rendered.document) {
            results.push({ slug: one, data: name, status: 'passed' });
          } else {
            results.push({ slug: one, data: name, status: 'failed', snapshot: file });
            lines.push(...formatDiff(`${one}/${name}`, readFileSync(file, 'utf8'), rendered.document, 2, ['approved', 'current']));
          }
        }
      }

      const failed = results.filter((r) => r.status === 'failed').length;
      const summary = (status: TestResult['status']) => results.filter((r) => r.status === status).length;
      emit(p(), { ok: failed === 0, results }, () => [
        ...lines,
        `${summary('passed')} passed, ${failed} failed, ${summary('no-snapshot')} without snapshot, ${summary('written')} written`,
        ...(summary('no-snapshot') > 0 ? ['Run with --update-snapshots to approve the current output.'] : []),
      ]);
      if (failed > 0) throw new CliError(`${failed} snapshot check(s) failed`, exitCodes.validation, { silent: true });
    });

  const ci = program.command('ci').description('Commands for continuous integration');
  ci.command('preview')
    .description('Render the templates changed since a base ref and write a summary for the pull request')
    .option('--base <ref>', 'git ref to compare against', 'origin/main')
    .option('--out <dir>', 'directory for the rendered files', 'formfeed-preview')
    .option('--summary <file>', 'markdown summary file', 'formfeed-preview.md')
    .option('--all', 'render every template instead of the changed ones')
    .action(async (opts: { base: string; out: string; summary: string; all?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const cwd = ctx.cwd ?? process.cwd();
      const all = listTemplateSlugs(project);
      const slugs = opts.all ? all : changedTemplates(project, all, opts.base, cwd, ctx.git);
      const outDir = resolve(cwd, opts.out);
      const summaryFile = resolve(cwd, opts.summary);

      if (slugs.length === 0) {
        const text = `## Formfeed preview\n\nNo template changes against \`${opts.base}\`.\n`;
        writeFileSync(summaryFile, text);
        emit(p(), { base: opts.base, templates: [], summary: summaryFile }, () => [`No template changes against ${opts.base}`]);
        return;
      }

      const c = client(s);
      mkdirSync(outDir, { recursive: true });
      const rows: PreviewRow[] = [];
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const set = defaultData(tpl);
        const output = tpl.meta.kind === 'image' ? 'png' : 'pdf';
        const rendered = await renderLocal(project, tpl, set.data, { mode: 'print' });
        const created = await c.renders.create({
          html: rendered.document,
          settings: rendered.settings as Record<string, unknown>,
          output,
          meta: { source: 'formfeed ci preview', template: one },
        });
        const render = created.status === 'succeeded' || created.status === 'failed' ? created : await c.renders.waitFor(created.id);
        if (render.status !== 'succeeded') {
          rows.push({ slug: one, data: set.name, status: 'failed', error: JSON.stringify(render.error ?? null) });
          continue;
        }
        const file = join(outDir, `${one}.${output}`);
        writeFileSync(file, await c.renders.download(render));
        rows.push({ slug: one, data: set.name, status: 'succeeded', file, pages: render.page_count ?? null, url: render.download_url ?? null });
      }

      writeFileSync(summaryFile, previewMarkdown(opts.base, rows));
      const failed = rows.filter((r) => r.status === 'failed').length;
      emit(p(), { base: opts.base, templates: rows, summary: summaryFile, out: outDir }, () => [
        ...rows.map((r) =>
          r.status === 'succeeded'
            ? `${r.slug} (${r.data}): ${r.pages ?? '?'} page(s) -> ${r.file}`
            : `${r.slug} (${r.data}): failed ${r.error ?? ''}`,
        ),
        `Summary written to ${summaryFile}`,
      ]);
      if (failed > 0) throw new CliError(`${failed} template(s) failed to render`, exitCodes.validation, { silent: true });
    });

  const rendersCmd = program.command('renders').description('Inspect renders');
  rendersCmd
    .command('get <id>')
    .description('Show one render')
    .action(async (id: string) => {
      const s = settings();
      const render = await client(s).renders.get(id);
      emit(p(), render, () => [`${render.id}: ${render.status}${render.page_count ? `, ${render.page_count} page(s)` : ''}${render.download_url ? `\n${render.download_url}` : ''}`]);
    });
  rendersCmd
    .command('list')
    .description('Recent renders of the workspace, newest first')
    .option('--template <slug>', 'only renders of this template')
    .option('--status <status>', 'queued, rendering, succeeded or failed')
    .option('--environment <env>', 'live or test')
    .option('--since <iso>', 'only renders created at or after this time')
    .option('--until <iso>', 'only renders created at or before this time')
    .option('--limit <n>', 'page size (1-100)', (v) => Number(v), 20)
    .option('--all', 'follow the cursor and list every match')
    .action(async (opts: { template?: string; status?: string; environment?: string; since?: string; until?: string; limit: number; all?: boolean }) => {
      const s = settings();
      const c = client(s);
      const query = {
        template: opts.template,
        status: opts.status as 'queued' | 'rendering' | 'succeeded' | 'failed' | undefined,
        environment: opts.environment as 'live' | 'test' | undefined,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
      };
      const page = opts.all
        ? { data: await c.renders.all(query), next_cursor: null }
        : await c.renders.list(query);
      emit(p(), page, () => [
        ...table(
          page.data.map((r) => [
            r.id,
            r.status,
            r.template?.slug ?? r.output,
            r.page_count === null || r.page_count === undefined ? '-' : String(r.page_count),
            String(r.units),
            r.created_at,
          ]),
          ['id', 'status', 'template', 'pages', 'units', 'created'],
        ),
        ...(page.next_cursor ? ['', 'More renders follow; use --all or a larger --limit.'] : []),
      ]);
    });
  rendersCmd
    .command('delete-outputs <id>')
    .description('Remove the stored files of a render before they expire')
    .action(async (id: string) => {
      const s = settings();
      await client(s).renders.deleteOutputs(id);
      emit(p(), { id, deleted: true }, () => [`${id}: outputs deleted`]);
    });

  // --- import ---------------------------------------------------------------------------------
  program
    .command('import')
    .description('Import templates from other services')
    .command('apitemplate')
    .description('Create a local template from files exported from apitemplate.io')
    .requiredOption('--html <file>', 'template body (HTML)')
    .option('--css <file>', 'stylesheet')
    .option('--settings <file>', 'settings JSON (paper, margins, header and footer)')
    .option('--sample <file>', 'sample data JSON')
    .option('--name <name>', 'template name')
    .option('--slug <slug>', 'folder and slug (default: from the name)')
    .action((opts: { html: string; css?: string; settings?: string; sample?: string; name?: string; slug?: string }) => {
      const s = settings();
      const project = requireProject(s);
      const read = (f?: string) => (f ? readFileSync(resolve(ctx.cwd ?? process.cwd(), f), 'utf8') : undefined);
      const result = importApitemplate({
        name: opts.name ?? basename(opts.html, extname(opts.html)),
        html: read(opts.html) ?? '',
        css: read(opts.css),
        settings: opts.settings ? (JSON.parse(read(opts.settings) ?? '{}') as Record<string, unknown>) : undefined,
        sample_data: opts.sample ? JSON.parse(read(opts.sample) ?? '{}') : undefined,
      });
      const slug = opts.slug ?? result.slug;
      const dir = writeTemplate(
        project,
        slug,
        { name: result.name, kind: result.kind, engine: result.engine, description: null, tags: ['imported'] },
        { html: result.html, css: result.css, head: result.head, settings: result.settings as Record<string, unknown>, sample_data: (result.sampleData ?? {}) as Record<string, unknown>, data_schema: null, i18n: null },
      );
      emit(p(), { ...result, slug, dir }, () => [
        `Imported ${result.name} -> ${dir}`,
        ...result.errors.map((e) => `error  ${e.message}`),
        ...result.warnings.map((w) => `warn   ${w.message}`),
        ...result.changes.map((c) => `note   ${c}`),
      ]);
    });

  return program;
}

// --- helpers --------------------------------------------------------------------------------

/** The API host the CLI talks to, honouring --base-url and the region. */
function apiBaseUrl(s: Settings): string {
  if (s.baseUrl) return s.baseUrl;
  return s.region === 'us' ? 'https://api-us.formfeed.dev/v1' : 'https://api-eu.formfeed.dev/v1';
}

function hostName(env: NodeJS.ProcessEnv = process.env): string {
  return env['COMPUTERNAME'] ?? env['HOSTNAME'] ?? 'this machine';
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  void import('node:child_process').then(({ exec }) => exec(command));
}

function parseEngine(value: string): EngineId {
  if (!['jinja2', 'liquid', 'handlebars'].includes(value)) throw new InvalidArgumentError('engine must be jinja2, liquid or handlebars');
  return value as EngineId;
}

function parseOutput(value: string): 'pdf' | 'png' | 'jpg' {
  if (!['pdf', 'png', 'jpg'].includes(value)) throw new InvalidArgumentError('output must be pdf, png or jpg');
  return value as 'pdf' | 'png' | 'jpg';
}

function loadData(root: string, tpl: LocalTemplate, nameOrFile?: string): unknown {
  if (nameOrFile && (nameOrFile.endsWith('.json') || nameOrFile.includes('/') || nameOrFile.includes('\\'))) {
    const file = resolve(root, nameOrFile);
    if (!existsSync(file)) throw new CliError(`Data file not found: ${file}`, exitCodes.usage);
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  return defaultData(tpl, nameOrFile).data;
}

async function pullTemplates(c: ReturnType<typeof createClient>, project: ReturnType<typeof requireProject>, slug: string | undefined, draft: boolean) {
  const list = slug ? [await c.templates.get(slug)] : await c.templates.all();
  const pulled: Array<{ slug: string; number: number; status: string; dir: string }> = [];
  for (const t of list) {
    const version = await c.templates.versions.get(t.slug, draft || !t.published_version ? 'latest' : 'published');
    const meta: TemplateMeta = { name: t.name, kind: t.kind, engine: t.engine, description: t.description, tags: t.tags };
    const dir = writeTemplate(project, t.slug, meta, version);
    recordSync(project, t.slug, version, readTemplate(project, t.slug));
    pulled.push({ slug: t.slug, number: version.number, status: version.status, dir });
  }
  return pulled;
}

async function pushTemplate(
  c: ReturnType<typeof createClient>,
  project: ReturnType<typeof requireProject>,
  tpl: LocalTemplate,
  opts: { publish: boolean; message?: string; baseChecksum?: string },
): Promise<TemplateVersion> {
  const payload = versionPayload(tpl);
  let exists = true;
  try {
    await c.templates.get(tpl.slug);
  } catch (e) {
    if ((e as FormfeedError).status === 404) exists = false;
    else throw e;
  }
  let version: TemplateVersion;
  if (!exists) {
    await c.templates.create({
      name: tpl.meta.name,
      slug: tpl.slug,
      description: tpl.meta.description ?? null,
      kind: tpl.meta.kind,
      engine: tpl.meta.engine,
      tags: tpl.meta.tags ?? [],
      ...payload,
      publish: opts.publish,
    });
    version = await c.templates.versions.get(tpl.slug, 'latest');
  } else {
    version = await c.templates.versions.create(tpl.slug, {
      ...payload,
      change_note: opts.message ?? 'formfeed templates push',
      ...(opts.baseChecksum ? { base_checksum: opts.baseChecksum } : {}),
      publish: opts.publish,
    });
  }
  recordSync(project, tpl.slug, version, tpl);
  return version;
}

function writeStarter(project: ReturnType<typeof requireProject>, engine: EngineId): string {
  const kind: TemplateKind = 'pdf';
  const body =
    engine === 'handlebars'
      ? '<main class="document">\n  <h1>{{ title }}</h1>\n  <p>Hello {{ customer.name }}, this is your first Formfeed template.</p>\n</main>\n'
      : '<main class="document">\n  <h1>{{ title }}</h1>\n  <p>Hello {{ customer.name }}, this is your first Formfeed template.</p>\n</main>\n';
  return writeTemplate(
    project,
    'hello',
    { name: titleFromSlug('hello'), kind, engine, description: 'Starter template created by formfeed init', tags: [] },
    {
      html: body,
      css: '.document { font-family: system-ui, sans-serif; padding: 24px; }\nh1 { color: #4f46e5; }\n',
      head: '',
      settings: { paper: { format: 'A4' }, margin: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' } },
      sample_data: { title: 'Hello from Formfeed', customer: { name: 'Ada' } },
      data_schema: null,
      i18n: null,
    },
  );
}

/** Runs the CLI: parses argv, maps errors to exit codes, never throws. */
export async function run(argv: string[], ctx: ProgramContext = {}): Promise<number> {
  const program = buildProgram(ctx);
  const p = printer(argv.includes('--json'), { out: ctx.out, err: ctx.err });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCodes.ok;
  } catch (e) {
    const commanderCode = (e as { code?: string; exitCode?: number }).code;
    if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.version') return exitCodes.ok;
    if (typeof commanderCode === 'string' && commanderCode.startsWith('commander.')) return exitCodes.usage;
    if (e instanceof CliError && (e.details as { silent?: boolean } | undefined)?.silent) return e.exitCode;
    return reportError(p, e);
  }
}

// --- test and ci helpers ----------------------------------------------------------------------

interface TestResult {
  slug: string;
  data: string;
  status: 'passed' | 'failed' | 'written' | 'no-snapshot';
  errors?: number;
  snapshot?: string;
}

interface PreviewRow {
  slug: string;
  data: string;
  status: 'succeeded' | 'failed';
  file?: string;
  pages?: number | null;
  url?: string | null;
  error?: string;
}

/** Approved snapshots live beside the template, the layout the docs describe. */
function snapshotPath(project: Parameters<typeof templateDir>[0], slug: string, dataSet: string): string {
  return join(templateDir(project, slug), 'tests', '__snapshots__', `${dataSet}.html`);
}

/**
 * Template slugs touched since `base`. A changed partial affects every template, because partials
 * are shared. Without git (or with an unknown ref) every template is previewed.
 */
export function changedTemplates(
  project: { root: string; templatesDir: string; partialsDir: string },
  all: string[],
  base: string,
  cwd: string,
  git: ProgramContext['git'] = defaultGit,
): string[] {
  const output = git([`diff`, `--name-only`, `${base}...HEAD`], cwd) ?? git([`diff`, `--name-only`, base], cwd);
  if (output === null) return all;
  const files = output.split('\n').map((f) => f.trim()).filter(Boolean);
  const templates = relativeName(project.root, project.templatesDir);
  const partials = relativeName(project.root, project.partialsDir);
  if (files.some((f) => f.startsWith(`${partials}/`))) return all;
  const changed = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(`${templates}/`)) continue;
    const slug = file.slice(templates.length + 1).split('/')[0];
    if (slug && all.includes(slug)) changed.add(slug);
  }
  return all.filter((slug) => changed.has(slug));
}

function relativeName(root: string, dir: string): string {
  const rel = dir.startsWith(root) ? dir.slice(root.length) : dir;
  return rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function defaultGit(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

function previewMarkdown(base: string, rows: PreviewRow[]): string {
  const lines = [
    '## Formfeed preview',
    '',
    `Templates changed against \`${base}\`: ${rows.length}`,
    '',
    '| Template | Data set | Pages | Output |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) =>
      r.status === 'succeeded'
        ? `| \`${r.slug}\` | ${r.data} | ${r.pages ?? '?'} | [${basename(r.file ?? '')}](${r.url ?? r.file ?? ''}) |`
        : `| \`${r.slug}\` | ${r.data} | — | failed: ${r.error ?? 'unknown error'} |`,
    ),
    '',
    'Rendered with a Formfeed test key; links expire.',
    '',
  ];
  return lines.join('\n');
}
