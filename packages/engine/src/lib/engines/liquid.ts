import { Liquid, type FS, type Template as LiquidTemplate } from 'liquidjs';
import { unavailableHelper } from '../unavailable';
import {
  liquidTags,
  missingPathDiagnostics,
  rangeOf,
  scanBlocks,
} from '../analysis/tags';
import { EngineSyntaxError, RenderError } from '../errors';
import { defaultHelpers } from '../helpers';
import { enforceLimits } from '../limits';
import type {
  Analysis,
  AnalyzeOptions,
  CompileOptions,
  CompiledTemplate,
  Diagnostic,
  Engine,
  FilterRef,
  IncludeRef,
  PartialResolver,
  Range,
  RenderContext,
  VariableRef,
} from '../types';

/** LiquidJS standard filters (Shopify set) that count as known. */
export const liquidBuiltinFilters = new Set([
  'abs',
  'append',
  'at_least',
  'at_most',
  'capitalize',
  'ceil',
  'compact',
  'concat',
  'date',
  'default',
  'divided_by',
  'downcase',
  'escape',
  'escape_once',
  'first',
  'floor',
  'join',
  'json',
  'last',
  'lstrip',
  'map',
  'minus',
  'modulo',
  'newline_to_br',
  'plus',
  'prepend',
  'remove',
  'remove_first',
  'replace',
  'replace_first',
  'reverse',
  'round',
  'rstrip',
  'size',
  'slice',
  'sort',
  'sort_natural',
  'split',
  'strip',
  'strip_html',
  'strip_newlines',
  'times',
  'truncate',
  'truncatewords',
  'uniq',
  'upcase',
  'url_decode',
  'url_encode',
  'where',
  'where_exp',
  'find_exp',
  'reject_exp',
  'group_by_exp',
  'raw',
  'sum',
  'group_by',
  'find',
  'reject',
  'has',
  'find_index',
  'to_integer',
  'array_to_sentence_string',
  'normalize_whitespace',
  'number_of_words',
  'push',
  'pop',
  'shift',
  'unshift',
  'inspect',
  'type',
  'sample',
  'time_zone',
]);
const builtinRoots = new Set([
  'forloop',
  'tablerowloop',
  'true',
  'false',
  'nil',
  'null',
  'empty',
  'blank',
  'continue',
  'break',
]);
const keywords = new Set([
  'and',
  'or',
  'not',
  'in',
  'contains',
  'with',
  'for',
  'as',
  'reversed',
  'limit',
  'offset',
  'by',
  'cols',
  'else',
]);

function partialFs(resolve: PartialResolver): FS {
  const read = (file: string) => {
    const src = resolve(file);
    if (src === undefined) throw new Error(`Partial "${file}" not found`);
    return src;
  };
  return {
    readFileSync: read,
    readFile: (file) => Promise.resolve(read(file)),
    existsSync: (file) => resolve(file) !== undefined,
    exists: (file) => Promise.resolve(resolve(file) !== undefined),
    resolve: (_root, file, ext) =>
      ext && !file.endsWith(ext) ? `${file}${ext}` : file,
    contains: () => Promise.resolve(true),
    sep: '/',
    dirname: () => '',
  };
}

/**
 * LiquidJS hands keyword filter arguments (`| image: width: 120, fit: 'cover'`) over as `[key, value]`
 * pairs after the positional ones. They become one trailing options object, the shape the helpers
 * take in Jinja2 (`{ width: 120 }`) and Handlebars (hash arguments), so all engines share one helper.
 *
 * Which arguments are keywords comes from the parsed filter token (`isKeyword`), never from the
 * value: at runtime a `[key, value]` pair and a two-element array of strings look the same, and
 * guessing by shape turned `['red', 'green'] | join: ', '` into the keyword argument `red: 'green'`
 * — a list that worked with three entries silently broke with exactly two.
 */
export function collectKeywordArgs(
  args: unknown[],
  isKeyword: (index: number) => boolean,
): unknown[] {
  const positional: unknown[] = [];
  const named: Record<string, unknown> = {};
  let sawNamed = false;
  args.forEach((arg, index) => {
    if (isKeyword(index) && Array.isArray(arg) && typeof arg[0] === 'string') {
      named[arg[0]] = arg[1];
      sawNamed = true;
    } else positional.push(arg);
  });
  return sawNamed ? [...positional, named] : positional;
}

function createLiquid(ctx: RenderContext): Liquid {
  const liquid = new Liquid({
    strictFilters: true,
    strictVariables: false,
    ownPropertyOnly: true,
    relativeReference: false,
    extname: '',
    root: [''],
    fs: partialFs(ctx.partials),
    renderLimit: ctx.limits.ms,
    memoryLimit: ctx.limits.outputBytes * 4,
    parseLimit: 2_000_000,
  });
  for (const [name, { fn }] of ctx.helpers.bind(ctx))
    liquid.registerFilter(name, function (
      this: { token?: { args?: unknown[] } },
      input: unknown,
      ...argv: unknown[]
    ) {
      // argv[i] was evaluated from token.args[i], where a keyword argument is a [name, token] pair
      const tokens = this.token?.args ?? [];
      return fn(
        ...collectKeywordArgs([input, ...argv], (i) => i > 0 && Array.isArray(tokens[i - 1])),
      );
    });
  return liquid;
}

