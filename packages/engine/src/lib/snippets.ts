import type { EngineId } from './types';

/**
 * Snippet library (spec 06 §2): building blocks in every engine's syntax with the sample data keys
 * they expect, so inserting one also completes the data panel.
 */
export interface Snippet {
  id: string;
  title: string;
  description: string;
  /** Source per engine; `$0` marks the final cursor position (Monaco snippet syntax). */
  source: Record<EngineId, string>;
  /** Sample data merged (deep, without overwriting) into the template's sample data. */
  sampleData?: Record<string, unknown>;
  /** CSS appended to the template's stylesheet if the selector prefix is absent. */
  css?: string;
}

const loop = (engine: EngineId, item: string, list: string, body: string) =>
  engine === 'handlebars'
    ? `{{#each ${list}}}\n${body.replace(/\{\{ item\./g, '{{ ')}\n{{/each}}`
    : `{% for ${item} in ${list} %}\n${body}\n{% endfor %}`;
const val = (engine: EngineId, expr: string, filter?: string) => {
  if (!filter) return `{{ ${expr} }}`;
  if (engine === 'handlebars')
    return `{{${filter.split('(')[0]} ${expr}${filter.includes('(') ? ' ' + filter.slice(filter.indexOf('(') + 1, -1) : ''}}}`;
  return engine === 'liquid'
    ? `{{ ${expr} | ${filter.replace('(', ': ').replace(')', '')} }}`
    : `{{ ${expr} | ${filter} }}`;
};

function forAll(build: (engine: EngineId) => string): Record<EngineId, string> {
  return {
    jinja2: build('jinja2'),
    liquid: build('liquid'),
    handlebars: build('handlebars'),
  };
}

