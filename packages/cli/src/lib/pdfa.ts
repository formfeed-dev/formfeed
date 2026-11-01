import type { Render } from '@formfeed/sdk-ts';

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
