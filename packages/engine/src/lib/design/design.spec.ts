// @vitest-environment jsdom
import { renderVersion } from '../assemble';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';
import {
  designOutputHash,
  designStarters,
  emitDesign,
  googleFontsUrl,
  imageIsEmpty,
  nearestWeight,
  googleFont,
  parseDesign,
  defaultLayer,
  nextLayerId,
  emptyDesign,
  type DesignDocument,
  type DesignLayer,
} from './index';

const engines: EngineId[] = ['jinja2', 'liquid', 'handlebars'];
const size = { width: 1200, height: 630 };

/** A design with every layer type and option the emitter knows. */
const fixture: DesignDocument = {
  version: 1,
  output: '',
  background: { brand: 'primary', fallback: '#0f172a' },
  layers: [
    {
      id: 'title',
      name: 'Title',
      type: 'text',
      x: 80,
      y: 120,
      width: 1040,
      height: 240,
      rotation: 0,
      opacity: 1,
      visible: true,
      content: [
        { text: 'Invoice ' },
        { path: 'invoice.number' },
        { break: true },
        { text: 'for ' },
        { path: 'customer.name', format: { helper: 'upper' } },
      ],
      style: {
        font: { family: 'Inter', source: 'google' },
        weight: 750,
        size: 72,
        lineHeight: 1.1,
        letterSpacing: -1,
        color: { color: '#ffffff' },
        align: 'left',
      },
      sizing: 'shrink',
      minFontSize: 36,
      valign: 'middle',
    },
    {
      id: 'total',
      name: 'Total',
      type: 'text',
      x: 80,
      y: 400,
      width: 500,
      height: 60,
      rotation: -4,
      opacity: 0.9,
      visible: true,
      content: [
        { path: 'invoice.total', format: { helper: 'money' } },
        { text: ' due ' },
        {
          path: 'invoice.due',
          format: { helper: 'date', pattern: 'd MMMM yyyy' },
        },
      ],
      style: {
        font: { brand: 'heading' },
        weight: 600,
        size: 36,
        lineHeight: 1.2,
        letterSpacing: 0,
        color: { brand: 'accent', fallback: '#38bdf8' },
        align: 'right',
        italic: true,
        uppercase: true,
      },
      sizing: 'fixed',
      valign: 'top',
      maxLines: 1,
      fill: { color: '#00000033' },
      padding: 8,
      shadow: { x: 0, y: 2, blur: 4, color: '#00000080' },
      showWhen: { path: 'invoice.total' },
    },
    {
      id: 'logo',
      name: 'Logo',
      type: 'image',
      x: 960,
      y: 40,
      width: 200,
      height: 80,
      rotation: 0,
      opacity: 1,
      visible: true,
      source: { brandLogo: 'primary' },
      fit: 'contain',
      radius: 8,
    },
    {
      id: 'photo',
      name: 'Photo',
      type: 'image',
      x: 700,
      y: 400,
      width: 200,
      height: 200,
      rotation: 0,
      opacity: 1,
      visible: true,
      source: { asset: "team's photo.png" },
      fit: 'cover',
      focus: { x: 50, y: 20 },
      stroke: { width: 4, paint: { color: '#ffffff' } },
    },
    {
      id: 'badge',
      name: 'Badge',
      type: 'shape',
      shape: 'ellipse',
      x: 20,
      y: 20,
      width: 60,
      height: 60,
      rotation: 0,
      opacity: 1,
      visible: true,
      fill: { color: '#fbbf24' },
    },
    {
      id: 'hidden',
      name: 'Hidden',
      type: 'shape',
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      visible: false,
      fill: { color: '#000000' },
    },
    {
      id: 'qr',
      name: 'QR',
      type: 'qr',
      x: 1000,
      y: 460,
      width: 140,
      height: 140,
      rotation: 0,
      opacity: 1,
      visible: true,
      value: { path: 'invoice.url' },
      ecc: 'M',
      color: { brand: 'primary', fallback: '#111111' },
      background: null,
    },
    {
      id: 'ean',
      name: 'EAN',
      type: 'barcode',
      x: 80,
      y: 520,
      width: 300,
      height: 90,
      rotation: 0,
      opacity: 1,
      visible: true,
      value: { text: '4006381333931' },
      symbology: 'ean13',
      showText: true,
    },
  ],
};

const data = {
  invoice: {
    number: 'RE-1001',
    total: 1234.5,
    due: '2026-10-15',
    url: 'https://fennlor.test/i/1001',
  },
  customer: { name: 'Olvarest GmbH' },
};

const ctx: RenderContext = {
  locale: 'en-GB',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
  assetBaseUrl: 'https://cdn.test/a/ws',
  brand: {
    version: 1,
    name: 'Fennlor Studio',
    colors: { primary: '#0f172a' },
    fonts: { heading: 'Inter', body: null },
    font_size: null,
    logo: { primary: 'https://cdn.test/logo.png', inverse: null, mark: null },
    legal_footer: null,
  },
};

