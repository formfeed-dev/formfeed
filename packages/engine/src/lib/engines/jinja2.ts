import nunjucks, { type NunjucksNode } from 'nunjucks/browser/nunjucks.js';
import {
  jinjaTags,
  missingPathDiagnostics,
  rangeAt,
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
  HelperRegistry,
  IncludeRef,
  PartialResolver,
  Range,
  RenderContext,
  VariableRef,
} from '../types';

/** Nunjucks built-in filters that count as known even without a helper of the same name. */
export const nunjucksBuiltinFilters = new Set([
  'abs',
  'batch',
  'capitalize',
  'center',
  'default',
  'd',
  'dictsort',
  'dump',
  'escape',
  'e',
  'first',
  'float',
  'forceescape',
  'groupby',
  'indent',
  'int',
  'join',
  'last',
  'length',
  'list',
  'lower',
  'nl2br',
  'random',
  'reject',
  'rejectattr',
  'replace',
  'reverse',
  'round',
  'safe',
  'select',
  'selectattr',
  'slice',
  'sort',
  'string',
  'striptags',
  'sum',
  'title',
  'trim',
  'truncate',
  'upper',
  'urlencode',
  'urlize',
  'wordcount',
]);
const builtinRoots = new Set([
  'loop',
  'caller',
  'super',
  'range',
  'cycler',
  'joiner',
  'lipsum',
  'varargs',
  'kwargs',
]);

// --- Python compatibility (spec 05 §8) -------------------------------------------------------

type StringMethods = Record<string, (s: string, ...args: unknown[]) => unknown>;
const stringMethods: StringMethods = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  strip: (s, chars?) => trimChars(s, chars, 'both'),
  lstrip: (s, chars?) => trimChars(s, chars, 'left'),
  rstrip: (s, chars?) => trimChars(s, chars, 'right'),
  title: (s) =>
    s.replace(
      /\p{L}[\p{L}\p{M}]*/gu,
      (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    ),
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  startswith: (s, p) => s.startsWith(String(p)),
  endswith: (s, p) => s.endsWith(String(p)),
  replace: (s, a, b, count?) => {
    const n = count === undefined ? Infinity : Number(count);
    let out = s;
    let done = 0;
    while (done < n && out.includes(String(a))) {
      out = out.replace(String(a), String(b));
      done++;
      if (String(a) === '') break;
    }
    return out;
  },
  split: (s, sep?, max?) =>
    sep === undefined || sep === null
      ? s.trim().split(/\s+/)
      : s.split(String(sep), max === undefined ? undefined : Number(max) + 1),
  join: (s, list) => (Array.isArray(list) ? list.join(s) : String(list)),
  format: (s, ...args) => {
    let i = 0;
    const named = (
      args.at(-1) && typeof args.at(-1) === 'object'
        ? (args.at(-1) as Record<string, unknown>)
        : {}
    ) as Record<string, unknown>;
    return s.replace(/\{(\w*)\}/g, (_, key: string) =>
      String(key ? (named[key] ?? '') : (args[i++] ?? '')),
    );
  },
  zfill: (s, width) => s.padStart(Number(width), '0'),
  count: (s, sub) => s.split(String(sub)).length - 1,
  find: (s, sub) => s.indexOf(String(sub)),
  isdigit: (s) => /^\d+$/.test(s),
  isalpha: (s) => /^\p{L}+$/u.test(s),
  splitlines: (s) => s.split(/\r?\n/),
  center: (s, width, fill?) => {
    const total = Math.max(0, Number(width) - s.length);
    const left = Math.floor(total / 2);
    const f = String(fill ?? ' ');
    return f.repeat(left) + s + f.repeat(total - left);
  },
};

