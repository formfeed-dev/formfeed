import Handlebars from 'handlebars';
import { unavailableHelper } from '../unavailable';
import { missingPathDiagnostics, rangeAt } from '../analysis/tags';
import { EngineSyntaxError, RenderError, RenderLimitError } from '../errors';
import { defaultHelpers } from '../helpers';
import { enforceLimits } from '../limits';
import type {
  Analysis,
  AnalyzeOptions,
  BlockRef,
  CompileOptions,
  CompiledTemplate,
  Diagnostic,
  Engine,
  FilterRef,
  HelperRegistry,
  IncludeRef,
  Range,
  RenderContext,
  VariableRef,
} from '../types';

type HB = typeof Handlebars;
type Node = hbs.AST.Node;
type Loc = hbs.AST.SourceLocation;

const builtinHelpers = new Set([
  'if',
  'unless',
  'each',
  'with',
  'lookup',
  'log',
  'blockHelperMissing',
  'helperMissing',
]);
const builtinRoots = new Set([
  'this',
  '@index',
  '@key',
  '@first',
  '@last',
  '@root',
  'lookup',
]);

function createInstance(ctx: RenderContext): HB {
  const hb = Handlebars.create();
  for (const [name, { fn, html }] of ctx.helpers.bind(ctx)) {
    hb.registerHelper(name, function (this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as
        { hash?: Record<string, unknown> } | undefined;
      const params = args.slice(0, -1);
      const hasHash = !!options?.hash && Object.keys(options.hash).length > 0;
      // `{{title}}` is ambiguous in Handlebars, and a registered helper wins over a field of the same
      // name: `{{date}}` printed today instead of the invoice date and `{{number}}` printed nothing.
      // A bare mention without arguments reads the field when the current context has one.
      if (
        params.length === 0 &&
        !hasHash &&
        this !== null &&
        this !== undefined &&
        Object.prototype.hasOwnProperty.call(Object(this), name)
      )
        return (this as Record<string, unknown>)[name];
      if (hasHash) params.push(options.hash);
      const result = fn(...params);
      return html ? new hb.SafeString(String(result ?? '')) : result;
    });
  }
  return hb;
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
  const err = e as { message?: string; lineNumber?: number; column?: number };
  const message = String(err.message ?? e);
  const m = /Parse error on line (\d+)/.exec(message);
  const line = err.lineNumber ?? (m ? Number(m[1]) : 1);
  const column = typeof err.column === 'number' ? err.column + 1 : 1;
  return new EngineSyntaxError(
    'handlebars',
    message.split('\n')[0] ?? message,
    line,
    column,
  );
}

// --- analysis --------------------------------------------------------------------------------

function toRange(loc: Loc | undefined): Range {
  if (!loc) return rangeAt(1, 1, 1);
  return {
    start: { line: loc.start.line, column: loc.start.column + 1 },
    end: { line: loc.end.line, column: loc.end.column + 1 },
  };
}

interface Scope {
  /** Data path the current `this` stands for; null when it comes from an unknown expression. */
  source: string[] | null;
  /** Block params (`as |item index|`) mapped to their source. */
  params: Map<string, string[] | null>;
  loop: boolean;
}

interface Walk {
  variables: VariableRef[];
  filters: FilterRef[];
  includes: IncludeRef[];
  blocks: BlockRef[];
  scopes: Scope[];
  helpers: HelperRegistry;
  loopSources: Map<string, string[] | null>;
}

function pathParts(path: hbs.AST.PathExpression): string[] {
  const parts = path.parts.map(String);
  if (path.data) return [`@${parts[0] ?? ''}`, ...parts.slice(1)];
  return parts;
}

/** Resolves a path against the scope stack into an absolute data path (or null when unknown). */
function resolve(
  w: Walk,
  path: hbs.AST.PathExpression,
): { abs: string[] | null; kind: VariableRef['kind']; display: string[] } {
  const parts = pathParts(path);
  const original = path.original;
  let depth = 0;
  let rest = parts;
  while (original.startsWith('../'.repeat(depth + 1))) depth++;
  const rootScope: Scope = w.scopes[0] ?? {
    source: [],
    params: new Map(),
    loop: false,
  };
  const scope = w.scopes[w.scopes.length - 1 - depth] ?? rootScope;
  if (rest[0] === 'this') rest = rest.slice(1);
  if (original.startsWith('@root'))
    return { abs: rest, kind: 'read', display: parts };
  const first = rest[0] ?? '';
  for (let i = w.scopes.length - 1 - depth; i >= 0; i--) {
    const s = w.scopes[i];
    if (s?.params.has(first)) {
      const src = s.params.get(first);
      return {
        abs: src ? [...src, ...rest.slice(1)] : null,
        kind: 'loop-var',
        display: parts,
      };
    }
  }
  const inLoop = w.scopes.slice(0, w.scopes.length - depth).some((s) => s.loop);
  return {
    abs: scope.source ? [...scope.source, ...rest] : null,
    kind: inLoop || scope !== w.scopes[0] ? 'loop-var' : 'read',
    display: parts,
  };
}