/** The rendered design as a DOM, so the three engines' different entity spellings compare equal. */
async function renderedDesign(
  engine: EngineId,
  design: DesignDocument,
  sample: unknown = data,
): Promise<string> {
  const { html, css } = emitDesign(design, engine, size);
  const out = await renderVersion(
    { engine, html, css, kind: 'image', settings: { image: size } },
    sample,
    ctx,
    'print',
  );
  const doc = new DOMParser().parseFromString(out.document, 'text/html');
  return doc.querySelector('.ff-design')?.outerHTML ?? '';
}

describe('parseDesign', () => {
  it('reads every starter and the fixture', () => {
    for (const starter of designStarters)
      expect(parseDesign(starter.design).problems, starter.id).toEqual([]);
    expect(parseDesign(fixture).problems).toEqual([]);
  });

  it('refuses what could write markup or CSS of its own', () => {
    const layer = (overrides: Record<string, unknown>) => ({
      ...fixture,
      layers: [{ ...fixture.layers[0], ...overrides }],
    });
    expect(parseDesign(layer({ id: 'Bad Id' })).problems).toEqual([
      'layer Bad Id: id is not valid',
    ]);
    expect(
      parseDesign(
        layer({
          style: {
            ...(fixture.layers[0] as { style: object }).style,
            font: { family: 'x";}body{color:red', source: 'google' },
          },
        }),
      ).problems,
    ).toEqual(['layer title: font is not valid']);
    expect(
      parseDesign(
        layer({
          style: {
            ...(fixture.layers[0] as { style: object }).style,
            color: { color: 'red;background:url(x)' },
          },
        }),
      ).problems,
    ).toEqual(['layer title: colour is not a colour']);
    expect(
      parseDesign(layer({ content: [{ path: 'a }}{{ b' }] })).problems,
    ).toEqual(['layer title: content path is not valid']);
    expect(parseDesign(layer({ type: 'video' })).problems).toEqual([
      'layer title: unknown layer type',
    ]);
    expect(
      parseDesign({
        ...fixture,
        layers: [fixture.layers[0], fixture.layers[0]],
      }).problems,
    ).toEqual(['layer title: id is used twice']);
    expect(parseDesign({ ...fixture, version: 2 }).problems).toEqual([
      'design: version must be 1',
    ]);
    expect(parseDesign('nope').problems).toEqual(['design: not an object']);
  });

  it('clamps numbers to sane ranges', () => {
    const parsed = parseDesign({
      ...fixture,
      layers: [{ ...fixture.layers[4], width: 1e9, opacity: 3, x: -1e9 }],
    });
    expect(parsed.design?.layers[0]).toMatchObject({
      width: 10000,
      opacity: 1,
      x: -10000,
    });
  });
});

describe('emitDesign', () => {
  for (const engine of engines)
    it(`${engine}: writes the fixture as it always did`, () => {
      const { html, css } = emitDesign(fixture, engine, size);
      expect(html).toMatchSnapshot('html');
      expect(css).toMatchSnapshot('css');
    });

  it('means the same in every engine', async () => {
    const [jinja2, liquid, handlebars] = await Promise.all(
      engines.map((engine) => renderedDesign(engine, fixture)),
    );
    expect(jinja2).toContain('RE-1001');
    expect(jinja2).toContain('OLVAREST GMBH');
    expect(jinja2).toContain('src="https://cdn.test/logo.png"');
    expect(jinja2).toContain('data:image/svg+xml');
    expect(liquid).toBe(jinja2);
    expect(handlebars).toBe(jinja2);
  });

  it('leaves out a layer whose showWhen path has no value', async () => {
    for (const engine of engines) {
      const out = await renderedDesign(engine, fixture, {
        ...data,
        invoice: { ...data.invoice, total: null },
      });
      expect(out, engine).not.toContain('data-ff-layer="total"');
      expect(out, engine).toContain('data-ff-layer="title"');
    }
  });

  it('shows literal text as typed, markup and template syntax included', async () => {
    const literal = `a < b & c {{ x }} {% if %} {# c #} "q" 'a'`;
    const design: DesignDocument = {
      ...emptyDesign(),
      layers: [
        {
          ...(defaultLayer('text', 'note', 'Note', size) as DesignLayer & {
            type: 'text';
          }),
          content: [{ text: literal }],
        },
      ],
    };
    for (const engine of engines) {
      const out = await renderedDesign(engine, design, {});
      const text = new DOMParser()
        .parseFromString(out, 'text/html')
        .querySelector('.ff-text')?.textContent;
      expect(text, engine).toBe(literal);
    }
  });

  it('maps each layer to its line and hashes its output', () => {
    const emitted = emitDesign(fixture, 'jinja2', size);
    expect(emitted.map['title']).toEqual({ start: 2, end: 2 });
    expect(emitted.map['hidden']).toBeUndefined();
    expect(emitted.html.split('\n')[emitted.map['qr']!.start - 1]).toContain(
      'data-ff-layer="qr"',
    );
    expect(emitted.output).toBe(designOutputHash(emitted.html, emitted.css));
    expect(designOutputHash(emitted.html, emitted.css)).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(designOutputHash(emitted.html, `${emitted.css} `)).not.toBe(
      emitted.output,
    );
    // a checkout with CRLF line ends is the same code
    expect(
      designOutputHash(
        emitted.html.replace(/\n/g, '\r\n'),
        emitted.css.replace(/\n/g, '\r\n'),
      ),
    ).toBe(emitted.output);
  });

  it('asks Google only for families and weights it serves', () => {
    expect(googleFontsUrl([])).toBeNull();
    expect(
      googleFontsUrl([{ family: 'Unknown', weight: 400, italic: false }]),
    ).toBeNull();
    expect(
      googleFontsUrl([
        { family: 'Inter', weight: 750, italic: false },
        { family: 'Inter', weight: 400, italic: true },
        { family: 'Bebas Neue', weight: 700, italic: true },
      ]),
    ).toBe(
      'https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&family=Inter:ital,wght@0,800;1,400&display=block',
    );
    expect(nearestWeight(googleFont('Lato')!, 500)).toBe(400);
    expect(nearestWeight(googleFont('Lato')!, 550)).toBe(700);
  });
});

