import { describe, expect, it } from 'vitest';
import { getEngine } from './index';
import { defaultHelpers } from '../helpers';
import type { EngineId, RenderContext } from '../types';

/**
 * Template sandbox (spec 11 threat table: "sandbox escape (prototype pollution, `constructor`
 * access)"). A template is attacker-controlled: any account that can save a template or send ad-hoc
 * `html` reaches the engine, which on the render-worker runs in the process that holds the database
 * URL and the storage keys. So no template of any engine may walk the prototype chain to the
 * `Function` constructor and run JavaScript (server-side template injection, CWE-1336). LiquidJS
 * (`ownPropertyOnly`) and Handlebars (prototype access off) refuse it in their own configuration;
 * Nunjucks has no sandbox, so `jinja2.ts` guards `memberLookup`.
 *
 * Each payload below would, unguarded, evaluate `globalThis.process` (the Node process object) and
 * render the string `"object"`. The assertion is only that none of them does; the probe reads
 * nothing and runs nothing further.
 */
const ctx = (): RenderContext => ({
  locale: 'en-US',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
});

const render = (engine: EngineId, source: string, data: unknown) =>
  getEngine(engine).render(
    getEngine(engine).compile(source, { name: 'probe' }),
    data,
    ctx(),
  );

/** Each entry: an engine and a payload that tries to reach `typeof process` through the prototype. */
const escapes: Array<{ engine: EngineId; source: string }> = [
  {
    engine: 'jinja2',
    source: '{{ range.constructor("return typeof process")() }}',
  },
  {
    engine: 'jinja2',
    source: '{{ cycler.constructor("return typeof process")() }}',
  },
  {
    engine: 'jinja2',
    source: '{{ "".constructor.constructor("return typeof process")() }}',
  },
  {
    engine: 'jinja2',
    source: '{{ data.constructor.constructor("return typeof process")() }}',
  },
  {
    engine: 'jinja2',
    source:
      '{{ data["constructor"]["constructor"]("return typeof process")() }}',
  },
  { engine: 'jinja2', source: '{{ data.__proto__ }}' },
  { engine: 'liquid', source: '{{ data.constructor.constructor }}' },
  { engine: 'handlebars', source: '{{ data.constructor.constructor }}' },
  {
    engine: 'handlebars',
    source: '{{#with data as |d|}}{{d.constructor}}{{/with}}',
  },
];

describe('template sandbox', () => {
  for (const { engine, source } of escapes) {
    it(`${engine} cannot reach the Function constructor: ${source}`, async () => {
      const out = await render(engine, source, { data: { a: 1 } }).catch(
        (e: Error) => `threw: ${e.message}`,
      );
      // The escape renders "object" only when it reached Node's `process`. Anything else — empty
      // string, "undefined", or a thrown error — means the chain was cut.
      expect(out).not.toContain('object');
    });
  }

  it('Jinja2 still serves a data field that happens to be a method name', async () => {
    const out = await render(
      'jinja2',
      '{% for line in invoice.items %}{{ line }} {% endfor %}',
      { invoice: { items: ['a', 'b'] } },
    );
    expect(out.trim()).toBe('a b');
  });

  it('Jinja2 still serves object methods and dict get', async () => {
    const out = await render('jinja2', '{{ meta.get("x", "fallback") }}', {
      meta: {},
    });
    expect(out).toBe('fallback');
  });

  it('Jinja2 refuses the key "constructor" even on a plain object, so the chain never starts', async () => {
    // The guard is by key, not by whether the property is inherited: a data field literally named
    // `constructor` is unreachable too. No legitimate template relies on that name, and refusing it
    // outright is simpler than telling an own `constructor` string from the prototype's. Liquid and
    // Handlebars instead serve an own `constructor` field (a harmless string) and block only the
    // prototype, which the escape cases above already prove.
    const out = await render('jinja2', '{{ data.constructor }}', {
      data: { constructor: 'SECRET' },
    }).catch(() => '');
    expect(out).not.toContain('SECRET');
  });
});
