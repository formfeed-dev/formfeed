import { inferSchemaFromDataSets } from './schema';
import { diffSchemas, type SchemaChangeKind } from './schema-diff';

const object = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});

type Row = [string, unknown, unknown, SchemaChangeKind, boolean, string];

// one row per line of spec 19 §3.1, in both directions where the reverse is meaningful
const rows: Row[] = [
  ['new required field', object({ a: { type: 'string' } }), object({ a: { type: 'string' }, b: { type: 'string' } }, ['b']), 'field-added-required', true, 'b'],
  ['new optional field', object({ a: { type: 'string' } }), object({ a: { type: 'string' }, b: { type: 'string' } }), 'field-added-optional', false, 'b'],
  ['optional becomes required', object({ a: { type: 'string' } }), object({ a: { type: 'string' } }, ['a']), 'field-became-required', true, 'a'],
  ['required becomes optional', object({ a: { type: 'string' } }, ['a']), object({ a: { type: 'string' } }), 'field-became-optional', false, 'a'],
  ['type narrowed by removing null', object({ a: { type: ['string', 'null'] } }), object({ a: { type: 'string' } }), 'type-narrowed', true, 'a'],
  ['number to integer', object({ a: { type: 'number' } }), object({ a: { type: 'integer' } }), 'type-narrowed', true, 'a'],
  ['integer to number', object({ a: { type: 'integer' } }), object({ a: { type: 'number' } }), 'type-widened', false, 'a'],
  ['any to string', object({ a: {} }), object({ a: { type: 'string' } }), 'type-narrowed', true, 'a'],
  ['enum value removed', object({ a: { enum: ['x', 'y'] } }), object({ a: { enum: ['x'] } }), 'enum-values-removed', true, 'a'],
  ['enum value added', object({ a: { enum: ['x'] } }), object({ a: { enum: ['x', 'y'] } }), 'enum-values-added', false, 'a'],
  ['enum added', object({ a: { type: 'string' } }), object({ a: { type: 'string', enum: ['x'] } }), 'enum-added', true, 'a'],
  ['const added', object({ a: { type: 'string' } }), object({ a: { type: 'string', const: 'x' } }), 'const-changed', true, 'a'],
  ['minimum tightened', object({ a: { type: 'number', minimum: 0 } }), object({ a: { type: 'number', minimum: 1 } }), 'constraint-tightened', true, 'a'],
  ['maxLength added', object({ a: { type: 'string' } }), object({ a: { type: 'string', maxLength: 10 } }), 'constraint-tightened', true, 'a'],
  ['maxLength relaxed', object({ a: { type: 'string', maxLength: 10 } }), object({ a: { type: 'string', maxLength: 20 } }), 'constraint-relaxed', false, 'a'],
  ['additionalProperties closed', object({ a: { type: 'string' } }), object({ a: { type: 'string' } }, [], { additionalProperties: false }), 'additional-properties-closed', true, ''],
  ['additionalProperties opened', object({ a: { type: 'string' } }, [], { additionalProperties: false }), object({ a: { type: 'string' } }), 'additional-properties-opened', false, ''],
  ['field removed from an open object', object({ a: { type: 'string' }, b: { type: 'string' } }), object({ a: { type: 'string' } }), 'field-removed', false, 'b'],
  ['field removed from a closed object', object({ a: {}, b: {} }, [], { additionalProperties: false }), object({ a: {} }, [], { additionalProperties: false }), 'field-removed', true, 'b'],
  ['format added', object({ a: { type: 'string' } }), object({ a: { type: 'string', format: 'email' } }), 'constraint-tightened', true, 'a'],
  ['unknown keyword changed', object({ a: { anyOf: [{ type: 'string' }] } }), object({ a: { anyOf: [{ type: 'number' }] } }), 'keyword-changed', true, 'a'],
];

describe('diffSchemas', () => {
  it.each(rows)('%s', (_name, previous, next, kind, breaking, path) => {
    const diff = diffSchemas(previous, next);
    const all = [...diff.breaking, ...diff.safe];
    const change = all.find((c) => c.kind === kind);
    expect(change, JSON.stringify(all)).toBeDefined();
    expect(change!.breaking).toBe(breaking);
    expect(change!.path).toBe(path);
  });

  it('finds nothing between equal schemas, whatever the key order or annotations', () => {
    const a = object({ a: { type: 'string', description: 'A', examples: ['x'] }, b: { type: 'integer' } }, ['a']);
    const b = { required: ['a'], properties: { b: { type: 'integer' }, a: { examples: ['y'], type: 'string' } }, type: 'object', title: 'T' };
    expect(diffSchemas(a, b)).toEqual({ breaking: [], safe: [] });
  });

  it('walks nested objects and array items with dotted paths and pointers', () => {
    const previous = object({ customer: object({ name: { type: 'string' } }), items: { type: 'array', items: object({ qty: { type: 'number' } }) } });
    const next = object({
      customer: object({ name: { type: 'string' }, email: { type: 'string' } }, ['email']),
      items: { type: 'array', items: object({ qty: { type: 'integer' } }) },
    });
    const { breaking } = diffSchemas(previous, next);
    expect(breaking.map((c) => [c.path, c.pointer])).toEqual([
      ['customer.email', '/properties/customer/properties/email'],
      ['items[].qty', '/properties/items/items/properties/qty'],
    ]);
  });

  it('follows local $ref on both sides', () => {
    const previous = { type: 'object', properties: { a: { $ref: '#/$defs/amount' } }, $defs: { amount: { type: 'number' } } };
    const next = { type: 'object', properties: { a: { $ref: '#/$defs/amount' } }, $defs: { amount: { type: 'integer' } } };
    expect(diffSchemas(previous, next).breaking.map((c) => c.kind)).toEqual(['type-narrowed']);
  });

  it('returns nothing when a side has no schema', () => {
    expect(diffSchemas(null, object({}))).toEqual({ breaking: [], safe: [] });
    expect(diffSchemas(object({}), undefined)).toEqual({ breaking: [], safe: [] });
  });
});

describe('inferSchemaFromDataSets', () => {
  it('requires a field only when every data set has it', () => {
    const schema = inferSchemaFromDataSets([
      { number: 'A-1', customer: { name: 'Jane', email: 'j@example.com' } },
      { number: 'A-2', customer: { name: 'Max' }, note: 'x' },
    ]);
    expect(schema.required).toEqual(['number', 'customer']);
    expect(schema.properties!['customer']!.required).toEqual(['name']);
    expect(schema.properties!['note']).toBeDefined();
  });
});
