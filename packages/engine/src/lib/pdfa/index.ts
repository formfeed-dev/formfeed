import type { EinvoiceValidation } from '../einvoice/report';

/**
 * `@formfeed/engine/pdfa` (plan 26): what `pdf.pdfa` asks for, what it cannot go with, and the
 * report a render keeps of what the validator said. No template engine is imported here and nothing
 * of Node, so the gateway Worker, the render-worker, the editor and the CLI all read the same names.
 *
 * PDF/A is ISO 19005, a file format for keeping documents: the fonts embedded, the colours defined,
 * nothing that needs the network or a password. Whether an archive keeps them as a law asks (the
 * GoBD, for one) is a matter of how the archive is run, not of the file, so nothing here or on any
 * page says "revisionssicher", "GoBD-konform", "certified" or "archive-compliant": the report says
 * which part and level a file was held to, and by which validator.
 */

/**
 * The levels a render can ask for. 3b is the default and what an e-invoice is; 2b is for archives
 * that take PDF/A-2 and not PDF/A-3, which may carry any file as an attachment. PDF/A-1 forbids the
 * transparency Chromium writes, so it is not offered.
 */
export const PDFA_LEVELS = ['2b', '3b'] as const;
export type PdfaLevel = (typeof PDFA_LEVELS)[number];

/** What `true` stands for. */
export const PDFA_DEFAULT_LEVEL: PdfaLevel = '3b';

/** The standard a level names, as the report and the `X-Formfeed-PDF-A` header write it. */
export const PDFA_STANDARDS = {
  '2b': 'PDF/A-2b',
  '3b': 'PDF/A-3b',
} as const satisfies Record<PdfaLevel, string>;
export type PdfaStandard = (typeof PDFA_STANDARDS)[PdfaLevel];

/** `pdf.pdfa` as a template's settings or a request write it. */
export type PdfaSetting = PdfaLevel | boolean | null;

/**
 * `pdf.pdfa` as a render takes it: a level, `true` for the default level, and anything else off.
 * There is no check to choose (plan 26, decision 2): a file that fails PDF/A fails the render.
 */
export function resolvePdfa(setting: unknown): PdfaLevel | null {
  if (setting === true) return PDFA_DEFAULT_LEVEL;
  return typeof setting === 'string' &&
    (PDFA_LEVELS as readonly string[]).includes(setting)
    ? (setting as PdfaLevel)
    : null;
}

/** Whether a `pdf.pdfa` value is one the API takes: a level, a boolean, or null. */
export function isPdfaSetting(value: unknown): value is PdfaSetting {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' &&
      (PDFA_LEVELS as readonly string[]).includes(value))
  );
}

export function pdfaStandard(level: PdfaLevel): PdfaStandard {
  return PDFA_STANDARDS[level];
}

/**
 * What `pdf.pdfa` cannot go with, in the words every place that refuses it uses (the gateway before
 * a render costs anything, the worker for whoever calls it directly, `formfeed validate`, the API's
 * template validation). A merge, a watermark and Word and PowerPoint templates go with it, since all
 * of them come before the conversion.
 */
export const PDFA_REFUSALS = {
  password:
    'pdf.pdfa cannot be combined with post.password: PDF/A does not allow encryption',
  einvoice:
    'pdf.pdfa "2b" cannot be combined with an e-invoice: the invoice XML is an attachment, which PDF/A-2 does not allow. An e-invoice is a PDF/A-3b already; ask for "3b" or leave pdf.pdfa out',
  invalid: 'settings.pdf.pdfa is "2b", "3b", true, false or null',
} as const;

// --- the report --------------------------------------------------------------------------------

/** How many findings a render keeps; a render row travels in every list and webhook. */
export const PDFA_MAX_MESSAGES = 50;

/** One rule of PDF/A the file failed, as the validator reports it. */
export interface PdfaMessage {
  severity: 'error' | 'warning';
  /** A clause of ISO 19005 and veraPDF's test number, `6.2.11.4.1-1`. */
  rule: string | null;
  message: string;
  /** veraPDF's path to the object of the PDF. */
  location: string | null;
}

/**
 * `pdfa` on a render (plan 26): `null` unless the render asked for PDF/A or is an e-invoice with
 * `pdf.pdfa` beside it. `conformant` is the validator's word on the file it judged; a render that
 * succeeded delivered exactly that file, and one that failed delivered nothing.
 */
