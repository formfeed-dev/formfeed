import type { DisplayCheck } from './display';
import type {
  EinvoiceFlavour,
  EinvoiceOptions,
  EinvoiceProfile,
} from './schema';

/**
 * What a render says about its e-invoice (spec 17 §4.1, §5): the validator's report and the display
 * check. One shape for the render-worker that builds it, the database row that keeps it, the API
 * that returns it, the render log and the CLI that show it.
 */

/** One finding of the validator: a rule of the XML (schematron, XSD) or of PDF/A (veraPDF). */
export interface EinvoiceMessage {
  part: 'xml' | 'pdf';
  severity: 'error' | 'warning';
  /** `BR-CO-15`, `CII-SR-465`, or a clause of PDF/A such as `6.2.11.4.1-1`. */
  rule: string | null;
  message: string;
  /** Where: an XPath into the XML, or the object of the PDF. */
  location: string | null;
}

export interface EinvoiceValidation {
  valid: boolean;
  /** The rule set the XML was held to, as the validator names it. */
  schematron: string;
  /** `PDF/A-3b` once the file was checked; `null` when validation ended at the XML. */
  pdfa: string | null;
  messages: EinvoiceMessage[];
  /** More findings than the render keeps. */
  truncated?: boolean;
  /**
   * The validator's own id for this report, which its log names too. Absent in reports from before
   * 2026-10-09, like the three fields below.
   */
  id?: string;
  /** The versions of the validator's parts that judged the file: `mustang`, `verapdf`, `pdfbox`. */
  versions?: Record<string, string>;
  /** SHA-256 of the XML that was judged, which is the XML inside the PDF. */
  xml_sha256?: string;
  /**
   * SHA-256 of the PDF that was judged: the delivered file when the render succeeded. `null` when the
   * validator ended before there was a converted file.
   */
  pdf_sha256?: string | null;
}

export interface EinvoiceDisplay {
  /** The business terms looked for in the text of the PDF (`BT-1`, `BT-112`). */
  checked: string[];
  /** Those the text does not show. */
  missing: string[];
}

/** `einvoice` of a render as the row keeps it; the API adds `xml_url`. */
export interface EinvoiceResult {
  profile: EinvoiceProfile;
  flavour: EinvoiceFlavour;
  /** The release of the specification under the flavour's name: `1.09` or `2.5`. */
  spec_version: string;
  validation: EinvoiceValidation | null;
  display: EinvoiceDisplay | null;
}

/**
 * A render row travels in every list and webhook, so it keeps this many findings and says when there
 * were more. Errors go first: a report cut short must not lose the reason it failed to warnings.
 */
export const EINVOICE_MAX_MESSAGES = 50;

export function capMessages(
  messages: readonly EinvoiceMessage[],
  max = EINVOICE_MAX_MESSAGES,
): Pick<EinvoiceValidation, 'messages' | 'truncated'> {
  const sorted = [
    ...messages.filter((message) => message.severity === 'error'),
    ...messages.filter((message) => message.severity !== 'error'),
  ];
  return sorted.length > max
    ? { messages: sorted.slice(0, max), truncated: true }
    : { messages: sorted };
}

/** The result of a render that got as far as `validation` and `display` say. */
export function einvoiceResult(
  options: Pick<EinvoiceOptions, 'profile' | 'flavour'>,
  specVersion: string,
  validation: EinvoiceValidation | null,
  display: DisplayCheck | null,
): EinvoiceResult {
  return {
    profile: options.profile,
    flavour: options.flavour,
    spec_version: specVersion,
    validation: validation
      ? {
          valid: validation.valid,
          schematron: validation.schematron,
          pdfa: validation.pdfa,
          ...capMessages(validation.messages),
          // what judged which bytes: the report a business keeps as its proof names both
          ...(validation.id ? { id: validation.id } : {}),
          ...(validation.versions ? { versions: validation.versions } : {}),
          ...(validation.xml_sha256
            ? { xml_sha256: validation.xml_sha256 }
            : {}),
          ...(validation.pdf_sha256 !== undefined
            ? { pdf_sha256: validation.pdf_sha256 }
            : {}),
        }
      : null,
    display: display
      ? { checked: display.checked, missing: display.missing }
      : null,
  };
}

/**
 * How long the report may be as a header value. A proxy answers a response whose headers grow past a
 * few kilobytes with 502, and the e-invoice's report shares this room with a PDF/UA verdict
 * (`ACCESSIBILITY_HEADER_LENGTH`) where a render made both.
 */
export const EINVOICE_HEADER_LENGTH = 8000;

/**
 * The report as a response header carries it: the editor's true render reads the file from the body
 * and the report from `X-Formfeed-Einvoice`, percent-encoded because a validator's message is not
 * always ASCII. A report too long for `limit` loses, in this order, every finding's place, then the
 * findings from the last, warnings before errors, and says so in `truncated` (plan 25 §5.5). What
 * makes it a verdict always arrives: whether the file is valid, the rule set, the validator's id and
 * versions, the hashes of the bytes it judged, and the display check.
 */
export function einvoiceHeaderValue(
  result: EinvoiceResult,
  limit = EINVOICE_HEADER_LENGTH,
): string {
  const encode = (report: EinvoiceResult) =>
    encodeURIComponent(JSON.stringify(report));
  const full = encode(result);
  const validation = result.validation;
  if (full.length <= limit || !validation) return full;
  let messages = validation.messages.map((message) => ({
    ...message,
    location: null,
  }));
  const cut = (): EinvoiceResult => ({
    ...result,
    validation: { ...validation, messages, truncated: true },
  });
  let value = encode(cut());
  while (value.length > limit && messages.length > 0) {
    let last = messages.length - 1;
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i]!.severity !== 'error') {
        last = i;
        break;
      }
    messages = messages.filter((_, i) => i !== last);
    value = encode(cut());
  }
  return value;
}

/** The names a person reads: `Factur-X` and `EN 16931` for `factur-x` and `en16931`. */
export const EINVOICE_FLAVOUR_NAMES: Record<EinvoiceFlavour, string> = {
  'factur-x': 'Factur-X',
  zugferd: 'ZUGFeRD',
};
export const EINVOICE_PROFILE_NAMES: Record<EinvoiceProfile, string> = {
  basic: 'Basic',
  en16931: 'EN 16931',
};

/**
 * Where in the invoice a finding of the XML sits, for a reader who knows `_invoice` and not CII:
 * `line 2` for anything inside the second line item, `null` where the path names no line. The XPath
 * itself stays beside it; this only spares the reader counting brackets.
 */
export function invoiceLineOf(location: string | null): number | null {
  if (!location) return null;
  const match = /IncludedSupplyChainTradeLineItem\[(\d+)\]/.exec(location);
  return match ? Number(match[1]) : null;
}