function walk(node: Node | undefined, w: Walk): void {
  if (!node) return;
  switch (node.type) {
    case 'Program':
      for (const s of (node as hbs.AST.Program).body) walk(s, w);
      return;
    case 'MustacheStatement':
    case 'SubExpression': {
      const n = node as hbs.AST.MustacheStatement;
      const path = n.path as hbs.AST.PathExpression;
      const name = path.original;
      const bare =
        n.params.length === 0 && Object.keys(n.hash?.pairs ?? {}).length === 0;
      // A bare `{{date}}` reads the data field, as the runtime does (createInstance), so it is a
      // variable for the schema and the data check. Only a helper that takes no arguments at all,
      // like `{{pageBreak}}`, is a call without them.
      const isHelper = !bare || builtinHelpers.has(name) || takesNoArguments(w.helpers, name);
      if (isHelper && path.type === 'PathExpression') {
        w.filters.push({
          name,
          range: toRange(path.loc),
          known: w.helpers.has(name) || builtinHelpers.has(name),
        });
      } else if (path.type === 'PathExpression') {
        recordVariable(w, path);
      } else {
        walk(path as unknown as Node, w);
      }
      for (const p of n.params) walk(p, w);
      for (const pair of n.hash?.pairs ?? []) walk(pair.value, w);
      return;
    }
    case 'BlockStatement': {
      const n = node as hbs.AST.BlockStatement;
      const path = n.path as hbs.AST.PathExpression;
      const name = path.original;
      const type: BlockRef['type'] =
        name === 'each'
          ? 'for'
          : name === 'if' || name === 'unless'
            ? 'if'
            : 'block';
      w.blocks.push({ type, open: toRange(n.loc), close: toRange(n.loc) });
      if (!builtinHelpers.has(name)) {
        w.filters.push({
          name,
          range: toRange(path.loc),
          known: w.helpers.has(name),
        });
      }
      for (const p of n.params) walk(p, w);
      const subject = n.params[0];
      const subjectPath =
        subject?.type === 'PathExpression'
          ? resolve(w, subject as hbs.AST.PathExpression).abs
          : null;
      const scope: Scope = {
        source: w.scopes.at(-1)?.source ?? [],
        params: new Map(),
        loop: false,
      };
      if (name === 'each') {
        scope.loop = true;
        scope.source = subjectPath;
        const [item, index] = n.program?.blockParams ?? [];
        if (item) scope.params.set(item, subjectPath);
        if (index) scope.params.set(index, null);
      } else if (name === 'with') {
        scope.source = subjectPath;
        const [alias] = n.program?.blockParams ?? [];
        if (alias) scope.params.set(alias, subjectPath);
      } else {
        for (const p of n.program?.blockParams ?? []) scope.params.set(p, null);
      }
      w.scopes.push(scope);
      walk(n.program, w);
      w.scopes.pop();
      walk(n.inverse, w);
      return;
    }
    case 'PartialStatement':
    case 'PartialBlockStatement': {
      const n = node as hbs.AST.PartialStatement;
      const nameNode = n.name as hbs.AST.PathExpression;
      if (nameNode.type === 'PathExpression')
        w.includes.push({ name: nameNode.original, range: toRange(n.loc) });
      for (const p of n.params) walk(p, w);
      for (const pair of n.hash?.pairs ?? []) walk(pair.value, w);
      return;
    }
    case 'PathExpression':
      recordVariable(w, node as hbs.AST.PathExpression);
      return;
    default:
      return;
  }
}

/** `pageBreak()`: a helper whose signature has no parameters is called even when mentioned bare. */
function takesNoArguments(helpers: HelperRegistry, name: string): boolean {
  return /^\w+\(\)$/.test(helpers.get(name)?.doc.signature ?? '');
}

/**
 * Records a data reference. No helper check here: Handlebars evaluates arguments as lookups in the
 * data — `title` in `{{upper title}}` is the field, never the `title` helper — and a bare mention
 * only reaches this point once it is known not to be a call.
 */
