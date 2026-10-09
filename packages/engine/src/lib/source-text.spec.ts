import { renderVersion, type TemplateSettings } from './assemble';
import { engineIds, getEngine } from './engines';
import { EngineSyntaxError } from './errors';
import { defaultHelpers } from './helpers';
import { defaultLimits } from './limits';
import type { RenderContext } from './types';

// A template's sources reach the engine from JSON (a version's settings, a render request's
// `settings`), and JSON can carry an object where a source belongs. Handlebars compiles an object as
// a parsed syntax tree, and up to 4.7.9 values of such a tree went into the generated code unchecked
// (GHSA-8r5x-fm3f-whwj): a header sent as a tree ran as JavaScript in the process that rendered it.

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: defaultLimits,
  ...overrides,
});

/** The advisory's proof with a mark instead of an error: a block whose program carries code as its `blockParams.length`. */
const tree = (): unknown => {
  const loc = { start: { line: 1, column: 0 } };
  return {
    type: 'Program',
    loc,
    body: [
      {
        type: 'BlockStatement',
        path: {
          type: 'PathExpression',
          data: false,
          depth: 0,
          parts: ['missingHelper'],
          original: 'missingHelper',
          loc,
        },
        params: [],
        program: {
          type: 'Program',
          blockParams: {
            length: '((globalThis.__formfeedInjected = true), 0)',
          },
          body: [],
          loc,
        },
        openStrip: { open: false, close: false },
        inverseStrip: { open: false, close: false },
        closeStrip: { open: false, close: false },
        loc,
      },
    ],
  };
};

const marks = globalThis as { __formfeedInjected?: boolean };
const injected = () => marks.__formfeedInjected === true;
afterEach(() => {
  delete marks.__formfeedInjected;
});

const renderWith = (settings: unknown) =>
  renderVersion(
    {
      engine: 'handlebars',
      html: '<p>Body</p>',
      settings: settings as TemplateSettings,
    },
    {},
    context(),
  );

describe('a template source that is not text', () => {
  it.each(engineIds)('is refused by %s before anything is compiled', (id) => {
    const engine = getEngine(id);
    for (const source of [tree(), ['{{ x }}'], 42, null])
      expect(() => engine.compile(source as string)).toThrow(EngineSyntaxError);
    expect(injected()).toBe(false);
  });

  it('is refused as the header, the footer and the PDF title, which a render request can set', async () => {
    for (const settings of [
      { header: { html: tree() } },
      { footer: { html: tree() } },
      { pdf: { metadata: { title: tree() } } },
    ]) {
      await expect(renderWith(settings)).rejects.toThrow(EngineSyntaxError);
      expect(injected()).toBe(false);
    }
  });

  it('is refused as a Handlebars partial', async () => {
    const engine = getEngine('handlebars');
    const ctx = context({
      partials: (name) => (name === 'part' ? (tree() as string) : undefined),
    });
    await expect(
      engine.render(engine.compile('<p>{{> part}}</p>'), {}, ctx),
    ).rejects.toThrow(/not text/);
    expect(injected()).toBe(false);
  });

  it('leaves text as it was', async () => {
    const rendered = await renderWith({
      header: { html: '<span>{{title}}</span>' },
      pdf: { metadata: { title: 'Report {{year}}' } },
    });
    expect(rendered.headerHtml).toBe('<span></span>');
    expect(rendered.title).toBe('Report');
  });
});
