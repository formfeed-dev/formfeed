import type { EngineId, Position } from './types';

/** Parse or compile failure with a location the editor can jump to. */
export class EngineSyntaxError extends Error {
  override readonly name = 'EngineSyntaxError';
  constructor(
    readonly engine: EngineId,
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }

  get position(): Position {
    return { line: this.line, column: this.column };
  }
}

/**
 * A template source that is not text. JSON can carry an object where a source belongs (a version's
 * settings, a render request's `settings`), and Handlebars compiles an object as a parsed syntax tree
 * whose values went into the generated code unchecked up to 4.7.9 (GHSA-8r5x-fm3f-whwj): a header
 * sent as a tree ran as JavaScript in the render-worker. Every engine takes text only.
 */
export function notText(engine: EngineId, source: unknown): EngineSyntaxError {
  const kind =
    source === null || source === undefined
      ? String(source)
      : Array.isArray(source)
        ? 'an array'
        : typeof source === 'object'
          ? 'an object'
          : `a ${typeof source}`;
  return new EngineSyntaxError(
    engine,
    `A template must be text, not ${kind}`,
    1,
    1,
  );
}

/** A render exceeded one of the limits in `RenderLimits` (spec 05 §7). */
export class RenderLimitError extends Error {
  override readonly name = 'RenderLimitError';
  constructor(
    readonly limit: 'ms' | 'outputBytes' | 'includeDepth',
    message: string,
  ) {
    super(message);
  }
}

/** What part of a Markdown document its library could not read (plan 33, decision 9). */
export type MarkdownSyntaxPart = 'math';

/**
 * A formula in a Markdown document that does not parse or is past a limit (plan 33, decision 9):
 * the render fails, naming the line, instead of printing an error box into a document that will be
 * sent. The API answers it as `422 markdown_syntax_error`.
 */
export class MarkdownSyntaxError extends Error {
  override readonly name = 'MarkdownSyntaxError';
  constructor(
    readonly part: MarkdownSyntaxPart,
    message: string,
    /** The line of the document, from 1, front matter included. */
    readonly line: number,
  ) {
    super(message);
  }
}

/** Runtime failure inside a template (unknown filter at render time, helper threw, ...). */
export class RenderError extends Error {
  override readonly name = 'RenderError';
  constructor(
    readonly engine: EngineId,
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
  }
}
