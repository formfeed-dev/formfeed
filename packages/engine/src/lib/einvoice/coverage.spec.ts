import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EN16931_TERMS, carriesTerm } from './coverage';
import { checkInvoice, invoiceToCii, invoiceSchema } from './index';

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

/** Every field a caller can fill, dotted and with `[]` for the items of a list. */
function leaves(schema: JsonSchema, path = '', out: string[] = []): string[] {
  if (schema.type === 'object' && schema.properties) {
    for (const [key, child] of Object.entries(schema.properties))
      leaves(child, path ? `${path}.${key}` : key, out);
  } else if (schema.type === 'array' && schema.items) {
    leaves(schema.items, `${path}[]`, out);
  } else {
    // a value: text, a number, a code, or an identifier with its scheme
    out.push(path);
  }
  return out;
}

/** Sets a field named as the list names it; `[]` is the first item of a list that exists. */
function set(target: Record<string, any>, path: string, value: string): void {
  const keys = path.replace(/\[\]/g, '.0').split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys[keys.length - 1]!] = value;
}

/** The XML of the `simple` invoice with each term's first field set to a mark of its own. */
function marked(
  terms: ReadonlyArray<{ term: string; fields: readonly string[] }>,
  profile: 'basic' | 'en16931',
): string {
  const invoice = fixture('simple');
  for (const term of terms) set(invoice, term.fields[0]!, `MARK-${term.term}`);
  const check = checkInvoice(invoice, { profile });
  if (!check.ok) throw new Error(JSON.stringify(check.problems));
  return invoiceToCii(check.invoice, { profile });
}

describe('EN16931_TERMS', () => {
  it('lists the 164 business terms of the standard once each, in order', () => {
    const numbers = EN16931_TERMS.map((term) => Number(term.term.slice(3)));
    expect(numbers).toHaveLength(164);
    // the standard numbers its terms BT-1 to BT-165 and has no BT-4
    expect(numbers).toEqual(
      Array.from({ length: 165 }, (_, index) => index + 1).filter(
        (n) => n !== 4,
      ),
    );
    for (const term of EN16931_TERMS) expect(term.name.trim()).not.toBe('');
  });

  it('names fields that exist, and every field of the block has its term', () => {
    const fields = new Set(leaves(z.toJSONSchema(invoiceSchema) as JsonSchema));
    const named = new Set(EN16931_TERMS.flatMap((term) => term.fields));
    // a field the list names but the block does not have
    expect([...named].filter((field) => !fields.has(field))).toEqual([]);
    // a field of the block that no term names: a new one wants its line in coverage.ts
    expect([...fields].filter((field) => !named.has(field))).toEqual([]);
  });

  it('counts what the block carries', () => {
    expect(EN16931_TERMS.filter(carriesTerm)).toHaveLength(129);
    // the profile is the one term written from an option, not from the block
    expect(
      EN16931_TERMS.filter((term) => term.option).map((term) => term.term),
    ).toEqual(['BT-24']);
  });

  it('marks what the profile basic leaves out of the XML', () => {
    // the rounding amount is refused in basic rather than left out (check.spec.ts)
    const left = EN16931_TERMS.filter(
      (term) => term.en16931Only && term.term !== 'BT-114',
    );
    const full = marked(left, 'en16931');
    const basic = marked(left, 'basic');
    for (const term of left) {
      expect(full, term.term).toContain(`MARK-${term.term}`);
      expect(basic, term.term).not.toContain(`MARK-${term.term}`);
    }
  });

  it('keeps in basic what is not marked', () => {
    // the text fields among the terms basic carries; codes, amounts and dates have rules of their own
    const text = new Set([
      'buyer_reference',
      'order_reference',
      'contract_reference',
      'note',
      'seller.trading_name',
      'seller.tax_number',
      'buyer.trading_name',
      'delivery.name',
      'payment.reference',
      'payment.terms',
      'lines[].name',
      'lines[].note',
    ]);
    const kept = EN16931_TERMS.filter(
      (term) => !term.en16931Only && text.has(term.fields[0] ?? ''),
    );
    expect(kept).toHaveLength(text.size);
    const basic = marked(kept, 'basic');
    for (const term of kept)
      expect(basic, term.term).toContain(`MARK-${term.term}`);
  });
});
