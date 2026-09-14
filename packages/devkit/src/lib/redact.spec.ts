import { parseRedactPath, redactData, redactString } from './redact';

const order = {
  customer: { name: 'Jane Doe', email: 'jane@acme.com', vip: true, discount: null },
  iban: 'DE89 3704 0044 0532 0130 00',
  total: 1234.5,
  items: [
    { name: 'Widget', sku: 'W-01', qty: 2 },
    { name: 'Gadget', sku: 'G-02', qty: 1 },
  ],
  notes: ['Leave at door', 42],
};

describe('redactString', () => {
  it('keeps length and character classes', () => {
    expect(redactString('jane@acme.com')).toBe('aaaa@aaaa.aaa');
    expect(redactString('DE89 3704')).toBe('AA00 0000');
    expect(redactString('Müller-Lüdenscheidt, Straße 5a')).toBe('Aaaaaa-Aaaaaaaaaaaa, Aaaaaa 0a');
    expect(redactString('+49 (30) 123/45')).toBe('+00 (00) 000/00');
    expect(redactString('')).toBe('');
  });
});

describe('parseRedactPath', () => {
  it('splits dots and array brackets', () => {
    expect(parseRedactPath('customer.email')).toEqual(['customer', 'email']);
    expect(parseRedactPath('items[].name')).toEqual(['items', '*', 'name']);
    expect(parseRedactPath('items.*.name')).toEqual(['items', '*', 'name']);
    expect(parseRedactPath('lines[0].qty')).toEqual(['lines', '0', 'qty']);
    expect(parseRedactPath('matrix[][]')).toEqual(['matrix', '*', '*']);
  });
});

describe('redactData', () => {
  it('redacts every string and keeps numbers, booleans, null and the shape', () => {
    expect(redactData(order)).toEqual({
      customer: { name: 'Aaaa Aaa', email: 'aaaa@aaaa.aaa', vip: true, discount: null },
      iban: 'AA00 0000 0000 0000 0000 00',
      total: 1234.5,
      items: [
        { name: 'Aaaaaa', sku: 'A-00', qty: 2 },
        { name: 'Aaaaaa', sku: 'A-00', qty: 1 },
      ],
      notes: ['Aaaaa aa aaaa', 42],
    });
    expect(redactData(order, [])).toEqual(redactData(order));
  });

  it('redacts only the selected paths', () => {
    const result = redactData(order, ['customer.*', 'iban', 'items[].name']);
    expect(result.customer).toEqual({ name: 'Aaaa Aaa', email: 'aaaa@aaaa.aaa', vip: true, discount: null });
    expect(result.iban).toBe('AA00 0000 0000 0000 0000 00');
    expect(result.items).toEqual([
      { name: 'Aaaaaa', sku: 'W-01', qty: 2 },
      { name: 'Aaaaaa', sku: 'G-02', qty: 1 },
    ]);
    expect(result.notes).toEqual(['Leave at door', 42]);
    expect(redactData(order, ['items.*.sku']).items.map((i) => i.sku)).toEqual(['A-00', 'A-00']);
    expect(redactData(order, ['items[1].sku']).items.map((i) => i.sku)).toEqual(['W-01', 'A-00']);
  });

  it('redacts a whole branch, ignores paths that match nothing and never mutates the input', () => {
    const copy = structuredClone(order);
    const result = redactData(order, ['customer', 'nope.deeper', 'total.x']);
    expect(result.customer.email).toBe('aaaa@aaaa.aaa');
    expect(result.total).toBe(1234.5);
    expect(result.iban).toBe(order.iban);
    expect(order).toEqual(copy);
    expect(redactData('plain', ['x'])).toBe('plain');
    expect(redactData(null)).toBeNull();
  });
});
