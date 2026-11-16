import { renderVersionParts } from '../assemble';
import { layeredPartials } from '../brand';
import { defaultHelpers } from '../helpers';
import { defaultLimits } from '../limits';
import { renderMarkdownParts } from '../markdown/render';
import { renderOffice } from '../office/render';
import type { RenderContext } from '../types';
import {
  errorData,
  type EngineRunner,
  type SandboxContext,
  type SandboxHost,
  type SandboxRequest,
  type SandboxResponse,
  type SandboxSeed,
} from './protocol';

/**
 * The template sandbox's runtime (plan 27 §5.1): the one function the isolate and the frame call,
 * and the in-process runner, which runs the same code where no sandbox is (tests, the CLI's
 * neighbours, `ENGINE_SANDBOX=process`). It never throws: a failure comes back as data.
 */
export async function runSandbox(
  request: SandboxRequest,
  host: SandboxHost = {},
): Promise<SandboxResponse> {
  try {
    const random = seededRandom(request.seed);
    const shared: string[] = [];
    const ctx = renderContextOf(request.context, (name) => {
      if (!shared.includes(name)) shared.push(name);
    });
    switch (request.op) {
      case 'version':
        return {
          ok: true,
          op: 'version',
          parts: await renderVersionParts(request.version, request.data, ctx),
          shared,
        };
      case 'markdown':
        return {
          ok: true,
          op: 'markdown',
          parts: await renderMarkdownParts(
            request.source,
            request.data,
            ctx,
            nonceOf(random),
          ),
          shared,
        };
      case 'office': {
        const filled = await renderOffice(request.file, {
          engine: request.engine,
          data: request.data,
          context: ctx,
          random,
          images: host.images,
        });
        return {
          ok: true,
          op: 'office',
          bytes: filled.bytes,
          format: filled.format,
          warnings: filled.warnings,
          diagnostics: filled.diagnostics,
        };
      }
      default:
        throw new Error('The template sandbox knows no such operation');
    }
  } catch (e) {
    return { ok: false, error: errorData(e) };
  }
}

/** The runtime in this thread: no boundary, the same code and the same answers. */
export const inProcessRunner: EngineRunner = { run: runSandbox };

/** A render context from the request's data; helpers, partials and limits are the runtime's own. */
export function renderContextOf(
  context: SandboxContext,
  onShared: (name: string) => void,
): RenderContext {
  return {
    locale: context.locale,
    timezone: context.timezone,
    currency: context.currency,
    partials: layeredPartials(context.partials, context.shared, (name) =>
      onShared(name),
    ),
    helpers: defaultHelpers(),
    limits: { ...defaultLimits, ...context.limits },
    i18n: context.i18n,
    assetBaseUrl: context.assetBaseUrl,
    brand: context.brand,
  };
}

/**
 * A generator over the host's seed (sfc32): the nonces of one render come from bytes the data never
 * sees, in the isolate as in process, where `Math.random` of a context made from a snapshot would be
 * a state every render shares.
 */
export function seededRandom(seed: SandboxSeed): () => number {
  // a view of bytes from any realm: a copy across a frame or a port is another realm's Uint8Array
  if (
    !ArrayBuffer.isView(seed) ||
    (seed as Uint8Array).BYTES_PER_ELEMENT !== 1 ||
    seed.byteLength < 16
  )
    throw new Error('The template sandbox needs a seed of 16 bytes or more');
  const word = (i: number) =>
    (seed[i]! |
      (seed[i + 1]! << 8) |
      (seed[i + 2]! << 16) |
      (seed[i + 3]! << 24)) >>>
    0;
  let a = word(0);
  let b = word(4);
  let c = word(8);
  let d = word(12);
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Sixteen hexadecimal digits for the kept HTML of a Markdown render (`kept.ts`). */
function nonceOf(random: () => number): string {
  let nonce = '';
  for (let i = 0; i < 16; i++) nonce += Math.floor(random() * 16).toString(16);
  return nonce;
}

/** Thirty-two bytes of the platform's random source, for a host that makes a request. */
export function sandboxSeed(): SandboxSeed {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}