export const snippets: Snippet[] = [
  {
    id: 'invoice-table',
    title: 'Invoice table',
    description:
      'Line items with description, quantity, unit price and line total.',
    source: forAll(
      (e) => `<table class="ff-lines">
  <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
  <tbody>
${loop(e, 'line', 'invoice.lines', `    <tr><td>${val(e, 'line.description')}</td><td class="num">${val(e, 'line.qty', 'number(0)')}</td><td class="num">${val(e, 'line.price', 'money')}</td><td class="num">${val(e, 'line.total', 'money')}</td></tr>`)}
  </tbody>
</table>$0`,
    ),
    sampleData: {
      invoice: {
        lines: [
          { description: 'Consulting', qty: 8, price: 120, total: 960 },
          { description: 'Implementation', qty: 20, price: 110, total: 2200 },
        ],
      },
    },
    css: `.ff-lines { width: 100%; border-collapse: collapse; font-size: 10pt; }\n.ff-lines th, .ff-lines td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; }\n.ff-lines .num { text-align: right; white-space: nowrap; }\n.ff-lines thead th { border-bottom: 2px solid #222; }`,
  },
  {
    id: 'totals',
    title: 'Totals block',
    description: 'Net, VAT and gross totals right-aligned under a table.',
    source: forAll(
      (e) => `<table class="ff-totals">
  <tr><td>Net</td><td class="num">${val(e, 'invoice.net', 'money')}</td></tr>
  <tr><td>VAT ${val(e, 'invoice.vat_rate')} %</td><td class="num">${val(e, 'invoice.vat', 'money')}</td></tr>
  <tr class="grand"><td>Total</td><td class="num">${val(e, 'invoice.total', 'money')}</td></tr>
</table>$0`,
    ),
    sampleData: {
      invoice: { net: 3160, vat_rate: 19, vat: 600.4, total: 3760.4 },
    },
    css: `.ff-totals { margin-left: auto; margin-top: 12px; border-collapse: collapse; font-size: 10pt; }\n.ff-totals td { padding: 4px 8px; }\n.ff-totals .num { text-align: right; min-width: 90px; }\n.ff-totals .grand td { border-top: 2px solid #222; font-weight: 600; }`,
  },
  {
    id: 'address-block',
    title: 'Address block',
    description: 'Recipient name and postal address lines.',
    source: forAll(
      (e) => `<address class="ff-address">
  <strong>${val(e, 'customer.name')}</strong><br>
  ${val(e, 'customer.street')}<br>
  ${val(e, 'customer.zip')} ${val(e, 'customer.city')}<br>
  ${val(e, 'customer.country')}
</address>$0`,
    ),
    sampleData: {
      customer: {
        name: 'Muster GmbH',
        street: 'Musterstraße 1',
        zip: '10115',
        city: 'Berlin',
        country: 'Deutschland',
      },
    },
    css: `.ff-address { font-style: normal; line-height: 1.4; }`,
  },
  {
    id: 'page-footer',
    title: 'Footer with page numbers',
    description: 'Paste into the Footer tab: company line and “Page x of y”.',
    source: forAll(
      (
        e,
      ) => `<div style="width:100%;display:flex;justify-content:space-between;font-size:9px;color:#666">
  <span>${val(e, 'company.name')} · ${val(e, 'company.email')}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>$0`,
    ),
    sampleData: { company: { name: 'Acme GmbH', email: 'hello@acme.example' } },
  },
  {
    id: 'cover-page',
    title: 'Cover page',
    description: 'Title, subtitle and date on a page of its own.',
    source: forAll(
      (e) => `<section class="ff-cover">
  <h1>${val(e, 'report.title')}</h1>
  <p class="subtitle">${val(e, 'report.subtitle')}</p>
  <p class="date">${val(e, 'report.date', "date('PPP')")}</p>
</section>
<div class="page-break"></div>$0`,
    ),
    sampleData: {
      report: {
        title: 'Quarterly report',
        subtitle: 'Q3 2026',
        date: '2026-09-30',
      },
    },
    css: `.ff-cover { min-height: 60vh; display: flex; flex-direction: column; justify-content: center; }\n.ff-cover h1 { font-size: 32pt; margin: 0 0 8px; }\n.ff-cover .subtitle { font-size: 16pt; color: #444; margin: 0; }\n.ff-cover .date { margin-top: 24px; color: #666; }`,
  },
  {
    id: 'signature',
    title: 'Signature line',
    description: 'Place, date and a signature line.',
    source: forAll(
      (e) => `<div class="ff-signature">
  <div class="line"></div>
  <div>${val(e, 'signature.place')}, ${val(e, 'signature.date', "date('PP')")} · ${val(e, 'signature.name')}</div>
</div>$0`,
    ),
    sampleData: {
      signature: {
        place: 'Berlin',
        date: '2026-09-07',
        name: 'Philipp Staudt',
      },
    },
    css: `.ff-signature { margin-top: 48px; width: 260px; font-size: 9pt; color: #444; }\n.ff-signature .line { border-top: 1px solid #222; margin-bottom: 6px; }`,
  },
  {
    id: 'epc-qr',
    title: 'SEPA payment QR code',
    description: 'GiroCode that banking apps scan to prefill the transfer.',
    source: {
      jinja2: `<figure class="ff-qr">\n  <img src="{{ epcQr({ name: company.name, iban: company.iban, bic: company.bic, amount: invoice.total, reference: invoice.number }, { size: 120 }) }}" alt="Payment QR code">\n  <figcaption>Scan to pay</figcaption>\n</figure>$0`,
      liquid: `<figure class="ff-qr">\n  <img src="{{ payment | epcQr }}" alt="Payment QR code">\n  <figcaption>Scan to pay</figcaption>\n</figure>$0`,
      handlebars: `<figure class="ff-qr">\n  <img src="{{epcQr payment size=120}}" alt="Payment QR code">\n  <figcaption>Scan to pay</figcaption>\n</figure>$0`,
    },
    sampleData: {
      company: {
        name: 'Acme GmbH',
        iban: 'DE02120300000000202051',
        bic: 'BYLADEM1001',
      },
      invoice: { number: '2026-0042', total: 3760.4 },
      payment: {
        name: 'Acme GmbH',
        iban: 'DE02120300000000202051',
        bic: 'BYLADEM1001',
        amount: 3760.4,
        reference: '2026-0042',
      },
    },
    css: `.ff-qr { margin: 16px 0; text-align: center; width: 140px; }\n.ff-qr figcaption { font-size: 8pt; color: #666; }`,
  },
  {
    id: 'chart',
    title: 'Chart',
    description:
      'Bar chart drawn with Chart.js from a chart configuration in the data.',
    source: {
      jinja2: `<figure class="ff-chart-box">\n  {{ chart(salesChart) }}\n  <figcaption>{{ salesChart.caption }}</figcaption>\n</figure>$0`,
      liquid: `<figure class="ff-chart-box">\n  {{ salesChart | chart }}\n  <figcaption>{{ salesChart.caption }}</figcaption>\n</figure>$0`,
      handlebars: `<figure class="ff-chart-box">\n  {{chart salesChart}}\n  <figcaption>{{salesChart.caption}}</figcaption>\n</figure>$0`,
    },
    sampleData: {
      salesChart: {
        type: 'bar',
        caption: 'Revenue per quarter',
        width: 480,
        height: 240,
        data: {
          labels: ['Q1', 'Q2', 'Q3', 'Q4'],
          datasets: [
            {
              label: 'Revenue',
              data: [12000, 15500, 14200, 18900],
              backgroundColor: '#3E63DD',
            },
          ],
        },
      },
    },
    css: `.ff-chart-box { margin: 16px 0; break-inside: avoid; }\n.ff-chart-box figcaption { font-size: 9pt; color: #666; margin-top: 4px; }`,
  },
  {
    id: 'two-columns',
    title: 'Two-column layout',
    description: 'Two equal columns that stay side by side in print.',
    source: forAll(
      () => `<div class="ff-columns">
  <div>$1</div>
  <div>$0</div>
</div>`,
    ),
    css: `.ff-columns { display: flex; gap: 24px; }\n.ff-columns > div { flex: 1 1 0; min-width: 0; }`,
  },
];

export function snippetsFor(
  engine: EngineId,
): Array<Snippet & { code: string }> {
  return snippets.map((s) => ({ ...s, code: s.source[engine] }));
}

/** Deep merge that keeps existing values; arrays are taken from the base when present. */
export function mergeSampleData(
  base: unknown,
  extra: Record<string, unknown> | undefined,
): unknown {
  if (!extra) return base;
  const target =
    base && typeof base === 'object' && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(extra)) {
    const existing = target[key];
    if (existing === undefined) target[key] = value;
    else if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      target[key] = mergeSampleData(existing, value as Record<string, unknown>);
    }
  }
  return target;
}
