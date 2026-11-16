/**
 * The template sandbox's runtime as one script (plan 27 §5.1), bundled by `nx run engine:sandbox`
 * (`scripts/build-sandbox.mjs`) and loaded by the render-worker's isolate and the editor's frame. It
 * sets one global, `formfeedSandbox`, whose `run(request, host)` answers in the shapes of
 * `lib/sandbox/protocol.ts` and never throws.
 *
 * The shims come first, because the engine's modules read some of those globals as they load.
 */
import './shims';
import { SANDBOX_PROTOCOL } from '../lib/sandbox/protocol';
import { runSandbox } from '../lib/sandbox/run';

(globalThis as unknown as { formfeedSandbox: unknown }).formfeedSandbox =
  Object.freeze({ protocol: SANDBOX_PROTOCOL, run: runSandbox });
