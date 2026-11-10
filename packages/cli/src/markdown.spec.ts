import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type ProgramContext } from './commands';

// `formfeed pdf convert notes.md` (plan 29, decision 10): a Markdown file is a Markdown render on
// every plan, its pictures inside its folder sent along as data URIs.

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(render: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    if (url.hostname === 'cdn.test') return new Response(PDF, { status: 200 });
    if (url.pathname === '/v1/renders' && init?.method === 'POST')
      return json({
        id: 'rnd_md',
        status: 'succeeded',
        output: 'pdf',
        page_count: 2,
        units: 1,
        download_url: 'https://cdn.test/o/notes.pdf',
        accessibility: null,
        pdfa: null,
        ...render,
      });
    return json({ code: 'not_found', title: 'Not found', status: 404 }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('formfeed pdf convert: Markdown', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let api: ReturnType<typeof fakeApi>;
  let ctx: ProgramContext;
  const renders = () =>
    api.calls.filter((c) => c.method === 'POST' && c.path === '/v1/renders');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'formfeed-markdown-'));
    out = [];
    err = [];
    api = fakeApi();
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
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renders the file with its pictures and the options folded into settings', async () => {
    mkdirSync(join(dir, 'docs', 'img'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'img', 'logo.png'), PNG);
    writeFileSync(join(dir, 'docs', 'look.css'), 'h1 { color: teal }');
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ pdf: { outline: true }, markdown: { breaks: true } }),
    );
    writeFileSync(
      join(dir, 'docs', 'notes.md'),
      '\uFEFF# Notes\n\n![Logo](img/logo.png) ![Seal](seal.png)\n',
    );
    const code = await run(
      [
        'pdf',
        'convert',
        'docs/notes.md',
        '--theme',
        'none',
        '--css',
        'docs/look.css',
        '--settings',
        'settings.json',
        '--raw-html',
        '--landscape',
        '--page-ranges',
        '1-2',
      ],
      ctx,
    );
    expect(code, err.join('\n')).toBe(0);
    expect(renders()).toHaveLength(1);
    expect(renders()[0]!.body).toEqual({
      markdown:
        '# Notes\n\n![Logo](data:image/png;base64,iVBORw==) ![Seal](seal.png)\n',
      settings: {
        pdf: { outline: true },
        markdown: {
          breaks: true,
          theme: 'none',
          css: 'h1 { color: teal }',
          html: 'allow',
        },
        paper: { landscape: true },
        pageRanges: '1-2',
      },
      output: 'pdf',
      filename: 'notes.pdf',
      meta: { source: 'formfeed pdf convert' },
    });
    // no office upload, and the file next to where the command ran
    expect(api.calls.some((c) => c.path === '/v1/pdf/convert')).toBe(false);
    expect(new Uint8Array(readFileSync(join(dir, 'notes.pdf')))).toEqual(PDF);
    expect(out.join('\n')).toContain('picture img/logo.png sent along');
    expect(out.join('\n')).toContain(
      'picture seal.png named in the file library',
    );
  });

  it('sends a plain file with no settings at all', async () => {
    writeFileSync(join(dir, 'README.md'), '# Hello');
    expect(
      await run(
        ['pdf', 'convert', 'README.md', '--no-download', '--json'],
        ctx,
      ),
    ).toBe(0);
    expect(renders()[0]!.body).toEqual({
      markdown: '# Hello',
      output: 'pdf',
      filename: 'README.pdf',
      meta: { source: 'formfeed pdf convert' },
    });
    expect(existsSync(join(dir, 'README.pdf'))).toBe(false);
  });

  it('refuses what the API would refuse, before sending anything', async () => {
    writeFileSync(join(dir, 'secret.png'), PNG);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'up.md'), '![x](../secret.png)');
    writeFileSync(join(dir, 'docs', 'big.md'), '![x](big.png)');
    writeFileSync(join(dir, 'docs', 'big.png'), new Uint8Array(800 * 1024));
    writeFileSync(join(dir, 'notes.md'), '# A');
    writeFileSync(join(dir, 'report.docx'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dir, 'bad.json'), '{"markdown": {"theme": "dark"}}');

    const refused = async (args: string[], message: string) => {
      err = [];
      expect(await run(['pdf', 'convert', ...args], ctx)).toBe(2);
      expect(err.join('\n')).toContain(message);
    };
    await refused(['docs/up.md'], "lies outside the document's folder");
    await refused(
      ['docs/big.md'],
      'more than the 1 MB a Markdown render takes',
    );
    await refused(
      ['notes.md', '--theme', 'dark'],
      '--theme is one of document, none',
    );
    await refused(
      ['notes.md', '--settings', 'bad.json'],
      'settings.markdown.theme must be one of document, none',
    );
    await refused(
      ['notes.md', '--single-page-sheets'],
      'applies to spreadsheets',
    );
    await refused(
      ['report.docx', '--theme', 'none'],
      '--theme applies to a Markdown file',
    );
    expect(renders()).toHaveLength(0);
  });

  it('reports a strict PDF/UA verdict as a finding about the document', async () => {
    api = fakeApi({
      status: 'failed',
      download_url: null,
      error: { code: 'pdfua_validation_failed', message: 'failed' },
      accessibility: {
        standard: 'PDF/UA-1',
        check: 'strict',
        conformant: false,
        validator: 'veraPDF 1.30.2',
        rules: { passed: 10, failed: 1 },
        failures: [
          { rule: '7.1-3', message: 'Content is neither marked', elements: [] },
        ],
        warnings: [],
        truncated: false,
      },
    });
    ctx = { ...ctx, fetch: api.fetchImpl };
    writeFileSync(join(dir, 'notes.md'), '# A');
    expect(await run(['pdf', 'convert', 'notes.md'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('PDF/UA-1   not conformant');
    expect(err.join('\n')).toContain('notes.md: no file');
  });
});
