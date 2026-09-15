/**
 * Failures of the office container code (spec 22 §2.1, §8). The codes are the API's problem codes, so
 * the gateway and the worker pass them on unchanged.
 */
export type OfficeErrorCode =
  | 'file_type_unsupported'
  | 'source_encrypted'
  | 'office_document_invalid'
  | 'office_document_too_large';

export class OfficeError extends Error {
  constructor(
    readonly code: OfficeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OfficeError';
  }
}

/** Limits of spec 22 §2.1 and §4.3. */
export const officeLimits = {
  /** Entries in one container. */
  maxEntries: 2000,
  /** Sum of the uncompressed sizes the central directory declares. */
  maxDeclaredBytes: 200 * 1024 * 1024,
  /** One part we inflate; enforced while inflating, because the declared size can lie. */
  maxPartBytes: 20 * 1024 * 1024,
  /** A conversion upload or a template file. */
  maxFileBytes: 20 * 1024 * 1024,
} as const;
