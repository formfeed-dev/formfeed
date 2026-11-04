import { describe, expect, it } from 'vitest';
import { getEngine } from './index';
import { defaultHelpers } from '../helpers';
import { EngineSyntaxError, RenderError, RenderLimitError } from '../errors';
import { tick } from '../limits';
import type { EngineId, RenderContext } from '../types';

/**
 * A render's time limit, checked from inside it (plan 27, step 0). A render is synchronous, so nothing
 * outside it can stop it: before this, a template with a loop of a few million steps held the
 * render-worker's event loop for seconds, and one with two nested loops of 20,000 for minutes, while
 * no other render, health check or queue claim moved. Each case below would run for minutes without
 * the limit; with it, the render ends at its limit with `RenderLimitError('ms')`, which the
 * render-worker answers with 504 `render_timeout`.
 */
const LIMIT_MS = 200;
/** What a loaded CI runner may add to the limit before the render is seen to end. */
const SLACK_MS = 1500;

const ctx = (ms = LIMIT_MS): RenderContext => ({
  locale: 'en-US',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
});

const render = (
  engine: EngineId,
  source: string,
  data: unknown,
  context = ctx(),
) =>
  getEngine(engine).render(
    getEngine(engine).compile(source, { name: 'probe' }),
    data,
    context,
  );

const failure = (promise: Promise<string>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

const rows = Array.from({ length: 20_000 }, (_, i) => i);
/** Nested 40 deep: a recursion that calls itself twice per level makes 2^40 calls. */
const deep = (depth: number): unknown => (depth ? { a: deep(depth - 1) } : {});

const runaways: Array<{
  name: string;
  engine: EngineId;
  source: string;
  data?: unknown;
}> = [
  {
    name: 'nested loops',
    engine: 'jinja2',
    source:
      '{% for i in range(0, 20000) %}{% for j in range(0, 20000) %}{% endfor %}{% endfor %}',
  },
  {
    name: 'nested loops over data',
    engine: 'jinja2',
    source: '{% for i in rows %}{% for j in rows %}{% endfor %}{% endfor %}',
    data: { rows },
  },
  {
    name: 'a macro that calls itself twice',
    engine: 'jinja2',
    source:
      '{% macro f(n) %}{% if n > 0 %}{{ f(n - 1) }}{{ f(n - 1) }}{% endif %}{% endmacro %}{{ f(40) }}',
  },
  {
    name: 'nested each',
    engine: 'handlebars',
    source: '{{#each rows}}{{#each ../rows}}{{/each}}{{/each}}',
    data: { rows },
  },
  {
    name: 'a block over a list',
    engine: 'handlebars',
    source: '{{#rows}}{{#each ../rows}}{{/each}}{{/rows}}',
    data: { rows },
  },
  {
    name: 'an inline partial that includes itself twice',
    engine: 'handlebars',
    source:
      '{{#*inline "f"}}{{#if a}}{{> f a}}{{> f a}}{{/if}}{{/inline}}{{> f this}}',
    data: deep(40),
  },
  {
    name: 'nested loops',
    engine: 'liquid',
    source:
      '{% for i in (1..20000) %}{% for j in (1..20000) %}{% endfor %}{% endfor %}',
  },
];

describe('a render that does not end stops at its time limit', () => {
  for (const c of runaways)
    it(`${c.engine}: ${c.name}`, async () => {
      const started = Date.now();
      const error = await failure(render(c.engine, c.source, c.data ?? {}));
      expect(error).toBeInstanceOf(RenderLimitError);
      expect((error as RenderLimitError).limit).toBe('ms');
      expect(Date.now() - started).toBeLessThan(LIMIT_MS + SLACK_MS);
    });

  it('gives the event loop back at the limit: a timer set before the render fires right after it', async () => {
    const started = Date.now();
    let firedAfter = 0;
    setTimeout(() => (firedAfter = Date.now() - started), 10);
    await failure(render('jinja2', runaways[0]!.source, {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firedAfter).toBeGreaterThan(0);
    expect(firedAfter).toBeLessThan(LIMIT_MS + SLACK_MS);
  });

  it('closes the limit with the render, also when the render was stopped', async () => {
    await failure(render('handlebars', runaways[3]!.source, runaways[3]!.data));
    await new Promise((resolve) => setTimeout(resolve, LIMIT_MS));
    // outside a render nothing is timed, so a tick never throws there
    expect(() => {
      for (let i = 0; i < 64; i++) tick();
    }).not.toThrow();
  });

  it('lets a long template that ends within its limit finish', async () => {
    expect(
      await render(
        'jinja2',
        '{% for i in range(0, 100000) %}{% endfor %}done',
        {},
        ctx(30_000),
      ),
    ).toBe('done');
  });
});

describe('the range helper', () => {
  const huge: Array<[EngineId, string]> = [
    ['jinja2', '{% for i in range(0, 10**9) %}{% endfor %}'],
    ['liquid', '{% assign nums = 0 | range: 1000000000 %}{{ nums | size }}'],
    ['handlebars', '{{#each (range 0 1000000000)}}{{/each}}'],
  ];
  for (const [engine, source] of huge)
    it(`${engine}: refuses more items than the sandbox of Jinja2 allows, before building the list`, async () => {
      const error = await failure(render(engine, source, {}, ctx(30_000)));
      expect(error).toBeInstanceOf(RenderError);
      expect((error as Error).message).toContain(
        'range() would yield 1000000000 items; a template may ask for at most 100,000',
      );
    });

  it('yields what it yielded before, up to that limit', async () => {
    const at = ctx(30_000);
    expect(
      await render('jinja2', '{{ range(0, 100000) | length }}', {}, at),
    ).toBe('100000');
    expect(
      await render(
        'jinja2',
        '{{ range(5) | join(",") }}|{{ range(10, 0, -3) | join(",") }}|{{ range(0, 1, 0.25) | join(",") }}|{{ range(3, 1) | length }}',
        {},
        at,
      ),
    ).toBe('0,1,2,3,4|10,7,4,1|0,0.25,0.5,0.75|0');
  });
});

describe('Jinja2 regular expression literals', () => {
  it('are refused when the template compiles, because their match is one step the limit cannot reach', () => {
    // unrefused, this one match backtracks for hours: about twice as long per further "a"
    const source = `{{ r/(a+)+$/.test("${'a'.repeat(40)}!") }}`;
    let error: unknown;
    try {
      getEngine('jinja2').compile(source, { name: 'probe' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EngineSyntaxError);
    expect((error as EngineSyntaxError).message).toContain(
      'Regular expressions (r/…/) are not supported in templates',
    );
    expect((error as EngineSyntaxError).line).toBe(1);
  });

  it('leave a division by a variable named r as it was', async () => {
    expect(await render('jinja2', '{{ r / 2 }}', { r: 10 })).toBe('5');
  });
});
