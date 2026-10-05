import {
  UA_REFUSALS,
  isOfficeKind,
  isUaSetting,
  resolveEinvoiceOptions,
  resolveUa,
  staticAuditDiagnostics,
} from '@formfeed/engine';
import type { LocalDiagnostic } from './local-render';
import { templateFileName, type LocalTemplate } from './project';

/**
 * `pdf.ua` of a template folder (plan 21 §6): what can be said about a template that declares
 * PDF/UA-1 without rendering it. `formfeed validate` and the MCP server's validation report it. It
 * is the static half of the template check: a document without a title, an image written without
 * `alt`, and a declaration the API will refuse. What depends on the data (heading levels, table
 * rows, a chart's name) is found in the rendered page, by the editor's preview and by the render.
 */

/** The findings of one file of a template folder. */
export interface FileDiagnostics {
  /** Relative to the template folder: `template.html`, `settings.json`. */
  file: string;
  diagnostics: LocalDiagnostic[];
}

const nowhere = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

const about = (
  severity: LocalDiagnostic['severity'],
  code: string,
  message: string,
): FileDiagnostics => ({
  file: 'settings.json',
  diagnostics: [{ severity, code, message, range: nowhere }],
});

/**
 * Empty for a template that does not declare `pdf.ua`. A fault the validator fails the file for is
 * an error where the template is strict, since every render of it then fails, and a warning where
 * it only reports; what a reader stumbles over without a rule failing is a warning either way.
 */
export function diagnoseAccessibility(tpl: LocalTemplate): FileDiagnostics[] {
  const declared = tpl.settings.pdf?.ua;
  if (declared !== undefined && !isUaSetting(declared))
    return [
      about(
        'error',
        'accessibility-setting',
        'pdf.ua is true, false or { "check": "strict" | "report" }',
      ),
    ];
  const ua = resolveUa(declared);
  if (!ua) return [];
  if (tpl.meta.kind === 'image')
    return [
      about(
        'warning',
        'accessibility-image',
        'settings.json declares pdf.ua, which an image template never produces: PDF/UA is a format of PDF',
      ),
    ];
  // what the API refuses when the template renders a PDF, in the API's words
  if (isOfficeKind(tpl.meta.kind))
    return [about('error', 'accessibility-office', UA_REFUSALS.office)];
  const out: FileDiagnostics[] = [];
  const einvoice = resolveEinvoiceOptions(tpl.settings.einvoice);
  if (!einvoice.ok || einvoice.options)
    out.push(about('error', 'accessibility-einvoice', UA_REFUSALS.einvoice));
  const body: LocalDiagnostic[] = [];
  for (const found of staticAuditDiagnostics(
    {
      engine: tpl.meta.engine,
      html: tpl.html,
      head: tpl.head,
      title: tpl.settings.pdf?.metadata?.title,
    },
    ua,
  )) {
    // a finding about the document as a whole (its title) belongs to the settings
    if (!found.location) {
      out.push(about(found.severity, found.code, found.message));
      continue;
    }
    body.push({
      severity: found.severity,
      code: found.code,
      message: found.message,
      range: { start: found.location, end: found.location },
    });
  }
  if (body.length)
    out.push({ file: templateFileName(tpl.meta.kind), diagnostics: body });
  return out;
}