function recordVariable(w: Walk, path: hbs.AST.PathExpression): void {
  const parts = pathParts(path);
  if (parts.length === 0 || builtinRoots.has(parts[0] ?? '') || path.data)
    return;
  const r = resolve(w, path);
  const ref: VariableRef = {
    path: r.display,
    range: toRange(path.loc),
    kind: r.kind,
  };
  w.variables.push(ref);
  // the data check works on absolute paths; register a synthetic loop source per display root
  const key = r.display.join('.');
  if (r.kind === 'loop-var') w.loopSources.set(key, r.abs);
}

export function analyzeHandlebars(
  source: string,
  opts: AnalyzeOptions = {},
): Analysis {
  const helpers = opts.helpers ?? defaultHelpers();
  const w: Walk = {
    variables: [],
    filters: [],
    includes: [],
    blocks: [],
    scopes: [{ source: [], params: new Map(), loop: false }],
    helpers,
    loopSources: new Map(),
  };
  const diagnostics: Diagnostic[] = [];
  try {
    walk(Handlebars.parse(source), w);
  } catch (e) {
    const err = toSyntaxError(e);
    diagnostics.push({
      severity: 'error',
      code: 'syntax-error',
      message: err.message,
      range: rangeAt(err.line, err.column, 1),
    });
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
        message: `Unknown helper "${f.name}"`,
        range: f.range,
      });
    }
  }
  // Data check: loop-scoped variables were resolved to absolute paths already (or to null = unknown).
  const forCheck: VariableRef[] = w.variables.map((v) =>
    v.kind === 'loop-var' ? { ...v, path: [v.path.join('.')] } : v,
  );
  const dataDiagnostics = missingPathDiagnostics(
    forCheck,
    opts.sampleData,
    w.loopSources,
    new Set([...builtinRoots, ...helpers.names()]),
  ).map((d) => ({
    ...d,
    message: d.message.replace(/"([^"]+)"/, (_, p: string) => `"${p}"`),
  }));
  return {
    variables: w.variables,
    filters: w.filters,
    includes: w.includes,
    blocks: w.blocks,
    diagnostics: [...diagnostics, ...dataDiagnostics],
  };
}

// --- engine ----------------------------------------------------------------------------------

class HandlebarsCompiled implements CompiledTemplate {
  readonly engine = 'handlebars' as const;
  private readonly runtimes = new WeakMap<
    RenderContext,
    { hb: HB; template: HandlebarsTemplateDelegate }
  >();

  constructor(
    readonly name: string,
    readonly source: string,
  ) {}

  private runtime(ctx: RenderContext) {
    let rt = this.runtimes.get(ctx);
    if (!rt) {
      const hb = createInstance(ctx);
      rt = {
        hb,
        template: hb.compile(this.source, {
          strict: false,
          noEscape: false,
          preventIndent: true,
        }),
      };
      this.runtimes.set(ctx, rt);
    }
    return rt;
  }

  async render(data: unknown, ctx: RenderContext): Promise<string> {
    const started = Date.now();
    const { template } = this.runtime(ctx);
    // Partials are collected up front (includes nest, depth is capped) so Handlebars gets a plain map.
    const partials: Record<string, string> = {};
    const collect = (source: string, depth: number) => {
      for (const inc of analyzeHandlebars(source).includes) {
        if (inc.name in partials) continue;
        if (depth >= ctx.limits.includeDepth) {
          throw new RenderLimitError(
            'includeDepth',
            `Partials nest deeper than ${ctx.limits.includeDepth} (${inc.name})`,
          );
        }
        const src = ctx.partials(inc.name);
        if (src === undefined) continue;
        partials[inc.name] = src;
        collect(src, depth + 1);
      }
    };
    collect(this.source, 0);
    try {
      const out = template((data ?? {}) as object, {
        partials,
        allowProtoPropertiesByDefault: false,
        allowProtoMethodsByDefault: false,
      });
      return enforceLimits(out, started, ctx.limits);
    } catch (e) {
      if (e instanceof Error && e.name === 'RenderLimitError') throw e;
      const err = e as {
        message?: string;
        lineNumber?: number;
        column?: number;
      };
      throw new RenderError(
        'handlebars',
        String(err.message ?? e),
        err.lineNumber,
        err.column === undefined ? undefined : err.column + 1,
      );
    }
  }
}

export const handlebarsEngine: Engine = {
  id: 'handlebars',
  compile(source: string, opts: CompileOptions = {}): CompiledTemplate {
    const name = opts.name ?? 'template';
    try {
      createInstance(validationContext).precompile(source, { strict: false });
    } catch (e) {
      throw toSyntaxError(e);
    }
    return new HandlebarsCompiled(name, source);
  },
  analyze: analyzeHandlebars,
  render: (tpl, data, ctx) => tpl.render(data, ctx),
};
