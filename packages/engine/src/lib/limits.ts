import { RenderLimitError } from './errors';
import type { RenderLimits } from './types';

/** Limits of spec 05 §7 for a normal render. */
export const defaultLimits: RenderLimits = {
  ms: 5000,
  outputBytes: 20 * 1024 * 1024,
  includeDepth: 8,
};

const encoder = new TextEncoder();

/**
 * Post-hoc enforcement for synchronous engines: the render-worker isolates runaway templates with a
 * process timeout; here we reject oversized or overlong results so they never reach Chromium.
 */
export function enforceLimits(
  output: string,
  startedAt: number,
  limits: RenderLimits,
): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed > limits.ms)
    throw new RenderLimitError(
      'ms',
      `Template render took ${elapsed} ms; the limit is ${limits.ms} ms`,
    );
  // cheap upper bound first; exact byte length only when close to the limit
  if (output.length > limits.outputBytes / 4) {
    const bytes = encoder.encode(output).length;
    if (bytes > limits.outputBytes) {
      throw new RenderLimitError(
        'outputBytes',
        `Rendered HTML is ${bytes} bytes; the limit is ${limits.outputBytes} bytes`,
      );
    }
  }
  return output;
}

/** Wraps a partial resolver so nested includes past `includeDepth` fail instead of recursing. */
export function depthGuard(
  resolve: (name: string) => string | undefined,
  includeDepth: number,
): (name: string) => string | undefined {
  const stack: string[] = [];
  return (name) => {
    if (stack.length >= includeDepth)
      throw new RenderLimitError(
        'includeDepth',
        `Includes nest deeper than ${includeDepth} (${[...stack, name].join(' → ')})`,
      );
    if (stack.includes(name))
      throw new RenderLimitError(
        'includeDepth',
        `Partial "${name}" includes itself`,
      );
    stack.push(name);
    try {
      return resolve(name);
    } finally {
      stack.pop();
    }
  };
}
