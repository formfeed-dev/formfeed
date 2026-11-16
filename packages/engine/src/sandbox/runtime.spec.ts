import { createContext, runInContext, type Context } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineIds } from '../lib/engines';
import { helperDocs } from '../lib/helpers';
import { starterDocument } from '../lib/office/starter';
import { starterPresentation } from '../lib/office/starter-pptx';
import {
  SANDBOX_PROTOCOL,
  type SandboxContext,
  type SandboxRequest,
  type SandboxResponse,
} from '../lib/sandbox/protocol';
import { parseSandboxResponse } from '../lib/sandbox/response';
import { runSandbox } from '../lib/sandbox/run';

/**
 * The template sandbox's runtime as the isolate and the editor's frame load it (plan 27 §5.1, step
 * 2), run here in a realm of its own that has nothing but the language: no Node, no browser, no
 * `TextEncoder`, `atob` or timers, as a bare V8 isolate. It must answer every request exactly as
 * the same code does in process, which is what the hosts fall back to (`ENGINE_SANDBOX=process`).
 * The render-worker's `engine-sandbox.spec.ts` does the same with the real isolate over every
 * example of the site.
 */

let realm: Context;

beforeAll(async () => {
  const { buildSandboxRuntime } =
    (await import('../../scripts/build-sandbox.mjs')) as {
      buildSandboxRuntime(options?: { minify?: boolean }): Promise<string>;
    };
  const source = await buildSandboxRuntime();
  realm = createContext({});
  runInContext(source, realm, { filename: 'formfeed-sandbox.js' });
}, 60_000);

/**
 * A request through the bundle in the bare realm, as a copy made there (an isolate gets its own
 * objects too: a `Uint8Array` of this realm is no `Uint8Array` of that one), and its answer copied
 * back into this realm as a host gets it.
 */
async function inRealm(request: SandboxRequest): Promise<SandboxResponse> {
  realm.requestJson = JSON.stringify(request, (_, value: unknown) =>
    value instanceof Uint8Array ? { __bytes: [...value] } : value,
  );
  const answer = await runInContext(
    `formfeedSandbox.run(JSON.parse(requestJson, (_, v) => v && Array.isArray(v.__bytes) ? new Uint8Array(v.__bytes) : v))`,
    realm,
  );
  return structuredClone(answer) as SandboxResponse;
}

const seed = () =>
  Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);

const context: SandboxContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  assetBaseUrl: 'https://cdn.example.test/a/ws',
  i18n: { 'de-DE': { 'invoice.title': 'Rechnung {number}' } },
};

/** The data the helper reference's examples draw on (`helper-examples.spec.ts` has the same shape). */
const data = {
  line: { total: 1234.5, qty: 8, price: 120, sku: 'A-100' },
  qty: 1234,
  total: 243,
  discount: 20,
  count: 4,
  name: 'erika mustermann',
  description: 'Beratung, Konzeption und Umsetzung der neuen Dokumentstrecke',
  iban: 'DE36 0000 0000 0000 0000 00',
  keywords: 'pdf,invoice,eu',
  tags: ['pdf', 'invoice', 'eu'],
  address: 'Musterstraße 1\n12345 Musterstadt',
  notes: 'Zahlbar **ohne Abzug**.',
  html_snippet: '<strong>Kopie</strong>',
  country: 'DE',
  scores: [4.5, 3.75, 5],
  prices: [120, 110, 95],
  labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
  customer: { vat: '', vatId: 'DE000000000' },
  company: { name: 'Fennlor Studio GmbH', iban: 'DE36000000000000000000' },
  order: { url: 'https://example.test/orders/1' },
  item: { sku: 'A-100' },
  product: { photo: 'https://example.test/photo.png' },
  sales: { labels: ['Q1', 'Q2', 'Q3'], quarters: [12, 18, 15] },
  lines: [
    { sku: 'A-100', position: 2, taxable: true, category: 'Beratung' },
    { sku: 'B-200', position: 1, taxable: false, category: 'Lizenz' },
  ],
  invoice: {
    number: '2026-0042',
    date: '2026-09-07',
    total: 1500,
    paid: false,
    credited: true,
    lines: [
      { sku: 'A-100', total: 960 },
      { sku: 'B-200', total: 540 },
    ],
  },
};