function trimChars(
  s: string,
  chars: unknown,
  side: 'both' | 'left' | 'right',
): string {
  if (chars === undefined || chars === null)
    return side === 'both'
      ? s.trim()
      : side === 'left'
        ? s.trimStart()
        : s.trimEnd();
  const set = new Set(String(chars));
  let start = 0;
  let end = s.length;
  if (side !== 'right') while (start < end && set.has(s[start] ?? '')) start++;
  if (side !== 'left') while (end > start && set.has(s[end - 1] ?? '')) end--;
  return s.slice(start, end);
}

let compatInstalled = false;
function installCompat(): void {
  if (compatInstalled) return;
  compatInstalled = true;
  nunjucks.installJinjaCompat();
  // `not a == b` means `not (a == b)` in Jinja2, and nunjucks' parser builds exactly that tree, but
  // its code generator writes `!` in front of the operand's JavaScript without parentheses, so it
  // runs as `(!a) == b`: `{% if not status == 'paid' %}` never fired. Wrapping the operand keeps a
  // simple `not x` identical and gives the compound case the Jinja2 meaning.
  nunjucks.compiler.Compiler.prototype.compileNot = function (node, frame) {
    this._emit('!(');
    this.compile(node.target, frame);
    this._emit(')');
  };
  const original = nunjucks.runtime.memberLookup;
  nunjucks.runtime.memberLookup = (obj: unknown, val: unknown, ...rest: unknown[]) => {
    if (
      typeof obj === 'string' &&
      typeof val === 'string' &&
      Object.prototype.hasOwnProperty.call(stringMethods, val)
    ) {
      const method = stringMethods[val];
      if (method) return (...args: unknown[]) => method(obj, ...args);
    }
    // A field of the data wins over the Python dict method of the same name. The Jinja compat layer
    // answers `items`, `keys`, `values`, `get`, `pop`, `update`... with dict methods on every object,
    // ahead of real properties, so `invoice.items` was a function and `{% for line in
    // invoice.items %}` rendered nothing. `meta.items()` still works where there is no such field.
    if (
      obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      typeof val === 'string' &&
      Object.prototype.hasOwnProperty.call(obj, val)
    ) {
      const own = (obj as Record<string, unknown>)[val];
      return typeof own === 'function'
        ? (...args: unknown[]) => (own as (...a: unknown[]) => unknown).apply(obj, args)
        : own;
    }
    if (
      obj &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      val === 'get' &&
      !('get' in obj)
    ) {
      return (key: unknown, fallback?: unknown) =>
        String(key) in obj
          ? (obj as Record<string, unknown>)[String(key)]
          : fallback;
    }
    // the extra arguments are the bounds of a slice (`values[0:2]`)
    return original(obj, val, ...rest);
  };
}

// --- environment -----------------------------------------------------------------------------

class PartialLoader extends nunjucks.Loader {
  async = false;
  constructor(private readonly lookup: PartialResolver) {
    super();
  }
  getSource(
    name: string,
  ): { src: string; path: string; noCache: boolean } | null {
    const src = this.lookup(name);
    return src === undefined ? null : { src, path: name, noCache: true };
  }
}

function createEnvironment(
  ctx: RenderContext,
): InstanceType<typeof nunjucks.Environment> {
  installCompat();
  const env = new nunjucks.Environment(
    new PartialLoader(ctx.partials) as never,
    {
      autoescape: true,
      throwOnUndefined: false,
      trimBlocks: false,
      lstripBlocks: false,
    },
  );
  for (const [name, { fn, html }] of ctx.helpers.bind(ctx)) {
    const wrapped = (...args: unknown[]) => {
      const result = fn(...args);
      return html
        ? new nunjucks.runtime.SafeString(String(result ?? ''))
        : result;
    };
    env.addFilter(name, wrapped as never);
    env.addGlobal(name, wrapped);
  }
  return env;
}

