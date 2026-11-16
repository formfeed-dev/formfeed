import {
  assembleVersion,
  type AssembleExtras,
  type RenderedDocument,
  type VersionSource,
} from '../assemble';
import type { OfficeImageHost } from '../office/drawings';
import type { OfficeRenderResult } from '../office/render';
import type { EngineId } from '../types';
import {
  unwrapResponse,
  type EngineRunner,
  type SandboxContext,
} from './protocol';
import { sandboxSeed } from './run';

/**
 * `renderVersion` with its template code in a sandbox (plan 27): the runner renders the parts, the
 * document is assembled here. A failure is thrown as the engine's error, as `renderVersion` throws
 * it. `shared` names the shared partials the template read.
 */
export async function renderVersionWith(
  runner: EngineRunner,
  version: VersionSource,
  data: unknown,
  context: SandboxContext,
  mode: 'preview' | 'print' = 'print',
  extras: AssembleExtras = {},
): Promise<RenderedDocument & { shared: string[] }> {
  const { parts, shared } = unwrapResponse(
    await runner.run({
      op: 'version',
      version,
      data,
      context,
      seed: sandboxSeed(),
    }),
    'version',
  );
  return {
    ...assembleVersion(
      version,
      parts,
      { assetBaseUrl: context.assetBaseUrl, brand: context.brand },
      mode,
      extras,
    ),
    shared,
  };
}

/** `renderOffice` with its template code in a sandbox (plan 27); the pictures come from `images`. */
export async function renderOfficeWith(
  runner: EngineRunner,
  file: Uint8Array,
  options: {
    engine: EngineId;
    data: unknown;
    context: SandboxContext;
    images?: OfficeImageHost;
  },
): Promise<OfficeRenderResult> {
  const filled = unwrapResponse(
    await runner.run(
      {
        op: 'office',
        file,
        engine: options.engine,
        data: options.data,
        context: options.context,
        seed: sandboxSeed(),
      },
      { images: options.images },
    ),
    'office',
  );
  return {
    bytes: filled.bytes,
    format: filled.format,
    warnings: filled.warnings,
    diagnostics: filled.diagnostics,
  };
}
