import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import {
  defaultOutput,
  EngineSyntaxError,
  apitemplateRegions,
  importApitemplate,
  importApitemplateFromApi,
  importJsreport,
  importPdfmonkey,
  inferSchemaFromDataSets,
  isApitemplateHtmlTemplate,
  isApitemplateRegion,
  isOfficeKind,
  isOutputFormat,
  isScss,
  jsreportTemplates,
  OfficeTemplateError,
  outputsForKind,
  RenderError,
  type Diagnostic as EngineDiagnostic,
  type ApitemplateListItem,
  type EngineId,
  type ImportResult,
  type OutputFormat,
  type TemplateKind,
} from '@formfeed/engine';
import type { Channel, FormfeedError, Render, RenderInput, SchemaChange, SharedPartialPutResult, TemplateVersion } from '@formfeed/sdk-ts';
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
import {
  apitemplateTemplate,
  apitemplateTemplateList,
  pdfmonkeyTemplate,
  pdfmonkeyTemplateIds,
  projectSassCompiler,
  readJsreportFile,
  readSnippets,
} from './lib/importers';
import { defaultConnect, listenStatePath, readListenState, runListen, type Connect } from './lib/listen';
import { emit, formatDiagnostic, printer, reportError, table, type Printer } from './lib/output';
import {
  contentHash,
  defaultData,
  defaultTypesFile,
  diagnose,
  generateTypes,
  isIgnored,
  listLocalFiles,
  listTemplateSlugs,
  localTypeSource,
  officeSnapshot,
  officeVersionPayload,
  partialContentHash,
  readBrand,
  readState,
  readTemplate,
  recordSharedPartial,
  recordSync,
  redactData,
  renderLocal,
  renderOfficeLocal,
  sharedPartialPath,
  templateDir,
  templateFileName,
  titleFromSlug,
  versionPayload,
  writeBrand,
  writeLocalFile,
  writeTemplate,
  type LocalTemplate,
  type TemplateMeta,
  type TypeSource,
} from '@formfeed/devkit';
import { onlyNames, planPull, planPush, remoteAssetBase } from './lib/files';
import { cliImageHost } from './lib/office-images';

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
  /** Waits between device-login polls and listen reconnects; injected in tests so they do not sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Opens the relay WebSocket of `listen`; Node's global `WebSocket` by default, a fake in tests. */
  connect?: Connect;
  /** Stops long-running commands (`listen`) like Ctrl+C does; SIGINT by default. */
  signal?: AbortSignal;
  /** The clock of `listen` output lines. */
  now?: () => Date;
}

const VERSION = '0.3.0';

