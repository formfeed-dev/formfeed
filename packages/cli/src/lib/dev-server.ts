import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { Formfeed } from '@formfeed/sdk-ts';
import type { Project } from './config';
import { CliError, exitCodes } from './errors';
import { contentTypeFor, defaultData, diagnose, localFilePath, previewDocument, readTemplate, renderLocal, type LocalTemplate } from '@formfeed/devkit';
import { remoteAssetBase } from './files';

/**
 * `formfeed dev` (spec 15 §4): the editor's preview frame served locally. The server renders with
 * the shared engine, wraps the document like the editor (flow or Paged.js) and pushes a reload over
 * server-sent events whenever a file under the template or partials folder changes. Templates see
 * the brand kit of `.formfeed/brand.json` (`renderLocal` reads it on every render). Binds to
 * localhost only; the true-render button needs an API key and stays off without one.
 */
export interface DevServerOptions {
  project: Project;
  slug: string;
  port?: number;
  host?: string;
  data?: string;
  locale?: string;
  /** Present when a key is configured: true renders go through the API as test renders. */
  client?: Formfeed | null;
  log?: (line: string) => void;
}

export interface DevServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Browser builds served to the preview frame: package name and file below the package root. */
const vendorFiles: Record<string, [pkg: string, file: string]> = {
  '/vendor/pagedjs/paged.polyfill.min.js': ['pagedjs', 'dist/paged.polyfill.min.js'],
  '/vendor/chartjs/chart.umd.js': ['chart.js', 'dist/chart.umd.js'],
  '/vendor/tailwind/index.global.js': ['@tailwindcss/browser', 'dist/index.global.js'],
};

const require = createRequire(import.meta.url);

