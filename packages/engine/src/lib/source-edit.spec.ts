// @vitest-environment jsdom
import { renderVersion } from './assemble';
import { defaultHelpers } from './helpers';
import {
  applyRegionEdit,
  chipValues,
  editableRegion,
  editableRegionAt,
  findRegionAgain,
  regionChips,
  regionItems,
  translationItems,
  translationText,
  type EditableRegion,
  type EditItem,
} from './source-edit';
import { annotateSourcePositions } from './source-positions';
import { resolveTranslation, translationTarget } from './translation';
import type { EngineId, RenderContext } from './types';

const region = (
  source: string,
  engine: EngineId = 'jinja2',
  at = source.indexOf('<'),
): EditableRegion => {
  const found = editableRegionAt(source, engine, at);
  if ('reason' in found) throw new Error(`no region: ${found.reason}`);
  return found;
};
const reason = (source: string, engine: EngineId = 'jinja2') => {
  const found = editableRegionAt(source, engine, source.indexOf('<'));
  return 'reason' in found ? found.reason : found.kind;
};
const edit = (
  source: string,
  items: EditItem[],
  engine: EngineId = 'jinja2',
) => {
  const result = applyRegionEdit(source, engine, region(source, engine), items);
  if ('error' in result) throw new Error(result.error);
  return result.source;
};
const text = (t: string): EditItem => ({ kind: 'text', text: t });
const chip = (index: number): EditItem => ({ kind: 'chip', index });

describe('editableRegion', () => {
  it('reads literal text, output tags as chips and line breaks', () => {
    const source =
      '<p class="x">Dear {{ customer.name }},<br>thanks &amp; bye</p>';
    const r = region(source);
    expect(r).toMatchObject({
      kind: 'text',
      tag: 'p',
      tagStart: 0,
      start: 13,
      end: source.indexOf('</p>'),
      outerEnd: source.length,
    });
    expect(regionItems(source, r)).toEqual([
      text('Dear '),
      chip(0),
      text(','),
      { kind: 'break' },
      text('thanks & bye'),
    ]);
    expect(regionChips(source, r)).toEqual([
      {
        index: 0,
        kind: 'expression',
        label: 'customer.name',
        source: '{{ customer.name }}',
      },
    ]);
  });

  it('takes a field that stands alone, and text typed on either side of it', () => {
    const source = '<h1>{{ title }}</h1>';
    expect(regionItems(source, region(source))).toEqual([chip(0)]);
    expect(edit(source, [text('Re: '), chip(0), text(' (draft)')])).toBe(
      '<h1>Re: {{ title }} (draft)</h1>',
    );
    expect(
      edit('<td>\n  {{ item.qty }}\n</td>', [chip(0), text(' pcs')]),
    ).toContain('{{ item.qty }} pcs');
    expect(edit('<td>{{qty}}</td>', [text('x '), chip(0)], 'handlebars')).toBe(
      '<td>x {{qty}}</td>',
    );
    // the value: the whole rendered text is the field's
    expect(chipValues('Hello', [chip(0)])).toEqual(['Hello']);
  });

  it('finds the start tag by the line and column data-ff-src names', () => {
    const source = '<main>\n  <h1>Invoice {{ no }}</h1>\n</main>';
    const found = editableRegion(source, 'jinja2', { line: 2, column: 3 });
    expect('reason' in found ? found.reason : found.tag).toBe('h1');
    expect(editableRegion(source, 'jinja2', { line: 9, column: 1 })).toEqual({
      reason: 'not-an-element',
    });
    // the main element holds a block child
    expect(editableRegion(source, 'jinja2', { line: 1, column: 1 })).toEqual({
      reason: 'block-child',
    });
  });

  it('keeps inline children, comments and unknown character references as chips', () => {
    const source =
      '<p>Due in <strong>14 <em>days</em></strong>{# note #}<!-- x --> &zwsp; ok</p>';
    const chips = regionChips(source, region(source));
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ['element', '<strong>'],
      ['comment', 'comment'],
      ['comment', 'comment'],
      ['entity', '&zwsp;'],
    ]);
    expect(chips[0]?.source).toBe('<strong>14 <em>days</em></strong>');
  });

  it('refuses what the preview cannot edit, and says why', () => {
    expect(reason('<p>{% if paid %}Paid{% endif %}</p>')).toBe('control-flow');
    expect(reason('<p>{% for x in xs %}{{ x }}{% endfor %}</p>')).toBe(
      'control-flow',
    );
    expect(reason('<p>{{#if paid}}Paid{{/if}}</p>', 'handlebars')).toBe(
      'control-flow',
    );
    expect(reason('<p>Hi {{> footer}}</p>', 'handlebars')).toBe('control-flow');
    expect(reason('<p>A {{else}} B</p>', 'handlebars')).toBe('control-flow');
    expect(reason('<div>Intro <p>para</p></div>')).toBe('block-child');
    expect(reason('<td> </td>')).toBe('no-text');
    expect(reason('<p><strong>{{ item.qty }}</strong></p>')).toBe('no-text');
    expect(reason('<img src="a.png">')).toBe('void');
    expect(reason('<br/>')).toBe('void');
    expect(reason('<style>p{}</style>')).toBe('raw-text');
    expect(reason('<p>Hi <textarea>x</textarea></p>')).toBe('raw-text');
    expect(reason('<p>Hi <b>open</p>')).toBe('unclosed');
    expect(reason('<p>no end')).toBe('unclosed');
    expect(reason('<h{{ level }}>T</h{{ level }}>')).toBe('dynamic-tag');
  });

  it('reads output tags with whitespace control, triple stashes and a lone brace', () => {
    expect(
      regionChips('<p>a {{- x -}} b</p>', region('<p>a {{- x -}} b</p>')).map(
        (c) => c.label,
      ),
    ).toEqual(['x']);
    expect(
      regionChips(
        '<p>a {{{html}}} b</p>',
        region('<p>a {{{html}}} b</p>', 'handlebars'),
      ).map((c) => c.label),
    ).toEqual(['html']);
    expect(
      regionItems(
        '<p>{ not a tag } a < b</p>',
        region('<p>{ not a tag } a < b</p>'),
      ),
    ).toEqual([text('{ not a tag } a < b')]);
  });

  it('knows a region that is one t() call in each engine', () => {
    expect(region(`<th>{{ t('table.qty') }}</th>`)).toMatchObject({
      kind: 't',
      key: 'table.qty',
      params: {},
    });
    expect(
      region(
        `<p>\n  {{ t("due", { days: terms.days, date: invoice.due }) }}\n</p>`,
      ),
    ).toMatchObject({
      kind: 't',
      key: 'due',
      params: { days: 'terms.days', date: 'invoice.due' },
    });
    expect(region(`<th>{{ 'table.qty' | t }}</th>`, 'liquid')).toMatchObject({
      kind: 't',
      key: 'table.qty',
    });
    expect(
      region(`<p>{{ 'due' | t: days: terms.days }}</p>`, 'liquid'),
    ).toMatchObject({ kind: 't', params: { days: 'terms.days' } });
    expect(region(`<th>{{t 'table.qty'}}</th>`, 'handlebars')).toMatchObject({
      kind: 't',
      key: 'table.qty',
    });
    expect(
      region(`<p>{{t "due" days=terms.days}}</p>`, 'handlebars'),
    ).toMatchObject({ kind: 't', params: { days: 'terms.days' } });
    // a t call among other text is an ordinary chip
    expect(region(`<p>No. {{ t('no') }}</p>`).kind).toBe('text');
  });

  it('finds a region again after the source changed around it', () => {
    const before = '<h1>Invoice {{ no }}</h1>';
    const moved = `<header>logo</header>\n${before}`;
    const again = findRegionAgain(moved, 'jinja2', before);
    expect(again?.tagStart).toBe(moved.indexOf('<h1>'));
    expect(findRegionAgain(`${before}${before}`, 'jinja2', before)).toBeNull();
    expect(findRegionAgain('<h1>Other</h1>', 'jinja2', before)).toBeNull();
  });
});

