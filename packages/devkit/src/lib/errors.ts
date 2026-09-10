/** Errors of the development kit; the CLI maps `code` to its exit codes. */
export class DevkitError extends Error {
  override readonly name = 'DevkitError';
  constructor(
    message: string,
    readonly code: 'usage' | 'validation' = 'usage',
  ) {
    super(message);
  }
}
