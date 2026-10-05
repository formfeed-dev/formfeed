import {
  AUDIT_SEVERITY,
  AUDIT_TITLES,
  auditMessage,
  type AuditFinding,
} from '@formfeed/engine';
import type { Render } from '@formfeed/sdk-ts';
import { CliError, exitCodes } from './errors';

/** `accessibility` of a render that set `pdf.ua`. */
export type Verdict = NonNullable<Render['accessibility']>;

/**
 * What the validator said about a render as PDF/UA-1 (plan 21 §7), for `formfeed render` and the
 * dev server: the verdict with the rule count and the validator, every failed rule with what to
 * change and the elements it is about, and what a reader stumbles over although no rule fails.
 * Nothing for a render that did not set `pdf.ua`.
 */
export function accessibilityLines(
  accessibility: Render['accessibility'],
): string[] {
  if (!accessibility) return [];
  const { rules } = accessibility;
  const lines = [
    accessibility.conformant
      ? `${accessibility.standard}   conformant, ${rules.passed} rule(s) passed (${accessibility.validator})`
      : `${accessibility.standard}   not conformant, ${rules.failed} of ${rules.passed + rules.failed} rule(s) failed (${accessibility.validator})`,
  ];
  for (const failure of accessibility.failures)
    lines.push(
      `  error    ${failure.rule}: ${failure.message}`,
      ...failure.elements.map((element) => `           ${element}`),
    );
  if (accessibility.truncated)
    lines.push('           more rules failed than are listed');
  for (const warning of accessibility.warnings) {
    const title =
      (AUDIT_TITLES as Record<string, string>)[warning.code] ?? warning.code;
    lines.push(
      `  warn     ${title}${warning.elements.length ? `: ${warning.elements.join(', ')}` : ''}`,
    );
  }
  // with `report` the file is delivered either way, and says of itself only what was proven
  if (!accessibility.conformant && accessibility.check === 'report')
    lines.push('  the file does not carry the PDF/UA identifier');
  return lines;
}

/** The verdict of a strict render that failed, as its problem or its stored render carries it. */
export function strictVerdict(error: unknown): Verdict | null {
  const failed = error as {
    code?: unknown;
    problem?: Record<string, unknown> | null;
  } | null;
  const verdict = failed?.problem?.['accessibility'];
  return failed?.code === 'pdfua_validation_failed' &&
    verdict &&
    typeof verdict === 'object'
    ? (verdict as Verdict)
    : null;
}

/**
 * A strict PDF/UA render that failed: a finding about the template, with the rules and their
 * elements, and the exit code of a validation, not of a failed request.
 */
export function strictFailure(
  slug: string,
  verdict: Verdict,
  data: unknown,
): CliError {
  return new CliError(
    [
      ...accessibilityLines(verdict),
      `${slug}: no file, because pdf.ua is strict (check: "report" delivers it without the identifier)`,
    ].join('\n'),
    exitCodes.validation,
    data,
  );
}

/** One finding of the preview's template check, worded for the dev server's list. */
export interface AuditLine {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  snippet: string;
}

/**
 * The findings a preview frame posts (`formfeed:audit`), as the dev server lists them. They come
 * from a page the template wrote, so nothing in them is trusted: a code the audit does not have is
 * dropped, and the sentence is built here from the code and its values.
 */
export function auditLines(findings: unknown): AuditLine[] {
  if (!Array.isArray(findings)) return [];
  const out: AuditLine[] = [];
  for (const entry of findings.slice(0, 200)) {
    const finding = entry as Partial<AuditFinding> | null;
    const code = finding?.code;
    if (typeof code !== 'string' || !(code in AUDIT_SEVERITY)) continue;
    const args =
      finding?.args && typeof finding.args === 'object' ? finding.args : {};
    out.push({
      severity: AUDIT_SEVERITY[code as AuditFinding['code']],
      code,
      message: auditMessage({ code: code as AuditFinding['code'], args }),
      snippet: typeof finding?.snippet === 'string' ? finding.snippet : '',
    });
  }
  return out;
}