/** Largest file `pdf convert` uploads; the API refuses bigger ones with `file_too_large`. */
const OFFICE_UPLOAD_LIMIT = 20 * 1024 * 1024;

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
        // The account call proves the key works. An unknown, revoked or expired key gets 401; a 403
        // means the gateway accepted the key and refused only the account:read scope, which keys
        // created for a single job often lack, so such a key is stored too.
        const account = await c.account.get().catch((e: unknown) => {
          if ((e as FormfeedError).status === 403) return null;
          throw e;
        });
        const path = saveUserConfig(
          { ...loadUserConfig(ctx.env), apiKey: resolved, ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}), region: s.region },
          ctx.env,
        );
        const environment = resolved.startsWith('ff_live_') ? 'live' : 'test';
        emit(printer, { ok: true, account, config: path }, () => [
          ...(note ? [note] : []),
          account
            ? `Signed in to ${(account['organization'] as { name?: string })?.name ?? 'organisation'} / ${(account['workspace'] as { name?: string })?.name ?? 'workspace'} (${(account['environment'] as string) ?? ''} key)`
            : `Signed in with a ${environment} key. It lacks the account:read scope, so whoami cannot show its workspace and usage.`,
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

  const workspacesCmd = program.command('workspaces').description("Workspaces of the key's organisation");
  workspacesCmd
    .command('delete <id>')
    .description('Delete a workspace (needs the workspace:delete scope); its content is removed after 30 days')
    .option('--yes', 'confirm the deletion; required, because the API has no undo')
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes)
        throw new CliError(`Deleting workspace ${id} revokes its keys and removes its content after 30 days; pass --yes to confirm`, exitCodes.usage);
      const s = settings();
      await client(s).workspaces.delete(id);
      emit(p(), { id, deleted: true }, () => [`${id}: workspace deleted`]);
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
      emit(p(), pulled, () =>
        pulled.map(
          (x) =>
            `pulled ${x.slug} v${x.number} (${x.status}) -> ${x.dir}` +
            (x.partials ? ` (+${x.partials} partial${x.partials === 1 ? '' : 's'} in ${project.partialsDir})` : ''),
        ),
      );
    });

  templates
    .command('push [slug]')
    .description('Create draft versions from local files; --publish publishes them')
    .option('--publish', 'publish the new version')
    .option('--message <note>', 'change note')
    .option('--dry-run', 'show what would change without pushing')
    .option('--force', 'push even when the remote changed since the last pull')
    .option('--channel <name>', 'point this release channel at the new version (e.g. staging)')
    .option('--allow-breaking', 'publish or move the channel although the data schema breaks callers of the current version')
    .action(async (slug: string | undefined, opts: { publish?: boolean; message?: string; dryRun?: boolean; force?: boolean; channel?: string; allowBreaking?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      // `ignore` in formfeed.json leaves folders out of a push of everything; a named slug is pushed
      const listed = slug ? [slug] : listTemplateSlugs(project);
      const ignored = slug ? [] : listed.filter((one) => isIgnored(project, templateDir(project, one), true));
      const slugs = listed.filter((one) => !ignored.includes(one));
      if (listed.length === 0) throw new CliError(`No templates in ${project.templatesDir}`, exitCodes.usage);
      const state = readState(project);
      const c = opts.dryRun ? null : client(s);
      const results: Array<Record<string, unknown>> = ignored.map((one) => ({ slug: one, status: 'ignored' }));
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        // the partials travel with the version, so an include without a file would fail on the
        // server exactly as it does locally
        if (tpl.missingPartials.length)
          throw new CliError(
            `${one} includes ${tpl.missingPartials.map((n) => `"${n}"`).join(', ')}, but no such file is in ${project.partialsDir}`,
            exitCodes.validation,
          );
        const known = state.templates[one];
        const changed = !known || known.contentHash !== contentHash(tpl);
        if (opts.dryRun) {
          results.push({ slug: one, status: known ? (changed ? 'modified' : 'unchanged') : 'new' });
          continue;
        }
        if (known && !changed && !opts.publish && !opts.channel) {
          results.push({ slug: one, status: 'unchanged' });
          continue;
        }
        // only moving a channel to what was pushed before needs no new version
        const version =
          known && !changed && !opts.publish
            ? await c!.templates.versions.get(one, known.number)
            : await schemaGuard(() =>
                pushTemplate(c!, project, tpl, {
                  publish: Boolean(opts.publish),
                  message: opts.message,
                  baseChecksum: opts.force ? undefined : known?.checksum,
                  allowBreaking: Boolean(opts.allowBreaking),
                  // a Word or PowerPoint document is uploaded only when it is not the one last synced
                  sendFile: !known?.fileSha256 || known.fileSha256 !== tpl.file?.sha256,
                }),
              );
        const result: Record<string, unknown> = { slug: one, status: version.status, number: version.number, checksum: version.checksum };
        if (opts.channel) {
          const channel = await schemaGuard(() =>
            c!.templates.channels.set(one, opts.channel!, { version: version.number }, { allowBreaking: Boolean(opts.allowBreaking) }),
          );
          result['channel'] = channel.name;
          result['schema_check'] = channel.schema_check ?? null;
        } else if (version.schema_check) {
          result['schema_check'] = version.schema_check;
        }
        results.push(result);
      }
      emit(p(), results, () =>
        results.flatMap((r) => [
          r['number']
            ? `${r['slug']}: v${r['number']} ${r['status']}${r['channel'] ? ` -> channel ${r['channel']}` : ''}`
            : `${r['slug']}: ${r['status']}`,
          ...schemaWarnings(r['schema_check'] as TemplateVersion['schema_check']),
        ]),
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
        const changed: string[] = [];
        const files: Array<[string, string, string]> = [];
        if (tpl.file) {
          // a document is compared by its hash; open both in Word or PowerPoint to see what changed
          const name = templateFileName(tpl.meta.kind);
          if (remote.source_file?.sha256 !== tpl.file.sha256) {
            changed.push(name);
            out.push(`${one}/${name}: differs from the document of v${remote.number} (${tpl.file.bytes.length} bytes locally, ${remote.source_file?.bytes ?? 0} remotely)`);
          }
        } else {
          const local = versionPayload(tpl);
          files.push(
            ['template.html', remote.html ?? '', local.html],
            ['style.css', remote.css ?? '', local.css],
            ['head.html', remote.head ?? '', local.head],
          );
        }
        const local = tpl.file ? officeVersionPayload(tpl) : versionPayload(tpl);
        files.push(
          ['settings.json', JSON.stringify(remote.settings ?? {}, null, 2), JSON.stringify(local.settings, null, 2)],
          ['data/default.json', JSON.stringify(remote.sample_data ?? {}, null, 2), JSON.stringify(local.sample_data, null, 2)],
        );
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

  // --- release channels (spec 19 §4) ---------------------------------------------------------
  const channelsCmd = program
    .command('channels')
    .description('Release channels: which version a render with version=<channel> uses');
  channelsCmd
    .command('list <slug>')
    .description('Channels of a template with their versions, canaries and renders of the last 24 hours')
    .action(async (slug: string) => {
      const s = settings();
      const list = await client(s).templates.channels.list(slug);
      emit(p(), list, () => [
        ...table(
          list.data.map((ch) => {
            const usage = (ch.usage_24h ?? []).reduce((sum, u) => ({ renders: sum.renders + u.renders, failed: sum.failed + u.failed }), { renders: 0, failed: 0 });
            return [
              ch.name,
              ch.version === null ? '-' : `v${ch.version}`,
              ch.canary ? `v${ch.canary.version} ${ch.canary.percent}%` : '-',
              ch.previous_version === null ? '-' : `v${ch.previous_version}`,
              `${usage.renders} (${usage.failed} failed)`,
            ];
          }),
          ['channel', 'version', 'canary', 'previous', 'renders 24h'],
        ),
        `plan: ${list.limits.channels === null ? 'unlimited' : list.limits.channels} channel(s) besides published, canary ${list.limits.canary ? 'allowed' : 'not included'}`,
      ]);
    });
  channelsCmd
    .command('set <slug> <name> <version>')
    .description('Create a channel or point it at a version; on published this publishes')
    .option('--canary <version>', 'a second version that receives --percent of the renders', positiveInt)
    .option('--percent <n>', 'share of the canary, 1 to 50', positiveInt)
    .option('--allow-breaking', 'go ahead although the data schema breaks callers of the current version')
    .action(async (slug: string, name: string, versionArg: string, opts: { canary?: number; percent?: number; allowBreaking?: boolean }) => {
      const version = positiveInt(versionArg);
      if ((opts.canary === undefined) !== (opts.percent === undefined))
        throw new CliError('--canary and --percent go together', exitCodes.usage);
      const s = settings();
      const channel = await schemaGuard(() =>
        client(s).templates.channels.set(
          slug,
          name,
          { version, canary: opts.canary !== undefined ? { version: opts.canary, percent: opts.percent! } : null },
          { allowBreaking: Boolean(opts.allowBreaking) },
        ),
      );
      emit(p(), channel, () => [describeChannel(slug, channel), ...schemaWarnings(channel.schema_check)]);
    });
  for (const action of ['promote', 'rollback'] as const) {
    channelsCmd
      .command(`${action} <slug> <name>`)
      .description(action === 'promote' ? 'Make the canary the main version of the channel' : 'Return the channel to the version before its last move')
      .option('--allow-breaking', 'go ahead although the data schema breaks callers of the current version')
      .action(async (slug: string, name: string, opts: { allowBreaking?: boolean }) => {
        const s = settings();
        const channels = client(s).templates.channels;
        const guard = { allowBreaking: Boolean(opts.allowBreaking) };
        const channel = await schemaGuard(() => (action === 'promote' ? channels.promote(slug, name, guard) : channels.rollback(slug, name, guard)));
        emit(p(), channel, () => [describeChannel(slug, channel), ...schemaWarnings(channel.schema_check)]);
      });
  }
  channelsCmd
    .command('delete <slug> <name>')
    .description('Delete a channel; --force when renders of the last hour still used it')
    .option('--force', 'delete even when the channel was used in the last hour')
    .action(async (slug: string, name: string, opts: { force?: boolean }) => {
      const s = settings();
      await client(s).templates.channels.delete(slug, name, { force: Boolean(opts.force) });
      emit(p(), { ok: true, slug, channel: name }, () => [`deleted channel ${name} of ${slug}`]);
    });

  // --- generated types (spec 19 §2) ------------------------------------------------------------
  program
    .command('types [slugs...]')
    .description('Generate TypeScript or Python types for the data of templates')
    .option('--lang <lang>', 'ts or python (default: formfeed.json types.lang, else ts)')
    .option('--out <file>', 'output file (default: formfeed.d.ts or formfeed_templates.py in the project root)')
    .option('--channel <name>', 'read the schemas of this channel from the API (default: published)')
    .option('--remote', 'read schemas from the API even inside a project')
    .option('--sdk-module <name>', 'module the TypeScript file augments (default @formfeed/sdk)')
    .option('--check', 'write nothing; exit 1 when the file differs from what would be generated')
    .action(async (slugs: string[], opts: { lang?: string; out?: string; channel?: string; remote?: boolean; sdkModule?: string; check?: boolean }) => {
      const s = settings();
      const project = s.project;
      const defaults = project?.config.types ?? {};
      const lang = opts.lang ?? defaults.lang ?? 'ts';
      if (lang !== 'ts' && lang !== 'python') throw new CliError('--lang must be ts or python', exitCodes.usage);
      const out = resolve(project?.root ?? ctx.cwd ?? process.cwd(), opts.out ?? defaults.out ?? defaultTypesFile[lang]);
      const sources =
        project && !opts.remote && !opts.channel
          ? (slugs.length ? slugs : listTemplateSlugs(project)).map((slug) => localTypeSource(readTemplate(project, slug)))
          : await remoteTypeSources(client(s), slugs, opts.channel);
      const text = generateTypes(sources, lang, { sdkModule: opts.sdkModule ?? defaults.sdkModule });
      const summary = { file: out, lang, templates: sources.map((x) => ({ slug: x.slug, origin: x.origin, version: x.version ?? null })) };
      const lines = sources.map((x) => `  ${x.slug}: ${x.origin}${x.version ? ` v${x.version}` : ''}${x.origin === 'inferred' ? ' (every field optional; store a schema to make it a contract)' : ''}`);
      if (opts.check) {
        // line endings may differ after a checkout on Windows; the content is what matters
        const current = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : null;
        if (current !== text)
          throw new CliError(`${out} is out of date; run \`formfeed types\` and commit the result`, exitCodes.validation, summary);
        emit(p(), { ...summary, ok: true }, () => [`${out} is up to date`, ...lines]);
        return;
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
      emit(p(), summary, () => [`wrote ${out}`, ...lines]);
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
      const report: Array<{ slug: string; file: string; diagnostics: ReturnType<typeof diagnose> }> = [];
      // `brand` is a built-in root of the analysis; a broken .formfeed/brand.json fails here rather
      // than in the first render
      readBrand(project);
      let errors = 0;
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const set = defaultData(tpl, opts.data);
        const diagnostics = diagnose(tpl, set.data);
        errors += diagnostics.filter((d) => d.severity === 'error').length;
        report.push({ slug: one, file: templateFileName(tpl.meta.kind), diagnostics });
      }
      emit(p(), { ok: errors === 0, errors, templates: report }, () => [
        ...report.flatMap((r) => r.diagnostics.map((d) => formatDiagnostic(`${r.slug}/${r.file}`, d))),
        errors === 0 ? `${report.length} template(s) valid` : `${errors} error(s)`,
      ]);
      if (errors > 0) throw new CliError(`${errors} error(s) found`, exitCodes.validation, { silent: true });
    });

  program
    .command('render <slug>')
    .description('True render through the API from the local files (test keys are free)')
    .option('--data <name-or-file>', 'data set name or a JSON file')
    .option('--out <file>', 'output file (default: <slug>.<ext>)')
    .option('--output <format>', "pdf, png, jpg, webp, docx or pptx (default: the template's kind and settings)", parseOutput)
    .option('--remote', 'render the published remote version instead of local files')
    .action(async (slug: string, opts: { data?: string; out?: string; output?: OutputFormat; remote?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const tpl = readTemplate(project, slug);
      const data = loadData(project.root, tpl, opts.data);
      const allowed = outputsForKind(tpl.meta.kind);
      if (opts.output && !allowed.includes(opts.output))
        throw new CliError(`A ${tpl.meta.kind} template renders to ${allowed.join(' or ')}, not ${opts.output}`, exitCodes.usage);
      // local files leave as HTML, which has no kind, so the output is decided here; the published
      // version decides its own
      const output = opts.output ?? defaultOutput(tpl.meta.kind, tpl.settings);
      const target = (extension: string) => resolve(ctx.cwd ?? process.cwd(), opts.out ?? `${slug}.${extension}`);
      let warnings: string[] = [];
      let render: Render;
      if (opts.remote) {
        render = await c.renders.create({ template: slug, data: data as Record<string, unknown>, ...(opts.output ? { output: opts.output } : {}) });
      } else if (tpl.file) {
        // No API renders a local Word or PowerPoint file: it is filled here with the render-worker's
        // engine, and a PDF comes from the converter, as the worker would make it.
        const filled = await fillOffice(project, tpl, data, c, ctx.fetch);
        warnings = filled.warnings;
        if (output !== 'pdf') {
          const file = target(output);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, filled.bytes);
          emit(p(), { file, output, filled: 'locally', warnings }, () => [...warnings.map((w) => `warn   ${w}`), `filled locally -> ${file}`]);
          return;
        }
        render = await c.pdf.convert(
          { file: { data: filled.bytes, name: `${slug}.${tpl.meta.kind}` } },
          { filename: `${slug}.pdf`, meta: { source: 'formfeed render', template: slug } },
        );
      } else {
        // the document leaves complete, so asset() must already point at the workspace library
        const rendered = await renderLocal(project, tpl, data, { mode: 'print', assetBaseUrl: await remoteAssetBase(c), brand: readBrand(project) });
        render = await c.renders.create({ html: rendered.document, settings: rendered.settings as Record<string, unknown>, output, meta: { source: 'formfeed render', template: slug } });
      }
      const finished = render.status === 'succeeded' || render.status === 'failed' ? render : await c.renders.waitFor(render.id);
      if (finished.status !== 'succeeded') throw new CliError(`render ${finished.id} failed: ${JSON.stringify(finished.error)}`, exitCodes.network, finished);
      const bytes = await c.renders.download(finished);
      const file = target(finished.output || output);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      emit(p(), { ...finished, file, warnings }, () => [
        ...warnings.map((w) => `warn   ${w}`),
        `${finished.id}: ${finished.page_count ?? '?'} page(s), ${finished.units} unit(s) -> ${file}`,
      ]);
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
      const server = await startDevServer({ project, slug: chosen, port: opts.port, host: opts.host, data: opts.data, locale: opts.locale, client: apiClient, fetch: ctx.fetch, log: (l) => p().err(l) });
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
      const brand = readBrand(project);
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const names = Object.keys(tpl.dataSets);
        const chosen = opts.data ? [opts.data] : names.length > 0 ? names : ['empty'];
        for (const name of chosen) {
          const data = defaultData(tpl, names.includes(name) ? name : undefined).data;
          const diagnostics = diagnose(tpl, data);
          const errors = diagnostics.filter((d) => d.severity === 'error');
          const source = `${one}/${templateFileName(tpl.meta.kind)}`;
          if (errors.length > 0) {
            results.push({ slug: one, data: name, status: 'failed', errors: errors.length });
            lines.push(...errors.map((d) => formatDiagnostic(source, d)));
            continue;
          }
          // Word and PowerPoint: the filled parts' XML, pretty printed, so a diff is readable. Offline
          // and repeatable: no pictures are loaded and the placeholder nonce is fixed.
          let current: string;
          if (tpl.file) {
            try {
              current = officeSnapshot((await renderOfficeLocal(project, tpl, data, { brand, random: () => 0.5 })).bytes);
            } catch (e) {
              results.push({ slug: one, data: name, status: 'failed', errors: 1 });
              lines.push(...officeFailureLines(source, e));
              continue;
            }
          } else {
            current = (await renderLocal(project, tpl, data, { mode: 'preview', brand })).document;
          }
          const file = snapshotPath(project, one, name, tpl.file ? 'xml' : 'html');
          if (opts.updateSnapshots) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, current);
            results.push({ slug: one, data: name, status: 'written' });
          } else if (!existsSync(file)) {
            results.push({ slug: one, data: name, status: 'no-snapshot' });
          } else if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === current) {
            results.push({ slug: one, data: name, status: 'passed' });
          } else {
            results.push({ slug: one, data: name, status: 'failed', snapshot: file });
            lines.push(...formatDiff(`${one}/${name}`, readFileSync(file, 'utf8'), current, 2, ['approved', 'current']));
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
      const assetBaseUrl = await remoteAssetBase(c);
      const brand = readBrand(project);
      const rows: PreviewRow[] = [];
      for (const one of slugs) {
        const tpl = readTemplate(project, one);
        const set = defaultData(tpl);
        // a pull request is reviewed as PDF: Word and PowerPoint templates are filled here and converted
        const output = tpl.file ? 'pdf' : defaultOutput(tpl.meta.kind, tpl.settings);
        const meta = { source: 'formfeed ci preview', template: one };
        let created: Render;
        if (tpl.file) {
          let filled;
          try {
            filled = await renderOfficeLocal(project, tpl, set.data, { assetBaseUrl, brand, images: cliImageHost(ctx.fetch) });
          } catch (e) {
            rows.push({ slug: one, data: set.name, status: 'failed', error: officeFailureLines(one, e).join(' ') });
            continue;
          }
          created = await c.pdf.convert({ file: { data: filled.bytes, name: `${one}.${tpl.meta.kind}` } }, { filename: `${one}.pdf`, meta });
        } else {
          const rendered = await renderLocal(project, tpl, set.data, { mode: 'print', assetBaseUrl, brand });
          created = await c.renders.create({ html: rendered.document, settings: rendered.settings as Record<string, unknown>, output, meta });
        }
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

  // --- brand kit and shared partials (spec 18 §8) ---------------------------------------------
  const brandCmd = program.command('brand').description("The organisation's brand kit, for local previews and renders");
  brandCmd
    .command('pull')
    .description('Download the brand kit into .formfeed/brand.json; dev, render, test and ci preview use it as brand')
    .action(async () => {
      const s = settings();
      const project = requireProject(s);
      const brand = await client(s).brand.get();
      const file = writeBrand(project, brand);
      const colors = Object.keys(brand.colors ?? {});
      emit(p(), { ...brand, file }, () => [
        `brand v${brand.version}${brand.name ? ` (${brand.name})` : ''} -> ${file}`,
        `  colors: ${colors.length ? colors.join(', ') : 'none'}; logos: ${Object.entries(brand.logo ?? {}).filter(([, url]) => url).map(([variant]) => variant).join(', ') || 'none'}`,
      ]);
    });

  const partialsCmd = program
    .command('partials')
    .description("Shared partials of the organisation, kept in the project's partials folder as <name>.html");
  partialsCmd
    .command('list')
    .description('Remote shared partials with version and local sync status')
    .action(async () => {
      const s = settings();
      const rows = await client(s).partials.list();
      const project = s.project ? requireProject(s) : null;
      const state = project ? (readState(project).sharedPartials ?? {}) : {};
      const local = (name: string, version: number) => {
        const known = state[name];
        if (!project || !known) return '-';
        const path = sharedPartialPath(project, name);
        const edited = existsSync(path) && partialContentHash(readFileSync(path, 'utf8')) !== known.contentHash;
        return `v${known.version}${known.version !== version ? ' (behind)' : ''}${edited ? ' modified' : ''}`;
      };
      const json = rows.map((r) => ({ ...r, local: local(r.name, r.version) }));
      emit(p(), json, () =>
        table(
          json.map((r) => [r.name, r.engine, `v${r.version}`, r.local, (r.updated_at ?? '').slice(0, 10)]),
          ['name', 'engine', 'version', 'local', 'updated'],
        ),
      );
    });

  partialsCmd
    .command('pull [names...]')
    .description('Download shared partials (all when no name is given) and record their versions in .formfeed/state.json')
    .action(async (names: string[]) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const remote = await c.partials.list();
      const unknown = names.filter((name) => !remote.some((r) => r.name === name));
      if (unknown.length) throw new CliError(`No shared partial ${unknown.map((n) => `"${n}"`).join(', ')} in the organisation`, exitCodes.usage);
      const results: Array<{ name: string; engine: string; version: number; status: 'pulled' | 'unchanged'; path: string }> = [];
      for (const row of remote.filter((r) => !names.length || names.includes(r.name))) {
        const partial = await c.partials.get(row.name);
        const source = partial.source ?? '';
        const path = sharedPartialPath(project, partial.name);
        const unchanged = existsSync(path) && readFileSync(path, 'utf8') === source;
        if (!unchanged) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, source);
        }
        recordSharedPartial(project, partial.name, { version: partial.version, engine: partial.engine }, source);
        results.push({ name: partial.name, engine: partial.engine, version: partial.version, status: unchanged ? 'unchanged' : 'pulled', path });
      }
      emit(p(), results, () =>
        results.length ? results.map((r) => `${r.name}: v${r.version} ${r.status}${r.status === 'pulled' ? ` -> ${r.path}` : ''}`) : ['The organisation has no shared partials'],
      );
    });

  partialsCmd
    .command('push [names...]')
    .description('Create or update shared partials from the partials folder (all recorded ones when no name is given)')
    .option('--engine <id>', 'engine of new partials (default: the recorded engine, else the project engine)', parseEngine)
    .option('--dry-run', 'show what would be pushed')
    .option('--force', 'push even when the remote partial changed since the last pull')
    .action(async (names: string[], opts: { engine?: EngineId; dryRun?: boolean; force?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const state = readState(project).sharedPartials ?? {};
      const targets = names.length ? names : Object.keys(state).sort();
      if (!targets.length)
        throw new CliError('No shared partials are recorded in .formfeed/state.json; name the ones to push, e.g. formfeed partials push letterhead', exitCodes.usage);
      for (const name of targets) {
        if (!sharedPartialName.test(name))
          throw new CliError(`"${name}" is not a shared partial name: lowercase letters, digits, - and _, at most 64 characters`, exitCodes.usage);
        if (!existsSync(sharedPartialPath(project, name))) throw new CliError(`No file ${sharedPartialPath(project, name)}`, exitCodes.usage);
      }
      const c = opts.dryRun ? null : client(s);
      // a name without a state entry is new here; refuse to overwrite a remote partial nobody pulled
      const remote = c && targets.some((name) => !state[name]) ? await c.partials.list() : [];
      const results: Array<{ name: string; status: string; version?: number; engine: EngineId }> = [];
      for (const name of targets) {
        const source = readFileSync(sharedPartialPath(project, name), 'utf8');
        const known = state[name];
        const engine = opts.engine ?? known?.engine ?? project.config.engine;
        const changed = !known || known.contentHash !== partialContentHash(source) || known.engine !== engine;
        if (!c) {
          results.push({ name, engine, status: known ? (changed ? 'modified' : 'unchanged') : 'new' });
          continue;
        }
        if (!changed) {
          results.push({ name, engine, status: 'unchanged', version: known.version });
          continue;
        }
        if (!known && !opts.force && remote.some((r) => r.name === name))
          throw new CliError(`A shared partial "${name}" exists already; run formfeed partials pull ${name} first, or push with --force to replace it`, exitCodes.usage);
        let written: SharedPartialPutResult;
        try {
          written = await c.partials.put(name, { engine, source, ...(known && !opts.force ? { base_version: known.version } : {}) });
        } catch (e) {
          if ((e as FormfeedError).status === 409)
            throw new CliError(
              `${name} changed remotely since v${known?.version}; run formfeed partials pull ${name} and merge, or push with --force`,
              exitCodes.usage,
              (e as FormfeedError).problem,
            );
          throw e;
        }
        recordSharedPartial(project, name, { version: written.partial.version, engine: written.partial.engine }, source);
        results.push({ name, engine, status: written.created ? 'created' : 'updated', version: written.partial.version });
      }
      emit(p(), results, () =>
        results.map((r) => `${r.name}: ${r.version !== undefined && r.status !== 'unchanged' ? `v${r.version} ` : ''}${r.status}${opts.dryRun && r.status !== 'unchanged' ? ' (dry run)' : ''}`),
      );
    });

  // --- files ---------------------------------------------------------------------------------
  const filesCmd = program.command('files').description("The workspace file library, mirrored in the project's files folder");
  filesCmd
    .command('list')
    .description('Files in the workspace library')
    .option('--prefix <prefix>', 'only names starting with this, e.g. brand/')
    .action(async (opts: { prefix?: string }) => {
      const s = settings();
      const rows = await client(s).files.all({ prefix: opts.prefix });
      emit(p(), rows, () =>
        table(
          rows.map((f) => [f.name, f.content_type, `${Math.max(1, Math.round(f.bytes / 1024))} kB`, (f.updated_at ?? f.created_at).slice(0, 10)]),
          ['name', 'type', 'size', 'updated'],
        ),
      );
    });

  filesCmd
    .command('push [names...]')
    .description('Upload new and changed files from the files folder; the same name replaces the remote file')
    .option('--dry-run', 'show what would be uploaded')
    .action(async (names: string[], opts: { dryRun?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const local = listLocalFiles(project);
      for (const skip of local.skipped) p().err(`skipped ${skip.path}: ${skip.reason}`);
      const c = client(s);
      const plan = onlyNames(planPush(local.files, await c.files.all()), names);
      if (names.length && plan.length === 0)
        throw new CliError(`None of ${names.join(', ')} is in ${project.filesDir}`, exitCodes.usage);
      const results: Array<{ name: string; status: string; url?: string }> = [];
      for (const row of plan) {
        if (row.status === 'unchanged' || opts.dryRun) {
          results.push(row);
          continue;
        }
        const file = local.files.find((f) => f.name === row.name)!;
        const uploaded = await c.files.upload({ data: readFileSync(file.path), name: file.name, contentType: file.contentType ?? undefined });
        results.push({ name: row.name, status: row.status === 'new' ? 'uploaded' : 'replaced', url: uploaded.url });
      }
      emit(p(), results, () =>
        results.length ? results.map((r) => `${r.name}: ${r.status}${opts.dryRun && r.status !== 'unchanged' ? ' (dry run)' : ''}`) : [`No files in ${project.filesDir}`],
      );
    });

  filesCmd
    .command('pull [names...]')
    .description('Download library files into the files folder')
    .action(async (names: string[]) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const remote = await c.files.all();
      const plan = onlyNames(planPull(remote, listLocalFiles(project).files), names);
      const results: Array<{ name: string; status: string; path?: string }> = [];
      for (const row of plan) {
        if (row.status === 'unchanged') {
          results.push(row);
          continue;
        }
        const file = remote.find((f) => f.name === row.name)!;
        const res = await (ctx.fetch ?? fetch)(file.url);
        if (!res.ok) throw new CliError(`Downloading ${file.name} answered HTTP ${res.status}`, exitCodes.network);
        const path = writeLocalFile(project, file.name, new Uint8Array(await res.arrayBuffer()));
        results.push({ name: row.name, status: 'pulled', path });
      }
      emit(p(), results, () => (results.length ? results.map((r) => `${r.name}: ${r.status}`) : ['The workspace library is empty']));
    });

  filesCmd
    .command('delete <name>')
    .description('Remove a file from the workspace library (the local copy stays)')
    .action(async (name: string) => {
      const s = settings();
      const c = client(s);
      const file = (await c.files.all()).find((f) => f.name === name || f.id === name);
      if (!file) throw new CliError(`No file "${name}" in the workspace library`, exitCodes.usage);
      await c.files.delete(file);
      emit(p(), { name: file.name, deleted: true }, () => [`${file.name}: deleted`]);
    });

  // --- PDF tools (spec 22 §3) ------------------------------------------------------------------
  const pdfCmd = program.command('pdf').description('PDF tools through the API');
  pdfCmd
    .command('convert <source>')
    .description('Convert a Word, Excel, PowerPoint, OpenDocument, RTF or HTML file to PDF (Starter plan and above); a render id (rnd_…) of a Word or PowerPoint template converts its output')
    .option('--out <file>', 'output file (default: the file name with .pdf, or <render id>.pdf)')
    .option('--page-ranges <ranges>', 'pages to convert, e.g. 1-3,5')
    .option('--landscape', 'landscape for spreadsheets and documents without their own page setup')
    .option('--single-page-sheets', 'each spreadsheet sheet on one page')
    .option('--no-download', 'create the PDF render without downloading it')
    .action(async (source: string, opts: { out?: string; pageRanges?: string; landscape?: boolean; singlePageSheets?: boolean; download: boolean }) => {
      const s = settings();
      const cwd = ctx.cwd ?? process.cwd();
      const path = resolve(cwd, source);
      const isFile = existsSync(path);
      if (!isFile && !/^rnd_[A-Za-z0-9]+$/.test(source))
        throw new CliError(`No file ${path}, and ${source} is not a render id (rnd_…)`, exitCodes.usage);
      if (opts.pageRanges && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(opts.pageRanges))
        throw new CliError('--page-ranges looks like 1-3,5', exitCodes.usage);
      const stem = isFile ? basename(path, extname(path)) : source;
      if (isFile && statSync(path).size > OFFICE_UPLOAD_LIMIT)
        throw new CliError(`${path} is larger than ${OFFICE_UPLOAD_LIMIT / 1024 / 1024} MB, the limit for conversions`, exitCodes.usage);
      const options = {
        filename: `${stem}.pdf`,
        meta: { source: 'formfeed pdf convert' },
        ...(opts.pageRanges ? { page_ranges: opts.pageRanges } : {}),
        ...(opts.landscape ? { landscape: true } : {}),
        ...(opts.singlePageSheets ? { single_page_sheets: true } : {}),
      };
      const c = client(s);
      const render = isFile
        ? await c.pdf.convert({ file: { data: new Uint8Array(readFileSync(path)), name: basename(path) } }, options)
        : await c.pdf.convert(source, options);
      const finished = render.status === 'succeeded' || render.status === 'failed' ? render : await c.renders.waitFor(render.id);
      if (finished.status !== 'succeeded') throw new CliError(`conversion ${finished.id} failed: ${JSON.stringify(finished.error)}`, exitCodes.network, finished);
      const warnings = ((finished as { warnings?: unknown }).warnings as string[] | undefined) ?? [];
      const summary = `${finished.id}: ${finished.page_count ?? '?'} page(s), ${finished.units} unit(s)`;
      if (!opts.download) {
        emit(p(), { ...finished, warnings }, () => [...warnings.map((w) => `warn   ${w}`), `${summary}, ${finished.download_url ?? 'no URL'}`]);
        return;
      }
      const file = resolve(cwd, opts.out ?? `${stem}.pdf`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await c.renders.download(finished));
      emit(p(), { ...finished, file, warnings }, () => [...warnings.map((w) => `warn   ${w}`), `${summary} -> ${file}`]);
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

  // --- render to data set and test case (spec 20 §3.3) ----------------------------------------
  rendersCmd
    .command('pull <id>')
    .description("Save a render's stored request data as a data set of its template; --run reproduces it locally")
    .option('--as <name>', 'data set name (default: render-<last 6 characters of the id>)')
    .option('--redact [paths...]', 'replace strings with same-shape placeholders; only these data paths when given (customer.*, items[].name)')
    .option('--no-redact', 'skip the redaction formfeed.json sets in pull.redact')
    .option('--run', 'render the data set locally and print diagnostics with template line and column')
    .option('--snapshot', 'write tests/__snapshots__/<name>.html from the local render (not for failed renders)')
    .option('--force', 'overwrite an existing data set of that name')
    .action(async (id: string, opts: { as?: string; redact?: boolean | string[]; run?: boolean; snapshot?: boolean; force?: boolean }) => {
      const s = settings();
      const project = requireProject(s);
      const c = client(s);
      const printer = p();
      const name = opts.as ?? `render-${id.slice(-6)}`;
      if (!/^[\w.-]+$/.test(name) || name === 'default')
        throw new CliError(`"${name}" is not a data set name: letters, digits, _, . and -, and not "default"`, exitCodes.usage);

      let input: RenderInput;
      try {
        input = await c.renders.input(id);
      } catch (e) {
        throw renderInputError(id, e as FormfeedError);
      }
      if (!input.template)
        throw new CliError(`${id} rendered ${input.url ? 'a URL' : 'ad-hoc HTML'}, not a template; only template renders can become a data set`, exitCodes.usage);
      const { slug, version: renderVersion } = input.template;
      if (!listTemplateSlugs(project).includes(slug))
        throw new CliError(`${id} used template "${slug}", which has no folder in ${project.templatesDir}; run formfeed templates pull ${slug} first`, exitCodes.usage);
      const file = join(templateDir(project, slug), 'data', `${name}.json`);
      if (existsSync(file) && !opts.force) throw new CliError(`${file} exists already; choose another name with --as or overwrite it with --force`, exitCodes.usage);
      if (opts.snapshot) {
        const render = await c.renders.get(id);
        if (render.status === 'failed')
          throw new CliError(`${id} failed, so its output is no reference for a snapshot; pull it with --run to reproduce the failure`, exitCodes.usage);
      }

      const localVersion = readState(project).templates[slug]?.number ?? null;
      const warnings: string[] = [];
      if (localVersion !== null && localVersion !== renderVersion)
        warnings.push(`${id} used ${slug} v${renderVersion}, the local folder is at v${localVersion}: the data may not fit the local template`);

      // --redact [paths] > --no-redact > formfeed.json pull.redact > nothing
      const configured = project.config.pull?.redact?.length ? project.config.pull.redact : undefined;
      const paths: string[] | 'all' | null =
        Array.isArray(opts.redact) && opts.redact.length
          ? opts.redact.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)
          : opts.redact === true
            ? (configured ?? 'all')
            : opts.redact === false
              ? null
              : (configured ?? null);
      const raw = input.data ?? {};
      const data = paths === null ? raw : redactData(raw, paths === 'all' ? undefined : paths);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      if (paths === null)
        warnings.push(`${file} holds the data of a real render and may contain personal data; pull with --redact before committing it`);

      const result: Record<string, unknown> = {
        render_id: id,
        template: slug,
        version: renderVersion,
        local_version: localVersion,
        data_set: name,
        file,
        redacted: paths === null ? false : paths,
      };
      const lines = [`${id} -> ${file}${paths === null ? '' : ` (redacted: ${paths === 'all' ? 'all strings' : paths.join(', ')})`}`];
      let errors = 0;
      if (opts.run || opts.snapshot) {
        const tpl = readTemplate(project, slug);
        const brand = readBrand(project);
        const diagnostics = diagnose(tpl, data);
        // the snapshot is what `formfeed test` compares: the document, or a Word or PowerPoint file's filled XML
        let rendered: string | null = null;
        if (!diagnostics.some((d) => d.severity === 'error')) {
          try {
            // --run reproduces with the render's locale; the snapshot renders the way `formfeed test` compares it
            if (tpl.file) {
              if (opts.run && input.locale) await renderOfficeLocal(project, tpl, data, { brand, locale: input.locale });
              rendered = officeSnapshot((await renderOfficeLocal(project, tpl, data, { brand, random: () => 0.5 })).bytes);
            } else {
              if (opts.run && input.locale) await renderLocal(project, tpl, data, { mode: 'preview', brand, locale: input.locale });
              rendered = (await renderLocal(project, tpl, data, { mode: 'preview', brand })).document;
            }
          } catch (e) {
            diagnostics.push(runtimeDiagnostic(e));
          }
        }
        errors = diagnostics.filter((d) => d.severity === 'error').length;
        result['diagnostics'] = diagnostics;
        lines.push(...diagnostics.map((d) => formatDiagnostic(`${slug}/${templateFileName(tpl.meta.kind)}`, d)));
        if (opts.run) lines.push(errors ? `${errors} error(s) rendering ${slug} with ${name}` : `${slug} renders with ${name} without errors`);
        if (opts.snapshot && rendered !== null) {
          const snapshot = snapshotPath(project, slug, name, tpl.file ? 'xml' : 'html');
          mkdirSync(dirname(snapshot), { recursive: true });
          writeFileSync(snapshot, rendered);
          result['snapshot'] = snapshot;
          lines.push(`snapshot -> ${snapshot}`);
        } else if (opts.snapshot) {
          result['snapshot'] = null;
          lines.push(`no snapshot written: ${slug} does not render with ${name}`);
        }
      }
      for (const w of warnings) printer.err(`warning: ${w}`);
      emit(printer, { ...result, warnings }, () => lines);
      if (errors > 0) throw new CliError(`${errors} error(s) found`, exitCodes.validation, { silent: true });
    });

  // --- local webhooks (spec 20 §2) ------------------------------------------------------------
  program
    .command('listen')
    .description("Forward the workspace's webhook events to a local server, signed with a session secret")
    .option('--forward-to <url>', 'local URL that receives the deliveries', 'http://localhost:3000/webhooks')
    .option('--events <types>', 'comma-separated event types, e.g. render.completed,job.failed (default: all)')
    .option('--live', 'include live-environment events (needs the webhook:manage scope)')
    .option('--print-secret', 'start a session, print only its signing secret and end it again')
    .option('--skip-verify', 'accept a self-signed certificate of an https:// forward URL')
    .action(async (opts: { forwardTo: string; events?: string; live?: boolean; printSecret?: boolean; skipVerify?: boolean }) => {
      const s = settings();
      const c = client(s);
      const printer = p();
      let target: URL;
      try {
        target = new URL(opts.forwardTo);
      } catch {
        throw new CliError(`--forward-to must be a URL such as http://localhost:3000/webhooks, not "${opts.forwardTo}"`, exitCodes.usage);
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new CliError('--forward-to must be an http:// or https:// URL', exitCodes.usage);
      const events = (opts.events ?? '').split(',').map((e) => e.trim()).filter(Boolean);
      const start = () => c.webhooks.listen.start({ ...(events.length ? { events } : {}), ...(opts.live ? { live: true } : {}) });

      if (opts.printSecret) {
        const session = await start();
        await c.webhooks.listen.end(session.id).catch(() => undefined);
        printer.out(printer.json ? JSON.stringify({ secret: session.secret, session_id: session.id }) : session.secret);
        return;
      }

      const account = await c.account.get().catch(() => null);
      const workspaceName = (account?.['workspace'] as { name?: string } | undefined)?.name ?? null;
      let signal = ctx.signal;
      let detach = () => undefined as void;
      if (!signal) {
        const controller = new AbortController();
        const onSigint = () => controller.abort();
        process.once('SIGINT', onSigint);
        detach = () => void process.removeListener('SIGINT', onSigint);
        signal = controller.signal;
      }
      try {
        await runListen({
          start,
          end: (sessionId) => c.webhooks.listen.end(sessionId),
          connect: ctx.connect ?? defaultConnect,
          forwardTo: target.toString(),
          skipVerify: Boolean(opts.skipVerify),
          json: printer.json,
          out: printer.out,
          err: printer.err,
          signal,
          wait: ctx.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
          now: ctx.now ?? (() => new Date()),
          statePath: listenStatePath(userConfigPath(ctx.env), s.apiKey!),
          workspaceName,
        });
      } finally {
        detach();
      }
    });

  const webhooksCmd = program.command('webhooks').description('Webhook events and deliveries');
  webhooksCmd
    .command('resend <eventId>')
    .description('Send a stored event (evt_…) again, to the running formfeed listen session or to --to')
    .option('--to <id>', 'endpoint or listen session id (default: the session of a running formfeed listen with the same key)')
    .action(async (eventId: string, opts: { to?: string }) => {
      const s = settings();
      const c = client(s);
      const to = opts.to ?? readListenState(listenStatePath(userConfigPath(ctx.env), s.apiKey!))?.session_id;
      if (!to)
        throw new CliError('No formfeed listen is running with this API key; start one, or name the endpoint with --to <endpoint id>', exitCodes.usage);
      try {
        const resent = await c.webhooks.resend(eventId, to);
        emit(p(), resent, () => [`${resent.event} (${resent.event_id}) queued again for ${resent.endpoint_id} as delivery ${resent.delivery_id}`]);
      } catch (e) {
        const error = e as FormfeedError;
        if (error.code === 'listen_session_ended' || error.status === 410)
          throw new CliError(`The listen session ${to} has ended; start formfeed listen again, or name an endpoint with --to`, exitCodes.usage, error.problem);
        if (error.status === 404) throw new CliError(`No event ${eventId} or endpoint ${to} in this workspace`, exitCodes.usage, error.problem);
        throw e;
      }
    });

  program
    .command('trigger <event>')
    .description('Make a real async render so a genuine event reaches formfeed listen (render.completed)')
    .requiredOption('--template <slug>', 'template to render')
    .option('--data <file>', 'JSON data (default: the local default data set, else the sample data of the published version)')
    .action(async (event: string, opts: { template: string; data?: string }) => {
      if (event !== 'render.completed')
        throw new CliError(
          `formfeed trigger supports render.completed. ${event} cannot be produced on purpose reliably; send a stored event again with formfeed webhooks resend <evt_id>`,
          exitCodes.usage,
        );
      const s = settings();
      const c = client(s);
      const printer = p();
      const live = s.apiKey!.startsWith('ff_live_');
      if (live) printer.err('warning: this is a live key: the render is metered, and formfeed listen shows its event only with --live');
      const data = await triggerData(c, s, opts.template, opts.data, ctx.cwd ?? process.cwd());
      const render = await c.renders.create({ template: opts.template, data, mode: 'async', meta: { source: 'formfeed trigger' } });
      emit(printer, { event, render }, () => [
        `Queued ${render.id} (${live ? 'live' : 'test'} render of ${opts.template}); ${event} follows when it finishes (render.failed if the data does not fit).`,
      ]);
    });

  // --- import ---------------------------------------------------------------------------------
  const importCmd = program.command('import').description('Import templates from other services (apitemplate.io, PDFMonkey, jsreport)');
  const cwd = () => ctx.cwd ?? process.cwd();

  /** Writes one converted template into the project and returns what `emit` reports. */
  const writeImported = (result: ImportResult, slugOverride?: string) => {
    const project = requireProject(settings());
    const slug = slugOverride ?? result.slug;
    const dir = writeTemplate(
      project,
      slug,
      { name: result.name, kind: result.kind, engine: result.engine, description: null, tags: ['imported', result.source] },
      { html: result.html, css: result.css, head: result.head, settings: result.settings as Record<string, unknown>, sample_data: (result.sampleData ?? {}) as Record<string, unknown>, data_schema: null, i18n: null },
    );
    return { ...result, slug, dir };
  };
  const reportLines = (results: Array<ImportResult & { dir: string }>) =>
    results.flatMap((r) => [
      `Imported ${r.name} (${r.engine}) -> ${r.dir}`,
      ...r.errors.map((e) => `error  ${e.line ? `line ${e.line}: ` : ''}${e.message}`),
      ...r.warnings.map((w) => `warn   ${w.line ? `line ${w.line}: ` : ''}${w.message}`),
      ...r.changes.map((c) => `note   ${c}`),
    ]);

  importCmd
    .command('apitemplate')
    .description('Create local templates from apitemplate.io: read with an API key, or from exported files')
    .option('--key <key>', 'apitemplate.io API key (or APITEMPLATE_API_KEY)')
    .option('--template <ids...>', 'template ids to read with the key')
    .option('--all', 'read every PDF template of the account with the key')
    .option('--group <name>', 'read the PDF templates of this apitemplate.io group with the key')
    .option('--source-region <region>', `apitemplate.io region of the account: ${Object.keys(apitemplateRegions).join(', ')} (or APITEMPLATE_REGION)`)
    .option('--html <file>', 'template body (HTML), instead of reading it with a key')
    .option('--css <file>', 'stylesheet (with --html)')
    .option('--settings <file>', 'settings JSON: paper, margins, header and footer (with --html)')
    .option('--sample <file>', 'sample data JSON (with --html)')
    .option('--name <name>', 'template name (with --html)')
    .option('--slug <slug>', 'folder and slug (default: from the name; with --html)')
    .action(
      async (opts: {
        key?: string;
        template?: string[];
        all?: boolean;
        group?: string;
        sourceRegion?: string;
        html?: string;
        css?: string;
        settings?: string;
        sample?: string;
        name?: string;
        slug?: string;
      }) => {
        const env = ctx.env ?? process.env;
        const fromApi = Boolean(opts.template?.length || opts.all || opts.group);
        if (opts.html) {
          if (fromApi) throw new CliError('Use either --html or --template/--all/--group, not both.', exitCodes.usage);
          const read = (f?: string) => (f ? readFileSync(resolve(cwd(), f), 'utf8') : undefined);
          const result = importApitemplate({
            name: opts.name ?? basename(opts.html, extname(opts.html)),
            html: read(opts.html) ?? '',
            css: read(opts.css),
            settings: opts.settings ? (JSON.parse(read(opts.settings) ?? '{}') as Record<string, unknown>) : undefined,
            sample_data: opts.sample ? JSON.parse(read(opts.sample) ?? '{}') : undefined,
          });
          const written = writeImported(result, opts.slug);
          emit(p(), written, () => reportLines([written]));
          return;
        }
        if (!fromApi)
          throw new CliError(
            'Name the templates with --template <id…>, --group <name> or --all (with an API key), or pass exported files with --html.',
            exitCodes.usage,
          );
        const key = opts.key ?? env['APITEMPLATE_API_KEY'];
        if (!key) throw new CliError('An apitemplate.io API key is required: --key or APITEMPLATE_API_KEY.', exitCodes.usage);
        const region = opts.sourceRegion ?? env['APITEMPLATE_REGION'] ?? 'default';
        if (!isApitemplateRegion(region))
          throw new CliError(`Unknown apitemplate.io region "${region}"; use one of ${Object.keys(apitemplateRegions).join(', ')}.`, exitCodes.usage);
        requireProject(settings());
        const fetchImpl = ctx.fetch ?? globalThis.fetch;

        // the list gives names, formats and groups, also for templates named by id
        const listed = await apitemplateTemplateList(fetchImpl, key, region);
        const byId = new Map(listed.map((t) => [t.template_id, t]));
        const skipped: string[] = [];
        let items: ApitemplateListItem[];
        if (opts.template?.length) {
          items = [...new Set(opts.template)].map((id) => byId.get(id) ?? { template_id: id });
        } else {
          const group = opts.group?.trim().toLowerCase();
          const inScope = listed.filter((t) => !group || (t.group_name ?? '').trim().toLowerCase() === group);
          items = inScope.filter((t) => isApitemplateHtmlTemplate(t));
          for (const t of inScope.filter((x) => !isApitemplateHtmlTemplate(x)))
            skipped.push(`skip   ${t.name ?? t.template_id} (${t.template_id}): ${t.format} templates are layer designs without HTML`);
          if (!items.length)
            throw new CliError(
              opts.group ? `No PDF templates in the apitemplate.io group "${opts.group}".` : 'The apitemplate.io account has no PDF templates.',
              exitCodes.usage,
            );
        }

        const written: Array<ImportResult & { dir: string; template_id: string }> = [];
        const failed: Array<{ template_id: string; name: string; error: string }> = [];
        const slugs = new Set<string>();
        for (const item of items) {
          let result: ImportResult;
          try {
            result = importApitemplateFromApi(item, await apitemplateTemplate(fetchImpl, key, region, item.template_id));
          } catch (e) {
            // a rejected key, the rate limit or a network failure would hit every template the same way
            if (!(e instanceof CliError) || e.exitCode !== exitCodes.usage) throw e;
            failed.push({ template_id: item.template_id, name: item.name ?? item.template_id, error: e.message });
            continue;
          }
          if (!result.html.trim()) {
            failed.push({ template_id: item.template_id, name: result.name, error: result.errors[0]?.message ?? 'no HTML' });
            continue;
          }
          // two templates of the same name must not share a folder
          let slug = result.slug;
          for (let n = 2; slugs.has(slug); n++) slug = `${result.slug}-${n}`;
          slugs.add(slug);
          written.push({ ...writeImported(result, slug), template_id: item.template_id });
        }
        for (const x of failed) skipped.push(`failed ${x.name} (${x.template_id}): ${x.error}`);
        emit(p(), { imported: written, failed }, () => [
          ...reportLines(written),
          ...skipped,
          ...(written.length ? [`${written.length} template(s) written; review them with "formfeed dev", then "formfeed templates push".`] : []),
        ]);
        if (!written.length) throw new CliError('No template could be imported.', exitCodes.validation, { silent: true });
      },
    );

  importCmd
    .command('pdfmonkey')
    .description('Create local templates from PDFMonkey code templates, read through their API')
    .option('--key <key>', 'PDFMonkey secret API key (or PDFMONKEY_API_KEY)')
    .option('--template <ids...>', 'template ids to import')
    .option('--workspace-id <id>', 'import every code template of this PDFMonkey workspace')
    .option('--snippet <name=file...>', 'snippet code for templates that load_snippets (repeatable)')
    .option('--draft', 'import the unpublished drafts')
    .action(async (opts: { key?: string; template?: string[]; workspaceId?: string; snippet?: string[]; draft?: boolean }) => {
      const key = opts.key ?? (ctx.env ?? process.env)['PDFMONKEY_API_KEY'];
      if (!key) throw new CliError('A PDFMonkey secret API key is required: --key or PDFMONKEY_API_KEY.', exitCodes.usage);
      const fetchImpl = ctx.fetch ?? globalThis.fetch;
      const ids = [...(opts.template ?? [])];
      if (opts.workspaceId) {
        const cards = await pdfmonkeyTemplateIds(fetchImpl, key, opts.workspaceId);
        ids.push(...cards.filter((c) => c.edition_mode !== 'builder').map((c) => c.id));
      }
      if (!ids.length) throw new CliError('Name the templates with --template <id…> or --workspace-id <id>.', exitCodes.usage);
      const snippets = readSnippets(opts.snippet ?? [], cwd());
      const templates = await Promise.all([...new Set(ids)].map((id) => pdfmonkeyTemplate(fetchImpl, key, id)));
      const compileScss = templates.some((t) => isScss(String((opts.draft ? t.scss_style_draft : t.scss_style) ?? '')))
        ? await projectSassCompiler(cwd())
        : undefined;
      const written = templates.map((t) => writeImported(importPdfmonkey(t, { snippets, draft: opts.draft, compileScss })));
      emit(p(), written, () => reportLines(written));
    });

  importCmd
    .command('jsreport <file>')
    .description('Create local templates from a jsreport export (.jsrexport)')
    .option('--template <paths...>', 'templates to import by folder path or name (default: every Handlebars chrome-pdf/chrome-image template)')
    .action((file: string, opts: { template?: string[] }) => {
      const bundle = readJsreportFile(resolve(cwd(), file));
      const refs = opts.template?.length
        ? opts.template
        : jsreportTemplates(bundle)
            .filter((t) => t.engine === 'handlebars' && (t.recipe === 'chrome-pdf' || t.recipe === 'chrome-image'))
            .map((t) => t.ref);
      if (!refs.length) throw new CliError('The export has no Handlebars chrome-pdf or chrome-image template; name one with --template.', exitCodes.usage);
      const written = refs.map((ref) => {
        try {
          return writeImported(importJsreport(bundle, ref));
        } catch (e) {
          throw new CliError(e instanceof Error ? e.message : String(e), exitCodes.usage);
        }
      });
      emit(p(), written, () => reportLines(written));
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

/** `renders.input` failures in words: 410 names the workspace setting that keeps requests. */
function renderInputError(id: string, error: FormfeedError): unknown {
  if (error.code === 'render_input_expired' || error.status === 410) {
    const retention = error.problem?.['request_data_retention'] as string | undefined;
    const why =
      retention === 'off' || !retention
        ? 'the workspace does not keep render requests'
        : `the workspace keeps render requests for ${retention === '7d' ? '7 days' : '24 hours'} and that period is over`;
    return new CliError(
      `The request of ${id} is no longer stored: ${why}. An owner or admin can change this in Settings → Keep render requests; it applies to renders made afterwards.`,
      exitCodes.usage,
      error.problem,
    );
  }
  if (error.status === 404) return new CliError(`No render ${id} in this workspace`, exitCodes.usage, error.problem);
  if (error.status === 403)
    return new CliError(`The API key may not read render requests: it needs the render:input scope (editors and above)`, exitCodes.auth, error.problem);
  return error;
}

/** A render-time failure as a diagnostic, with the template position when the engine knows it. */
function runtimeDiagnostic(e: unknown): EngineDiagnostic {
  let message = e instanceof Error ? e.message : String(e);
  let at = e instanceof RenderError || e instanceof EngineSyntaxError ? { line: e.line ?? 0, column: e.column ?? 1 } : { line: 0, column: 1 };
  // Nunjucks runtime errors carry the position only in the message, zero-based: "[Line 1, Column 35]\n  Error: …"
  const position = /\[Line (\d+), Column (\d+)\]/.exec(message);
  if (position) {
    if (!at.line && e instanceof RenderError && e.engine === 'jinja2') at = { line: Number(position[1]) + 1, column: Number(position[2]) + 1 };
    message = message.replace(position[0], '').trim().replace(/^Error:\s*/, '');
  }
  if (!at.line) at = { line: 1, column: 1 };
  return {
    severity: 'error',
    code: e instanceof RenderError ? 'render-error' : e instanceof EngineSyntaxError ? 'syntax-error' : 'render-failed',
    message,
    range: { start: at, end: { line: at.line, column: at.column + 1 } },
  };
}

/** `trigger` data: a JSON file, else the local default data set, else the sample data of the published (or latest) version. */
async function triggerData(c: ReturnType<typeof createClient>, s: Settings, slug: string, file: string | undefined, cwd: string): Promise<Record<string, unknown>> {
  if (file) {
    const path = resolve(s.project?.root ?? cwd, file);
    if (!existsSync(path)) throw new CliError(`Data file not found: ${path}`, exitCodes.usage);
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      throw new CliError(`${path} is not valid JSON: ${e instanceof Error ? e.message : e}`, exitCodes.usage);
    }
  }
  if (s.project && listTemplateSlugs(s.project).includes(slug))
    return (defaultData(readTemplate(s.project, slug)).data ?? {}) as Record<string, unknown>;
  for (const which of ['published', 'latest'] as const) {
    try {
      return ((await c.templates.versions.get(slug, which)).sample_data ?? {}) as Record<string, unknown>;
    } catch (e) {
      if ((e as FormfeedError).status !== 404) throw e;
    }
  }
  return {};
}

/** Mirrors `public.partials.name`; kept here because the published CLI does not carry `@formfeed/api-types`. */
const sharedPartialName = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

function parseEngine(value: string): EngineId {
  if (!['jinja2', 'liquid', 'handlebars'].includes(value)) throw new InvalidArgumentError('engine must be jinja2, liquid or handlebars');
  return value as EngineId;
}

function parseOutput(value: string): OutputFormat {
  if (!isOutputFormat(value)) throw new InvalidArgumentError('output must be pdf, png, jpg, webp, docx or pptx');
  return value;
}

/**
 * Fills a local Word or PowerPoint template as the render-worker does: `asset()` resolves against the
 * workspace library, pictures are fetched and codes drawn by `cliImageHost`. A template that cannot be
 * filled is a validation error naming the part.
 */
async function fillOffice(project: ReturnType<typeof requireProject>, tpl: LocalTemplate, data: unknown, c: ReturnType<typeof createClient>, fetchImpl?: typeof fetch) {
  try {
    return await renderOfficeLocal(project, tpl, data, {
      assetBaseUrl: await remoteAssetBase(c),
      brand: readBrand(project),
      images: cliImageHost(fetchImpl),
    });
  } catch (e) {
    const lines = officeFailureLines(`${tpl.slug}/${templateFileName(tpl.meta.kind)}`, e);
    throw new CliError(lines.join('\n'), exitCodes.validation);
  }
}

/** Why a Word or PowerPoint template could not be filled, one finding per line. */
function officeFailureLines(source: string, e: unknown): string[] {
  if (e instanceof OfficeTemplateError && e.diagnostics.length)
    return e.diagnostics.map((d) => formatDiagnostic(source, { ...d, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } }));
  const code = (e as { code?: unknown }).code;
  const message = e instanceof Error ? e.message : String(e);
  return [`error  ${source}  ${message}${typeof code === 'string' ? `  [${code}]` : ''}`];
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
  const pulled: Array<{ slug: string; number: number; status: string; dir: string; partials: number }> = [];
  for (const t of list) {
    const version = await c.templates.versions.get(t.slug, draft || !t.published_version ? 'latest' : 'published');
    const meta: TemplateMeta = { name: t.name, kind: t.kind, engine: t.engine, description: t.description, tags: t.tags };
    // the document of exactly this version, even when a newer one was saved meanwhile
    const file = isOfficeKind(t.kind) ? await c.templates.versions.file(t.slug, version.number) : undefined;
    const dir = writeTemplate(project, t.slug, meta, version, file);
    recordSync(project, t.slug, version, readTemplate(project, t.slug));
    pulled.push({ slug: t.slug, number: version.number, status: version.status, dir, partials: Object.keys(version.partials ?? {}).length });
  }
  return pulled;
}

/** `schema_breaking_change` as a readable refusal that names the changes and the way past it. */
async function schemaGuard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    const error = e as FormfeedError;
    if (error.code !== 'schema_breaking_change') throw e;
    const breaking = ((error.problem?.['breaking'] as SchemaChange[] | undefined) ?? []).map((c) => `  - ${c.message}`);
    throw new CliError(
      [`${error.message}`, ...breaking, 'Run again with --allow-breaking to go ahead anyway.'].join('\n'),
      exitCodes.validation,
      error.problem,
    );
  }
}

/** Changes worth a line after a publish or a channel move: breaking ones that were allowed, and inferred warnings. */
function schemaWarnings(check: TemplateVersion['schema_check'] | null | undefined): string[] {
  if (!check || check.breaking.length === 0) return [];
  const label = check.source === 'inferred' ? 'warning (inferred from sample data)' : 'breaking change (allowed)';
  return check.breaking.map((c) => `  ${label}: ${c.message}`);
}

function describeChannel(slug: string, channel: Channel): string {
  const canary = channel.canary ? `, canary v${channel.canary.version} at ${channel.canary.percent}%` : '';
  const previous = channel.previous_version ? ` (previous v${channel.previous_version})` : '';
  return `${slug}: channel ${channel.name} -> v${channel.version}${canary}${previous}`;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`"${value}" is not a positive whole number`);
  return n;
}

/**
 * Schemas for `formfeed types` from the API: the stored schema of the channel's version, else one
 * inferred over its sample data and data sets. Without explicit slugs every template is included;
 * a template without a version on the channel is skipped then, and an error when it was named.
 */
async function remoteTypeSources(c: ReturnType<typeof createClient>, slugs: string[], channel: string | undefined): Promise<TypeSource[]> {
  const names = slugs.length ? slugs : (await c.templates.all()).map((t) => t.slug);
  const which = channel ?? 'published';
  const sources: TypeSource[] = [];
  for (const slug of names) {
    let version: TemplateVersion;
    try {
      version = await c.templates.versions.get(slug, which);
    } catch (e) {
      if ((e as FormfeedError).status !== 404) throw e;
      if (slugs.length) throw new CliError(`${slug} has no version on channel ${which}`, exitCodes.usage);
      // never published: the draft is the best description of the data it expects
      if (channel) continue;
      version = await c.templates.versions.get(slug, 'latest');
    }
    const sets = [version.sample_data ?? {}, ...Object.values(version.data_sets ?? {})];
    sources.push(
      version.data_schema
        ? { slug, schema: version.data_schema, origin: 'stored', version: version.number, channel: which }
        : { slug, schema: inferSchemaFromDataSets(sets) as Record<string, unknown>, origin: 'inferred', version: version.number, channel: which },
    );
  }
  return sources;
}

async function pushTemplate(
  c: ReturnType<typeof createClient>,
  project: ReturnType<typeof requireProject>,
  tpl: LocalTemplate,
  opts: { publish: boolean; message?: string; baseChecksum?: string; allowBreaking?: boolean; sendFile?: boolean },
): Promise<TemplateVersion> {
  let exists = true;
  try {
    await c.templates.get(tpl.slug);
  } catch (e) {
    if ((e as FormfeedError).status === 404) exists = false;
    else throw e;
  }
  let version: TemplateVersion;
  if (tpl.file) {
    // Word and PowerPoint: the document travels as multipart, the rest as form fields
    const fields = officeVersionPayload(tpl);
    const file = { data: tpl.file.bytes, name: `${tpl.slug}.${tpl.file.format}` };
    if (!exists) {
      await c.templates.create({
        name: tpl.meta.name,
        slug: tpl.slug,
        description: tpl.meta.description ?? null,
        kind: tpl.file.format,
        engine: tpl.meta.engine,
        tags: tpl.meta.tags ?? [],
        ...fields,
        publish: opts.publish,
        file,
      });
      version = await c.templates.versions.get(tpl.slug, 'latest');
    } else {
      version = await c.templates.versions.create(tpl.slug, {
        ...fields,
        change_note: opts.message ?? 'formfeed templates push',
        ...(opts.baseChecksum ? { base_checksum: opts.baseChecksum } : {}),
        publish: opts.publish,
        ...(opts.publish && opts.allowBreaking ? { allow_breaking: true } : {}),
        // without a file the API keeps the latest version's document
        ...(opts.sendFile !== false ? { file } : {}),
      });
    }
    recordSync(project, tpl.slug, version, tpl);
    return version;
  }
  const payload = versionPayload(tpl);
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
      ...(opts.publish && opts.allowBreaking ? { allow_breaking: true } : {}),
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

/** Approved snapshots live beside the template, the layout the docs describe (`.xml` for Word and PowerPoint). */
function snapshotPath(project: Parameters<typeof templateDir>[0], slug: string, dataSet: string, extension: 'html' | 'xml'): string {
  return join(templateDir(project, slug), 'tests', '__snapshots__', `${dataSet}.${extension}`);
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
