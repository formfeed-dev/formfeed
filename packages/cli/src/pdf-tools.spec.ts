import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type ProgramContext } from './commands';

// `formfeed pdf split|compress|to-image|redact|fill|info` (plan 30 step 6): a PDF on this machine goes
// as an upload, a render or library file by its id; the result is downloaded under the API's name.

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
const RESULT = new Uint8Array([1, 2, 3]);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const form = {
  type: 'acroform',
  signed: false,
  fields: [
    {
      name: 'customer.name',
      label: 'Name',
      type: 'text',
      value: 'Max Mustermann',
      options: null,
      required: true,
      readonly: false,
      calculated: false,
      format: null,
      pages: [1],
    },
    {
      name: 'size',
      label: null,
      type: 'radio',
      value: null,
      options: ['S', 'M', 'L'],
      required: false,
      readonly: false,
      calculated: false,
      format: null,
      pages: [1],
    },
  ],
};

function fakeApi(
  answer: (call: Call) => Response | undefined = () => undefined,
) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const result = (
    id: string,
    output: string,
    name: string,
    extra: Record<string, unknown> = {},
  ) =>
    json({
      id,
      status: 'succeeded',
      output,
      page_count: output === 'pdf' ? 2 : null,
      units: 0.5,
      download_url: `https://cdn.test/o/eu/ws/2026/11/${id}/${encodeURIComponent(name)}?exp=1&sig=2`,
      form: null,
      ...extra,
    });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      body:
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? JSON.parse(String(init.body))
            : undefined,
    };
    calls.push(call);
    if (url.hostname === 'cdn.test')
      return new Response(RESULT, { status: 200 });
    const own = answer(call);
    if (own) return own;
    if (call.path === '/v1/pdf/split')
      return result('rnd_zip', 'zip', 'contract.zip');
    if (call.path === '/v1/pdf/compress')
      return result('rnd_small', 'pdf', 'contract.pdf');
    if (call.path === '/v1/pdf/to-image')
      return result('rnd_png', 'png', 'contract-3.png', { units: 1 });
    if (call.path === '/v1/pdf/redact')
      return result('rnd_black', 'pdf', 'contract.pdf');
    if (call.path === '/v1/pdf/fill')
      return result('rnd_filled', 'pdf', 'form.pdf', {
        form: {
          filled: 1,
          skipped: [{ field: 'colour', reason: 'unknown' }],
          warnings: [{ field: 'total', code: 'calculation_not_run' }],
          xfa_removed: false,
        },
      });
    if (call.path === '/v1/pdf/info')
      return json({
        source: 'form.pdf',
        page_count: 1,
        pages: [
          {
            width_pt: 595.28,
            height_pt: 841.89,
            width_mm: 210,
            height_mm: 297,
          },
        ],
        encrypted: false,
        metadata: {
          title: 'Antrag',
          author: null,
          subject: null,
          producer: null,
          creator: null,
        },
        form,
      });
    return json({ code: 'not_found', title: 'Not found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('formfeed pdf: the PDF tools of plan 30', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let api: ReturnType<typeof fakeApi>;
  let ctx: ProgramContext;
  const posts = (path: string) =>
    api.calls.filter((c) => c.method === 'POST' && c.path === path);
  const setUp = (answer?: (call: Call) => Response | undefined) => {
    api = fakeApi(answer);
    ctx = {
      cwd: dir,
      env: {
        FORMFEED_CONFIG_DIR: join(dir, 'user'),
        FORMFEED_API_KEY: 'ff_test_k',
      },
      fetch: api.fetchImpl,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-pdf-tools-'));
    out = [];
    err = [];
    setUp();
    writeFileSync(join(dir, 'contract.pdf'), PDF);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('split uploads a local PDF with its ranges and saves the ZIP under the name the API gave it', async () => {
    expect(
      await run(
        ['pdf', 'split', 'contract.pdf', '--range', '1', '--range', '2-'],
        ctx,
      ),
      err.join('\n'),
    ).toBe(0);
    const body = posts('/v1/pdf/split')[0]!.body as FormData;
    expect((body.get('file') as File).name).toBe('contract.pdf');
    expect(
      new Uint8Array(await (body.get('file') as File).arrayBuffer()),
    ).toEqual(PDF);
    expect(body.get('ranges')).toBe('["1","2-"]');
    expect(body.get('meta')).toBe('{"source":"formfeed pdf split"}');
    expect(new Uint8Array(readFileSync(join(dir, 'contract.zip')))).toEqual(
      RESULT,
    );
    expect(out.join('\n')).toContain(
      'rnd_zip: a ZIP, 0.5 unit(s) -> contract.zip',
    );

    expect(
      await run(
        ['pdf', 'split', 'rnd_abc', '--every', '2', '--out', 'parts/all.zip'],
        ctx,
      ),
    ).toBe(0);
    expect(posts('/v1/pdf/split')[1]!.body).toMatchObject({
      source: 'rnd_abc',
      every: 2,
    });
    expect(existsSync(join(dir, 'parts', 'all.zip'))).toBe(true);

    expect(await run(['pdf', 'split', 'contract.pdf'], ctx)).toBe(2);
    expect(
      await run(
        ['pdf', 'split', 'contract.pdf', '--every', '2', '--range', '1'],
        ctx,
      ),
    ).toBe(2);
    expect(
      await run(['pdf', 'split', 'contract.pdf', '--range', 'first'], ctx),
    ).toBe(2);
    expect(
      await run(['pdf', 'split', 'contract.pdf', '--every', '0'], ctx),
    ).toBe(2);
  });

  it('compress names its result after what it did, so the source is never replaced', async () => {
    expect(
      await run(['pdf', 'compress', 'contract.pdf'], ctx),
      err.join('\n'),
    ).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, 'contract.pdf')))).toEqual(
      PDF,
    );
    expect(
      new Uint8Array(readFileSync(join(dir, 'contract-compressed.pdf'))),
    ).toEqual(RESULT);
    expect(out.join('\n')).toContain(
      'rnd_small: 2 page(s), 0.5 unit(s) -> contract-compressed.pdf',
    );

    // a library file by id, without downloading
    out = [];
    expect(
      await run(
        ['pdf', 'compress', 'fil_terms', '--no-download', '--json'],
        ctx,
      ),
    ).toBe(0);
    expect(posts('/v1/pdf/compress')[1]!.body).toEqual({
      source: 'fil_terms',
      meta: { source: 'formfeed pdf compress' },
    });
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      id: 'rnd_small',
      output: 'pdf',
    });
    expect(await run(['pdf', 'compress', 'missing.pdf'], ctx)).toBe(2);
  });

  it('to-image draws the pages asked for and saves the picture by its page', async () => {
    expect(
      await run(
        [
          'pdf',
          'to-image',
          'contract.pdf',
          '--pages',
          '3',
          '--dpi',
          '72',
          '--format',
          'png',
        ],
        ctx,
      ),
      err.join('\n'),
    ).toBe(0);
    const body = posts('/v1/pdf/to-image')[0]!.body as FormData;
    expect(body.get('pages')).toBe('3');
    expect(body.get('dpi')).toBe('72');
    expect(body.get('quality')).toBeNull();
    expect(existsSync(join(dir, 'contract-3.png'))).toBe(true);
    expect(out.join('\n')).toContain(
      'rnd_png: a PNG picture, 1 unit(s) -> contract-3.png',
    );
    expect(
      await run(['pdf', 'to-image', 'contract.pdf', '--dpi', '600'], ctx),
    ).toBe(2);
    expect(
      await run(['pdf', 'to-image', 'contract.pdf', '--format', 'gif'], ctx),
    ).toBe(2);
  });

  it('redact sends rectangles and texts, draws no box with --no-fill, and a text left behind is exit code 1', async () => {
    expect(
      await run(
        [
          'pdf',
          'redact',
          'contract.pdf',
          '--rect',
          '1:52,88,200,16',
          '--text',
          'Max Mustermann',
          '--text',
          'DE36 0000 0000 0000 0000 00',
          '--whole-words',
          '--no-fill',
        ],
        ctx,
      ),
      err.join('\n'),
    ).toBe(0);
    const body = posts('/v1/pdf/redact')[0]!.body as FormData;
    expect(JSON.parse(String(body.get('regions')))).toEqual([
      { page: 1, x: 52, y: 88, width: 200, height: 16 },
    ]);
    expect(JSON.parse(String(body.get('text')))).toEqual([
      'Max Mustermann',
      'DE36 0000 0000 0000 0000 00',
    ]);
    expect(body.get('whole_words')).toBe('true');
    expect(body.get('match_case')).toBeNull();
    expect(body.get('fill')).toBe('null');
    expect(existsSync(join(dir, 'contract-redacted.pdf'))).toBe(true);

    expect(
      await run(
        [
          'pdf',
          'redact',
          'rnd_abc',
          '--text',
          'Erika',
          '--fill',
          '#ffffff',
          '--no-download',
        ],
        ctx,
      ),
    ).toBe(0);
    expect(posts('/v1/pdf/redact')[1]!.body).toMatchObject({
      source: 'rnd_abc',
      text: ['Erika'],
      fill: '#ffffff',
    });

    expect(await run(['pdf', 'redact', 'contract.pdf'], ctx)).toBe(2);
    expect(
      await run(['pdf', 'redact', 'contract.pdf', '--rect', '1:52,88'], ctx),
    ).toBe(2);
    expect(
      await run(
        ['pdf', 'redact', 'contract.pdf', '--text', 'x', '--fill', 'black'],
        ctx,
      ),
    ).toBe(2);

    setUp((call) =>
      call.path === '/v1/pdf/redact'
        ? new Response(
            JSON.stringify({
              code: 'redaction_incomplete',
              status: 422,
              detail: 'Text 1 can still be found on page 2',
              texts: [1],
              pages: [2],
            }),
            {
              status: 422,
              headers: { 'content-type': 'application/problem+json' },
            },
          )
        : undefined,
    );
    err = [];
    expect(
      await run(
        ['pdf', 'redact', 'contract.pdf', '--text', 'Max Mustermann'],
        ctx,
      ),
    ).toBe(1);
    expect(err.join('\n')).toContain('Text 1 can still be found on page 2');
  });

  it('fill takes values from --data and --field, and says what it left out and what no viewer ran', async () => {
    writeFileSync(join(dir, 'form.pdf'), PDF);
    writeFileSync(
      join(dir, 'values.json'),
      JSON.stringify({
        'customer.name': 'Erika Mustermann',
        tags: ['a', 'b'],
        colour: 'blue',
      }),
    );
    expect(
      await run(
        [
          'pdf',
          'fill',
          'form.pdf',
          '--data',
          'values.json',
          '--field',
          'customer.name=Max Mustermann',
          '--field',
          'newsletter=true',
          '--flatten',
          '--lenient',
        ],
        ctx,
      ),
      err.join('\n'),
    ).toBe(0);
    const body = posts('/v1/pdf/fill')[0]!.body as FormData;
    expect(JSON.parse(String(body.get('fields')))).toEqual({
      'customer.name': 'Max Mustermann',
      tags: ['a', 'b'],
      colour: 'blue',
      newsletter: true,
    });
    expect(body.get('flatten')).toBe('true');
    expect(body.get('strict')).toBe('false');
    expect(existsSync(join(dir, 'form-filled.pdf'))).toBe(true);
    const shown = out.join('\n');
    expect(shown).toContain('filled 1 field(s)');
    expect(shown).toContain(
      'skip   colour: the form has no field of this name',
    );
    expect(shown).toContain(
      'warn   total: its value comes from a calculation, which did not run',
    );

    expect(await run(['pdf', 'fill', 'form.pdf'], ctx)).toBe(2);
    expect(
      await run(['pdf', 'fill', 'form.pdf', '--field', 'novalue'], ctx),
    ).toBe(2);
    writeFileSync(
      join(dir, 'bad.json'),
      JSON.stringify({ total: { amount: 1 } }),
    );
    expect(
      await run(['pdf', 'fill', 'form.pdf', '--data', 'bad.json'], ctx),
    ).toBe(2);
    // flatten alone takes no values
    expect(
      await run(['pdf', 'fill', 'rnd_abc', '--flatten', '--no-download'], ctx),
    ).toBe(0);
    expect(posts('/v1/pdf/fill')[1]!.body).toEqual({
      source: 'rnd_abc',
      flatten: true,
      meta: { source: 'formfeed pdf fill' },
    });
  });

  it('info lists pages, metadata and the form fields with their options, and uploads a local file', async () => {
    writeFileSync(join(dir, 'form.pdf'), PDF);
    expect(await run(['pdf', 'info', 'form.pdf'], ctx), err.join('\n')).toBe(0);
    const body = posts('/v1/pdf/info')[0]!.body as FormData;
    expect((body.get('file') as File).name).toBe('form.pdf');
    const shown = out.join('\n');
    expect(shown).toContain('form.pdf: 1 page(s), 210 x 297 mm');
    expect(shown).toContain('title     Antrag');
    expect(shown).toContain('form      acroform, 2 field(s)');
    expect(shown).toMatch(
      /customer\.name\s+text\s+"Max Mustermann"\s+\(required; label: Name\)/,
    );
    expect(shown).toMatch(/size\s+radio\s+-\s+\(options: S, M, L\)/);

    out = [];
    expect(await run(['pdf', 'info', 'fil_form', '--json'], ctx)).toBe(0);
    expect(posts('/v1/pdf/info')[1]!.body).toEqual({ source: 'fil_form' });
    expect(JSON.parse(out.join('\n')).form.fields).toHaveLength(2);
  });
});
