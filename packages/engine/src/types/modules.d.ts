/* Ambient typings for deep imports the engine relies on (browser-safe builds). */

declare module 'nunjucks/browser/nunjucks.js' {
  import type * as N from 'nunjucks';

  /** Nunjucks AST node; every node carries a 0-based `lineno`/`colno` and lists its child fields. */
  export interface NunjucksNode {
    typename: string;
    lineno: number;
    colno: number;
    fields: string[];
    children?: NunjucksNode[];
    value?: unknown;
    [field: string]: unknown;
  }

  export interface NunjucksCompiler {
    _emit(code: string): void;
    _emitLine(code: string): void;
    /** Throws a template error at a node's 0-based position. */
    fail(message: string, lineno?: number, colno?: number): never;
    _compileExpression(node: unknown, frame: unknown): void;
    compile(node: unknown, frame: unknown): void;
  }

  export interface NunjucksSetNode {
    targets: NunjucksNode[];
    value: NunjucksNode | null;
    body: NunjucksNode | null;
  }

  export interface NunjucksModule {
    Environment: typeof N.Environment;
    Template: typeof N.Template;
    Loader: typeof N.Loader;
    runtime: typeof N.runtime & {
      memberLookup: (obj: unknown, val: unknown, ...rest: unknown[]) => unknown;
      suppressValue: (val: unknown, autoescape: boolean) => unknown;
      /** Every call a template makes (helpers, macros, `caller()`) goes through it. */
      callWrap: (
        obj: unknown,
        name: string,
        context: unknown,
        args: unknown[],
      ) => unknown;
    };
    /**
     * The code generator; patched for `not` precedence, namespace attributes, the time limit and
     * regular expression literals (engines/jinja2.ts).
     */
    compiler: {
      Compiler: {
        prototype: {
          compileNot(
            this: NunjucksCompiler,
            node: { target: unknown },
            frame: unknown,
          ): void;
          compileSet(
            this: NunjucksCompiler,
            node: NunjucksSetNode,
            frame: unknown,
          ): void;
          compileLiteral(
            this: NunjucksCompiler,
            node: { value: unknown; lineno: number; colno: number },
          ): void;
          /** Writes a loop step's `loop.*` bindings: every loop form calls it once per step. */
          _emitLoopBindings(
            this: NunjucksCompiler,
            node: unknown,
            arr: string,
            i: string,
            len: string,
          ): void;
        };
      };
    };
    lib: {
      TemplateError: new (
        message: string,
        lineno?: number,
        colno?: number,
      ) => Error;
    };
    installJinjaCompat: () => void;
    parser: {
      parse(
        src: string,
        extensions?: unknown[],
        opts?: Record<string, unknown>,
      ): NunjucksNode;
    };
    nodes: Record<string, unknown>;
  }

  const nunjucks: NunjucksModule;
  export default nunjucks;
}

declare module 'qrcode/lib/renderer/svg-tag.js' {
  import type { QRCode } from 'qrcode';
  export function render(
    qrData: QRCode,
    options?: {
      width?: number;
      margin?: number;
      scale?: number;
      color?: { dark?: string; light?: string };
    },
  ): string;
}

declare module 'bwip-js' {
  /** Symbology rendering options; `bcid` and `text` are required. */
  export interface RenderOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    width?: number;
    includetext?: boolean;
    textxalign?: string;
    [option: string]: unknown;
  }
  export function toSVG(options: RenderOptions): string;
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  /** markdown-it's footnote plugin (`[^1]`); it ships no typings of its own. */
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}
