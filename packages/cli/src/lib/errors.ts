/** Exit codes of spec 15 §3. */
export const exitCodes = {
  ok: 0,
  validation: 1,
  usage: 2,
  auth: 3,
  network: 4,
  quota: 5,
} as const;
export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];

export class CliError extends Error {
  override readonly name = 'CliError';
  constructor(
    message: string,
    readonly exitCode: ExitCode = exitCodes.usage,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Maps SDK failures (problem status) and unknown errors to the documented exit codes. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode;
  if ((error as { name?: string } | null)?.name === 'DevkitError')
    return (error as { code?: string }).code === 'validation' ? exitCodes.validation : exitCodes.usage;
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: string } | null)?.code;
  if (status === 401 || status === 403 || code === 'unauthorized' || code === 'forbidden') return exitCodes.auth;
  if (status === 402 || status === 429 || code === 'quota_exceeded' || code === 'rate_limited') return exitCodes.quota;
  if (typeof status === 'number' && status >= 400 && status < 500) return exitCodes.usage;
  if ((error as { name?: string } | null)?.name === 'FormfeedError') return exitCodes.network;
  return exitCodes.network;
}