describe('applyRegionEdit', () => {
  it('rewrites only the changed stretch, so indentation and references survive', () => {
    const source =
      '<p>\n    Dear {{ name }},\n    thank you for&nbsp;your order.\n  </p>';
    const items = regionItems(source, region(source));
    const changed = items.map((item) =>
      item.kind === 'text' && item.text.includes('thank')
        ? text(item.text.replace('order', 'purchase'))
        : item,
    );
    expect(edit(source, changed)).toBe(
      '<p>\n    Dear {{ name }},\n    thank you for&nbsp;your purchase.\n  </p>',
    );
  });

  it('deletes a chip with its expression and leaves the others', () => {
    const source = '<p>{{ a }} and {{ b }}</p>';
    expect(edit(source, [text(' and '), chip(1)])).toBe('<p> and {{ b }}</p>');
    expect(edit(source, [chip(0), text(' & '), chip(1)])).toBe(
      '<p>{{ a }} &amp; {{ b }}</p>',
    );
  });

  it('refuses chips out of order, repeated or unknown', () => {
    const source = '<p>{{ a }} and {{ b }}</p>';
    const r = region(source);
    expect(applyRegionEdit(source, 'jinja2', r, [chip(1), chip(0)])).toEqual({
      error: 'chips',
    });
    expect(applyRegionEdit(source, 'jinja2', r, [chip(0), chip(0)])).toEqual({
      error: 'chips',
    });
    expect(applyRegionEdit(source, 'jinja2', r, [chip(2)])).toEqual({
      error: 'chips',
    });
  });

  it('writes line breaks in the spelling the region uses', () => {
    const source = '<address>Musterstraße 1<br />12345 Musterstadt</address>';
    expect(
      edit(source, [
        text('Musterstraße 1'),
        { kind: 'break' },
        text('Etage 2'),
        { kind: 'break' },
        text('12345 Musterstadt'),
      ]),
    ).toBe(
      '<address>Musterstraße 1<br />Etage 2<br />12345 Musterstadt</address>',
    );
    expect(edit('<p>a</p>', [text('a'), { kind: 'break' }, text('b')])).toBe(
      '<p>a<br>b</p>',
    );
  });

  it('escapes markup and anything that could open template syntax', () => {
    expect(edit('<p>x</p>', [text('a < b & c > d')])).toBe(
      '<p>a &lt; b &amp; c &gt; d</p>',
    );
    expect(
      edit('<p>x</p>', [text('{{ oops }} and {% no %} and {# c #}')]),
    ).toBe('<p>&#123;{ oops }} and &#123;% no %} and &#123;# c &#35;}</p>');
    // a brace typed before a kept chip would meet its braces
    expect(edit('<p>x {{ a }}</p>', [text('x {'), chip(0)])).toBe(
      '<p>x &#123;{{ a }}</p>',
    );
    // a kept brace meeting a typed percent sign is written anew
    expect(edit('<p>x {</p>', [text('x {% y')])).toBe('<p>x &#123;% y</p>');
    // Nunjucks ends a comment at `#}` even in plain text
    expect(edit('<p>x</p>', [text('see #} here')])).toBe(
      '<p>see &#35;} here</p>',
    );
    expect(edit('<p>a #</p>', [text('a #} b')])).toBe('<p>a &#35;} b</p>');
  });

  it('turns the space a browser types as a no-break space into a space, unless the text had one', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(edit('<p>a</p>', [text(`a${nbsp}b`)])).toBe('<p>a b</p>');
    expect(edit('<p>a&nbsp;b</p>', [text(`a${nbsp}c`)])).toBe(
      '<p>a&nbsp;c</p>',
    );
  });

  it('writes Liquid and Handlebars regions too', () => {
    expect(
      edit(
        '<p>Hi {{ name | upcase }}!</p>',
        [text('Hello '), chip(0), text('!')],
        'liquid',
      ),
    ).toBe('<p>Hello {{ name | upcase }}!</p>');
    expect(
      edit(
        '<p>Hi {{name}}!</p>',
        [text('Hello '), chip(0), text('!')],
        'handlebars',
      ),
    ).toBe('<p>Hello {{name}}!</p>');
  });

  const ctx: RenderContext = {
    locale: 'en',
    timezone: 'UTC',
    currency: 'EUR',
    partials: () => undefined,
    helpers: defaultHelpers(),
    limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
  };
  const renderedText = async (engine: EngineId, html: string) => {
    const out = await renderVersion(
      { engine, html },
      { name: 'Erika' },
      ctx,
      'print',
    );
    return (
      new DOMParser()
        .parseFromString(out.document, 'text/html')
        .querySelector('p')?.textContent ?? null
    );
  };

  /** A seeded generator, so a failure names the case that broke. */
  function* randomTexts(seed: number, count: number): Generator<string> {
    const alphabet = [
      'a',
      'Z',
      ' ',
      '<',
      '>',
      '&',
      '"',
      "'",
      '{',
      '}',
      '%',
      '#',
      '{{',
      '{%',
      '}}',
      '#}',
      '&amp;',
      String.fromCharCode(0xa0),
      'ü',
      '€',
      '\n',
    ];
    let state = seed;
    for (let n = 0; n < count; n++) {
      let out = '';
      const length = 1 + (n % 12);
      for (let k = 0; k < length; k++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        out += alphabet[state % alphabet.length];
      }
      yield out;
    }
  }

  for (const engine of ['jinja2', 'liquid', 'handlebars'] as const) {
    it(`${engine}: renders exactly the typed text around the chip`, async () => {
      const name = engine === 'handlebars' ? '{{name}}' : '{{ name }}';
      const source = `<p>Hello ${name} world</p>`;
      for (const typed of randomTexts(engine.length * 7919, 80)) {
        const written = edit(
          source,
          [text(typed), chip(0), text(' world')],
          engine,
        );
        const nbsp = new RegExp(String.fromCharCode(0xa0), 'g');
        expect(await renderedText(engine, written), JSON.stringify(typed)).toBe(
          `${typed.replace(nbsp, ' ')}Erika world`,
        );
      }
    });
  }
});

