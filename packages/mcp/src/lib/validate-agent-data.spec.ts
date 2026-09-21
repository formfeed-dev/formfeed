import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultHelpers, defaultLimits, renderVersion } from '@formfeed/engine';
import { createFormfeedServer } from './server';

/**
 * What `validate_template` catches offline in data an agent wrote, and what it does not — the blog
 * post `let-the-agent-write-the-data` quotes these results. With html plus engine nothing leaves the
 * process: the server's fetch throws, and nothing calls it. That check knows names, not values; a
 * stored template is checked by the API against its schema (server.spec.ts), and `money` stops a
 * render rather than print NaN.
 */
const template = `<table>
  {% for line in invoice.lines %}
  <tr><td>{{ line.description }}</td><td>{{ line.qty }}</td><td>{{ line.price | money }}</td><td>{{ line.total | money }}</td></tr>
  {% endfor %}
</table>
{% set net = invoice.lines | sum('total') %}
{% set vat = net * invoice.vat_rate / 100 %}
<p>Gesamt {{ (net + vat) | money }}</p>`;

const data = {
  invoice: {
    vat_rate: 19,
    lines: [
      { description: 'Consulting', qty: 8, price: 120, total: 960 },
      { description: 'Implementation', qty: 20, price: 110, total: 2200 },
    ],
  },
};

/** The same invoice as agents tend to get it wrong. */
const agentData = {
  // the template computes nothing per line; the agent expected it to
  noTotals: { invoice: { ...data.invoice, lines: data.invoice.lines.map(({ total: _, ...line }) => line) } },
  // `items` reads as well as `lines` to a model that did not look at the schema
  renamed: { invoice: { vat_rate: 19, items: data.invoice.lines } },
  // the rate as it is printed on a German invoice
  percentText: { invoice: { ...data.invoice, vat_rate: '19 %' } },
};

async function tools() {
  const fetch = (async (input: unknown) => {
    throw new Error(`network call: ${String(input)}`);
  }) as typeof globalThis.fetch;
  const server = createFormfeedServer({ apiKey: 'ff_test_k', fetch });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(clientSide);
  const validate = async (html: string, d: unknown) =>
    (await client.callTool({ name: 'validate_template', arguments: { html, engine: 'jinja2', data: d } })).structuredContent as {
      ok: boolean;
      diagnostics: Array<{ severity: string; code: string; message: string; line: number }>;
    };
  return { validate, close: () => Promise.all([client.close(), server.close()]) };
}

async function totalLine(d: unknown): Promise<string> {
  const rendered = await renderVersion({ engine: 'jinja2', kind: 'pdf', html: template, css: '', head: '', settings: { locale: 'de-DE', currency: 'EUR' } } as never, d, {
    locale: 'de-DE',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    partials: () => undefined,
    helpers: defaultHelpers(),
    limits: defaultLimits,
  });
  return /Gesamt[^<]*/.exec(rendered.document)![0].replace(/\s+/g, ' ');
}

describe('validate_template on data an agent wrote', () => {
  it('passes the data the template was written for, and it renders', async () => {
    const { validate, close } = await tools();
    expect(await validate(template, data)).toEqual({ ok: true, diagnostics: [] });
    expect(await totalLine(data)).toBe('Gesamt 3.760,40 €');
    await close();
  });

  it('warns about a missing field but stays ok, and the invoice totals zero', async () => {
    const { validate, close } = await tools();
    const result = await validate(template, agentData.noTotals);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      { severity: 'warning', code: 'unknown-variable', message: '"line.total" is not present in the sample data', line: 3, column: 101 },
    ]);
    expect(await totalLine(agentData.noTotals)).toBe('Gesamt 0,00 €');
    await close();
  });

  it('warns about every name under a renamed list', async () => {
    const { validate, close } = await tools();
    const result = await validate(template, agentData.renamed);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      '"invoice.lines" is not present in the sample data',
      '"line.description" is not present in the sample data',
      '"line.qty" is not present in the sample data',
      '"line.price" is not present in the sample data',
      '"line.total" is not present in the sample data',
    ]);
    expect(await totalLine(agentData.renamed)).toBe('Gesamt 0,00 €');
    await close();
  });

  it('does not check values offline: a rate written as text passes, and the render stops at money', async () => {
    const { validate, close } = await tools();
    expect(await validate(template, agentData.percentText)).toEqual({ ok: true, diagnostics: [] });
    // a stored template is checked by the API instead, which runs it with the data and knows its schema
    await expect(totalLine(agentData.percentText)).rejects.toThrow('money: got NaN, the result of a calculation with a value that is missing or not a number');
    await close();
  });

  it('fails a template with a misspelt helper', async () => {
    const { validate, close } = await tools();
    const result = await validate(template.replace('line.price | money', 'line.price | monney'), data);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'unknown-filter', message: 'Unknown filter or helper "monney"' })]);
    await close();
  });
});
