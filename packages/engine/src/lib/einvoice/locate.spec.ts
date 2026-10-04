import { invoicePathSegments, locateJsonPath } from './locate';

const text = `{
  "customer": { "name": "Olvarest GmbH" },
  "_invoice": {
    "number": "RE-2026-0042",
    "lines": [
      { "id": "1", "name": "Consulting", "unit_code": "HUR" },
      {
        "id": "2",
        "name": "A \\"quoted\\" name, with { braces } and [ brackets ]",
        "tax": { "category": "S", "rate": 19 }
      }
    ],
    "payment": { "means_code": "58" },
    "totals": {"grand":3760.4,"due":3760.4}
  }
}`;

describe('invoicePathSegments', () => {
  it('splits a path of a finding into keys and indexes', () => {
    expect(invoicePathSegments('number')).toEqual(['number']);
    expect(invoicePathSegments('lines[1].tax.rate')).toEqual([
      'lines',
      1,
      'tax',
      'rate',
    ]);
    expect(invoicePathSegments('lines[0].allowances[2].amount')).toEqual([
      'lines',
      0,
      'allowances',
      2,
      'amount',
    ]);
    expect(invoicePathSegments('')).toEqual([]);
  });
});

describe('locateJsonPath', () => {
  const at = (path: string): [number, number, number] | null => {
    const found = locateJsonPath(text, [
      '_invoice',
      ...invoicePathSegments(path),
    ]);
    return found ? [found.line, found.column, found.depth] : null;
  };

  it('finds a key by its line and column', () => {
    expect(at('number')).toEqual([4, 5, 2]);
    expect(at('payment.means_code')).toEqual([13, 18, 3]);
    // minified JSON has columns too
    expect(at('totals.due')).toEqual([14, 31, 3]);
  });

  it('finds an item of a list, and what is inside it', () => {
    expect(at('lines[0]')).toEqual([6, 7, 3]);
    expect(at('lines[0].unit_code')).toEqual([6, 42, 4]);
    expect(at('lines[1].tax.rate')).toEqual([10, 35, 5]);
  });

  it('is not misled by quotes, braces and brackets inside a string', () => {
    expect(at('lines[1].tax')).toEqual([10, 9, 4]);
  });

  it('marks the deepest part that exists when the rest is missing', () => {
    // payment has no iban: the finding sits at payment
    expect(at('payment.iban')).toEqual([13, 5, 2]);
    // the second line has no unit_code: the finding sits at that line
    expect(at('lines[1].unit_code')).toEqual([7, 7, 3]);
    // no such line at all: at the list
    expect(at('lines[5].name')).toEqual([5, 5, 2]);
    // no seller: at the block itself
    expect(at('seller.vat_id')).toEqual([3, 3, 1]);
  });

  it('marks the start of the text when not even the block is there', () => {
    expect(locateJsonPath('{ "invoice": {} }', ['_invoice', 'number'])).toEqual(
      { line: 1, column: 1, depth: 0 },
    );
    expect(locateJsonPath('  \n ', ['_invoice'])).toBeNull();
  });

  it('answers with what it reached when the text is not JSON after all', () => {
    const broken = '{ "_invoice": { "number": "1", "lines": [ { "id": 1 ';
    expect(locateJsonPath(broken, ['_invoice', 'lines', 0, 'name'])).toEqual({
      line: 1,
      column: 43,
      depth: 3,
    });
  });
});
