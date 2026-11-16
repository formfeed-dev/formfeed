import { z } from 'zod';
import { OFFICE_FILLED_MAX_BYTES } from '../office/render';
import { officeDrawingLimits } from '../office/drawings';
import { officeLimits } from '../office/errors';
import type { SandboxResponse } from './protocol';

/**
 * A sandbox's answer read as data from a stranger (plan 27 §5.1). The HTML always was untrusted; the
 * error, the names of the partials read and the office diagnostics are too now, because a template
 * that escaped its engine wrote them. Every string and list has a cap, and anything that does not fit
 * the shape is refused as a whole, never passed on in part.
 */

/** Twice the render's output limit: the engine refuses more before it answers, a stranger may not. */
const MAX_TEXT = 40 * 1024 * 1024;
const MAX_MESSAGE = 4000;
const MAX_NAME = 300;

const text = z.string().max(MAX_TEXT);
const optionalText = text.optional();
const message = z.string().max(MAX_MESSAGE);
const engine = z.enum(['jinja2', 'liquid', 'handlebars']);
const position = z.number().int().min(0).max(10_000_000);

const syntax = z.strictObject({
  kind: z.literal('syntax'),
  engine,
  message,
  line: position,
  column: position,
});
const runtime = z.strictObject({
  kind: z.literal('runtime'),
  engine,
  message,
  line: position.optional(),
  column: position.optional(),
});

const officeDiagnostic = z.strictObject({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().max(MAX_NAME),
  message,
  part: z.string().max(MAX_NAME),
  paragraph: position,
  text: z.string().max(MAX_MESSAGE),
});
const diagnostics = z.array(officeDiagnostic).max(500);

const detail = z.union([
  z.string().max(MAX_MESSAGE),
  z.number(),
  z.boolean(),
  z
    .array(z.union([z.string().max(MAX_NAME), z.number(), z.boolean()]))
    .max(100),
]);

const error = z.discriminatedUnion('kind', [
  syntax,
  runtime,
  z.strictObject({
    kind: z.literal('limit'),
    limit: z.enum(['ms', 'outputBytes', 'includeDepth']),
    message,
  }),
  z.strictObject({
    kind: z.literal('office'),
    code: z.enum([
      'file_type_unsupported',
      'source_encrypted',
      'office_document_invalid',
      'office_document_too_large',
    ]),
    message,
    details: z.record(z.string().max(MAX_NAME), detail),
  }),
  z.strictObject({
    kind: z.literal('office-template'),
    message,
    diagnostics,
    part: z.string().max(MAX_NAME).optional(),
    cause: z.discriminatedUnion('kind', [syntax, runtime]).optional(),
  }),
  z.strictObject({ kind: z.literal('error'), message }),
]);

const shared = z.array(z.string().max(MAX_NAME)).max(200);

const versionParts = z.strictObject({
  html: text,
  headerHtml: optionalText,
  footerHtml: optionalText,
  title: optionalText,
  author: optionalText,
  subject: optionalText,
  keywords: optionalText,
});

const markdownParts = z.strictObject({
  text,
  headerHtml: optionalText,
  footerHtml: optionalText,
  title: optionalText,
  author: optionalText,
  subject: optionalText,
  keywords: optionalText,
  kept: z
    .strictObject({
      nonce: z.string().regex(/^[0-9a-f]{16}$/),
      html: z.array(text).max(100_000),
    })
    .optional(),
});

/** The filled parts, every picture they may carry and the untouched parts of a template file. */
const MAX_OFFICE_BYTES =
  OFFICE_FILLED_MAX_BYTES +
  officeDrawingLimits.maxImageBytes +
  officeLimits.maxFileBytes;

const responseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    op: z.literal('version'),
    parts: versionParts,
    shared,
  }),
  z.strictObject({
    ok: z.literal(true),
    op: z.literal('markdown'),
    parts: markdownParts,
    shared,
  }),
  z.strictObject({
    ok: z.literal(true),
    op: z.literal('office'),
    // a view of bytes from any realm: what a frame or a port copies is another realm's Uint8Array
    bytes: z.custom<Uint8Array>(
      (bytes) =>
        ArrayBuffer.isView(bytes) &&
        (bytes as Uint8Array).BYTES_PER_ELEMENT === 1 &&
        bytes.byteLength <= MAX_OFFICE_BYTES,
      'the filled document as bytes',
    ),
    format: z.enum(['docx', 'pptx']),
    warnings: z.array(message).max(200),
    diagnostics,
  }),
  z.strictObject({ ok: z.literal(false), error }),
]);

/** Thrown when a sandbox answered something no runtime of ours writes. */
export class SandboxResponseError extends Error {
  override readonly name = 'SandboxResponseError';
}

/**
 * The answer as the protocol's shape, or `SandboxResponseError`: a host treats that as a failure of
 * its own (an internal error), never as the template's, because a runtime of ours never writes it.
 */
export function parseSandboxResponse(raw: unknown): SandboxResponse {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new SandboxResponseError(
      `The template sandbox answered in a shape it does not write (${parsed.error.issues[0]?.path.join('.') || 'the answer'})`,
    );
  return parsed.data as SandboxResponse;
}