describe('layers', () => {
  it('names new layers by type and places them in the middle', () => {
    const design = {
      ...emptyDesign(),
      layers: [defaultLayer('text', 'text-1', 'Text', size)],
    };
    expect(nextLayerId(design, 'text')).toBe('text-2');
    expect(nextLayerId(design, 'qr')).toBe('qr-1');
    // a new text is regular, so the editor's Bold starts switched off
    expect(design.layers[0]).toMatchObject({ style: { weight: 400 } });
    expect(defaultLayer('shape', 'shape-1', 'Shape', size)).toMatchObject({
      x: 480,
      y: 235,
      width: 240,
      height: 160,
    });
    // every new layer is a design the editor can go on with: it parses the design after each change,
    // and a new image that did not parse closed the canvas ("The design cannot be opened")
    for (const type of ['text', 'image', 'shape', 'qr', 'barcode'] as const) {
      const layer = defaultLayer(type, `${type}-1`, type, size);
      expect(
        parseDesign({ ...emptyDesign(), layers: [layer] }).problems,
        type,
      ).toEqual([]);
    }
  });

  it('draws a line under and through text, and its shadow', () => {
    const text = defaultLayer('text', 'note', 'Note', size) as DesignLayer & {
      type: 'text';
    };
    const css = (style: Partial<typeof text.style>, shadow?: object) => {
      const design = {
        ...emptyDesign(),
        layers: [
          {
            ...text,
            style: { ...text.style, ...style },
            ...(shadow ? { shadow } : {}),
          },
        ],
      };
      const parsed = parseDesign(design);
      expect(parsed.problems).toEqual([]);
      return emitDesign(parsed.design!, 'jinja2', size).css;
    };
    expect(css({})).not.toContain('text-decoration');
    expect(css({ strike: true })).toContain('text-decoration: line-through');
    expect(css({ underline: true, strike: true })).toContain(
      'text-decoration: underline line-through',
    );
    // a text layer's shadow follows the letters, not the box
    const shadowed = css({}, { x: 2, y: 4, blur: 8, color: '#00000080' });
    expect(shadowed).toContain('text-shadow: 2px 4px 8px #00000080');
    expect(shadowed).not.toContain('box-shadow');
  });

  it('keeps an image that is not chosen yet as an empty box', async () => {
    const image = defaultLayer('image', 'image-1', 'Image 1', size);
    expect(image.type === 'image' && imageIsEmpty(image.source)).toBe(true);
    for (const source of [{ url: '' }, { asset: '' }, { path: '' }]) {
      const design = {
        ...emptyDesign(),
        layers: [{ ...image, source } as DesignLayer],
      };
      expect(parseDesign(design).problems, JSON.stringify(source)).toEqual([]);
      for (const engine of engines) {
        const { html } = emitDesign(design, engine, size);
        // no request for an empty address, and no empty expression for an engine to refuse
        expect(html, engine).toContain(
          '<div class="ff-layer l-image-1" data-ff-layer="image-1"></div>',
        );
        expect(html, engine).not.toContain('<img');
        expect(await renderedDesign(engine, design, {}), engine).toContain(
          'data-ff-layer="image-1"',
        );
      }
    }
    expect(imageIsEmpty({ url: 'https://cdn.test/a.png' })).toBe(false);
    expect(imageIsEmpty({ brandLogo: 'primary' })).toBe(false);
    // a source that is there is still checked
    for (const source of [
      { url: 'cdn.test/a.png' },
      { asset: 'a"b.png' },
      { path: 'a b' },
    ])
      expect(
        parseDesign({
          ...emptyDesign(),
          layers: [{ ...image, source } as DesignLayer],
        }).design,
        JSON.stringify(source),
      ).toBeNull();
  });
});
