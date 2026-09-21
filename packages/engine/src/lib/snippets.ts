import type { EngineId } from './types';

/**
 * Snippet library (spec 06 §2): building blocks in every engine's syntax with the sample data keys
 * they expect, so inserting one also completes the data panel.
 */
export type SnippetGroup = 'letter' | 'invoice' | 'page' | 'report';

export interface Snippet {
  id: string;
  title: string;
  description: string;
  /** Where the library lists the block. */
  group: SnippetGroup;
  /** Document kinds the block makes sense in; absent means both (page breaks and footers are PDF only). */
  kinds?: Array<'pdf' | 'image'>;
  /**
   * The document the block belongs in; absent means the template body. Header and footer blocks
   * style themselves inline, because Chromium renders those templates without the page's CSS.
   */
  target?: 'header' | 'footer';
  /** Source per engine; `$0` marks the final cursor position (Monaco snippet syntax). */
  source: Record<EngineId, string>;
  /** Sample data merged (deep, without overwriting) into the template's sample data. */
  sampleData?: Record<string, unknown>;
  /**
   * CSS whose rules are appended when the stylesheet lacks their selector (`mergeSnippetCss`).
   * Colours and heading fonts read the brand kit's `--brand-*` variables with a neutral fallback.
   */
  css?: string;
  /**
   * Label texts per language for the `t` calls in `source`, merged into the template's dictionaries
   * without overwriting (`mergeSnippetI18n`), so a German template gets German labels.
   */
  i18n?: Record<string, Record<string, string>>;
}

/** Handlebars has no loop variable: inside `{{#each}}` the item's fields are read directly. */
const loop = (engine: EngineId, item: string, list: string, body: string) =>
  engine === 'handlebars'
    ? `{{#each ${list}}}\n${body.replace(new RegExp(`(?<![\\w.])${item}\\.`, 'g'), '')}\n{{/each}}`
    : `{% for ${item} in ${list} %}\n${body}\n{% endfor %}`;
const val = (engine: EngineId, expr: string, filter?: string) => {
  if (!filter) return `{{ ${expr} }}`;
  if (engine === 'handlebars')
    return `{{${filter.split('(')[0]} ${expr}${filter.includes('(') ? ' ' + filter.slice(filter.indexOf('(') + 1, -1) : ''}}}`;
  return engine === 'liquid'
    ? `{{ ${expr} | ${filter.replace('(', ': ').replace(')', '')} }}`
    : `{{ ${expr} | ${filter} }}`;
};
const ifElse = (engine: EngineId, cond: string, then: string, otherwise: string) =>
  engine === 'handlebars'
    ? `{{#if ${cond}}}${then}{{else}}${otherwise}{{/if}}`
    : `{% if ${cond} %}${then}{% else %}${otherwise}{% endif %}`;
/** A `t` call with optional placeholder params (`{ rate: 'invoice.vat_rate' }`, values are expressions). */
const tr = (engine: EngineId, key: string, params: Record<string, string> = {}) => {
  const entries = Object.entries(params);
  if (engine === 'handlebars')
    return `{{t '${key}'${entries.map(([k, v]) => ` ${k}=${v}`).join('')}}}`;
  if (engine === 'liquid')
    return `{{ '${key}' | t${entries.length ? ': ' + entries.map(([k, v]) => `${k}: ${v}`).join(', ') : ''} }}`;
  return `{{ t('${key}'${entries.length ? `, { ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }` : ''}) }}`;
};

function forAll(build: (engine: EngineId) => string): Record<EngineId, string> {
  return {
    jinja2: build('jinja2'),
    liquid: build('liquid'),
    handlebars: build('handlebars'),
  };
}

const rule = 'var(--brand-color-primary, #222)';

