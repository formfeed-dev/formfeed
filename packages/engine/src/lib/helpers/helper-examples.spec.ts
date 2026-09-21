import { describe, expect, it } from 'vitest';
import { engineIds, engines } from '../engines';
import type { EngineId, RenderContext } from '../types';
import { defaultHelpers, helperDocs } from './index';

/**
 * Every example in the helper reference, rendered in the engine it claims to be written for
 * (spec 16 §3). The three dialects differ in more than punctuation — Jinja2 passes filter arguments
 * in parentheses, Liquid after a colon and without object literals, Handlebars positionally with
 * hash arguments — so an example copied from one engine to another is usually a syntax error and
 * occasionally something worse: output that silently disappears. A reader who pastes what the page
 * shows must get a document, which is what this asserts.
 */

/** One shape that every example can draw on; the names in the examples are the names here. */
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

const context = (): RenderContext => ({
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  assetBaseUrl: 'https://cdn.example.test/a/ws',
  i18n: { 'de-DE': { 'invoice.title': 'Rechnung {number}' } },
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
});

const render = async (engine: EngineId, source: string): Promise<string> =>
  engines[engine].render(engines[engine].compile(source), data, context());

const docs = helperDocs();

describe('helper examples', () => {
  it('documents every helper in every engine', () => {
    for (const doc of docs)
      for (const engine of engineIds) expect(doc.examples[engine], `${doc.name} in ${engine}`).toBeTruthy();
  });

  for (const engine of engineIds) {
    describe(engine, () => {
      it.each(docs.map((d) => [d.name, d.examples[engine]] as const))('%s renders: %s', async (name, source) => {
        const out = await render(engine, source);
        // a dialect the engine half-understands yields these rather than an error
        expect(out, name).not.toMatch(/undefined|NaN|\[object Object\]/);
        // A condition whose test is false renders nothing, and that is the example working. Every
        // other example must put something on the page: a helper the engine does not know can come
        // back as the empty string instead of an error.
        if (!/\{%\s*if|\{\{#if/.test(source)) expect(out, name).not.toBe('');
        else expect(out, name).toMatch(/^(…)?$/);
      });

      // An example that never names its helper documents the engine, not the helper: `gt` shown as
      // `{% if a > b %}` leaves the reader no idea how to call it.
      it('calls the helper it documents', () => {
        for (const doc of docs) {
          const names = [doc.name, ...doc.aliases];
          expect(names.some((n) => doc.examples[engine].includes(n)), `${doc.name} in ${engine}`).toBe(true);
        }
      });
    });
  }
});
