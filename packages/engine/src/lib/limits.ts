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
 * The time limit of the render under way, checked from inside it. A render is synchronous, so nothing
 * outside can stop it: no timer fires while it runs, in the render-worker's process or in the editor's
 * page. Each engine therefore calls `tick` at every loop step, call and include, and a template that
 * does not end stops at its limit instead of holding the process (plan 27, step 0).
 */
interface OpenDeadline {
  readonly startedAt: number;
  readonly ms: number;
  hit: RenderLimitError | null;
  readonly outer: OpenDeadline | null;
}

/** A render's time limit while it is open. */
export interface Deadline {
  /**
   * The error `tick` threw once the limit had passed, so the engine reports the limit even where the
   * template language wrapped the error into one of its own.
   */
  readonly hit: RenderLimitError | null;
  /** Ends the limit and restores the one of the render around it. */
  close(): void;
}

let open: OpenDeadline | null = null;
let ticks = 0;

/** Opens the time limit of a synchronous render that started at `startedAt`. */
export function openDeadline(
  limits: RenderLimits,
  startedAt: number,
): Deadline {
  const deadline: OpenDeadline = {
    startedAt,
    ms: limits.ms,
    hit: null,
    outer: open,
  };
  open = deadline;
  return {
    get hit() {
      return deadline.hit;
    },
    close() {
      if (open === deadline) open = deadline.outer;
    },
  };
}

/**
 * Throws once the open render is past its limit. The clock is read every 16th call: a loop step
 * takes about a microsecond, so that stops a render within a millisecond of its limit and costs a
 * template that ends next to nothing.
 */
export function tick(): void {
  const deadline = open;
  if (!deadline || (++ticks & 15) !== 0) return;
  const elapsed = Date.now() - deadline.startedAt;
  if (elapsed <= deadline.ms) return;
  deadline.hit ??= new RenderLimitError(
    'ms',
    `Template render took ${elapsed} ms; the limit is ${deadline.ms} ms`,
  );
  throw deadline.hit;
}

/**
 * Checks a finished render: its output size, and its time once more for what `tick` cannot see, a
 * single long step such as one filter call. Oversized or overlong results never reach Chromium.
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
