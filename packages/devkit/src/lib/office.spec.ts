import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { starterDocument } from '@formfeed/engine';
import { diagnose, officeSnapshot, prettyXml, renderLocal, renderOfficeLocal } from './local-render';
import { contentHash, listTemplateSlugs, officeVersionPayload, readTemplate, writeTemplate } from './project';
import { loadProject, writeProjectConfig } from './project-config';

describe('Word and PowerPoint template folders (spec 22 §7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-office-folder-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const project = () => loadProject(writeProjectConfig(dir, { engine: 'jinja2' }));
  const starter = starterDocument('jinja2');
  const meta = { name: 'Offer', kind: 'docx' as const, engine: 'jinja2' as const, description: null, tags: [] };
  const version = { html: '', css: '', head: '', settings: { locale: 'de-DE' }, sample_data: starter.sampleData, data_schema: null, i18n: null };

  it('writes the document instead of the HTML files and reads it back as the source', () => {
    const p = project();
    const folder = join(dir, 'templates', 'offer');
    // a template that was HTML before leaves no HTML files behind
    writeTemplate(p, 'offer', { ...meta, kind: 'pdf' }, { ...version, html: '<p>old</p>', css: 'p{}', settings: { header: { html: '<b>h</b>' } } });
    writeTemplate(p, 'offer', meta, version, starter.bytes);
    for (const name of ['template.html', 'style.css', 'header.html']) expect(existsSync(join(folder, name))).toBe(false);
    expect(new Uint8Array(readFileSync(join(folder, 'template.docx')))).toEqual(starter.bytes);

    const tpl = readTemplate(p, 'offer');
    expect(listTemplateSlugs(p)).toEqual(['offer']);
    expect(tpl.meta.kind).toBe('docx');
    expect(tpl.file).toMatchObject({ format: 'docx', bytes: starter.bytes });
    expect(tpl.html).toBe('');
    expect(tpl.partials).toEqual({});
    expect(officeVersionPayload(tpl)).toEqual({ settings: { locale: 'de-DE' }, sample_data: starter.sampleData, data_sets: {}, data_schema: null, i18n: null });
    expect(() => writeTemplate(p, 'offer', meta, version)).toThrow(/document is needed/);
  });

  it('hashes the document, so replacing it counts as a local edit', () => {
    const p = project();
    writeTemplate(p, 'offer', meta, version, starter.bytes);
    const before = contentHash(readTemplate(p, 'offer'));
    const changed = starterDocument('liquid').bytes;
    writeFileSync(join(dir, 'templates', 'offer', 'template.docx'), changed);
    expect(contentHash(readTemplate(p, 'offer'))).not.toBe(before);
  });

  it('refuses a kind that does not match the document', () => {
    const p = project();
    writeTemplate(p, 'offer', meta, version, starter.bytes);
    writeFileSync(join(dir, 'templates', 'offer', 'template.json'), JSON.stringify({ ...meta, kind: 'pptx' }));
    expect(() => readTemplate(p, 'offer')).toThrow(/says kind "pptx", but the folder holds template.docx/);
  });

  it('diagnoses, fills and snapshots the document; HTML functions refuse it', async () => {
    const p = project();
    writeTemplate(p, 'offer', meta, version, starter.bytes);
    const tpl = readTemplate(p, 'offer');
    expect(diagnose(tpl, starter.sampleData).filter((d) => d.severity === 'error')).toEqual([]);
    const missing = diagnose(tpl, {}).find((d) => d.severity !== 'info' && d.part);
    expect(missing).toMatchObject({ part: 'word/document.xml', paragraph: expect.any(Number) });

    const filled = await renderOfficeLocal(p, tpl, starter.sampleData, { random: () => 0.5 });
    const again = await renderOfficeLocal(p, tpl, starter.sampleData, { random: () => 0.5 });
    expect(officeSnapshot(filled.bytes)).toBe(officeSnapshot(again.bytes));
    expect(officeSnapshot(filled.bytes)).toContain('--- word/document.xml ---');
    // no image host: the QR code becomes a warning instead of a picture
    expect(filled.warnings.join(' ')).toMatch(/Could not place a code/);

    await expect(renderLocal(p, tpl, {}, { mode: 'preview' })).rejects.toThrow(/renderOfficeLocal/);
  });
});

describe('prettyXml', () => {
  it('puts one element per line and keeps text with its element', () => {
    expect(prettyXml('<?xml version="1.0"?><w:p><w:r><w:t xml:space="preserve">Hi &lt;b&gt; </w:t></w:r><w:br/><w:r></w:r></w:p>')).toBe(
      ['<?xml version="1.0"?>', '<w:p>', '  <w:r>', '    <w:t xml:space="preserve">Hi &lt;b&gt; </w:t>', '  </w:r>', '  <w:br/>', '  <w:r></w:r>', '</w:p>', ''].join('\n'),
    );
  });
});