/** The packages' `exports` maps hide their dist files, so the root is found from the main entry. */
function resolveVendor([pkg, file]: [string, string]): string | null {
  try {
    let dir = dirname(require.resolve(pkg));
    for (let i = 0; i < 6; i++) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === pkg) {
        const target = join(dir, file);
        return existsSync(target) ? target : null;
      }
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { project, slug } = options;
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? (() => undefined);
  const clients = new Set<ServerResponse>();
  let template: LocalTemplate | null = null;
  let assetBase: string | undefined;
  let loadError: string | null = null;

  const reload = () => {
    try {
      template = readTemplate(project, slug);
      loadError = null;
    } catch (e) {
      template = null;
      loadError = e instanceof Error ? e.message : String(e);
    }
  };
  reload();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const broadcast = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      reload();
      for (const res of clients) res.write('event: change\ndata: {}\n\n');
      log(`changed: ${slug}`);
    }, 50);
  };
  const watchers: FSWatcher[] = [];
  // `.formfeed` holds brand.json: `formfeed brand pull` in another terminal reloads the preview
  for (const dir of [template?.dir ?? `${project.templatesDir}/${slug}`, project.partialsDir, project.filesDir, join(project.root, '.formfeed')]) {
    if (!existsSync(dir)) continue;
    try {
      watchers.push(watch(dir, { recursive: true }, broadcast));
    } catch {
      watchers.push(watch(dir, broadcast));
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(e instanceof Error ? e.message : String(e));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('event: hello\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname in vendorFiles) {
      const file = resolveVendor(vendorFiles[url.pathname]!);
      if (!file) {
        res.writeHead(404);
        res.end('vendor file not installed');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
      res.end(await readFile(file));
      return;
    }
    // The files folder stands in for the workspace library, so asset() works offline.
    if (url.pathname.startsWith('/files/')) {
      let path: string;
      try {
        path = localFilePath(project, decodeURIComponent(url.pathname.slice('/files/'.length)));
      } catch {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (!existsSync(path)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Not in ${project.filesDir}; run formfeed files pull`);
        return;
      }
      res.writeHead(200, { 'content-type': contentTypeFor(path) ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(path));
      return;
    }
    if (url.pathname === '/api/state') {
      const state = stateJson(url.searchParams.get('data') ?? options.data ?? undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/preview') {
      if (!template) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage(loadError ?? 'template not found'));
        return;
      }
      const mode = url.searchParams.get('mode') === 'flow' || template.meta.kind === 'image' ? 'flow' : 'paged';
      const set = defaultData(template, url.searchParams.get('data') ?? options.data ?? undefined);
      const locale = url.searchParams.get('locale') ?? options.locale ?? undefined;
      try {
        const rendered = await renderLocal(project, template, set.data, {
          mode: 'preview',
          locale,
          assetBaseUrl: `http://${req.headers.host ?? host}/files`,
          vendor: { chartJs: { src: '/vendor/chartjs/chart.umd.js' }, tailwind: { src: '/vendor/tailwind/index.global.js' } },
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(previewDocument(template, rendered, mode, '/vendor/pagedjs/paged.polyfill.min.js'));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage(e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    if (url.pathname === '/api/render' && req.method === 'POST') {
      if (!options.client) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'No API key configured; run `formfeed login --api-key ff_test_…`' }));
        return;
      }
      if (!template) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: loadError }));
        return;
      }
      const body = JSON.parse((await readBody(req)) || '{}') as { data?: string; output?: 'pdf' | 'png' | 'jpg' };
      const set = defaultData(template, body.data ?? options.data ?? undefined);
      // a true render leaves as a complete document, so it resolves against the remote library
      assetBase ??= await remoteAssetBase(options.client);
      const rendered = await renderLocal(project, template, set.data, { mode: 'print', assetBaseUrl: assetBase });
      try {
        const render = await options.client.renders.create({
          html: rendered.document,
          settings: rendered.settings as Record<string, unknown>,
          output: body.output ?? (template.meta.kind === 'image' ? 'png' : 'pdf'),
          meta: { source: 'formfeed dev', template: slug },
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(render));
      } catch (e) {
        const status = (e as { status?: number }).status;
        res.writeHead(status && status >= 400 ? status : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(shell(slug));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }

  function stateJson(dataName?: string) {
    if (!template) return { slug, error: loadError, dataSets: [], locales: [], diagnostics: [], kind: 'pdf', trueRender: Boolean(options.client) };
    const set = defaultData(template, dataName);
    return {
      slug,
      name: template.meta.name,
      kind: template.meta.kind,
      engine: template.meta.engine,
      dataSets: Object.keys(template.dataSets),
      dataSet: set.name,
      locales: template.i18n ? Object.keys(template.i18n) : [],
      diagnostics: diagnose(template, set.data),
      trueRender: Boolean(options.client),
      error: null,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4400, host, () => resolve());
  }).catch((e: NodeJS.ErrnoException) => {
    throw new CliError(
      e.code === 'EADDRINUSE' ? `Port ${options.port ?? 4400} is in use; pass --port` : e.message,
      exitCodes.usage,
    );
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of watchers) w.close();
        for (const res of clients) res.end();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function errorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font:14px/1.5 system-ui;padding:24px;color:#991b1b;background:#fef2f2"><strong>Render error</strong><pre style="white-space:pre-wrap">${message.replace(/</g, '&lt;')}</pre></body>`;
}

/** The shell page: toolbar, diagnostics and the preview frame; reloads over SSE. */
function shell(slug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>formfeed dev · ${slug}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; background: #f4f4f5; color: #18181b; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #e4e4e7; }
  header strong { font-size: 14px; }
  header .spacer { flex: 1; }
  select, button { font: inherit; padding: 4px 8px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; }
  button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  button:disabled { opacity: .5; }
  .modes button[aria-pressed="true"] { background: #e4e4e7; }
  main { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1; border: 0; background: #e5e7eb; }
  aside { width: 320px; border-left: 1px solid #e4e4e7; background: #fff; overflow: auto; padding: 8px 12px; }
  aside h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #71717a; margin: 8px 0; }
  .diag { padding: 6px 8px; border-radius: 6px; margin-bottom: 6px; font-size: 12px; }
  .diag.error { background: #fef2f2; color: #991b1b; } .diag.warning { background: #fffbeb; color: #92400e; } .diag.info { background: #eff6ff; color: #1e40af; }
  .diag code { font-size: 11px; opacity: .8; }
  #status { color: #71717a; }
  #result a { color: #4f46e5; }
</style>
</head>
<body>
<header>
  <strong>formfeed dev</strong> <span id="name">${slug}</span>
  <span class="spacer"></span>
  <label>Data <select id="data"></select></label>
  <label id="localeWrap" hidden>Locale <select id="locale"></select></label>
  <span class="modes"><button id="flow" aria-pressed="false">Flow</button><button id="paged" aria-pressed="true">Paged</button></span>
  <button id="render" class="primary" title="Render through the API as a test render">True render</button>
  <span id="status"></span>
</header>
<main>
  <iframe id="frame" title="preview" sandbox="allow-scripts allow-same-origin"></iframe>
  <aside>
    <h2>Diagnostics</h2>
    <div id="diagnostics"></div>
    <h2>True render</h2>
    <div id="result">Renders through the API with the current files and data set.</div>
  </aside>
</main>
<script>
(function () {
  var state = { mode: 'paged', data: null, locale: null };
  var $ = function (id) { return document.getElementById(id); };
  function query() {
    var p = new URLSearchParams(); p.set('mode', state.mode);
    if (state.data) p.set('data', state.data); if (state.locale) p.set('locale', state.locale);
    return p.toString();
  }
  function refresh() {
    $('frame').src = '/preview?' + query() + '&t=' + Date.now();
    fetch('/api/state?' + query()).then(function (r) { return r.json(); }).then(function (s) {
      $('name').textContent = s.name ? s.name + ' · ' + s.slug : s.slug;
      var sel = $('data'); sel.innerHTML = '';
      s.dataSets.forEach(function (d) { var o = document.createElement('option'); o.value = d; o.textContent = d; if (d === s.dataSet) o.selected = true; sel.appendChild(o); });
      $('localeWrap').hidden = !s.locales.length;
      var ls = $('locale'); ls.innerHTML = '';
      s.locales.forEach(function (l) { var o = document.createElement('option'); o.value = l; o.textContent = l; if (l === state.locale) o.selected = true; ls.appendChild(o); });
      $('paged').disabled = s.kind === 'image';
      $('render').disabled = !s.trueRender; $('render').title = s.trueRender ? 'Render through the API as a test render' : 'Run formfeed login --api-key first';
      var box = $('diagnostics'); box.innerHTML = '';
      if (s.error) { var e = document.createElement('div'); e.className = 'diag error'; e.textContent = s.error; box.appendChild(e); }
      if (!s.diagnostics.length && !s.error) { box.innerHTML = '<div class="diag info">No findings</div>'; }
      s.diagnostics.forEach(function (d) {
        var el = document.createElement('div'); el.className = 'diag ' + d.severity;
        el.innerHTML = '<code>' + d.range.start.line + ':' + d.range.start.column + '</code> ' + d.message.replace(/</g, '&lt;') + ' <code>[' + d.code + ']</code>';
        box.appendChild(el);
      });
      $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
    });
  }
  $('data').addEventListener('change', function (e) { state.data = e.target.value; refresh(); });
  $('locale').addEventListener('change', function (e) { state.locale = e.target.value; refresh(); });
  ['flow', 'paged'].forEach(function (m) { $(m).addEventListener('click', function () {
    state.mode = m; $('flow').setAttribute('aria-pressed', String(m === 'flow')); $('paged').setAttribute('aria-pressed', String(m === 'paged')); refresh();
  }); });
  $('render').addEventListener('click', function () {
    $('result').textContent = 'Rendering…';
    fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: state.data }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok) { $('result').textContent = res.body.error || 'failed'; return; }
        var r = res.body;
        $('result').innerHTML = (r.page_count ? r.page_count + ' page(s) · ' : '') + (r.units != null ? r.units + ' units · ' : '') +
          (r.download_url ? '<a href="' + r.download_url + '" target="_blank" rel="noopener">open output</a>' : r.status);
      })
      .catch(function (e) { $('result').textContent = String(e); });
  });
  var es = new EventSource('/events');
  es.addEventListener('change', refresh);
  window.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'formfeed:pages') $('status').textContent = ev.data.pages + ' page(s) · updated ' + new Date().toLocaleTimeString(); });
  refresh();
})();
</script>
</body>
</html>`;
}