describe('chipValues', () => {
  it('reads each chip value off the rendered text', () => {
    expect(
      chipValues('Dear Erika Mustermann, thanks', [
        text('Dear '),
        chip(0),
        text(', thanks'),
      ]),
    ).toEqual(['Erika Mustermann']);
    expect(chipValues('3 × 4.00 €', [chip(0), text(' × '), chip(1)])).toEqual([
      '3',
      '4.00 €',
    ]);
  });

  it('gives up where two placements fit or none does', () => {
    // the value repeats the literal
    expect(chipValues('a, b, c', [chip(0), text(', '), chip(1)])).toBeNull();
    // two chips side by side
    expect(chipValues('ab', [chip(0), chip(1)])).toBeNull();
    expect(chipValues('Hi there', [text('Hello '), chip(0)])).toBeNull();
  });
});

describe('translations', () => {
  it('turns placeholders into chips and back', () => {
    const { items, names } = translationItems('Due in {days} days, by {date}.');
    expect(items).toEqual([
      text('Due in '),
      chip(0),
      text(' days, by '),
      chip(1),
      text('.'),
    ]);
    expect(names).toEqual(['days', 'date']);
    expect(
      translationText([text('Pay within '), chip(0), text(' days.')], names),
    ).toBe('Pay within {days} days.');
  });

  it('resolves like the t helper and names where the text came from', () => {
    const dicts = {
      de: { title: 'Rechnung' },
      'de-AT': { title: 'Faktura' },
      en: { title: 'Invoice', only: 'English' },
    };
    expect(resolveTranslation(dicts, 'de-AT', 'title')).toEqual({
      text: 'Faktura',
      from: 'de-AT',
    });
    expect(resolveTranslation(dicts, 'de-DE', 'title')).toEqual({
      text: 'Rechnung',
      from: 'de',
    });
    expect(resolveTranslation(dicts, 'de-DE', 'only')).toEqual({
      text: 'English',
      from: 'en',
    });
    expect(resolveTranslation(dicts, 'de-DE', 'missing')).toEqual({
      text: 'missing',
      from: null,
    });
  });

  it('never writes an edit made in German into the English dictionary', () => {
    const dicts = {
      de: { title: 'Rechnung' },
      'de-AT': {},
      en: { only: 'English' },
    };
    expect(translationTarget(dicts, 'de-DE', 'title')).toBe('de');
    expect(translationTarget(dicts, 'de-DE', 'only')).toBe('de');
    expect(translationTarget(dicts, 'de-AT', 'only')).toBe('de-AT');
    expect(translationTarget(dicts, 'en-GB', 'only')).toBe('en');
    expect(translationTarget(undefined, 'fr-FR', 'x')).toBe('fr');
  });
});