const validationContext: RenderContext = {
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 2000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
};

function toSyntaxError(e: unknown): EngineSyntaxError {
  const err = e as {
    message?: string;
    token?: { getPosition?: () => [number, number] };
    line?: number;
    col?: number;
  };
  let line = err.line ?? 1;
  let column = err.col ?? 1;
  const pos = err.token?.getPosition?.();
  if (pos) [line, column] = pos;
  const message = String(err.message ?? e)
    .replace(/,\s*line:\d+,\s*col:\d+/, '')
    .trim();
  return new EngineSyntaxError('liquid', message, line, column);
}

// --- analysis (text based; deep AST analysis lands with the editor work) -----------------------

const identifier = /(?<![\w."'])([A-Za-z_][\w]*)((?:\.[A-Za-z_]\w*|\[\d+\])*)/g;

function pathsIn(
  expression: string,
  base: number,
  source: string,
  out: VariableRef[],
  scopes: Map<string, string[] | null>,
): void {
  const stripped = expression.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (m) =>
    ' '.repeat(m.length),
  );
  for (const m of stripped.matchAll(identifier)) {
    const root = m[1] ?? '';
    if (keywords.has(root) || builtinRoots.has(root) || /^\d/.test(root))
      continue;
    const path = [root, ...(m[2] ?? '').split(/[.[\]]+/).filter(Boolean)];
    const start = base + (m.index ?? 0);
    out.push({
      path,
      range: rangeOf(source, start, start + m[0].length),
      kind: scopes.has(root) ? 'loop-var' : 'read',
    });
  }
}

export function analyzeLiquid(
  source: string,
  opts: AnalyzeOptions = {},
): Analysis {
  const helpers = opts.helpers ?? defaultHelpers();
  const { blocks, diagnostics } = scanBlocks(source, liquidTags);
  const variables: VariableRef[] = [];
  const filters: FilterRef[] = [];
  const includes: IncludeRef[] = [];
  const loopSources = new Map<string, string[] | null>();

  try {
    new Liquid({ strictFilters: false, fs: partialFs(() => '') }).parse(source);
  } catch (e) {
    const err = toSyntaxError(e);
    if (!diagnostics.some((d) => d.severity === 'error')) {
      diagnostics.push({
        severity: 'error',
        code: 'syntax-error',
        message: err.message,
        range: {
          start: { line: err.line, column: err.column },
          end: { line: err.line, column: err.column + 1 },
        },
      });
    }
  }

  const filterNames = (expr: string, base: number) => {
    for (const m of expr.matchAll(/\|\s*([A-Za-z_]\w*)/g)) {
      const name = m[1] ?? '';
      const start = base + (m.index ?? 0) + m[0].indexOf(name);
      filters.push({
        name,
        range: rangeOf(source, start, start + name.length),
        known: helpers.has(name) || liquidBuiltinFilters.has(name),
      });
    }
  };
  const withoutFilters = (expr: string) => expr.split('|')[0] ?? expr;

  for (const m of source.matchAll(/\{\{-?([\s\S]*?)-?\}\}/g)) {
    const inner = m[1] ?? '';
    const base = (m.index ?? 0) + m[0].indexOf(inner);
    pathsIn(withoutFilters(inner), base, source, variables, loopSources);
    filterNames(inner, base);
  }
  for (const m of source.matchAll(/\{%-?\s*(\w+)([\s\S]*?)-?%\}/g)) {
    const keyword = m[1] ?? '';
    const rest = m[2] ?? '';
    const base = (m.index ?? 0) + m[0].indexOf(rest, 2 + keyword.length);
    if (keyword === 'for' || keyword === 'tablerow') {
      const fm = /^\s*([A-Za-z_]\w*)\s+in\s+([\w.[\]]+)/.exec(rest);
      if (fm) {
        const name = fm[1] ?? '';
        const src = (fm[2] ?? '').split(/[.[\]]+/).filter(Boolean);
        const root = src[0] ?? '';
        loopSources.set(
          name,
          loopSources.has(root)
            ? loopSources.get(root)
              ? [...(loopSources.get(root) as string[]), ...src.slice(1)]
              : null
            : src,
        );
        const start = base + rest.indexOf(name);
        variables.push({
          path: [name],
          range: rangeOf(source, start, start + name.length),
          kind: 'loop-var',
        });
        pathsIn(
          rest.slice(fm[0].length - (fm[2] ?? '').length),
          base + fm[0].length - (fm[2] ?? '').length,
          source,
          variables,
          loopSources,
        );
      }
    } else if (
      keyword === 'assign' ||
      keyword === 'capture' ||
      keyword === 'increment' ||
      keyword === 'decrement'
    ) {
      const am = /^\s*([A-Za-z_]\w*)/.exec(rest);
      if (am) {
        const name = am[1] ?? '';
        const start = base + rest.indexOf(name);
        variables.push({
          path: [name],
          range: rangeOf(source, start, start + name.length),
          kind: 'assigned',
        });
        loopSources.set(name, null);
        if (keyword === 'assign') {
          const value = rest.slice(am[0].length).replace(/^\s*=/, '');
          pathsIn(
            withoutFilters(value),
            base + rest.length - value.length,
            source,
            variables,
            loopSources,
          );
          filterNames(value, base + rest.length - value.length);
        }
      }
    } else if (keyword === 'render' || keyword === 'include') {
      const im = /^\s*(["'])([^"']+)\1/.exec(rest);
      if (im) {
        const start = base + rest.indexOf(im[0]);
        includes.push({
          name: im[2] ?? '',
          range: rangeOf(source, start, start + im[0].length),
        });
      }
    } else if (
      ['if', 'elsif', 'unless', 'case', 'when', 'echo', 'cycle'].includes(
        keyword,
      )
    ) {
      pathsIn(withoutFilters(rest), base, source, variables, loopSources);
      if (keyword === 'echo') filterNames(rest, base);
    }
  }

  const registry = helpers as typeof helpers & {
    deprecationOf?: (name: string) => string | undefined;
  };
  for (const f of filters) {
    const preferred = registry.deprecationOf?.(f.name);
    if (preferred) {
      diagnostics.push({
        severity: 'warning',
        code: 'deprecated-filter',
        message: `"${f.name}" is a compatibility alias; use "${preferred}"`,
        range: f.range,
        fix: { title: `Rename to ${preferred}`, replacement: preferred },
      });
    } else if (unavailableHelper(f.name)) {
      diagnostics.push({
        severity: 'warning',
        code: 'unavailable-helper',
        message: unavailableHelper(f.name) as string,
        range: f.range,
      });
    } else if (!f.known) {
      diagnostics.push({
        severity: 'error',
        code: 'unknown-filter',
        message: `Unknown filter "${f.name}"`,
        range: f.range,
      });
    }
  }
  const byPosition = (a: { range: Range }, b: { range: Range }) =>
    a.range.start.line - b.range.start.line ||
    a.range.start.column - b.range.start.column;
  variables.sort(byPosition);
  filters.sort(byPosition);
  const dataDiagnostics: Diagnostic[] = missingPathDiagnostics(
    variables,
    opts.sampleData,
    loopSources,
    new Set([...builtinRoots, ...helpers.names()]),
  );
  return {
    variables,
    filters,
    includes,
    blocks,
    diagnostics: [...diagnostics, ...dataDiagnostics],
  };
}

// --- engine ----------------------------------------------------------------------------------

class LiquidCompiled implements CompiledTemplate {
  readonly engine = 'liquid' as const;
  private readonly runtimes = new WeakMap<
    RenderContext,
    { liquid: Liquid; templates: LiquidTemplate[] }
  >();

  constructor(
    readonly name: string,
    readonly source: string,
  ) {}

  private runtime(ctx: RenderContext) {
    let rt = this.runtimes.get(ctx);
    if (!rt) {
      const liquid = createLiquid(ctx);
      rt = { liquid, templates: liquid.parse(this.source, this.name) };
      this.runtimes.set(ctx, rt);
    }
    return rt;
  }

  async render(data: unknown, ctx: RenderContext): Promise<string> {
    const started = Date.now();
    const { liquid, templates } = this.runtime(ctx);
    try {
      const out = (await liquid.render(
        templates,
        (data ?? {}) as object,
      )) as string;
      return enforceLimits(out, started, ctx.limits);
    } catch (e) {
      if (e instanceof Error && e.name === 'RenderLimitError') throw e;
      const err = e as {
        message?: string;
        token?: { getPosition?: () => [number, number] };
      };
      const pos = err.token?.getPosition?.();
      throw new RenderError(
        'liquid',
        String(err.message ?? e),
        pos?.[0],
        pos?.[1],
      );
    }
  }
}

export const liquidEngine: Engine = {
  id: 'liquid',
  compile(source: string, opts: CompileOptions = {}): CompiledTemplate {
    const name = opts.name ?? 'template';
    try {
      createLiquid(validationContext).parse(source, name);
    } catch (e) {
      throw toSyntaxError(e);
    }
    return new LiquidCompiled(name, source);
  },
  analyze: analyzeLiquid,
  render: (tpl, data, ctx) => tpl.render(data, ctx),
};
