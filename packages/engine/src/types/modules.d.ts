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
    compile(node: unknown, frame: unknown): void;
  }

  export interface NunjucksModule {
    Environment: typeof N.Environment;
    Template: typeof N.Template;
    Loader: typeof N.Loader;
    runtime: typeof N.runtime & {
      memberLookup: (obj: unknown, val: unknown, ...rest: unknown[]) => unknown;
    };
    /** The code generator; patched for `not` precedence (engines/jinja2.ts). */
    compiler: {
      Compiler: {
        prototype: {
          compileNot(this: NunjucksCompiler, node: { target: unknown }, frame: unknown): void;
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