describe('annotating editable regions', () => {
  it('marks text and t regions and nothing else', () => {
    const source = `<main><h1>Invoice {{ no }}</h1><th>{{ t('qty') }}</th><td>{{ qty }}</td><p>{% if a %}A{% endif %}</p></main>`;
    const out = annotateSourcePositions(source, 'jinja2', 'body', {
      editable: true,
    });
    expect(out).toContain('<h1 data-ff-src="body:1:7" data-ff-edit="text">');
    expect(out).toContain(`<th data-ff-src="body:1:32" data-ff-edit="t">`);
    // a field alone takes text beside it
    expect(out).toMatch(/<td data-ff-src="body:1:\d+" data-ff-edit="text">/);
    expect(out).toMatch(/<p data-ff-src="body:1:\d+">/);
    expect(out).toMatch(/<main data-ff-src="body:1:1">/);
    expect(annotateSourcePositions(source, 'jinja2', 'body')).not.toContain(
      'data-ff-edit',
    );
  });

  it('changes nothing else in the rendered document', async () => {
    const ctx: RenderContext = {
      locale: 'en',
      timezone: 'UTC',
      currency: 'EUR',
      partials: () => undefined,
      helpers: defaultHelpers(),
      limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
      i18n: { en: { qty: 'Quantity' } },
    };
    const html = `<table><tr><th>{{ t('qty') }}</th></tr>{% for l in lines %}<tr><td class="n">Item {{ l.n }}</td></tr>{% endfor %}</table><p>Total: <b>{{ total }}</b><br>thanks</p>`;
    const data = { lines: [{ n: 1 }, { n: 2 }], total: '9 €' };
    const plain = await renderVersion(
      { engine: 'jinja2', html },
      data,
      ctx,
      'preview',
    );
    const annotated = await renderVersion(
      {
        engine: 'jinja2',
        html: annotateSourcePositions(html, 'jinja2', 'body', {
          editable: true,
        }),
      },
      data,
      ctx,
      'preview',
    );
    // the two rows of the loop, the paragraph and the field alone in its `b`
    expect(annotated.document.match(/data-ff-edit="text"/g)).toHaveLength(4);
    expect(annotated.document.replace(/ data-ff-(src|edit)="[^"]*"/g, '')).toBe(
      plain.document,
    );
  });
});
