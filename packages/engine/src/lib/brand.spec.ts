import { renderVersion } from './assemble';
import { brandCss, emptyBrand, layeredPartials, normalisePartialName } from './brand';
import type { BrandContext } from './brand';
import { getEngine } from './engines';
import { defaultHelpers } from './helpers';
import { defaultLimits } from './limits';
import type { EngineId, RenderContext } from './types';

const brand: BrandContext = {
  ...emptyBrand(),
  version: 4,
  name: 'Fennlor Studio GmbH',
  colors: { primary: '#0f766e', accent: '#f59e0b' },
  fonts: { heading: 'Inter', body: null },
  font_size: '10pt',
  logo: { primary: 'https://cdn.example/a/brand/o/primary-1.svg', inverse: null, mark: null },
  legal_footer: 'Fennlor Studio GmbH · HRB 1',
};

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: defaultLimits,
  brand,
  ...overrides,
});

const render = async (engine: EngineId, source: string, data: unknown, ctx = context()) => {
  const e = getEngine(engine);
  return e.render(e.compile(source), data, ctx);
};

describe('brand global', () => {
  const sources: Record<EngineId, string> = {
    jinja2: '{{ brand.name }}|{{ brand.colors.primary }}|{{ brand.logo.primary }}',
    liquid: '{{ brand.name }}|{{ brand.colors.primary }}|{{ brand.logo.primary }}',
    handlebars: '{{brand.name}}|{{brand.colors.primary}}|{{brand.logo.primary}}',
  };

  for (const engine of ['jinja2', 'liquid', 'handlebars'] as const) {
    it(`${engine}: renders the kit and lets data of the same name win`, async () => {
      await expect(render(engine, sources[engine], { total: 1 })).resolves.toBe(
        'Fennlor Studio GmbH|#0f766e|https://cdn.example/a/brand/o/primary-1.svg',
      );
      await expect(
        render(engine, sources[engine], { brand: { name: 'Data', colors: { primary: 'red' }, logo: {} } }),
      ).resolves.toBe('Data|red|');
    });

    it(`${engine}: renders nothing for a missing kit`, async () => {
      await expect(render(engine, sources[engine], {}, context({ brand: undefined }))).resolves.toBe('||');
    });

    it(`${engine}: analyze does not report brand paths as missing sample data`, () => {
      const result = getEngine(engine).analyze(sources[engine], { sampleData: { total: 1 } });
      expect(result.diagnostics.filter((d) => d.message.includes('brand'))).toEqual([]);
    });
  }

  it('handlebars keeps a non-object root as it is', async () => {
    await expect(render('handlebars', '{{#each this}}{{.}}{{/each}}', ['a', 'b'])).resolves.toBe('ab');
  });
});

describe('brandCss', () => {
  it('writes the set values as custom properties', () => {
    expect(brandCss(brand)).toBe(
      ':root { --brand-color-primary: #0f766e; --brand-color-accent: #f59e0b; --brand-font-heading: "Inter"; --brand-font-size: 10pt; }',
    );
  });

  it('writes nothing for an empty kit and drops values that could leave the stylesheet', () => {
    expect(brandCss(emptyBrand())).toBe('');
    expect(brandCss(undefined)).toBe('');
    const hostile = brandCss({
      ...emptyBrand(),
      colors: { primary: 'red;}</style><script>', 'Bad Token': '#fff', ok: '#FFF' },
      fonts: { heading: 'Evil"</style>', body: null },
      font_size: '10pt; color: red',
    });
    expect(hostile).toBe(':root { --brand-color-ok: #FFF; --brand-font-heading: "Evil/style"; }');
  });
});

describe('renderVersion with a brand kit', () => {
  it('injects the variables before the reset and inlines them for header and footer', async () => {
    const rendered = await renderVersion(
      {
        engine: 'jinja2',
        html: '<h1 style="font-family: var(--brand-font-heading)">x</h1>',
        settings: { footer: { html: '{{ brand.legal_footer }}' } },
      },
      {},
      context(),
      'print',
      { fonts: [{ family: 'Inter', url: 'https://fonts.example/inter.woff2' }] },
    );
    const doc = rendered.document;
    expect(doc.indexOf('data-formfeed="fonts"')).toBeLessThan(doc.indexOf('data-formfeed="brand"'));
    expect(doc.indexOf('data-formfeed="brand"')).toBeLessThan(doc.indexOf('data-formfeed="reset"'));
    // the font is only named through the kit, and still gets its face
    expect(doc).toContain('font-family: "Inter"');
    expect(rendered.inlineCss).toContain('--brand-color-primary: #0f766e');
    expect(rendered.inlineCss).toContain('@font-face');
    expect(rendered.footerHtml).toBe('Fennlor Studio GmbH · HRB 1');
  });
});

describe('layeredPartials', () => {
  it('prefers the version partial, then matches shared ones by normalised name and reports them', () => {
    const read: string[] = [];
    const resolve = layeredPartials(
      { letterhead: 'own' },
      { letterhead: { source: 'shared', version: 2 }, footer: { source: 'shared footer', version: 5 } },
      (name, partial) => read.push(`${name}@${partial.version}`),
    );
    expect(resolve('letterhead')).toBe('own');
    expect(resolve('Footer.html')).toBe('shared footer');
    expect(resolve('missing')).toBeUndefined();
    expect(read).toEqual(['footer@5']);
  });

  it('does not treat inherited object keys as partials', () => {
    expect(layeredPartials({}, {})('toString')).toBeUndefined();
  });

  it('resolves shared partials in every engine, nested ones included', async () => {
    const partials = layeredPartials(undefined, {
      outer: { source: 'outer[{% include "inner" %}]', version: 1 },
      inner: { source: 'inner', version: 1 },
      'hb-outer': { source: 'outer[{{> hb-inner}}]', version: 1 },
      'hb-inner': { source: 'inner', version: 1 },
      'lq-outer': { source: "outer[{% render 'lq-inner' %}]", version: 1 },
      'lq-inner': { source: 'inner', version: 1 },
    });
    const ctx = context({ partials });
    await expect(render('jinja2', '{% include "outer.html" %}', {}, ctx)).resolves.toBe('outer[inner]');
    await expect(render('handlebars', '{{> hb-outer}}', {}, ctx)).resolves.toBe('outer[inner]');
    await expect(render('liquid', "{% render 'lq-outer' %}", {}, ctx)).resolves.toBe('outer[inner]');
  });

  it('normalises names like the database does', () => {
    expect(normalisePartialName('Letterhead.HTML')).toBe('letterhead');
    expect(normalisePartialName('footer.liquid')).toBe('footer');
    expect(normalisePartialName('a.b.hbs')).toBe('a.b');
  });
});
