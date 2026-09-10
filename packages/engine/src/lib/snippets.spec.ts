import { engineIds, engines } from './engines';
import { defaultHelpers } from './helpers';
import { mergeSampleData, snippets, snippetsFor } from './snippets';
import type { RenderContext } from './types';

const ctx = (engine: string): RenderContext => ({
  locale: 'en-GB',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 5000, outputBytes: 1e7, includeDepth: 8 },
  i18n: {},
  assetBaseUrl: engine,
});

describe('snippet library', () => {
  it('compiles and renders every snippet in every engine with its own sample data', async () => {
    for (const engine of engineIds) {
      for (const snippet of snippetsFor(engine)) {
        const source = snippet.code.replace(/\$\{?\d+(?::[^}]*)?\}?/g, '');
        const tpl = engines[engine].compile(source, { name: snippet.id });
        const out = await engines[engine].render(
          tpl,
          snippet.sampleData ?? {},
          ctx(engine),
        );
        expect(out, `${engine}/${snippet.id}`).not.toContain('undefined');
        expect(out.length, `${engine}/${snippet.id}`).toBeGreaterThan(10);
      }
    }
  });

  it('analyses clean against its sample data', () => {
    for (const engine of engineIds) {
      for (const snippet of snippetsFor(engine)) {
        const source = snippet.code.replace(/\$\{?\d+(?::[^}]*)?\}?/g, '');
        const a = engines[engine].analyze(source, {
          sampleData: snippet.sampleData ?? {},
        });
        expect(
          a.diagnostics.filter((d) => d.severity === 'error'),
          `${engine}/${snippet.id}`,
        ).toEqual([]);
      }
    }
    expect(snippets.map((s) => s.id)).toContain('epc-qr');
  });

  it('merges sample data without overwriting existing values', () => {
    const merged = mergeSampleData(
      { invoice: { number: '1', lines: [{ a: 1 }] }, keep: true },
      {
        invoice: { number: 'x', total: 5, lines: [] },
        customer: { name: 'n' },
      },
    ) as Record<string, unknown>;
    expect(merged).toEqual({
      invoice: { number: '1', lines: [{ a: 1 }], total: 5 },
      keep: true,
      customer: { name: 'n' },
    });
    expect(mergeSampleData(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeSampleData({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});
