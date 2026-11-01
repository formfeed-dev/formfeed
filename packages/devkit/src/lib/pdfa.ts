import {
  PDFA_REFUSALS,
  isPdfaSetting,
  pdfaStandard,
  resolveEinvoiceOptions,
  resolvePdfa,
} from '@formfeed/engine';
import type { FileDiagnostics } from './accessibility';
import type { LocalDiagnostic } from './local-render';
import type { LocalTemplate } from './project';

/**
 * `pdf.pdfa` of a template folder (plan 26): what can be said about a template that declares PDF/A
 * without rendering it. `formfeed validate` reports it, and the dev server shows it beside its
 * preview. A declaration the API refuses is an error, since every render of the template would
 * fail; whether the file passes is the render's to say, because only the sidecar converts.
 */

const nowhere = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

const about = (
  severity: LocalDiagnostic['severity'],
  code: string,
  message: string,
): FileDiagnostics => ({
  file: 'settings.json',
  diagnostics: [{ severity, code, message, range: nowhere }],
});

/** Empty for a template that does not declare `pdf.pdfa`, or declares it as the API takes it. */
export function diagnosePdfa(tpl: LocalTemplate): FileDiagnostics[] {
  const declared = tpl.settings.pdf?.pdfa;
  if (declared !== undefined && !isPdfaSetting(declared))
    return [about('error', 'pdfa-setting', PDFA_REFUSALS.invalid)];
  const level = resolvePdfa(declared);
  if (!level) return [];
  if (tpl.meta.kind === 'image')
    return [
      about(
        'warning',
        'pdfa-image',
        `settings.json declares ${pdfaStandard(level)}, which an image template never produces: PDF/A is a format of PDF`,
      ),
    ];
  // an e-invoice is a PDF/A-3b, whose XML PDF/A-2 does not allow
  const einvoice = resolveEinvoiceOptions(tpl.settings.einvoice);
  if (level === '2b' && einvoice.ok && einvoice.options)
    return [about('error', 'pdfa-einvoice', PDFA_REFUSALS.einvoice)];
  return [];
}