export interface PdfaResult {
  standard: PdfaStandard;
  conformant: boolean;
  /** The validator and its version: its rule set moves between releases. */
  validator: string;
  /** The validator's own id for this report, which its log names too. */
  id: string;
  /** The versions of what converted and judged the file: `verapdf`, `pdfbox` (and `mustang` for an e-invoice). */
  versions: Record<string, string>;
  /** SHA-256 of the PDF that was judged: the delivered file when the render succeeded. */
  pdf_sha256: string | null;
  messages: PdfaMessage[];
  /** More findings than the render keeps. */
  truncated?: boolean;
}

/** The sidecar's report of `POST /pdf/pdfa` (`ArchiveReport` in `apps/conformance`). */
export interface PdfaValidatorReport {
  id: string;
  valid: boolean;
  pdfa: string;
  validator: string;
  messages: Array<{
    severity?: string;
    rule?: string | null;
    message?: string;
    location?: string | null;
  }>;
  truncated?: boolean;
  versions?: Record<string, string>;
}

const asMessage = (
  message: PdfaValidatorReport['messages'][number],
): PdfaMessage => ({
  severity: message.severity === 'warning' ? 'warning' : 'error',
  rule: typeof message.rule === 'string' ? message.rule : null,
  message: typeof message.message === 'string' ? message.message : '',
  location: typeof message.location === 'string' ? message.location : null,
});

const capped = (
  messages: readonly PdfaMessage[],
  truncated: boolean,
): Pick<PdfaResult, 'messages' | 'truncated'> => {
  const sorted = [
    ...messages.filter((message) => message.severity === 'error'),
    ...messages.filter((message) => message.severity !== 'error'),
  ];
  return sorted.length > PDFA_MAX_MESSAGES || truncated
    ? { messages: sorted.slice(0, PDFA_MAX_MESSAGES), truncated: true }
    : { messages: sorted };
};

/** The report a render keeps, from the sidecar's, with the hash of the file it judged. */
export function pdfaResult(
  level: PdfaLevel,
  report: PdfaValidatorReport,
  pdfSha256: string | null,
): PdfaResult {
  return {
    standard: PDFA_STANDARDS[level],
    conformant: report.valid === true,
    validator: report.validator,
    id: report.id,
    versions: { ...(report.versions ?? {}) },
    pdf_sha256: pdfSha256,
    ...capped(
      (Array.isArray(report.messages) ? report.messages : []).map(asMessage),
      report.truncated === true,
    ),
  };
}

/**
 * The `pdfa` block of an e-invoice that asked for PDF/A too (plan 26, decision 8): an e-invoice is
 * a PDF/A-3b, converted and judged once, so the block is made from the e-invoice's own validation
 * and its PDF findings. Null while that validation ended at the XML, before there was a file.
 */
export function pdfaFromEinvoice(
  validation: EinvoiceValidation | null | undefined,
): PdfaResult | null {
  if (!validation || validation.pdfa == null) return null;
  const messages = validation.messages
    .filter((message) => message.part === 'pdf')
    .map((message): PdfaMessage => ({
      severity: message.severity,
      rule: message.rule,
      message: message.message,
      location: message.location,
    }));
  const versions = { ...(validation.versions ?? {}) };
  return {
    standard: PDFA_STANDARDS['3b'],
    conformant: !messages.some((message) => message.severity === 'error'),
    validator: `veraPDF ${versions['verapdf'] ?? 'unknown'}`,
    id: validation.id ?? '',
    versions,
    pdf_sha256: validation.pdf_sha256 ?? null,
    ...capped(messages, false),
  };
}

/** Whether a stored value is a report: the API shows it, and null otherwise. */
export function isPdfaResult(value: unknown): value is PdfaResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Partial<PdfaResult>;
  return (
    typeof report.standard === 'string' &&
    (Object.values(PDFA_STANDARDS) as string[]).includes(report.standard) &&
    typeof report.conformant === 'boolean'
  );
}

/** How long the report may be as a header value: proxies refuse a response whose headers grow past a few kilobytes. */
export const PDFA_HEADER_LENGTH = 2000;

/**
 * The report as the worker's binary answer carries it in `x-formfeed-pdfa`, percent-encoded: the
 * gateway records it with the render and `preview-render` shows it. A file that was delivered
 * passed, so its report is short; one that is too long anyway loses its findings and says so.
 */
export function pdfaHeaderValue(
  result: PdfaResult,
  limit = PDFA_HEADER_LENGTH,
): string {
  const value = encodeURIComponent(JSON.stringify(result));
  if (value.length <= limit) return value;
  return encodeURIComponent(
    JSON.stringify({ ...result, messages: [], truncated: true }),
  );
}
