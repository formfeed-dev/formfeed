/**
 * `@formfeed/engine/einvoice` (spec 17): the `_invoice` block, the rules it is held to, the CII XML
 * written from it and the display check. No template engine is imported here and nothing of Node,
 * so the gateway Worker, the render-worker, the editor and the CLI all run the same code: what the
 * API refuses, the editor has already said.
 */
import { checkInvoice, type Invoice, type InvoiceProblem } from './check';
import { invoiceToCii } from './cii';
import { withPlaces } from './decimal';
import type { EinvoiceFlavour, EinvoiceProfile } from './schema';

export {
  checkInvoice,
  type CheckOptions,
  type Identifier,
  type Invoice,
  type InvoiceAddress,
  type InvoiceAllowance,
  type InvoiceBreakdown,
  type InvoiceCheck,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceProblem,
  type InvoiceProblemCode,
  type InvoiceTax,
} from './check';
export { CII_GUIDELINES, EINVOICE_XML_NAME, invoiceToCii } from './cii';
export { EN16931_TERMS, carriesTerm, type EinvoiceTerm } from './coverage';
export { CODE_LIST_RELEASE } from './codes.generated';
export {
  DISPLAY_TERMS,
  displayCheck,
  displayMissingText,
  shownAmounts,
  type DisplayCheck,
  type DisplayValue,
} from './display';
export {
  EINVOICE_FLAVOURS,
  EINVOICE_PROFILES,
  VAT_CATEGORIES,
  defaultEinvoiceOptions,
  einvoiceOptionsSchema,
  invoiceSchema,
  resolveEinvoiceOptions,
  type EinvoiceFlavour,
  type EinvoiceOptions,
  type EinvoiceOptionsInput,
  type EinvoiceProfile,
  type InvoiceInput,
  type ResolvedEinvoice,
  type VatCategory,
} from './schema';
export {
  invoicePathSegments,
  locateJsonPath,
  type JsonLocation,
} from './locate';
export {
  EINVOICE_FLAVOUR_NAMES,
  EINVOICE_MAX_MESSAGES,
  EINVOICE_PROFILE_NAMES,
  capMessages,
  einvoiceResult,
  invoiceLineOf,
  type EinvoiceDisplay,
  type EinvoiceMessage,
  type EinvoiceResult,
  type EinvoiceValidation,
} from './report';
export { htmlText } from './html-text';
export { invoiceSkeleton } from './skeleton';

/** Where the invoice sits in the render data. */
export const INVOICE_DATA_KEY = '_invoice';

/**
 * The release of the specification the XML is written for, under each of its two names: ZUGFeRD 2.5
 * and Factur-X 1.09 are one document. The sidecar pins the same release (its validator is what a
 * file is held to); `codes.generated.ts` carries that release's code lists.
 */
export const EINVOICE_SPEC_VERSIONS: Record<EinvoiceFlavour, string> = {
  'factur-x': '1.09',
  zugferd: '2.5',
};

/**
 * An amount of a checked `Invoice` as the XML writes it and a reader expects it: `3760.40`. The
 * invoice itself keeps the digits it was given (`3760.4`), which is one value all the same.
 */
export function invoiceAmountText(amount: string): string {
  return withPlaces(amount, 2);
}

export type EinvoiceXml =
  | { ok: true; xml: string; invoice: Invoice }
  | { ok: false; problems: InvoiceProblem[] };

/**
 * The `_invoice` block of some render data as XML: checked, then written. A block that is absent is
 * one finding, since a template that declares an e-invoice cannot render without one.
 */
export function einvoiceXml(
  data: unknown,
  options: { profile: EinvoiceProfile },
): EinvoiceXml {
  const block =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)[INVOICE_DATA_KEY]
      : undefined;
  if (block === undefined || block === null)
    return {
      ok: false,
      problems: [
        {
          code: 'missing',
          path: '',
          message:
            'The data has no _invoice block: an e-invoice is built from it',
          args: { path: '' },
        },
      ],
    };
  const check = checkInvoice(block, options);
  if (!check.ok) return { ok: false, problems: check.problems };
  return {
    ok: true,
    xml: invoiceToCii(check.invoice, options),
    invoice: check.invoice,
  };
}
