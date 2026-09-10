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
