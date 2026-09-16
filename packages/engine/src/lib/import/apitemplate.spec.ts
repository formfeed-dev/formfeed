import {
  importApitemplate,
  importApitemplateFromApi,
  isApitemplateHtmlTemplate,
  isApitemplateRegion,
  slugFromName,
} from './apitemplate';

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

  it("hides the visual editor's loop wrappers and runs namespaces without errors", () => {
    const result = importApitemplate({
      name: 'Wrapped',
      html: '<table><tr class="apitemplate-is-content-hidden"><td>{%for r in rows%}</td></tr><tr><td>{{ r }}</td></tr><tr class="apitemplate-is-content-hidden"><td>{%endfor%}</td></tr></table>{% set ns = namespace(n=0) %}{% set ns.n = ns.n + 1 %}',
      css: 'td { padding: 2px }',
      sample_data: { rows: [1] },
    });
    expect(result.css).toBe('.apitemplate-is-content-hidden { display: none !important; }\ntd { padding: 2px }');
    expect(result.changes.join(' ')).toContain('apitemplate-is-content-hidden');
    expect(result.errors).toEqual([]);
    expect(importApitemplate({ name: 'Plain', html: '<p>x</p>' }).css).toBe('');
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

  it('does not report every variable as missing when there is no sample data', () => {
    const result = importApitemplate({ name: 'No sample', html: '<p>{{ customer.name }}</p>' });
    expect(result.warnings).toEqual([]);
    expect(result.changes.join(' ')).toContain('no sample data');
    const withSample = importApitemplate({ name: 'Sample', html: '<p>{{ customer.name }}</p>', sample_data: {} });
    expect(withSample.warnings.map((w) => w.code)).toEqual(['unknown-variable']);
  });
});

describe('apitemplate.io API import', () => {
  const item = { template_id: '3a677b23217dd954', name: 'circuit-diagram', format: 'PDF', group_name: 'MDS' };

  it('parses the settings string of get-template and keeps body and CSS', () => {
    const result = importApitemplateFromApi(item, {
      template_id: item.template_id,
      body: '<h1>{{ project.name }}</h1>',
      css: 'h1 { color: red }',
      settings: JSON.stringify({ paper_size: 'A4', orientation: '1', margin_top: '20', footer_template: '<span>{{ page_number }}</span>' }),
    });
    expect(result).toMatchObject({ name: 'circuit-diagram', slug: 'circuit-diagram', kind: 'pdf', engine: 'jinja2', html: '<h1>{{ project.name }}</h1>', css: 'h1 { color: red }', errors: [] });
    expect(result.settings.paper?.format).toBe('A4');
    expect(result.settings.margin?.top).toBe('20mm');
    expect(result.settings.footer?.html).toContain('pageNumber');
    expect(result.sampleData).toEqual({});
  });

  it('reports a missing body and unreadable settings instead of failing', () => {
    const empty = importApitemplateFromApi({ template_id: 'abc', name: '' }, { body: null, settings: '{broken' });
    expect(empty.name).toBe('abc');
    expect(empty.errors[0]?.code).toBe('no-body');
    expect(empty.warnings[0]?.code).toBe('settings-json');
    const objectSettings = importApitemplateFromApi(item, { body: '<p>x</p>', settings: { paper_size: 'Letter' } });
    expect(objectSettings.settings.paper?.format).toBe('Letter');
  });

  it('tells HTML templates from image templates and checks regions', () => {
    expect(isApitemplateHtmlTemplate({ format: 'PDF' })).toBe(true);
    expect(isApitemplateHtmlTemplate({ format: null })).toBe(true);
    expect(isApitemplateHtmlTemplate({ format: 'JPEG' })).toBe(false);
    expect(isApitemplateRegion('de')).toBe(true);
    expect(isApitemplateRegion('toString')).toBe(false);
    expect(isApitemplateRegion('eu')).toBe(false);
  });
});
