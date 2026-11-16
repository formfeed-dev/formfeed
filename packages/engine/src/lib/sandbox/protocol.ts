import type { VersionParts, VersionSource } from '../assemble';
import type { BrandContext, SharedPartial } from '../brand';
import { EngineSyntaxError, RenderError, RenderLimitError } from '../errors';
import type { MarkdownParts, MarkdownSource } from '../markdown/render';
import type { OfficeImageHost } from '../office/drawings';
import { OfficeError, type OfficeErrorCode } from '../office/errors';
import { OfficeTemplateError } from '../office/render';
import type { OfficeDiagnostic } from '../office/tags';
import type { EngineId, RenderLimits } from '../types';

/**
 * What crosses the boundary of the template sandbox (plan 27 §5.1): the render-worker's V8 isolate
 * and the editor's sandboxed frame run the same runtime, `formfeedSandbox.run(request)`, and a host
 * talks to it in these shapes only. Everything is data: a request carries no function, and a
 * response is read as data from a stranger (`response.ts`), because a template that escaped its
 * engine wrote it.
 */

/** The protocol's revision, which the runtime names as `formfeedSandbox.protocol`; a host refuses another. */
export const SANDBOX_PROTOCOL = 1;

/** The values a template renders with; the runtime makes the helpers, the partials and the limits. */
export interface SandboxContext {
  locale: string;
  timezone: string;
  currency: string;
  i18n?: Record<string, Record<string, string>>;
  assetBaseUrl?: string;
  brand?: BrandContext;
  /** The version's own partials, by exact name. */
  partials?: Record<string, string>;
  /** The organisation's shared partials, resolved after the version's own (`layeredPartials`). */
  shared?: Record<string, SharedPartial>;
  /** Over `defaultLimits`; the host decides them, the template never does. */
  limits?: Partial<RenderLimits>;
}

/** Thirty-two random bytes of the host's, from which the runtime draws every nonce of one render. */
export type SandboxSeed = Uint8Array;

export type SandboxRequest =
  | {
      op: 'version';
      version: VersionSource;
      data: unknown;
      context: SandboxContext;
      seed: SandboxSeed;
    }
  | {
      op: 'markdown';
      source: MarkdownSource;
      data: unknown;
      context: SandboxContext;
      seed: SandboxSeed;
    }
  | {
      op: 'office';
      file: Uint8Array;
      engine: EngineId;
      data: unknown;
      context: SandboxContext;
      seed: SandboxSeed;
    };

/** What a host offers the runtime besides the request: the office template's pictures. */
export interface SandboxHost {
  images?: OfficeImageHost;
}

/** A failure as data; `errorFromData` makes the engine's error classes of it again. */
export type SandboxErrorData =
  | {
      kind: 'syntax';
      engine: EngineId;
      message: string;
      line: number;
      column: number;
    }
  | {
      kind: 'runtime';
      engine: EngineId;
      message: string;
      line?: number;
      column?: number;
    }
  | {
      kind: 'limit';
      limit: RenderLimitError['limit'];
      message: string;
    }
  | {
      kind: 'office';
      code: OfficeErrorCode;
      message: string;
      details: Record<string, unknown>;
    }
  | {
      kind: 'office-template';
      message: string;
      diagnostics: OfficeDiagnostic[];
      part?: string;
      cause?: Extract<SandboxErrorData, { kind: 'syntax' | 'runtime' }>;
    }
  | { kind: 'error'; message: string };

export type SandboxResponse =
  | { ok: true; op: 'version'; parts: VersionParts; shared: string[] }
  | { ok: true; op: 'markdown'; parts: MarkdownParts; shared: string[] }
  | {
      ok: true;
      op: 'office';
      bytes: Uint8Array;
      format: 'docx' | 'pptx';
      warnings: string[];
      diagnostics: OfficeDiagnostic[];
    }
  | { ok: false; error: SandboxErrorData };

/** Runs one request: the runtime in process, in an isolate or in a frame. */
export interface EngineRunner {
  run(request: SandboxRequest, host?: SandboxHost): Promise<SandboxResponse>;
}

/** A failure inside the runtime as data. */
export function errorData(e: unknown): SandboxErrorData {
  if (e instanceof EngineSyntaxError)
    return {
      kind: 'syntax',
      engine: e.engine,
      message: e.message,
      line: e.line,
      column: e.column,
    };
  if (e instanceof RenderError)
    return {
      kind: 'runtime',
      engine: e.engine,
      message: e.message,
      line: e.line,
      column: e.column,
    };
  if (e instanceof RenderLimitError)
    return { kind: 'limit', limit: e.limit, message: e.message };
  if (e instanceof OfficeTemplateError) {
    const cause = e.cause ? errorData(e.cause) : undefined;
    return {
      kind: 'office-template',
      message: e.message,
      diagnostics: e.diagnostics,
      part: e.part,
      cause:
        cause?.kind === 'syntax' || cause?.kind === 'runtime'
          ? cause
          : undefined,
    };
  }
  if (e instanceof OfficeError)
    return {
      kind: 'office',
      code: e.code,
      message: e.message,
      details: plainDetails(e.details),
    };
  return {
    kind: 'error',
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Details that survive a structured copy: numbers, strings, booleans and lists of them. */
function plainDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (['string', 'number', 'boolean'].includes(typeof value))
      out[key] = value;
    else if (
      Array.isArray(value) &&
      value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
    )
      out[key] = [...value];
  }
  return out;
}

/** The engine's error class of a failure the runtime reported, so a host maps it as it always did. */
export function errorFromData(data: SandboxErrorData): Error {
  switch (data.kind) {
    case 'syntax':
      return new EngineSyntaxError(
        data.engine,
        data.message,
        data.line,
        data.column,
      );
    case 'runtime':
      return new RenderError(data.engine, data.message, data.line, data.column);
    case 'limit':
      return new RenderLimitError(data.limit, data.message);
    case 'office':
      return new OfficeError(data.code, data.message, data.details);
    case 'office-template':
      return new OfficeTemplateError(
        data.message,
        data.diagnostics,
        data.part,
        data.cause
          ? (errorFromData(data.cause) as EngineSyntaxError | RenderError)
          : undefined,
      );
    case 'error':
      return new Error(data.message);
  }
}

/** The response's result, or its failure thrown as the engine's error. */
export function unwrapResponse<Op extends SandboxRequest['op']>(
  response: SandboxResponse,
  op: Op,
): Extract<SandboxResponse, { ok: true; op: Op }> {
  if (!response.ok) throw errorFromData(response.error);
  if (response.op !== op)
    throw new Error(`The template sandbox answered ${response.op} to ${op}`);
  return response as Extract<SandboxResponse, { ok: true; op: Op }>;
}
