import type { HelperContext } from '../types';
import { epcPayload } from '../codes';
import { CHART_PALETTE, chartDataFromPlain, chartPayload } from './document';
import { createHelperRegistry, helperDocs } from './index';

const ctx: HelperContext = {
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  i18n: { de: { greeting: 'Hallo {name}' }, en: { greeting: 'Hello {name}' } },
  assetBaseUrl: 'https://cdn.formfeed.test/a/ws1',
};
const registry = createHelperRegistry();
const helper = (name: string) => {
  const def = registry.get(name);
  if (!def) throw new Error(`helper ${name} missing`);
  return def;
};
const call = (name: string, ...args: unknown[]) =>
  helper(name).fn(ctx, ...args);

describe('format helpers', () => {
  it('formats money with context defaults and explicit overrides', () => {
    expect(call('money', 1234.5)).toBe('1.234,50\u00a0€');
    expect(call('money', 1234.5, 'USD', 'en-US')).toBe('$1,234.50');
    expect(call('money', '12,5')).toBe('12,50\u00a0€');
  });

  it('formats numbers and dates in the render timezone', () => {
    expect(call('number', 1234.567, 2)).toBe('1.234,57');
    expect(call('date', '2026-09-07', 'dd.MM.yyyy')).toBe('07.09.2026');
    expect(call('date', '2026-09-07T23:30:00Z', 'dd.MM.yyyy HH:mm')).toBe(
      '08.09.2026 01:30',
    );
    expect(call('date', '2026-09-07T23:30:00Z', 'HH:mm', 'UTC')).toBe('23:30');
    expect(call('date', 1788781842, 'yyyy')).toBe('2026');
  });

  it('rounds as Jinja2 does, with the method as a third or a named argument', () => {
    expect(call('round', 2.345, 2)).toBe(2.35);
    expect(call('round', -2.5)).toBe(-3);
    expect(call('round', 2.999, 2, 'floor')).toBe(2.99);
    expect(call('round', 1.001, 0, 'ceil')).toBe(2);
    // binary products that land just below the cut are not floored one step too far
    expect(call('round', 1.15, 2, 'floor')).toBe(1.15);
    expect(call('round', 4.35, 1, { __keywords: true, method: 'ceil' })).toBe(4.4);
    expect(call('round', 12.7, { precision: 0, method: 'floor' })).toBe(12);
    expect(call('round', 'n/a', 2, 'floor')).toBe('');
    expect(() => call('round', 1.5, 0, 'down')).toThrow(/method must be 'common', 'floor' or 'ceil'/);
  });

  it('adds to dates', () => {
    expect(
      call('date', call('dateAdd', '2026-01-31', 1, 'month'), 'yyyy-MM-dd'),
    ).toBe('2026-02-28');
  });

  it('spells numbers out', () => {
    expect(call('numToWords', 243)).toBe('zweihundertdreiundvierzig');
    expect(call('numToWords', 21, 'en')).toBe('twenty-one');
  });

  it('translates with the template dictionary', () => {
    expect(call('t', 'greeting', { name: 'Ada' })).toBe('Hallo Ada');
    expect(
      helper('t').fn({ ...ctx, locale: 'fr' }, 'greeting', { name: 'Ada' }),
    ).toBe('Hello Ada');
    expect(call('t', 'missing.key')).toBe('missing.key');
  });

  it('handles text helpers', () => {
    expect(call('truncate', 'Hello world', 8)).toBe('Hello w…');
    expect(call('title', 'hello wORLD')).toBe('Hello World');
    expect(call('nl2br', 'a<b\nc')).toBe('a&lt;b<br>\nc');
    expect(call('markdown', '# Hi\n\n**bold**')).toContain(
      '<strong>bold</strong>',
    );
    expect(call('default', '', 'x')).toBe('x');
    expect(call('default', 0, 'x')).toBe(0);
    expect(call('asset', '/logo.png')).toBe(
      'https://cdn.formfeed.test/a/ws1/logo.png',
    );
  });
});

