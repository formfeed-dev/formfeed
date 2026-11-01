import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type ProgramContext } from './commands';

/**
 * PDF/A on the command line (plan 26): `validate` refuses a declaration the API refuses, and
 * `render` sends it with the document and prints the validator's verdict.
 */
describe('formfeed CLI: PDF/A (plan 26)', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;

  const reportDir = () => join(dir, 'templates', 'report');
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  function writeReport(settings: Record<string, unknown>, kind = 'pdf'): void {
    mkdirSync(join(reportDir(), 'data'), { recursive: true });
    writeFileSync(
      join(reportDir(), 'template.json'),
      json({ name: 'Report', kind, engine: 'jinja2' }),
    );
    writeFileSync(
      join(reportDir(), 'template.html'),
      '<h1>Jahresbericht {{ year }}</h1>',
    );
    writeFileSync(join(reportDir(), 'settings.json'), json(settings));
    writeFileSync(
      join(reportDir(), 'data', 'default.json'),
      json({ year: 2026 }),
    );
  }

  const passed = {
    standard: 'PDF/A-2b',
    conformant: true,
    validator: 'veraPDF 1.30.2',
    id: 'a-1',
    versions: { verapdf: '1.30.2', pdfbox: '3.0.8' },
    pdf_sha256: 'ee53',
    messages: [],
  };

  function api(answer: () => Response) {
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/renders' && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return answer();
      }
      if (url.host === 'cdn.test')
        return new Response(new Uint8Array([37, 80, 68, 70]));
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { sent, fetch: fetchImpl };
  }
  const render = (pdfa: unknown) =>
    new Response(
      JSON.stringify({
        id: 'rnd_1',
        status: 'succeeded',
        output: 'pdf',
        page_count: 4,
        units: 0,
        download_url: 'https://cdn.test/o/x.pdf',
        pdfa,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const withKey = (fetchImpl: typeof fetch): ProgramContext => ({
    ...ctx,
    env: { ...ctx.env, FORMFEED_API_KEY: 'ff_test_k' },
    fetch: fetchImpl,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-pdfa-'));
    out = [];
    err = [];
    ctx = {
      cwd: dir,
      env: { FORMFEED_CONFIG_DIR: join(dir, 'user') },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    };
    expect(await run(['init'], ctx)).toBe(0);
    rmSync(join(dir, 'templates', 'hello'), { recursive: true });
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('validate accepts a template that declares a level, and says nothing about it', async () => {
    for (const pdfa of ['2b', '3b', true]) {
      writeReport({ pdf: { pdfa } });
      out = [];
      expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
      expect(out).toEqual(['1 template(s) valid']);
    }
  });

  it('validate refuses a value that is no declaration', async () => {
    writeReport({ pdf: { pdfa: '1b' } });
    expect(await run(['validate'], ctx)).toBe(1);
    const line = out.find((l) => l.includes('pdfa-setting'));
    expect(line).toMatch(/^error {2}report\/settings\.json/);
    expect(line).toContain('"2b", "3b", true, false or null');
  });

  it('validate refuses 2b beside an e-invoice, which is a PDF/A-3b, and lets 3b go with it', async () => {
    writeReport({ pdf: { pdfa: '2b' }, einvoice: {} });
    await run(['validate'], ctx);
    expect(out.join('\n')).toContain('pdfa-einvoice');
    writeReport({ pdf: { pdfa: '3b' }, einvoice: {} });
    out = [];
    await run(['validate'], ctx);
    // (what is left is the e-invoice check's own: the data set has no _invoice block)
    expect(out.join('\n')).not.toContain('pdfa-');
  });

  it('validate says of an image template that it never makes a PDF/A, without failing', async () => {
    writeReport({ pdf: { pdfa: '2b' } }, 'image');
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out.join('\n')).toContain('pdfa-image');
  });

  it('render sends the declaration with the document and prints the verdict', async () => {
    writeReport({ pdf: { pdfa: '2b' } });
    const { sent, fetch } = api(() => render(passed));
    expect(
      await run(['render', 'report'], withKey(fetch)),
      err.join('\n'),
    ).toBe(0);
    expect(sent[0]).toMatchObject({
      output: 'pdf',
      settings: { pdf: { pdfa: '2b' } },
    });
    expect(out).toEqual([
      'PDF/A-2b   conformant (veraPDF 1.30.2)',
      'rnd_1: 4 page(s), 0 unit(s) -> report.pdf',
    ]);
  });
});