export const snippets: Snippet[] = [
  {
    id: 'letterhead',
    group: 'letter',
    title: 'Letterhead',
    description: 'Logo from the brand kit, or the organisation name when no logo is set.',
    source: forAll(
      (e) => `<header class="ff-letterhead">
  ${ifElse(e, 'brand.logo.primary', `<img class="logo" src="${val(e, 'brand.logo.primary')}" alt="${val(e, 'brand.name')}">`, `<strong class="name">${val(e, 'brand.name')}</strong>`)}
</header>$0`,
    ),
    css: `.ff-letterhead { display: flex; justify-content: flex-end; align-items: center; min-height: 48px; margin-bottom: 24px; padding-bottom: 8px; border-bottom: 2px solid ${rule}; }\n.ff-letterhead .logo { max-height: 56px; max-width: 200px; }\n.ff-letterhead .name { font-family: var(--brand-font-heading, inherit); font-size: 18pt; color: var(--brand-color-primary, inherit); }`,
  },
  {
    id: 'window-address',
    group: 'letter',
    kinds: ['pdf'],
    title: 'Window envelope address',
    description:
      'Return address and recipient in the 85 × 45 mm field of a DIN 5008 window envelope.',
    source: forAll(
      (e) => `<div class="ff-window">
  <div class="sender">${val(e, 'company.name')} · ${val(e, 'company.street')} · ${val(e, 'company.zip')} ${val(e, 'company.city')}</div>
  <address>
    <strong>${val(e, 'customer.name')}</strong><br>
    ${val(e, 'customer.street')}<br>
    ${val(e, 'customer.zip')} ${val(e, 'customer.city')}
  </address>
</div>$0`,
    ),
    sampleData: {
      company: { name: 'Fennlor Studio GmbH', street: 'Musterstraße 1', zip: '12345', city: 'Musterstadt' },
      customer: { name: 'Olvarest GmbH', street: 'Beispielweg 2', zip: '54321', city: 'Beispielstadt' },
    },
    // Form B puts the field 45 mm below the top edge and 20 mm from the left; the page margins decide where it lands
    css: `.ff-window { width: 85mm; height: 45mm; box-sizing: border-box; padding: 0 5mm; overflow: hidden; }\n.ff-window .sender { height: 5mm; line-height: 5mm; margin-bottom: 3mm; font-size: 7pt; color: #555; border-bottom: 0.5pt solid #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.ff-window address { font-style: normal; font-size: 10pt; line-height: 1.35; }`,
  },
  {
    id: 'reference-block',
    group: 'letter',
    title: 'Reference block',
    description:
      'Customer number, invoice number and date as a right-aligned table; put it in a two-column layout to sit beside the address.',
    source: forAll(
      (e) => `<table class="ff-reference">
  <tr><th>${tr(e, 'reference.customer')}</th><td>${val(e, 'customer.number')}</td></tr>
  <tr><th>${tr(e, 'reference.invoice')}</th><td>${val(e, 'invoice.number')}</td></tr>
  <tr><th>${tr(e, 'reference.date')}</th><td>${val(e, 'invoice.date', "date('P')")}</td></tr>
</table>$0`,
    ),
    sampleData: {
      customer: { number: 'K-1042' },
      invoice: { number: '2026-0042', date: '2026-09-13' },
    },
    css: `.ff-reference { margin-left: auto; border-collapse: collapse; font-size: 9pt; }\n.ff-reference th { text-align: left; font-weight: normal; color: #555; padding: 1px 12px 1px 0; }\n.ff-reference td { text-align: right; padding: 1px 0; }`,
    i18n: {
      en: { 'reference.customer': 'Customer no.', 'reference.invoice': 'Invoice no.', 'reference.date': 'Date' },
      de: { 'reference.customer': 'Kundennummer', 'reference.invoice': 'Rechnungsnummer', 'reference.date': 'Datum' },
    },
  },
  {
    id: 'invoice-heading',
    group: 'invoice',
    title: 'Invoice heading',
    description: 'Invoice number as the title and the service period below it.',
    source: forAll(
      (e) => `<div class="ff-heading">
  <h1>${tr(e, 'heading.title', { number: 'invoice.number' })}</h1>
  <p>${tr(e, 'heading.period')} ${val(e, 'invoice.period_start', "date('P')")} – ${val(e, 'invoice.period_end', "date('P')")}</p>
</div>$0`,
    ),
    sampleData: {
      invoice: { number: '2026-0042', period_start: '2026-09-01', period_end: '2026-09-30' },
    },
    css: `.ff-heading { margin: 24px 0 16px; }\n.ff-heading h1 { font-family: var(--brand-font-heading, inherit); font-size: 18pt; color: var(--brand-color-primary, inherit); margin: 0 0 4px; }\n.ff-heading p { margin: 0; color: #555; }`,
    i18n: {
      en: { 'heading.title': 'Invoice {number}', 'heading.period': 'Service period:' },
      de: { 'heading.title': 'Rechnung {number}', 'heading.period': 'Leistungszeitraum:' },
    },
  },
  {
    id: 'invoice-table',
    group: 'invoice',
    title: 'Invoice table',
    description:
      'Line items with description, quantity, unit price and line total.',
    source: forAll(
      (e) => `<table class="ff-lines">
  <thead><tr><th>${tr(e, 'lines.description')}</th><th class="num">${tr(e, 'lines.qty')}</th><th class="num">${tr(e, 'lines.price')}</th><th class="num">${tr(e, 'lines.total')}</th></tr></thead>
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
    css: `.ff-lines { width: 100%; border-collapse: collapse; font-size: 10pt; }\n.ff-lines th, .ff-lines td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; }\n.ff-lines .num { text-align: right; white-space: nowrap; }\n.ff-lines thead th { border-bottom: 2px solid ${rule}; }`,
    i18n: {
      en: {
        'lines.description': 'Description',
        'lines.qty': 'Qty',
        'lines.price': 'Unit price',
        'lines.total': 'Total',
      },
      de: {
        'lines.description': 'Beschreibung',
        'lines.qty': 'Menge',
        'lines.price': 'Einzelpreis',
        'lines.total': 'Gesamt',
      },
    },
  },
  {
    id: 'totals',
    group: 'invoice',
    title: 'Totals block',
    description: 'Net, VAT and gross totals right-aligned under a table.',
    source: forAll(
      (e) => `<table class="ff-totals">
  <tr><td>${tr(e, 'totals.net')}</td><td class="num">${val(e, 'invoice.net', 'money')}</td></tr>
  <tr><td>${tr(e, 'totals.vat', { rate: 'invoice.vat_rate' })}</td><td class="num">${val(e, 'invoice.vat', 'money')}</td></tr>
  <tr class="grand"><td>${tr(e, 'totals.total')}</td><td class="num">${val(e, 'invoice.total', 'money')}</td></tr>
</table>$0`,
    ),
    sampleData: {
      invoice: { net: 3160, vat_rate: 19, vat: 600.4, total: 3760.4 },
    },
    css: `.ff-totals { margin-left: auto; margin-top: 12px; border-collapse: collapse; font-size: 10pt; }\n.ff-totals td { padding: 4px 8px; }\n.ff-totals .num { text-align: right; min-width: 90px; }\n.ff-totals .grand td { border-top: 2px solid ${rule}; font-weight: 600; }`,
    i18n: {
      en: {
        'totals.net': 'Net',
        'totals.vat': 'VAT {rate} %',
        'totals.total': 'Total',
      },
      de: {
        'totals.net': 'Netto',
        'totals.vat': 'USt. {rate} %',
        'totals.total': 'Gesamtbetrag',
      },
    },
  },
  {
    id: 'payment-terms',
    group: 'invoice',
    title: 'Payment terms and bank details',
    description: 'Amount, due date and the account to transfer it to.',
    source: forAll(
      (e) => `<div class="ff-payment">
  <p>${tr(e, 'payment.transfer')} <strong>${val(e, 'payment.amount', 'money')}</strong> ${tr(e, 'payment.until')} <strong>${val(e, 'invoice.due_date', "date('P')")}</strong> ${tr(e, 'payment.account')}</p>
  <table>
    <tr><th>${tr(e, 'payment.holder')}</th><td>${val(e, 'payment.name')}</td></tr>
    <tr><th>IBAN</th><td>${val(e, 'payment.iban')}</td></tr>
    <tr><th>BIC</th><td>${val(e, 'payment.bic')}</td></tr>
    <tr><th>${tr(e, 'payment.reference')}</th><td>${val(e, 'payment.reference')}</td></tr>
  </table>
</div>$0`,
    ),
    sampleData: {
      invoice: { due_date: '2026-10-13' },
      payment: {
        name: 'Fennlor Studio GmbH',
        iban: 'DE36000000000000000000',
        bic: 'XXXXDEXXXXX',
        amount: 3760.4,
        reference: '2026-0042',
      },
    },
    css: `.ff-payment { margin-top: 16px; font-size: 9.5pt; break-inside: avoid; }\n.ff-payment p { margin: 0 0 6px; }\n.ff-payment table { border-collapse: collapse; }\n.ff-payment th { text-align: left; font-weight: normal; color: #555; padding: 1px 16px 1px 0; }`,
    i18n: {
      en: {
        'payment.transfer': 'Please transfer',
        'payment.until': 'by',
        'payment.account': 'to the following account:',
        'payment.holder': 'Account holder',
        'payment.reference': 'Reference',
      },
      de: {
        'payment.transfer': 'Bitte überweisen Sie',
        'payment.until': 'bis zum',
        'payment.account': 'auf folgendes Konto:',
        'payment.holder': 'Kontoinhaber',
        'payment.reference': 'Verwendungszweck',
      },
    },
  },
  {
    id: 'small-business-note',
    group: 'invoice',
    title: 'Small business VAT note',
    description: 'States that no VAT is charged under § 19 UStG (Kleinunternehmerregelung).',
    source: forAll((e) => `<p class="ff-note">${tr(e, 'vat.small_business')}</p>$0`),
    css: `.ff-note { margin-top: 12px; font-size: 9pt; color: #444; }`,
    i18n: {
      en: { 'vat.small_business': 'No VAT is charged under the small business scheme of § 19 UStG.' },
      de: { 'vat.small_business': 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' },
    },
  },
  {
    id: 'reverse-charge-note',
    group: 'invoice',
    title: 'Reverse charge note',
    description: 'EU business customers: the recipient owes the VAT, with their VAT ID.',
    source: forAll(
      (e) => `<p class="ff-note">${tr(e, 'vat.reverse_charge')} ${tr(e, 'vat.customer_id')} ${val(e, 'customer.vat_id')}</p>$0`,
    ),
    sampleData: { customer: { vat_id: 'ATU00000000' } },
    css: `.ff-note { margin-top: 12px; font-size: 9pt; color: #444; }`,
    i18n: {
      en: {
        'vat.reverse_charge': 'Reverse charge: the recipient of the service is liable for VAT.',
        'vat.customer_id': 'Customer VAT ID:',
      },
      de: {
        'vat.reverse_charge': 'Steuerschuldnerschaft des Leistungsempfängers.',
        'vat.customer_id': 'USt-IdNr. des Leistungsempfängers:',
      },
    },
  },
  {
    id: 'address-block',
    group: 'letter',
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
        name: 'Olvarest GmbH',
        street: 'Beispielweg 2',
        zip: '54321',
        city: 'Beispielstadt',
        country: 'Deutschland',
      },
    },
    css: `.ff-address { font-style: normal; line-height: 1.4; }`,
  },
  {
    id: 'page-footer',
    group: 'page',
    kinds: ['pdf'],
    title: 'Footer with page numbers',
    description: 'Company line and “Page x of y” in the page footer.',
    target: 'footer',
    source: forAll(
      (
        e,
      ) => `<div style="width:100%;display:flex;justify-content:space-between;font-size:9px;color:#666">
  <span>${val(e, 'company.name')} · ${val(e, 'company.email')}</span>
  <span>${tr(e, 'footer.page')} <span class="pageNumber"></span> ${tr(e, 'footer.of')} <span class="totalPages"></span></span>
</div>$0`,
    ),
    sampleData: { company: { name: 'Fennlor Studio GmbH', email: 'hello@fennlor.example' } },
    i18n: {
      en: { 'footer.page': 'Page', 'footer.of': 'of' },
      de: { 'footer.page': 'Seite', 'footer.of': 'von' },
    },
  },
  {
    id: 'legal-footer',
    group: 'page',
    kinds: ['pdf'],
    title: 'Legal footer',
    description: 'The legal footer from the brand kit, centred in the page footer.',
    target: 'footer',
    source: forAll(
      (e) => `<div style="width:100%;text-align:center;font-size:8px;color:#666">${val(e, 'brand.legal_footer')}</div>$0`,
    ),
  },
  {
    id: 'cover-page',
    group: 'report',
    kinds: ['pdf'],
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
    css: `.ff-cover { min-height: 60vh; display: flex; flex-direction: column; justify-content: center; }\n.ff-cover h1 { font-family: var(--brand-font-heading, inherit); font-size: 32pt; color: var(--brand-color-primary, inherit); margin: 0 0 8px; }\n.ff-cover .subtitle { font-size: 16pt; color: #444; margin: 0; }\n.ff-cover .date { margin-top: 24px; color: #666; }`,
  },
  {
    id: 'signature',
    group: 'letter',
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
        name: 'Erika Mustermann',
      },
    },
    css: `.ff-signature { margin-top: 48px; width: 260px; font-size: 9pt; color: #444; }\n.ff-signature .line { border-top: 1px solid #222; margin-bottom: 6px; }`,
  },
  {
    id: 'epc-qr',
    group: 'invoice',
    title: 'SEPA payment QR code',
    description: 'GiroCode that banking apps scan to prefill the transfer.',
    source: {
      jinja2: `<figure class="ff-qr">\n  <img src="{{ epcQr(payment, { size: 120 }) }}" alt="${tr('jinja2', 'qr.alt')}">\n  <figcaption>${tr('jinja2', 'qr.caption')}</figcaption>\n</figure>$0`,
      liquid: `<figure class="ff-qr">\n  <img src="{{ payment | epcQr: size: 120 }}" alt="${tr('liquid', 'qr.alt')}">\n  <figcaption>${tr('liquid', 'qr.caption')}</figcaption>\n</figure>$0`,
      handlebars: `<figure class="ff-qr">\n  <img src="{{epcQr payment size=120}}" alt="${tr('handlebars', 'qr.alt')}">\n  <figcaption>${tr('handlebars', 'qr.caption')}</figcaption>\n</figure>$0`,
    },
    i18n: {
      en: { 'qr.alt': 'Payment QR code', 'qr.caption': 'Scan to pay' },
      de: { 'qr.alt': 'QR-Code zur Zahlung', 'qr.caption': 'Zum Bezahlen scannen' },
    },
    sampleData: {
      payment: {
        name: 'Fennlor Studio GmbH',
        iban: 'DE36000000000000000000',
        bic: 'XXXXDEXXXXX',
        amount: 3760.4,
        reference: '2026-0042',
      },
    },
    css: `.ff-qr { margin: 16px 0; text-align: center; width: 140px; }\n.ff-qr figcaption { font-size: 8pt; color: #666; }`,
  },
  {
    id: 'chart',
    group: 'report',
    title: 'Chart',
    description:
      'Bar chart from labels and values in the data, in the brand colour.',
    // the colour comes from the brand kit; without one the helper takes its palette
    source: {
      jinja2: `<figure class="ff-chart-box">\n  {{ chart(sales, { type: '\${1:bar}', width: 480, height: 240, color: brand.colors.primary }) }}\n  <figcaption>{{ sales.caption }}</figcaption>\n</figure>$0`,
      liquid: `<figure class="ff-chart-box">\n  {{ sales | chart: type: '\${1:bar}', width: 480, height: 240, color: brand.colors.primary }}\n  <figcaption>{{ sales.caption }}</figcaption>\n</figure>$0`,
      handlebars: `<figure class="ff-chart-box">\n  {{chart sales type='\${1:bar}' width=480 height=240 color=brand.colors.primary}}\n  <figcaption>{{sales.caption}}</figcaption>\n</figure>$0`,
    },
    sampleData: {
      sales: {
        caption: 'Revenue per quarter',
        labels: ['Q1', 'Q2', 'Q3', 'Q4'],
        values: [12000, 15500, 14200, 18900],
      },
    },
    css: `.ff-chart-box { margin: 16px 0; break-inside: avoid; }\n.ff-chart-box figcaption { font-size: 9pt; color: #666; margin-top: 4px; }`,
  },
  {
    id: 'two-columns',
    group: 'page',
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
  {
    id: 'keep-together',
    group: 'page',
    kinds: ['pdf'],
    title: 'Keep together',
    description: 'Content that is never split across two pages.',
    source: forAll(() => `<div class="avoid-break">\n  $0\n</div>`),
  },
  {
    id: 'page-break',
    group: 'page',
    kinds: ['pdf'],
    title: 'Page break',
    description: 'Starts a new page in the PDF.',
    source: forAll(() => `<div class="page-break"></div>\n$0`),
  },
  {
    id: 'kpi-cards',
    group: 'report',
    title: 'Key figures',
    description: 'A row of cards with label, value and change for each figure.',
    source: forAll(
      (e) => `<div class="ff-kpis">
${loop(e, 'kpi', 'report.kpis', `  <div class="kpi"><span class="label">${val(e, 'kpi.label')}</span><strong>${val(e, 'kpi.value')}</strong><span class="change">${val(e, 'kpi.change')}</span></div>`)}
</div>$0`,
    ),
    sampleData: {
      report: {
        kpis: [
          { label: 'Revenue', value: '€ 61,600', change: '+12 % on Q2' },
          { label: 'New customers', value: '48', change: '+9 on Q2' },
          { label: 'Churn', value: '1.8 %', change: '−0.4 pt on Q2' },
        ],
      },
    },
    css: `.ff-kpis { display: flex; gap: 12px; margin: 16px 0; break-inside: avoid; }\n.ff-kpis .kpi { flex: 1 1 0; padding: 10px 12px; border: 1px solid #e5e5e5; border-top: 3px solid ${rule}; border-radius: 4px; }\n.ff-kpis .label { display: block; font-size: 8pt; color: #666; text-transform: uppercase; letter-spacing: 0.04em; }\n.ff-kpis strong { display: block; margin: 2px 0; font-size: 18pt; }\n.ff-kpis .change { font-size: 8pt; color: #555; }`,
  },
];

