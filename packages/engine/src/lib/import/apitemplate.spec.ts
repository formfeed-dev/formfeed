import { scaleLikeApitemplate } from '@formfeed/api-types';
import {
  importApitemplate,
  importApitemplateFromApi,
  isApitemplateHtmlTemplate,
  isApitemplateRegion,
  slugFromName,
  splitApitemplateCss,
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
    // bare numbers are pixels, as Chromium reads them; explicit units stay
    expect(result.settings.margin).toEqual({ top: '10px', bottom: '15mm' });
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

  it('moves link and script tags of the CSS field to the head', () => {
    const css = [
      '<script src="https://cdn.example/autofonts.js"> </script>',
      '<!--link rel="stylesheet" href="https://cdn.example/old.css"-->',
      "<link href='https://fonts.googleapis.com/css?family=Chivo' rel='stylesheet'>",
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />',
      '',
      '<style>',
      '  body { font-family: "Chivo", sans-serif; }',
      '</style>',
      '.loose { color: red }',
      '<style media="print">p { margin: 0 }</style>',
    ].join('\n');
    const result = importApitemplate({ name: 'Fonts', html: '<p>x</p>', css });
    expect(result.head).toBe(
      [
        '<script src="https://cdn.example/autofonts.js"> </script>',
        '<!--link rel="stylesheet" href="https://cdn.example/old.css"-->',
        "<link href='https://fonts.googleapis.com/css?family=Chivo' rel='stylesheet'>",
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" />',
      ].join('\n'),
    );
    expect(result.css).toBe('.loose { color: red }\n\n  body { font-family: "Chivo", sans-serif; }\n\np { margin: 0 }');
    expect(result.changes.join(' ')).toContain('Head tab');
    // plain CSS stays untouched
    expect(splitApitemplateCss('a > b { color: red }')).toEqual({ css: 'a > b { color: red }', head: '' });
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
      sample_json: '{"project": {"name": "Beispiel"}}',
    });
    expect(result).toMatchObject({ name: 'circuit-diagram', slug: 'circuit-diagram', kind: 'pdf', engine: 'jinja2', html: '<h1>{{ project.name }}</h1>', css: 'h1 { color: red }', errors: [] });
    expect(result.settings.paper?.format).toBe('A4');
    expect(result.settings.margin?.top).toBe('20px');
    expect(result.settings.footer?.html).toContain('pageNumber');
    // their editor's JSON becomes the default data set, and the template is checked against it
    expect(result.sampleData).toEqual({ project: { name: 'Beispiel' } });
    expect(result.warnings).toEqual([]);
    const missing = importApitemplateFromApi(item, { body: '<p>{{ offer.name }}</p>', sample_json: '{"offer": {}}' });
    expect(missing.warnings.map((w) => w.code)).toEqual(['unknown-variable']);
    const none = importApitemplateFromApi(item, { body: '<p>{{ offer.name }}</p>', sample_json: '' });
    expect(none.sampleData).toEqual({});
    expect(none.changes.join(' ')).toContain('no sample data');
  });

  it("rebuilds the header and footer text slots of apitemplate.io's stored settings", () => {
    // the example of their get-template response
    const result = importApitemplateFromApi(item, {
      body: '<p>x</p>',
      settings: JSON.stringify({
        paper_size: 'A4',
        orientation: '1',
        print_background: '1',
        margin_top: '40',
        header_right: '{{pageNumber}}/{{totalPages}}',
        footer_center: '{{pageNumber}}/{{totalPages}}',
        header_center: 'Sample <Invoice>',
        header_font_size: '11px',
        header_left: '{{date}}',
        footer_left: '{{date}}',
        custom_header: '',
        footer_font_size: '11',
        custom_footer: '<style>#header, #footer { padding: 0 !important; }</style>',
      }),
    });
    expect(result.warnings.filter((w) => w.code === 'setting-ignored')).toEqual([]);
    expect(result.settings.paper).toEqual({ format: 'A4', landscape: false });
    expect(result.settings.header?.html).toBe(
      scaleLikeApitemplate(
        '<div style="display:flex;gap:4mm;font-size:11px"><span style="flex:1;text-align:left"><span class="date"></span></span>' +
          '<span style="flex:1;text-align:center">Sample &lt;Invoice&gt;</span>' +
          '<span style="flex:1;text-align:right"><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>',
        'header',
      ),
    );
    // a custom footer of styles only keeps its styles above the slots
    expect(result.settings.footer?.html).toContain('<style>#header, #footer { padding: 0 !important; }</style><div style="display:flex;gap:4mm;font-size:11px">');
    expect(result.settings.footer?.html).toContain('<span style="flex:1;text-align:right"></span>');
    expect(result.changes.join(' ')).toContain('rebuilt as HTML');

    // custom markup wins over the slots
    const custom = importApitemplateFromApi(item, {
      body: '<p>x</p>',
      settings: { custom_header: '<table><tr><td>{{ pageNumber }}</td><td>{{ customer.name }}</td></tr></table>', header_left: 'ignored' },
    });
    expect(custom.settings.header?.html).toBe(
      scaleLikeApitemplate('<table><tr><td><span class="pageNumber"></span></td><td>{{ customer.name }}</td></tr></table>', 'header'),
    );
    expect(custom.warnings.filter((w) => w.code === 'setting-ignored')).toEqual([]);
    // header and footer stay off when the template turns them off
    const off = importApitemplateFromApi(item, { body: '<p>x</p>', settings: { displayHeaderFooter: false, header_left: 'x' } });
    expect(off.settings.header).toBeUndefined();
  });

  it('lets headers that clear their padding run edge to edge', () => {
    // as stored by apitemplate.io: the header resets only #header, the footer both boxes
    const result = importApitemplateFromApi(item, {
      body: '<p>x</p>',
      settings: {
        custom_header: '<style>#header {\n    padding: 0 !important;\n}</style>\n<div style="width: 100%">logo</div>',
        custom_footer: '<style>\n  #header, #footer {\n    padding: 0 !important;\n    font-family: Arial;\n  }\n</style><div>footer</div>',
      },
    });
    expect(result.settings.header).toMatchObject({ padding: '0' });
    expect(result.settings.footer).toMatchObject({ padding: '0' });
    expect(result.changes.join(' ')).toContain('edge to edge');
    // apitemplate.io draws header and footer a third larger: the markup is wrapped to match, the
    // footer growing from its bottom edge, and wrapping twice changes nothing
    expect(result.settings.header?.html).toMatch(/^<div data-formfeed-apitemplate-scale style="width:75%;transform:scale\(1\.333333\);transform-origin:top left"><style>#header/);
    expect(result.settings.footer?.html).toContain('transform-origin:bottom left');
    expect(scaleLikeApitemplate(result.settings.footer!.html!, 'footer')).toBe(result.settings.footer!.html);
    expect(result.changes.join(' ')).toContain('scaled by 4/3');
    // padding with a size, or none mentioned, keeps Formfeed's default
    const padded = importApitemplateFromApi(item, {
      body: '<p>x</p>',
      settings: { custom_header: '<style>#header { padding: 0 20px; }</style><div>h</div>', custom_footer: '<div>f</div>' },
    });
    expect(padded.settings.header?.padding).toBeUndefined();
    expect(padded.settings.footer?.padding).toBeUndefined();
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
