import type { Render } from '@formfeed/sdk-ts';
import { CliError, exitCodes } from './errors';

/** `pdfa` of a render that set `pdf.pdfa`. */
export type PdfaVerdict = NonNullable<Render['pdfa']>;

/**
 * What the validator said about a render as PDF/A (plan 26), for `formfeed render` and the dev
 * server: the standard with the validator, and every rule of a file that failed with where veraPDF
 * found it. Nothing for a render that did not set `pdf.pdfa`.
 */
export function pdfaLines(pdfa: Render['pdfa']): string[] {
  if (!pdfa) return [];
  const lines = [
    pdfa.conformant
      ? `${pdfa.standard}   conformant (${pdfa.validator})`
      : `${pdfa.standard}   not conformant, ${pdfa.messages.length} finding(s) (${pdfa.validator})`,
  ];
  for (const message of pdfa.messages)
    lines.push(
      `  ${message.rule ?? '-'}  ${message.message}${message.location ? ` (${message.location})` : ''}`,
    );
  if (pdfa.truncated) lines.push('  … and more');
  return lines;
}

/** The report of a file that failed its PDF/A level, as its problem carries it. */
export function pdfaVerdict(error: unknown): PdfaVerdict | null {
  const failed = error as {
    code?: unknown;
    problem?: Record<string, unknown> | null;
  } | null;
  const verdict = failed?.problem?.['pdfa'];
  return failed?.code === 'pdfa_validation_failed' &&
    verdict &&
    typeof verdict === 'object'
    ? (verdict as PdfaVerdict)
    : null;
}

/**
 * A file that failed its PDF/A level: a finding about the document, with the rules and veraPDF's
 * places, and the exit code of a validation, not of a failed request.
 */
export function pdfaFailure(
  slug: string,
  verdict: PdfaVerdict,
  data: unknown,
): CliError {
  return new CliError(
    [
      ...pdfaLines(verdict),
      `${slug}: no file, because a file that fails ${verdict.standard} is not delivered`,
    ].join('\n'),
    exitCodes.validation,
    data,
  );
}