export function snippetsFor(
  engine: EngineId,
): Array<Snippet & { code: string }> {
  return snippets.map((s) => ({ ...s, code: s.source[engine] }));
}

/** Snippet code without Monaco tab stops (`$0`, `$1`, `${1:default}` keeps its default), as it renders. */
export function snippetText(code: string): string {
  return code.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{?\d+\}?/g, '');
}

/**
 * The line that includes a partial in the engine's syntax, the form the gateway's
 * `sharedPartialsFor` recognises; `undefined` for a name that syntax cannot carry. Liquid uses
 * `include`, because `render` hides the template's data from the partial.
 */
export function partialInclude(engine: EngineId, name: string): string | undefined {
  if (engine === 'handlebars')
    return /^[A-Za-z0-9_./-]+$/.test(name) ? `{{> ${name}}}` : undefined;
  // `$` would start a tab stop when the line is inserted as a Monaco snippet
  return /^[^'"{}%$\\\n]+$/.test(name) ? `{% include '${name}' %}` : undefined;
}

const stripComments =(css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** A rule's selector list in one spelling; text before the last `;` (an `@import`) is not part of it. */
const selectorKey = (prelude: string) =>
  (prelude.split(';').pop() ?? '')
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ');

/**
 * Appends the rules of a snippet's CSS whose selector list the stylesheet does not have yet, so a
 * template that already styles `.ff-lines` itself keeps that rule and still gets the others.
 */
export function mergeSnippetCss(css: string, snippetCss: string | undefined): string {
  if (!snippetCss?.trim()) return css;
  const defined = new Set(
    [...stripComments(css).matchAll(/([^{}]+)\{/g)].map((m) => selectorKey(m[1] ?? '')),
  );
  const missing = [...stripComments(snippetCss).matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .filter((m) => !defined.has(selectorKey(m[1] ?? '')))
    .map((m) => m[0].trim());
  if (!missing.length) return css;
  const base = css.trimEnd();
  return `${base}${base ? '\n\n' : ''}${missing.join('\n')}\n`;
}

/**
 * Adds a snippet's label texts to the template's dictionaries without overwriting a key: English
 * always (the `t` helper's last fallback), plus every language the template renders in or already
 * has a dictionary for. A `de-DE` dictionary gets its keys through `de`, which `t` reads next.
 */
export function mergeSnippetI18n(
  dictionaries: unknown,
  extra: Snippet['i18n'],
  locale: string,
): unknown {
  if (!extra) return dictionaries;
  const base =
    dictionaries && typeof dictionaries === 'object' && !Array.isArray(dictionaries)
      ? (dictionaries as Record<string, unknown>)
      : {};
  const lang = (l: string) => l.split('-')[0]?.toLowerCase() ?? l;
  const wanted = new Set(['en', lang(locale), ...Object.keys(base).map(lang)]);
  const add: Record<string, unknown> = {};
  for (const [language, texts] of Object.entries(extra))
    if (wanted.has(language)) add[language] = texts;
  return mergeSampleData(base, add);
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
