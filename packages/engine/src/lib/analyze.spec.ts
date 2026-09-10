import { engines } from './engines';

const sample = {
  invoice: {
    number: '1',
    lines: [{ description: 'a', price: 1 }],
    customer: { name: 'x' },
  },
  company: { name: 'Acme' },
};

describe('jinja2 analysis', () => {
  it('collects variables, loop sources, filters, includes and blocks', () => {
    const a = engines.jinja2.analyze(
      `{% include "footer" %}{% for line in invoice.lines %}{{ line.price | money }} {{ line.missing }}{% endfor %}{{ invoice.customer.phone }}{{ company.name | upper }}`,
      { sampleData: sample },
    );
    expect(a.includes.map((i) => i.name)).toEqual(['footer']);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]?.type).toBe('for');
    expect(a.blocks[0]?.close).toBeDefined();
    expect(a.filters.map((f) => f.name)).toEqual(['money', 'upper']);
    expect(a.filters.every((f) => f.known)).toBe(true);
    const reads = a.variables
      .filter((v) => v.kind === 'read')
      .map((v) => v.path.join('.'));
    expect(reads).toEqual([
      'invoice.lines',
      'invoice.customer.phone',
      'company.name',
    ]);
    const loopVars = a.variables
      .filter((v) => v.kind === 'loop-var')
      .map((v) => v.path.join('.'));
    expect(loopVars).toEqual(['line', 'line.price', 'line.missing']);
    const warnings = a.diagnostics
      .filter((d) => d.code === 'unknown-variable')
      .map((d) => d.message);
    expect(warnings).toEqual([
      '"line.missing" is not present in the sample data',
      '"invoice.customer.phone" is not present in the sample data',
    ]);
    expect(
      a.diagnostics.find((d) => d.code === 'unknown-variable')?.range.start
        .line,
    ).toBe(1);
  });

  it('reports unknown and deprecated filters with fixes', () => {
    const a = engines.jinja2.analyze(
      `{{ a | nope }}{{ b | currency_format('EUR') }}`,
    );
    expect(a.diagnostics.map((d) => d.code)).toEqual([
      'unknown-filter',
      'deprecated-filter',
    ]);
    expect(a.diagnostics[1]?.fix).toEqual({
      title: 'Rename to money',
      replacement: 'money',
    });
    expect(a.diagnostics[1]?.range).toEqual({
      start: { line: 1, column: 22 },
      end: { line: 1, column: 37 },
    });
  });

  it('reports unclosed and mismatched blocks even when the parser stops early', () => {
    const a = engines.jinja2.analyze(
      `{% if a %}\n{% for x in xs %}\n{% endif %}\n{% endfor %}`,
    );
    const codes = a.diagnostics.map((d) => d.code);
    expect(codes).toContain('mismatched-end-tag');
    expect(a.diagnostics[0]?.range.start.line).toBe(3);
    const b = engines.jinja2.analyze(`{% for x in xs %}{{ x }}`);
    expect(b.diagnostics.map((d) => d.code)).toContain('unclosed-block');
  });

  it('treats helper calls and assignments as known', () => {
    const a = engines.jinja2.analyze(
      `{% set total = invoice.lines | sum('price') %}{{ total | money }}{{ qrcode(invoice.number) }}`,
      { sampleData: sample },
    );
    expect(a.diagnostics).toEqual([]);
    expect(a.variables.find((v) => v.path[0] === 'total')?.kind).toBe(
      'assigned',
    );
    expect(a.filters.map((f) => f.name)).toEqual(['sum', 'money', 'qrcode']);
  });
});

describe('handlebars analysis', () => {
  it('resolves each/with scopes against the sample data', () => {
    const a = engines.handlebars.analyze(
      `{{#each invoice.lines}}{{money price}} {{missing}}{{/each}}{{#with invoice.customer as |c|}}{{c.name}}{{c.email}}{{/with}}{{unknownHelper x}}`,
      { sampleData: sample },
    );
    expect(a.filters.map((f) => [f.name, f.known])).toEqual([
      ['money', true],
      ['unknownHelper', false],
    ]);
    expect(a.diagnostics.map((d) => d.code).sort()).toEqual([
      'unknown-filter',
      'unknown-variable',
      'unknown-variable',
      'unknown-variable',
    ]);
    expect(a.diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        '"missing" is not present in the sample data',
        '"c.email" is not present in the sample data',
      ]),
    );
    expect(a.blocks.map((b) => b.type)).toEqual(['for', 'block']);
    expect(a.includes).toEqual([]);
  });

  it('reads a bare helper name and every argument as data, as the runtime does', () => {
    // `{{date}}` reads the field when there is one, and arguments are always data lookups, so all
    // of them belong in the schema; only a helper without parameters is a call when bare
    const a = engines.handlebars.analyze(
      `{{title}} {{number}} vom {{date}} {{upper customer}}{{pageBreak}}`,
    );
    expect(a.variables.map((v) => v.path.join('.'))).toEqual(['title', 'number', 'date', 'customer']);
    expect(a.filters.map((f) => f.name)).toEqual(['upper', 'pageBreak']);
  });

  it('maps parse errors to a line', () => {
    const a = engines.handlebars.analyze(`ok\n{{#if a}}\nno close`);
    expect(a.diagnostics[0]?.code).toBe('syntax-error');
    expect(a.diagnostics[0]?.range.start.line).toBeGreaterThanOrEqual(2);
  });
});

describe('liquid analysis', () => {
  it('extracts variables, filters and includes from tags and outputs', () => {
    const a = engines.liquid.analyze(
      `{% render "footer" %}{% for line in invoice.lines %}{{ line.price | money }}{% endfor %}{% assign t = invoice.number | upcase %}{{ invoice.customer.phone }}{{ x | nope }}`,
      { sampleData: sample },
    );
    expect(a.includes.map((i) => i.name)).toEqual(['footer']);
    expect(a.filters.map((f) => f.name)).toEqual(['money', 'upcase', 'nope']);
    expect(a.diagnostics.map((d) => d.code).sort()).toEqual([
      'unknown-filter',
      'unknown-variable',
      'unknown-variable',
    ]);
    expect(a.variables.find((v) => v.path[0] === 't')?.kind).toBe('assigned');
    expect(a.blocks[0]?.type).toBe('for');
  });

  it('reports syntax errors', () => {
    const a = engines.liquid.analyze(`{% if a %}oops`);
    expect(a.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});