describe('the template sandbox runtime', () => {
  it('runs in a realm without Node or the browser and names its protocol', () => {
    expect(
      runInContext('typeof process + typeof require + typeof Buffer', realm),
    ).toBe('undefinedundefinedundefined');
    expect(runInContext('formfeedSandbox.protocol', realm)).toBe(
      SANDBOX_PROTOCOL,
    );
    expect(runInContext('Object.isFrozen(formfeedSandbox)', realm)).toBe(true);
  });

  for (const engine of engineIds)
    it(`renders every helper example of ${engine} as it does in process`, async () => {
      for (const doc of helperDocs()) {
        const request: SandboxRequest = {
          op: 'version',
          version: {
            engine,
            html: `<p>${doc.examples[engine]}</p>`,
            settings: {
              locale: 'de-DE',
              timezone: 'Europe/Berlin',
              currency: 'EUR',
            },
          },
          data,
          context,
          seed: seed(),
        };
        const [local, sandboxed] = await Promise.all([
          runSandbox(request),
          inRealm(request),
        ]);
        expect(sandboxed, `${doc.name} in ${engine}`).toEqual(local);
        expect(local.ok, `${doc.name} in ${engine}`).toBe(true);
      }
    });

  it('renders header, footer, metadata and partials, and names the shared partials it read', async () => {
    const request: SandboxRequest = {
      op: 'version',
      version: {
        engine: 'jinja2',
        html: '{% include "greeting" %} {% include "Signature.html" %}',
        settings: {
          header: { html: '<span>{{ company.name }}</span>' },
          footer: { html: 'Seite <span class="pageNumber"></span>' },
          pdf: {
            metadata: {
              title: 'Rechnung {{ invoice.number }}',
              author: '{{ company.name }}',
            },
          },
        },
      },
      data,
      context: {
        ...context,
        partials: { greeting: 'Hallo {{ name | title }}' },
        shared: {
          signature: { source: '— {{ company.name }}', version: 3 },
          unused: { source: 'x', version: 1 },
        },
      },
      seed: seed(),
    };
    const [local, sandboxed] = await Promise.all([
      runSandbox(request),
      inRealm(request),
    ]);
    expect(sandboxed).toEqual(local);
    expect(local).toMatchObject({
      ok: true,
      op: 'version',
      parts: {
        html: 'Hallo Erika Mustermann — Fennlor Studio GmbH',
        headerHtml: '<span>Fennlor Studio GmbH</span>',
        title: 'Rechnung 2026-0042',
        author: 'Fennlor Studio GmbH',
      },
      shared: ['signature'],
    });
  });

  it('keeps the helpers’ HTML of a Markdown render behind the nonce the seed gives', async () => {
    const request: SandboxRequest = {
      op: 'markdown',
      source: {
        markdown:
          '# {{ invoice.number }}\n\n{{ notes | markdown }}\n\n{{ qrcode("hi") }}',
        engine: 'jinja2',
      },
      data,
      context,
      seed: seed(),
    };
    const [local, sandboxed] = await Promise.all([
      runSandbox(request),
      inRealm(request),
    ]);
    expect(sandboxed).toEqual(local);
    if (!local.ok || local.op !== 'markdown') throw new Error('no parts');
    expect(local.parts.kept?.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(local.parts.kept?.html.length).toBeGreaterThan(0);
    // another seed, another nonce: the data never sees it
    const other = await runSandbox({
      ...request,
      seed: new Uint8Array(32).fill(7),
    });
    if (!other.ok || other.op !== 'markdown') throw new Error('no parts');
    expect(other.parts.kept?.nonce).not.toBe(local.parts.kept?.nonce);
  });

  for (const [format, starter] of [
    ['docx', starterDocument],
    ['pptx', starterPresentation],
  ] as const)
    it(`fills the ${format} starter as it does in process`, async () => {
      const { bytes, sampleData } = starter('jinja2');
      const request: SandboxRequest = {
        op: 'office',
        file: bytes,
        engine: 'jinja2',
        data: sampleData,
        context,
        seed: seed(),
      };
      const [local, sandboxed] = await Promise.all([
        runSandbox(request),
        inRealm(request),
      ]);
      expect(sandboxed).toEqual(local);
      expect(local).toMatchObject({ ok: true, op: 'office', format });
    });

  it('answers a failure as data, the same in both places', async () => {
    const failures: Array<[SandboxRequest['op'], SandboxRequest]> = [
      [
        'version',
        {
          op: 'version',
          version: { engine: 'jinja2', html: '{% for x in %}' },
          data,
          context,
          seed: seed(),
        },
      ],
      [
        'version',
        {
          op: 'version',
          version: { engine: 'jinja2', html: '{{ nope() }}' },
          data,
          context,
          seed: seed(),
        },
      ],
      [
        'version',
        {
          op: 'version',
          version: { engine: 'handlebars', html: '{{#each}}' },
          data,
          context,
          seed: seed(),
        },
      ],
      [
        'version',
        {
          op: 'version',
          version: {
            engine: 'jinja2',
            html: '{% for i in range(0, 100000) %}{% for j in range(0, 100000) %}{% endfor %}{% endfor %}',
          },
          data,
          context: { ...context, limits: { ms: 50 } },
          seed: seed(),
        },
      ],
      [
        'office',
        {
          op: 'office',
          file: new Uint8Array([1, 2, 3]),
          engine: 'jinja2',
          data,
          context,
          seed: seed(),
        },
      ],
    ];
    const kinds: string[] = [];
    for (const [, request] of failures) {
      const [local, sandboxed] = await Promise.all([
        runSandbox(request),
        inRealm(request),
      ]);
      if (local.ok || sandboxed.ok) throw new Error('rendered');
      expect(sandboxed.error.kind).toBe(local.error.kind);
      kinds.push(local.error.kind);
    }
    expect(kinds).toEqual(['syntax', 'runtime', 'syntax', 'limit', 'office']);
  });

  it('answers in the shape the host reads', async () => {
    const answer = await inRealm({
      op: 'version',
      version: { engine: 'handlebars', html: '{{name}}' },
      data,
      context,
      seed: seed(),
    });
    expect(parseSandboxResponse(answer)).toEqual(answer);
    expect(() => parseSandboxResponse({ ...answer, extra: true })).toThrow(
      /shape/,
    );
    expect(() =>
      parseSandboxResponse({
        ok: false,
        error: { kind: 'error', message: 'x'.repeat(5000) },
      }),
    ).toThrow(/shape/);
  });

  it('refuses a request without a seed', async () => {
    const answer = await runSandbox({
      op: 'version',
      version: { engine: 'jinja2', html: 'x' },
      data,
      context,
      seed: new Uint8Array(4),
    });
    expect(answer).toMatchObject({ ok: false, error: { kind: 'error' } });
  });
});
