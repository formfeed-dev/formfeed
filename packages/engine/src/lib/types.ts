import type { BrandContext } from './brand';
/**
 * Shared contracts of `@formfeed/engine` (spec 05). Used by the Angular editor (browser) and the
 * Fly.io render-worker (Node); nothing here may touch Node-only APIs.
 */

export type EngineId = 'jinja2' | 'liquid' | 'handlebars';

/** 1-based line and column, end exclusive. */
export interface Position {
  line: number;
  column: number;
}
export interface Range {
  start: Position;
  end: Position;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  range: Range;
  /** Stable code the editor keys quick-fixes and docs on, e.g. `unknown-filter`. */
  code: string;
  /** Optional quick-fix: replace the range with `replacement`. */
  fix?: { title: string; replacement: string };
}

export interface VariableRef {
  path: string[];
  range: Range;
  kind: 'read' | 'loop-var' | 'assigned';
  /**
   * For a variable bound in the template (loop variable, macro argument, `set`): the data path it
   * stands for where it is used, `null` when that is not a data path. Resolved per scope, so two loops
   * that reuse a name each check against their own list.
   */
  source?: string[] | null;
}
export interface FilterRef {
  name: string;
  range: Range;
  known: boolean;
}
export interface IncludeRef {
  name: string;
  range: Range;
}
export interface BlockRef {
  type: 'for' | 'if' | 'block' | 'raw' | 'macro' | 'other';
  open: Range;
  close?: Range;
}

export interface Analysis {
  variables: VariableRef[];
  filters: FilterRef[];
  includes: IncludeRef[];
  blocks: BlockRef[];
  diagnostics: Diagnostic[];
}

export interface AnalyzeOptions {
  /** Sample data; when given, variable paths missing from it produce warnings. */
  sampleData?: unknown;
  /** Helper registry that decides which filter names are known. Defaults to the built-in set. */
  helpers?: HelperRegistry;
}

/** Resolves a workspace partial by name to its source; `undefined` when it does not exist. */
export type PartialResolver = (name: string) => string | undefined;

export interface RenderLimits {
  /** Wall-clock budget of one render in milliseconds. */
  ms: number;
  /** Maximum size of the rendered HTML in bytes. */
  outputBytes: number;
  /** Maximum nesting of includes and extends. */
  includeDepth: number;
}

export interface RenderContext {
  locale: string;
  timezone: string;
  currency: string;
  partials: PartialResolver;
  helpers: HelperRegistry;
  limits: RenderLimits;
  /** Template-level dictionaries for `t()`: locale → key → text (USP-8). */
  i18n?: Record<string, Record<string, string>>;
  /** Base URL for `asset()` (workspace asset root on the CDN). */
  assetBaseUrl?: string;
  /**
   * The organisation's brand kit (spec 18): the template global `brand` (request data of the same
   * name wins) and the `--brand-*` variables the assembler injects.
   */
  brand?: BrandContext;
  /**
   * `office` renders the text of an office part (spec 22 §4.3): the engines do not escape, because the
   * text is escaped as a whole when the markup is restored (`office/template-text.ts`). HTML by default.
   */
  mode?: 'html' | 'office';
  /** Office mode, set by `renderOffice`: see `HelperContext.drawing`. */
  drawing?: (request: OfficeDrawingRequest) => string;
}

export interface CompileOptions {
  /** Name used in error messages and as the root include name. */
  name?: string;
}

export interface CompiledTemplate {
  engine: EngineId;
  name: string;
  source: string;
  render(data: unknown, ctx: RenderContext): Promise<string>;
}

export interface Engine {
  id: EngineId;
  /** Parses and compiles; throws `EngineSyntaxError` with line and column. */
  compile(source: string, opts?: CompileOptions): CompiledTemplate;
  analyze(source: string, opts?: AnalyzeOptions): Analysis;
  render(
    tpl: CompiledTemplate,
    data: unknown,
    ctx: RenderContext,
  ): Promise<string>;
}

// --- helpers ---------------------------------------------------------------------------------

export type HelperCategory =
  'format' | 'text' | 'collection' | 'logic' | 'code' | 'document' | 'debug';

export interface HelperDoc {
  signature: string;
  description: string;
  /**
   * The same call written for each engine, so the reference and the editor can show the reader the
   * one they can paste. They differ in more than punctuation — Jinja2 passes filter arguments in
   * parentheses, Liquid after a colon, Handlebars positionally — and `helper-examples.spec.ts`
   * renders every one of them, so none of the three can be wrong.
   */
  examples: Record<EngineId, string>;
  category: HelperCategory;
}

/** A helper's documentation with the name it is registered under. What `helperDocs()` returns. */
export interface HelperDocEntry extends HelperDoc {
  name: string;
  aliases: string[];
  /** The Jinja2 example, for readers written before `examples`. */
  example: string;
}

export interface HelperDefinition {
  name: string;
  /** Other names the helper answers to (apitemplate.io compatibility aliases). */
  aliases?: string[];
  /** Result is HTML that must not be escaped by the engine. */
  html?: boolean;
  /** Emits a warning diagnostic pointing to the preferred name (deprecated aliases). */
  deprecatedAlias?: Record<string, string>;
  doc: HelperDoc;
  /** Receives the render context first, then the template arguments. */
  fn: (ctx: HelperContext, ...args: unknown[]) => unknown;
}

/** What helpers know about the current render without receiving the whole context. */
export interface HelperContext {
  locale: string;
  timezone: string;
  currency: string;
  i18n?: Record<string, Record<string, string>>;
  assetBaseUrl?: string;
  /** `office` while an office template is filled (spec 22 §4.4); helpers that emit markup behave differently. */
  mode?: 'html' | 'office';
  /**
   * Office mode: registers a drawing (a code, an image or a page break) and returns the placeholder
   * the post pass turns into it. Set by `renderOffice`.
   */
  drawing?: (request: OfficeDrawingRequest) => string;
}

/** What a helper asks the office post pass to place where its placeholder stands. */
export type OfficeDrawingRequest =
  | { kind: 'svg'; svg: string; width?: number | string; height?: number | string; alt?: string }
  | { kind: 'url'; url: string; width?: number | string; height?: number | string; alt?: string }
  | { kind: 'page-break' };

export interface HelperRegistry {
  /** Registered helpers keyed by canonical name. */
  readonly definitions: ReadonlyMap<string, HelperDefinition>;
  /** Resolves a name or alias. */
  get(name: string): HelperDefinition | undefined;
  has(name: string): boolean;
  /** Every name the engines know, aliases included. */
  names(): string[];
  /** Concrete functions bound to a render context, keyed by every name and alias. */
  bind(
    ctx: HelperContext,
  ): Map<string, { fn: (...args: unknown[]) => unknown; html: boolean }>;
  register(definition: HelperDefinition): void;
}
