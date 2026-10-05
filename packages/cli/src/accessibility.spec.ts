import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type ProgramContext } from './commands';

/**
 * Accessible PDFs on the command line (plan 21): `validate` says what a template's source already
 * tells about a file that is to be PDF/UA-1, `render` prints the validator's verdict, and the dev
 * server checks the page it previews.
 */
describe('formfeed CLI: accessible PDFs (plan 21)', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let ctx: ProgramContext;

  const letterDir = () => join(dir, 'templates', 'letter');
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  function writeLetter(
    settings: Record<string, unknown>,
    html = '<h1>Bescheid</h1>\n<p>{{ text }}</p>',
    kind = 'pdf',
  ): void {
    mkdirSync(join(letterDir(), 'data'), { recursive: true });
    writeFileSync(
      join(letterDir(), 'template.json'),
      json({ name: 'Letter', kind, engine: 'jinja2' }),
    );
    writeFileSync(join(letterDir(), 'template.html'), html);
    writeFileSync(join(letterDir(), 'settings.json'), json(settings));
    writeFileSync(
      join(letterDir(), 'data', 'default.json'),
      json({ text: 'Sehr geehrte Frau Mustermann' }),
    );
  }

  const passed = {
    standard: 'PDF/UA-1',
    check: 'strict',
    conformant: true,
    validator: 'veraPDF 1.30.2',
    rules: { passed: 106, failed: 0 },
    failures: [],
    warnings: [
      { code: 'running-text', count: 1, elements: ['Fennlor Studio GmbH'] },
    ],
  };
  const failed = {
    ...passed,
    conformant: false,
    rules: { passed: 105, failed: 1 },
    failures: [
      {
        rule: '7.4.2-1',
        code: 'heading-order',
        count: 2,
        message:
          'This h3 follows an h1, so a heading level is skipped. Make it an h2 and size it with CSS.',
        elements: ['<h3>', '<h5>'],
      },
    ],
    warnings: [],
  };

  /** An API that answers every render with `answer`, and serves the file. */
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
  const render = (accessibility: unknown) =>
    new Response(
      JSON.stringify({
        id: 'rnd_1',
        status: 'succeeded',
        output: 'pdf',
        page_count: 1,
        units: 0,
        download_url: 'https://cdn.test/o/x.pdf',
        accessibility,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const withKey = (fetchImpl: typeof fetch): ProgramContext => ({
    ...ctx,
    env: { ...ctx.env, FORMFEED_API_KEY: 'ff_test_k' },
    fetch: fetchImpl,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-ua-'));
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

  it('validate accepts a template that declares pdf.ua and has a title and alternative texts', async () => {
    writeLetter(
      { pdf: { ua: true, metadata: { title: 'Bescheid' } } },
      '<h1>Bescheid</h1>\n<img src="logo.png" alt="Fennlor Studio">\n<img src="rule.png" alt="">',
    );
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out.at(-1)).toBe('1 template(s) valid');
  });

  it('validate names the image without alt at its line, and the missing title in settings.json', async () => {
    writeLetter(
      { pdf: { ua: true } },
      '<h1>Bescheid</h1>\n  <img src="{{ logo }}" class="logo">',
    );
    expect(await run(['validate'], ctx)).toBe(1);
    const image = out.find((l) => l.includes('template.html:2:3'));
    expect(image).toMatch(/^error {2}letter\/template\.html:2:3 /);
    expect(image).toContain('alt');
    expect(image).toContain('accessibility-image-alt');
    const title = out.find((l) => l.includes('settings.json'));
    expect(title).toContain('accessibility-document-title');
    expect(out.at(-1)).toBe('2 error(s)');

    // with `report` the render is delivered either way, so the same findings do not stop a pipeline
    writeFileSync(
      join(letterDir(), 'settings.json'),
      json({ pdf: { ua: { check: 'report' } } }),
    );
    out = [];
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(
      out.filter((l) => l.startsWith('warn') && l.includes('accessibility-')),
    ).toHaveLength(2);
  });

  it('validate says nothing of a template that does not declare it', async () => {
    writeLetter({}, '<h1>Bescheid</h1><img src="logo.png">');
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out).toEqual(['1 template(s) valid']);
  });

  it('validate refuses a declaration the API refuses', async () => {
    writeLetter({
      pdf: { ua: true, metadata: { title: 'Rechnung' } },
      einvoice: {},
    });
    // (the e-invoice check reports the missing _invoice block of the data set as well)
    expect(await run(['validate'], ctx)).toBe(1);
    expect(out.join('\n')).toContain('accessibility-einvoice');

    writeLetter({ pdf: { ua: 'yes', metadata: { title: 'Bescheid' } } });
    out = [];
    expect(await run(['validate'], ctx)).toBe(1);
    expect(out.join('\n')).toContain('accessibility-setting');

    // an image is never a PDF/UA file: said, but nothing fails for it
    writeLetter({ pdf: { ua: true } }, '<h1>Karte</h1>', 'image');
    out = [];
    expect(await run(['validate'], ctx), out.join('\n')).toBe(0);
    expect(out.join('\n')).toContain('accessibility-image');
  });

  it('render sends the declaration with the document and prints the verdict', async () => {
    writeLetter({ pdf: { ua: true, metadata: { title: 'Bescheid' } } });
    const { sent, fetch } = api(() => render(passed));
    expect(
      await run(['render', 'letter'], withKey(fetch)),
      err.join('\n'),
    ).toBe(0);
    expect(sent[0]).toMatchObject({
      output: 'pdf',
      settings: { pdf: { ua: true, metadata: { title: 'Bescheid' } } },
    });
    expect(out).toEqual([
      'PDF/UA-1   conformant, 106 rule(s) passed (veraPDF 1.30.2)',
      '  warn     Only in the header or footer: Fennlor Studio GmbH',
      'rnd_1: 1 page(s), 0 unit(s) -> letter.pdf',
    ]);
  });

  it('render prints the failed rules of a file that was delivered with report', async () => {
    writeLetter({
      pdf: { ua: { check: 'report' }, metadata: { title: 'Bescheid' } },
    });
    const { fetch } = api(() => render({ ...failed, check: 'report' }));
    expect(
      await run(['render', 'letter'], withKey(fetch)),
      err.join('\n'),
    ).toBe(0);
    expect(out).toEqual([
      'PDF/UA-1   not conformant, 1 of 106 rule(s) failed (veraPDF 1.30.2)',
      '  error    7.4.2-1: This h3 follows an h1, so a heading level is skipped. Make it an h2 and size it with CSS.',
      '           <h3>',
      '           <h5>',
      '  the file does not carry the PDF/UA identifier',
      'rnd_1: 1 page(s), 0 unit(s) -> letter.pdf',
    ]);
  });

  it('render reports a strict failure as a finding about the template, with exit code 1', async () => {
    writeLetter({ pdf: { ua: true, metadata: { title: 'Bescheid' } } });
    const { fetch } = api(
      () =>
        new Response(
          JSON.stringify({
            type: 'https://docs.formfeed.dev/errors/pdfua-validation-failed',
            title: 'PDF/UA validation failed',
            status: 422,
            code: 'pdfua_validation_failed',
            detail: 'The PDF fails 1 rule of PDF/UA-1',
            render_id: 'rnd_1',
            accessibility: failed,
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    );
    expect(await run(['render', 'letter'], withKey(fetch))).toBe(1);
    const said = err.join('\n');
    expect(said).toContain(
      'PDF/UA-1   not conformant, 1 of 106 rule(s) failed (veraPDF 1.30.2)',
    );
    expect(said).toContain('7.4.2-1: This h3 follows an h1');
    expect(said).toContain('<h5>');
    expect(said).toContain('letter: no file, because pdf.ua is strict');
    expect(out).toEqual([]);
  });

  it('the dev server checks the page it previews, words the findings and shows the verdict of a true render', async () => {
    writeLetter(
      { pdf: { ua: true, metadata: { title: 'Bescheid' } } },
      '<h1>Bescheid</h1><h3>Begründung</h3>',
    );
    const { fetch: fetchImpl } = api(() => render(passed));
    let server: { url: string; close(): Promise<void> } | null = null;
    expect(
      await run(['dev', 'letter', '--port', '0'], {
        ...withKey(fetchImpl),
        onServer: (s) => (server = s),
      }),
    ).toBe(0);
    const base = server!.url;
    try {
      // the frame runs the template check and posts what it finds
      for (const mode of ['flow', 'paged']) {
        const preview = await (
          await fetch(`${base}/preview?mode=${mode}`)
        ).text();
        expect(preview, mode).toContain('formfeedRunAudit');
        expect(preview, mode).toContain('formfeed:audit');
      }
      // and the server words it, taking nothing from the page but codes and values it knows
      const lines = await (
        await fetch(`${base}/api/audit`, {
          method: 'POST',
          body: JSON.stringify({
            findings: [
              {
                code: 'heading-order',
                severity: 'warning',
                src: null,
                snippet: '<h3>',
                args: { level: 3, previous: 1 },
              },
              { code: 'made-up', snippet: '<script>' },
              'nonsense',
            ],
          }),
        })
      ).json();
      expect(lines).toEqual([
        {
          severity: 'error',
          code: 'heading-order',
          message:
            'This h3 follows an h1, so a heading level is skipped. Make it an h2 and size it with CSS.',
          snippet: '<h3>',
        },
      ]);
      const rendered = (await (
        await fetch(`${base}/api/render`, { method: 'POST', body: '{}' })
      ).json()) as { accessibility_lines: string[] };
      expect(rendered.accessibility_lines[0]).toBe(
        'PDF/UA-1   conformant, 106 rule(s) passed (veraPDF 1.30.2)',
      );
    } finally {
      await server!.close();
    }
  });

  it('the dev server leaves a template that does not declare it alone', async () => {
    writeLetter({});
    let server: { url: string; close(): Promise<void> } | null = null;
    expect(
      await run(['dev', 'letter', '--port', '0'], {
        ...ctx,
        onServer: (s) => (server = s),
      }),
    ).toBe(0);
    try {
      const preview = await (
        await fetch(`${server!.url}/preview?mode=flow`)
      ).text();
      expect(preview).not.toContain('formfeedRunAudit');
    } finally {
      await server!.close();
    }
  });
});