describe('collection helpers', () => {
  const lines = [
    { sku: 'B', total: 20, cat: 'x' },
    { sku: 'A', total: 5, cat: 'y' },
    { sku: 'C', total: 15, cat: 'x' },
  ];
  it('aggregates and groups', () => {
    expect(call('sum', lines, 'total')).toBe(40);
    expect(call('avg', [2, 4])).toBe(3);
    expect(call('max', lines, 'total')).toBe(20);
    expect(call('groupBy', lines, 'cat')).toEqual([
      { key: 'x', items: [lines[0], lines[2]] },
      { key: 'y', items: [lines[1]] },
    ]);
    expect(
      (call('sortBy', lines, 'sku') as typeof lines).map((l) => l.sku),
    ).toEqual(['A', 'B', 'C']);
    expect(
      (call('sortBy', lines, 'total', 'desc') as typeof lines).map(
        (l) => l.total,
      ),
    ).toEqual([20, 15, 5]);
    expect(call('where', lines, 'cat', 'x')).toHaveLength(2);
    expect(call('pluck', lines, 'sku')).toEqual(['B', 'A', 'C']);
    expect(call('chunk', [1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(call('range', 1, 4)).toEqual([1, 2, 3]);
    expect(call('range', 3)).toEqual([0, 1, 2]);
    expect(call('length', { a: 1 })).toBe(1);
  });
});

describe('code helpers', () => {
  it('produces SVG data URIs', () => {
    const qr = call('qrcode', 'https://formfeed.dev', { size: 100 }) as string;
    expect(qr.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(qr)).toContain('<svg');
    const bc = call('barcode', '4006381333931', { type: 'ean13' }) as string;
    expect(decodeURIComponent(bc)).toContain('<svg');
  });

  it('builds a valid EPC payload', () => {
    const payload = epcPayload({
      name: 'Fennlor Studio GmbH',
      iban: 'DE36 0000 0000 0000 0000 00',
      bic: 'XXXXDEXXXXX',
      amount: 123.4,
      reference: 'RE-2026-0042',
    });
    expect(payload.split('\n')).toEqual([
      'BCD',
      '002',
      '1',
      'SCT',
      'XXXXDEXXXXX',
      'Fennlor Studio GmbH',
      'DE36000000000000000000',
      'EUR123.40',
      '',
      'RE-2026-0042',
      '',
      '',
    ]);
  });
});

describe('registry', () => {
  it('resolves aliases, deprecations and docs', () => {
    expect(registry.get('currency_format')?.name).toBe('money');
    expect(registry.deprecationOf('currency_format')).toBe('money');
    expect(registry.deprecationOf('money')).toBeUndefined();
    expect(registry.names()).toContain('tojson');
    const docs = helperDocs(registry);
    expect(docs.find((d) => d.name === 'epcQr')?.category).toBe('code');
    expect(docs.every((d) => d.signature && d.description && d.example)).toBe(
      true,
    );
  });
});

describe('document helpers', () => {
  it('emits a chart canvas with deterministic options and a sized image', () => {
    const chart = String(call('chart', { type: 'pie', data: { labels: ['a'] } }, { width: 200 }));
    expect(chart).toContain('class="ff-chart"');
    expect(chart).toContain('width="200"');
    expect(chart).toContain('&quot;animation&quot;:false');
    expect(chart).toContain('&quot;type&quot;:&quot;pie&quot;');
    expect(String(call('image', 'https://x/y.png', { width: '4cm', fit: 'contain', alt: 'Logo <1>' }))).toBe(
      '<img src="https://x/y.png" alt="Logo &lt;1&gt;" style="width:4cm;object-fit:contain">',
    );
    expect(helperDocs().map((d) => d.name)).toEqual(expect.arrayContaining(['chart', 'image']));
  });

  it('builds chart data from labels and values or series', () => {
    // numbers from strings, gaps for anything else; one series takes the first palette colour
    expect(chartDataFromPlain({ labels: ['a', 'b', 'c'], values: [1, '2', 'n/a'] })).toEqual({
      labels: ['a', 'b', 'c'],
      datasets: [{ data: [1, 2, null], backgroundColor: CHART_PALETTE[0], borderColor: CHART_PALETTE[0] }],
    });
    // named series, each with its own or the next palette colour
    const series = chartDataFromPlain({
      type: 'line',
      labels: ['Q1'],
      series: [{ label: '2025', values: [3] }, { label: '2026', values: [4], color: '#111111' }],
    });
    expect(series.datasets).toEqual([
      { label: '2025', data: [3], backgroundColor: CHART_PALETTE[0], borderColor: CHART_PALETTE[0], fill: false },
      { label: '2026', data: [4], backgroundColor: '#111111', borderColor: '#111111', fill: false },
    ]);
    // a pie colours every slice, unless the data gives a list
    expect(chartDataFromPlain({ type: 'pie', labels: ['a', 'b'], values: [1, 2] }).datasets[0]?.['backgroundColor']).toEqual(
      CHART_PALETTE.slice(0, 2),
    );
    expect(
      chartDataFromPlain({ type: 'doughnut', labels: ['a', 'b'], values: [1, 2], color: ['#000', '#fff'] }).datasets[0]?.[
        'backgroundColor'
      ],
    ).toEqual(['#000', '#fff']);
  });

  it('hides the legend of one unnamed series, but keeps the options a template sets', () => {
    const payload = (spec: object) => chartPayload(spec);
    expect(payload({ labels: ['a'], values: [1] }).options['plugins']).toEqual({ legend: { display: false } });
    expect(payload({ labels: ['a'], values: [1], label: 'Revenue' }).options['plugins']).toBeUndefined();
    expect(payload({ type: 'pie', labels: ['a'], values: [1] }).options['plugins']).toBeUndefined();
    expect(
      payload({ labels: ['a'], values: [1], options: { plugins: { legend: { position: 'bottom' } } } }).options['plugins'],
    ).toEqual({ legend: { position: 'bottom' } });
    // a full Chart.js configuration wins over plain fields
    expect(payload({ data: { datasets: [] }, values: [1] }).data).toEqual({ datasets: [] });
    // a missing colour (an empty brand kit) falls back to the palette
    expect(chartDataFromPlain({ labels: ['a'], values: [1], color: '' }).datasets[0]?.['backgroundColor']).toBe(CHART_PALETTE[0]);
  });
});
