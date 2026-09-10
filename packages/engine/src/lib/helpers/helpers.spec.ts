import type { HelperContext } from '../types';
import { epcPayload } from './codes';
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
      name: 'Acme GmbH',
      iban: 'DE02 1203 0000 0000 2020 51',
      bic: 'BYLADEM1001',
      amount: 123.4,
      reference: 'RE-2026-0042',
    });
    expect(payload.split('\n')).toEqual([
      'BCD',
      '002',
      '1',
      'SCT',
      'BYLADEM1001',
      'Acme GmbH',
      'DE02120300000000202051',
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
});
