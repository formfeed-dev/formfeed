import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INVOICE_DATA_KEY,
  einvoiceXml,
  invoicePathSegments,
  locateJsonPath,
  resolveEinvoiceOptions,
  type EinvoiceOptions,
  type EinvoiceOptionsInput,
  type Invoice,
} from '@formfeed/engine';
import { DevkitError } from './errors';
import type { LocalDiagnostic } from './local-render';
import type { LocalTemplate } from './project';

/**
 * The e-invoice of a template folder (spec 17): what `settings.json` declares, the check of every
 * data set against it, and the XML itself. All of it runs offline, with the code the API runs, so
 * what `formfeed validate` accepts the API accepts too.
 */

/**
 * The e-invoice a template declares in `settings.json`, with every default filled in; `null` when
 * it declares none. `override` is merged over it like a request's `post.einvoice`; `{}` asks for an
 * e-invoice with the defaults from a template that declares nothing.
 */
export function declaredEinvoice(
  tpl: LocalTemplate,
  override?: EinvoiceOptionsInput | false,
): EinvoiceOptions | null {
  const resolved = resolveEinvoiceOptions(tpl.settings.einvoice, override);
  if (!resolved.ok)
    throw new DevkitError(
      `${tpl.slug}: e-invoice ${resolved.field} "${resolved.value}": ${resolved.reason}`,
      'validation',
    );
  return resolved.options;
}

/** The findings of one data set, with the file they are in. */
export interface DataSetDiagnostics {
  dataSet: string;
  /** Relative to the template folder: `data/default.json`. */
  file: string;
  diagnostics: LocalDiagnostic[];
}

const nowhere = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

/**
 * Every data set of an invoice template against the `_invoice` schema and the rules of EN 16931
 * (spec 17 §8). Each is an error: a render with that data fails with `einvoice_data_invalid`, and a
 * template that declares an e-invoice renders nothing else. Empty for a template that declares
 * none; one warning for an image template, where the declaration has no effect.
 */
export function diagnoseEinvoice(tpl: LocalTemplate): DataSetDiagnostics[] {
  let options: EinvoiceOptions | null;
  try {
    options = declaredEinvoice(tpl);
  } catch (e) {
    return [
      {
        dataSet: '',
        file: 'settings.json',
        diagnostics: [
          {
            severity: 'error',
            code: 'einvoice-profile',
            message: e instanceof Error ? e.message : String(e),
            range: nowhere,
          },
        ],
      },
    ];
  }
  if (!options) return [];
  if (tpl.meta.kind === 'image')
    return [
      {
        dataSet: '',
        file: 'settings.json',
        diagnostics: [
          {
            severity: 'warning',
            code: 'einvoice-image',
            message:
              'settings.json declares an e-invoice, which an image template never produces: an e-invoice is a PDF',
            range: nowhere,
          },
        ],
      },
    ];
  const out: DataSetDiagnostics[] = [];
  for (const [name, data] of Object.entries(tpl.dataSets)) {
    const result = einvoiceXml(data, options);
    if (result.ok) continue;
    const file = `data/${name}.json`;
    const path = join(tpl.dir, 'data', `${name}.json`);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
    out.push({
      dataSet: name,
      file,
      diagnostics: result.problems.map((problem) => {
        const at = text
          ? locateJsonPath(text, [
              INVOICE_DATA_KEY,
              ...invoicePathSegments(problem.path),
            ])
          : null;
        const start = at ? { line: at.line, column: at.column } : nowhere.start;
        return {
          severity: 'error' as const,
          code: `einvoice-${problem.code.replace(/_/g, '-')}`,
          message: problem.message,
          range: { start, end: start },
        };
      }),
    });
  }
  return out;
}

/**
 * The XML of one data set, as a render of the template would embed it. Throws a validation error
 * that lists what is wrong with the block when it does not pass.
 */
export function localEinvoiceXml(
  tpl: LocalTemplate,
  data: unknown,
  override?: EinvoiceOptionsInput,
): { xml: string; invoice: Invoice; options: EinvoiceOptions } {
  // asked for by name, so a template that declares nothing gets the defaults
  const options = declaredEinvoice(tpl, override ?? {});
  if (!options)
    throw new DevkitError(`${tpl.slug} declares no e-invoice`, 'validation');
  const result = einvoiceXml(data, options);
  if (!result.ok)
    throw new DevkitError(
      [
        `${tpl.slug}: the _invoice block does not make an e-invoice`,
        ...result.problems.map((problem) => `  ${problem.message}`),
      ].join('\n'),
      'validation',
    );
  return { xml: result.xml, invoice: result.invoice, options };
}
