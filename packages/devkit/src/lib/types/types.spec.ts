import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { generateTypes } from './index';
import { buildTypes, pascalCase, relaxRequired, singular, type TypeSource } from './model';

const invoice: TypeSource = {
  slug: 'invoice',
  origin: 'stored',
  version: 4,
  channel: 'published',
  schema: {
    type: 'object',
    required: ['number', 'customer', 'items', 'status'],
    properties: {
      number: { type: 'string', description: 'Invoice number as printed', examples: ['RE-2026-001'] },
      issued: { type: 'string', format: 'date' },
      status: { enum: ['draft', 'sent', 'paid'] },
      customer: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, email: { type: ['string', 'null'], format: 'email' }, address: { $ref: '#/$defs/address' } },
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['qty', 'price'],
          properties: { qty: { type: 'integer', minimum: 1 }, price: { type: 'number' }, note: { not: { const: '' } } },
        },
      },
      addresses: { type: 'array', items: { $ref: '#/$defs/address' } },
      tags: { type: 'array', items: { type: 'string' } },
      totals: { type: 'object', additionalProperties: { type: 'number' } },
      discount: { anyOf: [{ type: 'number' }, { type: 'object', properties: { percent: { type: 'number' } } }] },
    },
    $defs: {
      address: { type: 'object', required: ['city'], properties: { street: { type: 'string' }, city: { type: 'string' } } },
    },
  },
};

const odd: TypeSource = {
  slug: 'delivery-note',
  origin: 'inferred',
  schema: {
    type: 'object',
    required: ['first-name', 'class'],
    properties: { 'first-name': { type: 'string' }, class: { type: 'string' }, '2nd': { type: 'boolean' } },
  },
};

describe('model', () => {
  it('names and singulars', () => {
    expect(pascalCase('delivery-note')).toBe('DeliveryNote');
    expect(pascalCase('2fa-codes')).toBe('T2faCodes');
    expect(pascalCase('lineItems')).toBe('LineItems');
    expect(['items', 'addresses', 'entries', 'status', 'data'].map(singular)).toEqual(['item', 'address', 'entry', null, null]);
  });

  it('makes every field of an inferred schema optional', () => {
    expect(relaxRequired({ required: ['a'], properties: { a: { required: ['b'], properties: { b: {} } } } })).toEqual({
      properties: { a: { properties: { b: {} } } },
    });
  });

  it('names nested objects after the template, array elements in the singular, definitions once', () => {
    const [model] = buildTypes([invoice]);
    expect(model!.objects.map((o) => o.name)).toEqual([
      'InvoiceData',
      'InvoiceCustomer',
      'InvoiceAddress',
      'InvoiceItem',
      'InvoiceDiscountOption2',
    ]);
  });

  it('gives a schema that is not a plain object an alias instead of an interface', () => {
    const [model] = buildTypes([{ slug: 'list', origin: 'local', schema: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } }]);
    expect(model!.root).toEqual({ kind: 'array', items: { kind: 'ref', name: 'ListItem' } });
  });
});

describe('generateTypes', () => {
  it('TypeScript output', async () => {
    await expect(generateTypes([invoice, odd], 'ts')).toMatchFileSnapshot('./__snapshots__/formfeed.d.ts.snap');
  });

  it('Python output', async () => {
    await expect(generateTypes([invoice, odd], 'python')).toMatchFileSnapshot('./__snapshots__/formfeed_templates.py.snap');
  });

  it('is stable whatever order the templates come in', () => {
    expect(generateTypes([odd, invoice], 'ts')).toBe(generateTypes([invoice, odd], 'ts'));
  });

  it('compiles against the SDK and rejects data that does not fit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'formfeed-types-'));
    try {
      writeFileSync(join(dir, 'formfeed.d.ts'), generateTypes([invoice, odd], 'ts'));
      const good = `import { Formfeed } from '@formfeed/sdk';
const client = new Formfeed({ apiKey: 'ff_test_x' });
void client.renders.create({ template: 'invoice', data: { number: 'A', status: 'paid', customer: { name: 'Jane' }, items: [{ qty: 1, price: 2 }] } });
void client.renders.create({ template: 'delivery-note', data: {} });
void client.renders.create({ template: 'unknown', data: { anything: true } });
void client.renders.create({ html: '<p>x</p>' });
const slug: string = 'invoice';
void client.renders.create({ template: slug, data: { free: 1 } });
void client.renders.batch({ template: 'invoice', items: [{ data: { number: 'B', status: 'sent', customer: { name: 'M' }, items: [] } }] });
`;
      const bad = `import { Formfeed } from '@formfeed/sdk';
const client = new Formfeed({ apiKey: 'ff_test_x' });
void client.renders.create({ template: 'invoice', data: { number: 'A', status: 'lost', customer: { name: 'Jane' }, items: [] } });
void client.renders.create({ template: 'invoice', data: { numbr: 'A', status: 'paid', customer: { name: 'Jane' }, items: [] } });
void client.renders.create({ template: 'invoice' });
`;
      writeFileSync(join(dir, 'good.ts'), good);
      writeFileSync(join(dir, 'bad.ts'), bad);
      const sdk = resolve(__dirname, '../../../../sdk-ts/src/index.ts');
      const diagnostics = (file: string) => {
        const program = ts.createProgram([join(dir, file), join(dir, 'formfeed.d.ts')], {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
          skipLibCheck: true,
          baseUrl: dir,
          paths: { '@formfeed/sdk': [sdk] },
          types: [],
        });
        return ts
          .getPreEmitDiagnostics(program)
          .filter((d) => d.file?.fileName.endsWith(file))
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      };
      expect(diagnostics('good.ts')).toEqual([]);
      const errors = diagnostics('bad.ts');
      expect(errors).toHaveLength(3);
      expect(errors.join('\n')).toMatch(/"lost"/);
      expect(errors.join('\n')).toMatch(/numbr/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('Python output imports and type-checks where Python is available', () => {
    let python: string | null = null;
    for (const candidate of ['python', 'python3']) {
      try {
        execFileSync(candidate, ['-c', 'import typing_extensions, formfeed'], {
          stdio: 'ignore',
          env: { ...process.env, PYTHONPATH: resolve(__dirname, '../../../../sdk-python/src') },
        });
        python = candidate;
        break;
      } catch {
        // not installed, or without the SDK's dependencies
      }
    }
    if (!python) return;
    const dir = mkdtempSync(join(tmpdir(), 'formfeed-types-py-'));
    try {
      writeFileSync(join(dir, 'formfeed_templates.py'), generateTypes([invoice, odd], 'python'));
      const env = { ...process.env, PYTHONPATH: `${resolve(__dirname, '../../../../sdk-python/src')}${process.platform === 'win32' ? ';' : ':'}${dir}` };
      execFileSync(
        python,
        [
          '-c',
          [
            'import asyncio, typing, formfeed_templates as t',
            'typing.get_type_hints(t.InvoiceData); typing.get_type_hints(t.DeliveryNoteData)',
            'class R:',
            '    def create(self, **kw): return kw',
            'class C: renders = R()',
            'assert t.typed(C()).invoice({"number": "A"}, mode="async") == {"template": "invoice", "data": {"number": "A"}, "mode": "async"}',
            'assert t.typed(C()).delivery_note({}) == {"template": "delivery-note", "data": {}}',
            'class AR:',
            '    async def create(self, **kw): return kw',
            'class AC: renders = AR()',
            'assert asyncio.run(t.typed_async(AC()).invoice({})) == {"template": "invoice", "data": {}}',
          ].join('\n'),
        ],
        { env },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
