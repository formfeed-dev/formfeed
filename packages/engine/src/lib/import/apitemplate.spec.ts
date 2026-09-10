import { importApitemplate, slugFromName } from './apitemplate';

describe('apitemplate.io importer', () => {
  it('maps settings, keeps the source and parses the sample data', () => {
    const result = importApitemplate({
      name: 'Rechnung DE',
      html: '<h1>{{ invoice.number }}</h1>{% for l in invoice.lines %}<p>{{ l.price | currency_format }}</p>{% endfor %}',
      css: 'h1 { color: red }',
      settings: {
        paper_size: 'A4',
        orientation: 'landscape',
        margin_top: '10',
        margin_bottom: '15mm',
        header_template: '<div>{{ page_number }} / {{ total_pages }}</div>',
        print_background: 1,
        unknown_thing: true,
      },
      sample_data: '{"invoice": {"number": "1", "lines": [{"price": 1}]}}',
    });
    expect(result.slug).toBe('rechnung-de');
    expect(result.kind).toBe('pdf');
    expect(result.engine).toBe('jinja2');
    expect(result.settings.paper).toEqual({ format: 'A4', landscape: true });
    expect(result.settings.margin).toEqual({ top: '10mm', bottom: '15mm' });
    expect(result.settings.header?.html).toContain('<span class="pageNumber"></span>');
    expect(result.settings.printBackground).toBe(true);
    expect(result.sampleData).toEqual({ invoice: { number: '1', lines: [{ price: 1 }] } });
    expect(result.errors).toEqual([]);
    // the alias works, and the report points at the preferred helper name
    expect(result.warnings.map((w) => w.code).sort()).toEqual(['deprecated-filter', 'setting-ignored']);
    expect(result.changes.join(' ')).toContain('currency_format');
    expect(result.changes.join(' ')).toContain('Header and Footer');
  });

  it('reports syntax errors, unknown filters, python-only constructs and missing sample keys', () => {
    const result = importApitemplate({
      name: 'Broken',
      html: [
        '<p>{{ total | fancy_filter }}</p>',
        '{% for x in items %}{% set last = x %}{{ loop.cycle("a", "b") }}{% endfor %}',
        '<p>{{ "%.2f" % (amount) }}</p>',
      ].join('\n'),
      sample_data: { items: [] },
    });
    // an unknown filter fails the render, so it is an error; the constructs are warnings
    expect(result.errors.map((e) => e.code)).toContain('unknown-filter');
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['set-in-loop', 'loop-cycle', 'python-format-operator']));
    expect(result.warnings.find((w) => w.code === 'loop-cycle')?.line).toBe(2);
    expect(result.warnings.every((w) => w.docs)).toBe(true);
    // Python's `is divisibleby 2` needs parentheses in Nunjucks: a syntax error plus the pointer
    const jinjaTest = importApitemplate({ name: 'Test', html: '{% if n is divisibleby 2 %}even{% endif %}' });
    expect(jinjaTest.errors[0]?.code).toBe('syntax-error');
    expect(jinjaTest.warnings.map((w) => w.code)).toContain('jinja-test');
    const broken = importApitemplate({ name: 'Syntax', html: '{% for x in %}' });
    expect(broken.errors[0]?.code).toBe('syntax-error');
  });

  it('turns JPEG templates into image templates and derives slugs', () => {
    const result = importApitemplate({ name: 'Social Card ✨', html: '<div>{{ title }}</div>', format: 'JPEG', settings: { output_image_type: 'jpeg', viewport_width: 800, viewport_height: 418 } });
    expect(result.kind).toBe('image');
    expect(result.settings.image).toEqual({ format: 'jpeg', width: 800, height: 418 });
    expect(result.slug).toBe('social-card');
    expect(slugFromName('!!')).toMatch(/^imported-/);
    const bad = importApitemplate({ name: 'x', html: '<p></p>', sample_data: '{not json' });
    expect(bad.warnings.map((w) => w.code)).toContain('sample-json');
  });
});
