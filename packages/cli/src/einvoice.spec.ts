import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoiceSkeleton } from '@formfeed/engine';
import { run, type ProgramContext } from './commands';

/**
 * E-invoices on the command line (spec 17 §8): `validate` holds every data set of an invoice
 * template to the rules a render is held to, and `einvoice` writes the XML, both offline.
 */
describe('formfeed CLI: e-invoices (spec 17)', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;

  const invoiceDir = () => join(dir, 'templates', 'invoice');
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  /** An invoice template whose settings declare an e-invoice, with one complete data set. */
  function writeInvoiceTemplate(settings: Record<string, unknown>): void {
    mkdirSync(join(invoiceDir(), 'data'), { recursive: true });
    writeFileSync(
      join(invoiceDir(), 'template.json'),
      json({ name: 'Invoice', kind: 'pdf', engine: 'jinja2' }),
    );
    writeFileSync(
      join(invoiceDir(), 'template.html'),
      '<h1>Rechnung {{ _invoice.number }}</h1><p>{{ _invoice.totals.grand }}</p>',
    );
    writeFileSync(join(invoiceDir(), 'settings.json'), json(settings));
    writeFileSync(
      join(invoiceDir(), 'data', 'default.json'),
      json({ _invoice: invoiceSkeleton('2026-09-10') }),
    );
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-einvoice-'));
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

  it('validate accepts a template whose data sets all make an e-invoice', async () => {
    writeInvoiceTemplate({ einvoice: { profile: 'en16931' } });
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out.at(-1)).toBe('1 template(s) valid');
  });

  it('validate names the data set, the place and the rule of a block that does not add up', async () => {
    writeInvoiceTemplate({ einvoice: {} });
    const broken = invoiceSkeleton('2026-09-10');
    broken.totals.due = 1000;
    writeFileSync(
      join(invoiceDir(), 'data', 'storno.json'),
      json({ _invoice: broken }),
    );
    expect(await run(['validate'], ctx)).toBe(1);
    const line = out.find((l) => l.includes('data/storno.json'));
    expect(line).toMatch(/^error {2}invoice\/data\/storno\.json:\d+:\d+ /);
    expect(line).toContain('_invoice.totals.due');
    expect(line).toContain('BR-CO-16');
    // the complete data set beside it is not reported
    expect(out.some((l) => l.includes('data/default.json'))).toBe(false);
    expect(out.at(-1)).toBe('1 error(s)');

    out = [];
    expect(await run(['validate', '--json'], ctx)).toBe(1);
    const report = JSON.parse(out.at(-1) ?? '{}') as {
      ok: boolean;
      errors: number;
      templates: Array<{ file: string }>;
    };
    expect(report).toMatchObject({ ok: false, errors: 1 });
    expect(report.templates.map((t) => t.file)).toContain('data/storno.json');
  });

  it('validate reports a data set without the block, and leaves other templates alone', async () => {
    writeInvoiceTemplate({ einvoice: {} });
    writeFileSync(
      join(invoiceDir(), 'data', 'empty.json'),
      json({ customer: { name: 'Olvarest GmbH' } }),
    );
    expect(await run(['validate'], ctx)).toBe(1);
    expect(out.join('\n')).toContain('no _invoice block');

    // no declaration, no check: the same data is fine for a template that makes plain PDFs
    writeFileSync(join(invoiceDir(), 'settings.json'), json({}));
    out = [];
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
  });

  it('validate refuses a profile that is not offered, in settings.json', async () => {
    writeInvoiceTemplate({ einvoice: { profile: 'minimum' } });
    expect(await run(['validate'], ctx)).toBe(1);
    const line = out.find((l) => l.includes('settings.json'));
    expect(line).toContain('MINIMUM');
    expect(line).toContain('basic or en16931');
  });

  it('einvoice writes the XML a render would embed and says what it wrote', async () => {
    writeInvoiceTemplate({ einvoice: { flavour: 'zugferd' } });
    expect(
      await run(['einvoice', 'invoice', '--out', 'out/rechnung.xml'], ctx),
      err.join('\n'),
    ).toBe(0);
    const xml = readFileSync(join(dir, 'out', 'rechnung.xml'), 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>');
    expect(xml).toContain('<ram:ID>RE-2026-0001</ram:ID>');
    expect(out[0]).toBe(
      'invoice: ZUGFeRD 2.5, EN 16931, RE-2026-0001, 1 line(s), 1142.40 EUR -> out/rechnung.xml',
    );

    // --profile wins over the settings, as `post.einvoice` does in a request
    out = [];
    expect(
      await run(['einvoice', 'invoice', '--profile', 'basic', '--json'], ctx),
    ).toBe(0);
    expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({
      profile: 'basic',
      flavour: 'zugferd',
      spec_version: '2.5',
      number: 'RE-2026-0001',
      lines: 1,
      total: '1142.40',
      currency: 'EUR',
    });
    expect(readFileSync(join(dir, 'invoice.xml'), 'utf8')).toContain(
      'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
    );
  });

  it('einvoice works on a template that declares nothing, with the defaults', async () => {
    writeInvoiceTemplate({});
    expect(await run(['einvoice', 'invoice'], ctx), err.join('\n')).toBe(0);
    expect(out[0]).toContain('Factur-X 1.09, EN 16931');
  });

  it('render sends what the settings declare with the invoice, and prints the report', async () => {
    writeInvoiceTemplate({
      einvoice: { flavour: 'zugferd', display_check: 'strict' },
    });
    const sent: Array<Record<string, unknown>> = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/files') return json({ data: [] });
      if (url.pathname === '/v1/renders' && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({
          id: 'rnd_1',
          status: 'succeeded',
          output: 'pdf',
          page_count: 1,
          units: 0,
          download_url: 'https://cdn.test/o/x.pdf',
          einvoice: {
            profile: 'en16931',
            flavour: 'zugferd',
            spec_version: '2.5',
            xml_url: null,
            validation: {
              valid: true,
              schematron: 'the rule set',
              pdfa: 'PDF/A-3b',
              messages: [],
            },
            display: {
              checked: ['BT-1', 'BT-109', 'BT-110', 'BT-112'],
              missing: ['BT-110'],
            },
          },
        });
      }
      if (url.host === 'cdn.test')
        return new Response(new Uint8Array([37, 80, 68, 70]));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    expect(
      await run(['render', 'invoice'], {
        ...ctx,
        env: { ...ctx.env, FORMFEED_API_KEY: 'ff_test_k' },
        fetch: fetchImpl,
      }),
      err.join('\n'),
    ).toBe(0);
    expect(sent).toHaveLength(1);
    // the document leaves as HTML, so the declaration and the block go along
    expect(sent[0]).toMatchObject({
      output: 'pdf',
      post: {
        einvoice: {
          profile: 'en16931',
          flavour: 'zugferd',
          xml: 'embedded',
          display_check: 'strict',
        },
      },
      data: { _invoice: { number: 'RE-2026-0001' } },
    });
    expect(sent[0]?.['html']).toContain('Rechnung RE-2026-0001');
    expect(out).toEqual([
      'e-invoice  ZUGFeRD, EN 16931, specification 2.5',
      '  valid    rules of the XML (the rule set), PDF/A-3b',
      '  shown    invoice number, net total, total',
      '  warn     not in the text of the PDF: VAT total',
      'rnd_1: 1 page(s), 0 unit(s) -> invoice.pdf',
    ]);
  });

  it('render sends no e-invoice for a template that declares none', async () => {
    writeInvoiceTemplate({});
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/renders' && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: 'rnd_2',
            status: 'succeeded',
            output: 'pdf',
            page_count: 1,
            units: 0,
            download_url: 'https://cdn.test/o/y.pdf',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.host === 'cdn.test')
        return new Response(new Uint8Array([37, 80, 68, 70]));
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    expect(
      await run(['render', 'invoice'], {
        ...ctx,
        env: { ...ctx.env, FORMFEED_API_KEY: 'ff_test_k' },
        fetch: fetchImpl,
      }),
    ).toBe(0);
    expect(sent[0]).not.toHaveProperty('post');
    expect(sent[0]).not.toHaveProperty('data');
    expect(out).toEqual(['rnd_2: 1 page(s), 0 unit(s) -> invoice.pdf']);
  });

  it('einvoice writes nothing for a block that breaks a rule, and lists what is wrong', async () => {
    writeInvoiceTemplate({ einvoice: {} });
    const broken = invoiceSkeleton('2026-09-10');
    broken.totals.grand = 1142.41;
    writeFileSync(
      join(invoiceDir(), 'data', 'default.json'),
      json({ _invoice: broken }),
    );
    expect(await run(['einvoice', 'invoice'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('does not make an e-invoice');
    expect(err.join('\n')).toContain('BR-CO-15');
    expect(() => readFileSync(join(dir, 'invoice.xml'))).toThrow();

    // a code that is not in its list is found before any sum is checked, and the code meant is named
    const coded = invoiceSkeleton('2026-09-10');
    coded.lines[0]!.unit_code = 'hours';
    writeFileSync(
      join(invoiceDir(), 'data', 'default.json'),
      json({ _invoice: coded }),
    );
    err = [];
    expect(await run(['einvoice', 'invoice'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('_invoice.lines[0].unit_code');
    expect(err.join('\n')).toContain('HUR');
  });
});
