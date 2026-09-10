import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Formfeed } from '@formfeed/sdk-ts';
import { createMatchers, loadTemplate } from './testing';

function writeTemplate(root: string, slug: string, html: string, data: unknown): string {
  const dir = join(root, 'templates', slug);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'template.json'), JSON.stringify({ name: slug, kind: 'pdf', engine: 'jinja2' }));
  writeFileSync(join(dir, 'template.html'), html);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ paper: { format: 'A4' } }));
  writeFileSync(join(dir, 'data', 'default.json'), JSON.stringify(data));
  return dir;
}

describe('@formfeed/testing', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'formfeed-testing-'));
    mkdirSync(join(root, 'partials'));
    writeFileSync(join(root, 'partials', 'footer.html'), '<footer>Thanks, {{ customer.name }}</footer>');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('loads a template folder without formfeed.json and renders it with partials', async () => {
    const dir = writeTemplate(root, 'invoice', '<h1>Invoice {{ invoice.number }}</h1>{% include "footer" %}', { invoice: { number: 7 }, customer: { name: 'Ada' } });
    const tpl = await loadTemplate(dir);
    expect(tpl.project.configPath).toBeNull();
    const html = await tpl.render();
    expect(html).toContain('Invoice 7');
    expect(html).toContain('Thanks, Ada');
    expect(tpl.analyze()).toEqual([]);
  });

  it('offline matchers pass and fail with useful messages', async () => {
    const warnings: string[] = [];
    const m = createMatchers({ env: {}, warn: (w) => warnings.push(w) });
    const good = await loadTemplate(writeTemplate(root, 'good', '<p>Total {{ total | money }}</p>', { total: 12.5 }));
    const bad = await loadTemplate(writeTemplate(root, 'bad', '<p>{{ total | nope }} {{ missing.path }}</p>', { total: 1 }));

    expect((await m.toRenderWithoutErrors(good)).pass).toBe(true);
    const failed = await m.toRenderWithoutErrors(bad);
    expect(failed.pass).toBe(false);
    expect(failed.message()).toMatch(/nope/);

    expect((await m.toUseOnlyKnownVariables(good)).pass).toBe(true);
    const unknown = await m.toUseOnlyKnownVariables(bad, { total: 1 });
    expect(unknown.pass).toBe(false);
    expect(unknown.message()).toMatch(/missing/);

    expect((await m.toContainText(good, 'Total')).pass).toBe(true);
    expect((await m.toContainText(good, 'Nowhere')).pass).toBe(false);

    // API matcher: skipped without a key, refused when the key is required
    const skipped = await m.toHavePageCount(good, 1);
    expect(skipped.pass).toBe(true);
    expect(warnings[0]).toMatch(/skipped/);
    const strict = createMatchers({ env: { FORMFEED_REQUIRE_API: '1' }, warn: () => undefined });
    expect((await strict.toHavePageCount(good, 1)).pass).toBe(false);
  });

  it('toHavePageCount renders through the API when a client is present', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return new Response(JSON.stringify({ id: 'rnd_1', status: 'succeeded', page_count: 2, units: 0 }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new Formfeed({ apiKey: 'ff_test_k', fetch: fetchImpl });
    const m = createMatchers({ env: {}, client });
    const tpl = await loadTemplate(writeTemplate(root, 'two', '<p>x</p>', {}));
    expect((await m.toHavePageCount(tpl, 2)).pass).toBe(true);
    const wrong = await m.toHavePageCount(tpl, 3);
    expect(wrong.pass).toBe(false);
    expect(wrong.message()).toMatch(/rendered 2 page/);
    expect(calls).toEqual(['POST /v1/renders', 'POST /v1/renders']);
  });
});
