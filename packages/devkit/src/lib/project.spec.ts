import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, writeProjectConfig } from './project-config';
import { diagnose, previewDocument, renderLocal } from './local-render';
import { contentHash, listTemplateSlugs, readTemplate, versionPayload, writeTemplate } from './project';

describe('template folders (spec 15 §2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-project-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const project = () => loadProject(writeProjectConfig(dir, { engine: 'jinja2' }));

  it('round-trips a version through files, folding header and footer into settings', () => {
    const p = project();
    writeTemplate(
      p,
      'invoice',
      { name: 'Invoice', kind: 'pdf', engine: 'jinja2', description: null, tags: ['a'] },
      {
        html: '<h1>{{ invoice.number }}</h1>',
        css: 'h1 { color: red }',
        head: '',
        settings: { paper: { format: 'A4' }, header: { html: '<p>Head</p>', height: '15mm' }, footer: { html: '<span class="pageNumber"></span>' } },
        sample_data: { invoice: { number: '7' } },
        data_schema: { type: 'object' },
        i18n: { de: { hello: 'Hallo' } },
      },
    );
    expect(existsSync(join(dir, 'templates', 'invoice', 'header.html'))).toBe(true);
    expect(existsSync(join(dir, 'templates', 'invoice', 'head.html'))).toBe(false); // empty files are not written
    const settingsOnDisk = JSON.parse(readFileSync(join(dir, 'templates', 'invoice', 'settings.json'), 'utf8'));
    expect(settingsOnDisk.header).toEqual({ height: '15mm' });
    expect(settingsOnDisk.footer).toBeNull();

    const tpl = readTemplate(p, 'invoice');
    expect(listTemplateSlugs(p)).toEqual(['invoice']);
    expect(tpl.meta).toMatchObject({ name: 'Invoice', kind: 'pdf', engine: 'jinja2', tags: ['a'] });
    expect(tpl.settings.header).toEqual({ height: '15mm', html: '<p>Head</p>' });
    expect(tpl.settings.footer).toEqual({ html: '<span class="pageNumber"></span>' });
    expect(tpl.dataSets['default']).toEqual({ invoice: { number: '7' } });
    expect(tpl.i18n).toEqual({ de: { hello: 'Hallo' } });
    const payload = versionPayload(tpl);
    expect(payload.settings['header']).toEqual({ height: '15mm', html: '<p>Head</p>' });
    const before = contentHash(tpl);
    writeFileSync(join(dir, 'templates', 'invoice', 'template.html'), '<h1>changed</h1>');
    expect(contentHash(readTemplate(p, 'invoice'))).not.toBe(before);
  });

  it('diagnoses like the editor and renders previews with the shared engine', async () => {
    const p = project();
    writeTemplate(
      p,
      'broken',
      { name: 'Broken', kind: 'pdf', engine: 'jinja2' },
      {
        html: '<p>{{ total | fancy_filter }} {{ missing.path }}</p>{% include "footer" %}',
        css: '',
        head: '',
        settings: {},
        sample_data: { total: 5 },
        data_schema: null,
        i18n: null,
      },
    );
    mkdirSync(join(dir, 'partials'), { recursive: true });
    writeFileSync(join(dir, 'partials', 'footer.html'), '<footer>{{ total }}</footer>');
    const tpl = readTemplate(p, 'broken');
    const diagnostics = diagnose(tpl, tpl.dataSets['default']);
    expect(diagnostics.some((d) => d.severity === 'error' && /fancy_filter/.test(d.message))).toBe(true);
    expect(diagnostics.some((d) => d.severity === 'warning' && /missing/.test(d.message))).toBe(true);

    writeFileSync(join(dir, 'templates', 'broken', 'template.html'), '<p>{{ total }}</p>{% include "footer" %}');
    const fixed = readTemplate(p, 'broken');
    const rendered = await renderLocal(p, fixed, { total: 5 }, { mode: 'preview' });
    expect(rendered.document).toContain('<footer>5</footer>');
    const paged = previewDocument(fixed, rendered, 'paged', '/vendor/pagedjs/paged.polyfill.min.js');
    expect(paged).toContain('paged.polyfill.min.js');
    expect(paged).toContain('window.PagedConfig');
    const flow = previewDocument(fixed, rendered, 'flow', '/x');
    expect(flow).toContain('body.formfeed-preview');
  });
});