const validationContext: RenderContext = {
  locale: 'en',
  timezone: 'UTC',
  currency: 'EUR',
  partials: () => undefined,
  helpers: defaultHelpers(),
  limits: { ms: 2000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
  i18n: {},
};

function toSyntaxError(e: unknown, fallbackLine = 1): EngineSyntaxError {
  const err = e as { message?: string; lineno?: number; colno?: number };
  const message = String(err.message ?? e)
    .replace(/^\(.*?\)\s*/, '')
    .replace(/^\[Line \d+, Column \d+\]\s*/, '')
    .trim();
  const fromMessage = /\[Line (\d+), Column (\d+)\]/.exec(
    String(err.message ?? ''),
  );
  const line =
    typeof err.lineno === 'number'
      ? err.lineno + 1
      : fromMessage
        ? Number(fromMessage[1])
        : fallbackLine;
  const column =
    typeof err.colno === 'number'
      ? err.colno + 1
      : fromMessage
        ? Number(fromMessage[2])
        : 1;
  return new EngineSyntaxError('jinja2', message, line, column);
}

// --- analysis --------------------------------------------------------------------------------

function nodeRange(node: NunjucksNode, length = 1): Range {
  return rangeAt(node.lineno + 1, node.colno + 1, length);
}

/** Flattens `a.b.c` / `a['b']` lookups into a path; undefined when dynamic. */
function pathOf(
  node: NunjucksNode,
): { path: string[]; root: NunjucksNode } | undefined {
  if (node.typename === 'Symbol')
    return { path: [String(node.value)], root: node };
  if (node.typename === 'LookupVal') {
    const target = pathOf(node['target'] as NunjucksNode);
    const val = node['val'] as NunjucksNode;
    if (!target) return undefined;
    if (val.typename === 'Literal')
      return { path: [...target.path, String(val.value)], root: target.root };
    return target; // dynamic index: keep the known prefix
  }
  return undefined;
}

interface Walk {
  variables: VariableRef[];
  filters: FilterRef[];
  includes: IncludeRef[];
  loopSources: Map<string, string[] | null>;
  scopes: Array<Set<string>>;
  helpers: HelperRegistry;
}

function inScope(w: Walk, name: string): boolean {
  return w.scopes.some((s) => s.has(name));
}

function walk(node: NunjucksNode | undefined, w: Walk): void {
  if (!node || typeof node !== 'object') return;
  switch (node.typename) {
    case 'Symbol':
    case 'LookupVal': {
      const p = pathOf(node);
      if (p) {
        const root = p.path[0] ?? '';
        w.variables.push({
          path: p.path,
          range: nodeRange(p.root, p.path.join('.').length),
          kind: inScope(w, root) ? 'loop-var' : 'read',
        });
      }
      if (node.typename === 'LookupVal' && !p) {
        walk(node['target'] as NunjucksNode, w);
        walk(node['val'] as NunjucksNode, w);
      } else if (node.typename === 'LookupVal') {
        // dynamic parts still contain reads, e.g. items[key]
        const val = node['val'] as NunjucksNode;
        if (val.typename !== 'Literal') walk(val, w);
      }
      return;
    }
    case 'Filter': {
      const nameNode = node['name'] as NunjucksNode;
      const name = String(nameNode.value);
      w.filters.push({
        name,
        range: nodeRange(nameNode, name.length),
        known: w.helpers.has(name) || nunjucksBuiltinFilters.has(name),
      });
      const args = node['args'] as NunjucksNode;
      for (const child of args.children ?? []) walk(child, w);
      return;
    }
    case 'FunCall': {
      const nameNode = node['name'] as NunjucksNode;
      if (
        nameNode.typename === 'Symbol' &&
        (w.helpers.has(String(nameNode.value)) ||
          builtinRoots.has(String(nameNode.value)))
      ) {
        const name = String(nameNode.value);
        w.filters.push({
          name,
          range: nodeRange(nameNode, name.length),
          known: true,
        });
      } else {
        walk(nameNode, w);
      }
      const args = node['args'] as NunjucksNode;
      for (const child of args.children ?? []) walk(child, w);
      return;
    }
    case 'For': {
      const arr = node['arr'] as NunjucksNode;
      walk(arr, w);
      const source = pathOf(arr);
      const nameNode = node['name'] as NunjucksNode;
      const names =
        nameNode.typename === 'Array' ? (nameNode.children ?? []) : [nameNode];
      const scope = new Set<string>();
      for (const n of names) {
        const name = String(n.value);
        scope.add(name);
        // `for k, v in dict` unpacks; only a single loop variable maps onto the array items
        w.loopSources.set(
          name,
          names.length === 1 && source && !inScope(w, source.path[0] ?? '')
            ? source.path
            : names.length === 1 && source
              ? resolveLoopSource(w, source.path)
              : null,
        );
        w.variables.push({
          path: [name],
          range: nodeRange(n, name.length),
          kind: 'loop-var',
        });
      }
      w.scopes.push(scope);
      walk(node['body'] as NunjucksNode, w);
      w.scopes.pop();
      walk(node['else_'] as NunjucksNode, w);
      return;
    }
    case 'Set': {
      for (const target of (node['targets'] as NunjucksNode[]) ?? []) {
        const p = pathOf(target);
        if (p) {
          w.variables.push({
            path: p.path,
            range: nodeRange(p.root, p.path.join('.').length),
            kind: 'assigned',
          });
          w.scopes[0]?.add(p.path[0] ?? '');
          w.loopSources.set(p.path[0] ?? '', null);
        }
      }
      walk(node['value'] as NunjucksNode, w);
      walk(node['body'] as NunjucksNode, w);
      return;
    }
    case 'Macro': {
      const args = node['args'] as NunjucksNode;
      const scope = new Set<string>();
      for (const child of args.children ?? [])
        if (child.typename === 'Symbol') scope.add(String(child.value));
      const nameNode = node['name'] as NunjucksNode;
      w.scopes[0]?.add(String(nameNode.value));
      w.loopSources.set(String(nameNode.value), null);
      w.scopes.push(scope);
      walk(node['body'] as NunjucksNode, w);
      w.scopes.pop();
      return;
    }
    case 'Pair': {
      // `{ size: 120 }` and `qrcode(x, size=120)`: the compiler turns a Symbol key into a string
      // literal, so only the value is a read
      walk(node['value'] as NunjucksNode, w);
      return;
    }
    case 'Include':
    case 'Extends':
    case 'Import':
    case 'FromImport': {
      const tpl = node['template'] as NunjucksNode;
      if (tpl.typename === 'Literal')
        w.includes.push({
          name: String(tpl.value),
          range: nodeRange(tpl, String(tpl.value).length + 2),
        });
      else walk(tpl, w);
      if (node.typename === 'Import')
        w.scopes[0]?.add(
          String((node['target'] as NunjucksNode | undefined)?.value ?? ''),
        );
      if (node.typename === 'FromImport')
        for (const n of (node['names'] as NunjucksNode).children ?? [])
          w.scopes[0]?.add(
            String(
              n.typename === 'Pair'
                ? (n['value'] as NunjucksNode).value
                : n.value,
            ),
          );
      return;
    }
    default:
      break;
  }
  if (node.children) {
    for (const child of node.children) walk(child, w);
    return;
  }
  for (const field of node.fields ?? []) {
    const value = node[field];
    if (Array.isArray(value)) for (const v of value) walk(v as NunjucksNode, w);
    else if (
      value &&
      typeof value === 'object' &&
      'typename' in (value as object)
    )
      walk(value as NunjucksNode, w);
  }
}

/** `for line in group.items` inside `for group in groups` → groups[].items */
function resolveLoopSource(w: Walk, path: string[]): string[] | null {
  const root = path[0] ?? '';
  if (!w.loopSources.has(root)) return path;
  const source = w.loopSources.get(root);
  return source ? [...source, ...path.slice(1)] : null;
}

export function analyzeJinja2(
  source: string,
  opts: AnalyzeOptions = {},
): Analysis {
  const helpers = opts.helpers ?? defaultHelpers();
  const { blocks, diagnostics } = scanBlocks(source, jinjaTags);
  const w: Walk = {
    variables: [],
    filters: [],
    includes: [],
    loopSources: new Map(),
    scopes: [new Set()],
    helpers,
  };
  try {
    installCompat();
    const root = nunjucks.parser.parse(source, [], {});
    walk(root, w);
  } catch (e) {
    const err = toSyntaxError(e);
    if (!diagnostics.some((d) => d.severity === 'error')) {
      diagnostics.push({
        severity: 'error',
        code: 'syntax-error',
        message: err.message,
        range: rangeAt(err.line, err.column, 1),
      });
    }
  }
  const registry = helpers as HelperRegistry & {
    deprecationOf?: (name: string) => string | undefined;
  };
  for (const f of w.filters) {
    const preferred = registry.deprecationOf?.(f.name);
    if (preferred) {
      diagnostics.push({
        severity: 'warning',
        code: 'deprecated-filter',
        message: `"${f.name}" is an apitemplate.io compatibility alias; use "${preferred}"`,
        range: f.range,
        fix: { title: `Rename to ${preferred}`, replacement: preferred },
      });
    } else if (!f.known) {
      diagnostics.push({
        severity: 'error',
        code: 'unknown-filter',
        message: `Unknown filter or helper "${f.name}"`,
        range: f.range,
      });
    }
  }
  const builtin = new Set([...builtinRoots, ...helpers.names()]);
  const dataDiagnostics: Diagnostic[] = missingPathDiagnostics(
    w.variables,
    opts.sampleData,
    w.loopSources,
    builtin,
  );
  return {
    variables: w.variables,
    filters: w.filters,
    includes: w.includes,
    blocks,
    diagnostics: [...diagnostics, ...dataDiagnostics],
  };
}

// --- engine ----------------------------------------------------------------------------------

class Jinja2Template implements CompiledTemplate {
  readonly engine = 'jinja2' as const;
  private readonly runtimes = new WeakMap<
    RenderContext,
    InstanceType<typeof nunjucks.Template>
  >();

  constructor(
    readonly name: string,
    readonly source: string,
  ) {}

  private runtime(ctx: RenderContext): InstanceType<typeof nunjucks.Template> {
    let tpl = this.runtimes.get(ctx);
    if (!tpl) {
      const env = createEnvironment(ctx);
      tpl = new nunjucks.Template(this.source, env, this.name, true);
      this.runtimes.set(ctx, tpl);
    }
    return tpl;
  }

  render(data: unknown, ctx: RenderContext): Promise<string> {
    const started = Date.now();
    const tpl = this.runtime(ctx);
    return new Promise<string>((resolve, reject) => {
      try {
        tpl.render(
          (data ?? {}) as object,
          (err: unknown, res: string | null) => {
            if (err) {
              const e = err as {
                message?: string;
                lineno?: number;
                colno?: number;
              };
              reject(
                new RenderError(
                  'jinja2',
                  String(e.message ?? err).replace(/^\(.*?\)\s*/, ''),
                  e.lineno === undefined ? undefined : e.lineno + 1,
                  e.colno === undefined ? undefined : e.colno + 1,
                ),
              );
              return;
            }
            try {
              resolve(enforceLimits(res ?? '', started, ctx.limits));
            } catch (limit) {
              reject(limit);
            }
          },
        );
      } catch (e) {
        reject(e instanceof Error ? e : new RenderError('jinja2', String(e)));
      }
    });
  }
}

export const jinja2Engine: Engine = {
  id: 'jinja2',
  compile(source: string, opts: CompileOptions = {}): CompiledTemplate {
    const name = opts.name ?? 'template';
    try {
      installCompat();
      // eager compile against a throw-away environment surfaces syntax errors now
      new nunjucks.Template(
        source,
        createEnvironment(validationContext),
        name,
        true,
      );
    } catch (e) {
      throw toSyntaxError(e);
    }
    return new Jinja2Template(name, source);
  },
  analyze: analyzeJinja2,
  render: (tpl, data, ctx) => tpl.render(data, ctx),
};
