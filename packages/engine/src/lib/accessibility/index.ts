/**
 * `@formfeed/engine/accessibility` (plan 21): what `pdf.ua` asks for, what the audit finds in a
 * document before it is rendered, and the report a render keeps of what the validator said. No
 * template engine is imported here and nothing of Node, so the gateway Worker, the render-worker,
 * the editor and the CLI all read the same names.
 *
 * PDF/UA-1 is ISO 14289-1. A machine can decide about two thirds of it; whether an alternative text
 * describes its image, or the reading order makes sense, stays with a person. So nothing here says
 * "accessible": the setting is named after the standard, and the report after what was checked.
 */

/** The standard a render with `pdf.ua` is held to, as the report names it. */
export const PDFUA_STANDARD = 'PDF/UA-1';

/**
 * What happens to a file that fails validation: `strict` fails the render and delivers nothing,
 * `report` delivers the file without the PDF/UA identifier and puts the verdict on the render.
 */
export const UA_CHECKS = ['strict', 'report'] as const;
export type UaCheck = (typeof UA_CHECKS)[number];

export interface UaOptions {
  check: UaCheck;
}

/** `pdf.ua` as a template's settings or a request write it. */
export type UaSetting = boolean | { check?: UaCheck } | null;

/**
 * `pdf.ua` as a render takes it: `true` is `{ check: 'strict' }`, and anything that is not a
 * declaration is off. A customer who asked for a conforming file and silently got another would
 * find out from their own customer, so strict is what a bare `true` means.
 */
export function resolveUa(setting: unknown): UaOptions | null {
  if (setting === true) return { check: 'strict' };
  if (!setting || typeof setting !== 'object' || Array.isArray(setting))
    return null;
  const check = (setting as { check?: unknown }).check;
  return { check: check === 'report' ? 'report' : 'strict' };
}

/**
 * What `pdf.ua` cannot go with, in the words every place that refuses it uses (the gateway before a
 * render costs anything, the worker for whoever calls it directly, `formfeed validate`, the API's
 * template validation). Merged pages lose their tags while the validator still passes the file;
 * the tags of Word and PowerPoint documents are LibreOffice's and not measured yet. An e-invoice
 * is not among them: its PDF/A-3 keeps the tags, and the file is held to both standards (plan 22).
 */
export const UA_REFUSALS = {
  office: 'pdf.ua is not available for Word and PowerPoint templates yet',
  merge:
    'pdf.ua cannot be combined with post.merge_after: the tags of merged documents do not survive the merge',
} as const;

/** Whether a `pdf.ua` value is one the API takes: a boolean, null, or `{ check }` and nothing else. */
export function isUaSetting(value: unknown): value is UaSetting {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(
    ([key, entry]) =>
      key === 'check' && (UA_CHECKS as readonly unknown[]).includes(entry),
  );
}

// --- the audit ---------------------------------------------------------------------------------

/**
 * What the audit looks for (plan 21 §6): one finding per fault we measured in Chromium's output,
 * not a general accessibility linter. Much of such a linter is about landmarks, focus and widgets,
 * which a printed page does not have, and it knows nothing of header and footer templates or of
 * what Chromium leaves untagged.
 */
export const AUDIT_CODES = [
  'document-title',
  'image-alt',
  'figure-name',
  'heading-order',
  'table-rows',
  'table-cell-empty',
  'masked-text',
  'filtered-text',
  'document-language',
  'table-headers',
  'link-name',
  'generated-text',
  'fixed-text',
  'running-text',
] as const;
export type AuditCode = (typeof AUDIT_CODES)[number];

export type AuditSeverity = 'error' | 'warning';

/**
 * An error is a fault the validator will fail the file for; a warning is one no rule catches and a
 * reader hears all the same.
 */
export const AUDIT_SEVERITY: Record<AuditCode, AuditSeverity> = {
  'document-title': 'error',
  'image-alt': 'error',
  'figure-name': 'error',
  'heading-order': 'error',
  'table-rows': 'error',
  'table-cell-empty': 'error',
  'masked-text': 'error',
  'filtered-text': 'warning',
  'document-language': 'warning',
  'table-headers': 'warning',
  'link-name': 'warning',
  'generated-text': 'warning',
  'fixed-text': 'warning',
  'running-text': 'warning',
};

/**
 * The rules of veraPDF's PDF/UA-1 profile a finding fails when it is left as it is, by clause and
 * test number. The other way round it says which elements a failed rule is about: the validator
 * names objects of the file, the audit the tags of the template.
 */
export const AUDIT_RULES: Record<AuditCode, readonly string[]> = {
  'document-title': ['7.1-9', '7.1-10'],
  'image-alt': ['7.3-1'],
  'figure-name': ['7.3-1'],
  'heading-order': ['7.4.2-1'],
  'table-rows': ['7.2-43'],
  'table-cell-empty': ['7.2-43'],
  'masked-text': ['7.20-2'],
  'filtered-text': [],
  'document-language': [],
  'table-headers': [],
  'link-name': [],
  'generated-text': [],
  'fixed-text': [],
  'running-text': [],
};

/**
 * A code in a few words, for a list that names the elements beside it: a render's warnings carry the
 * code and the elements, not a sentence each. The CLI and the MCP server print these; the app has
 * its own, per locale.
 */
export const AUDIT_TITLES: Record<AuditCode, string> = {
  'document-title': 'No document title',
  'image-alt': 'Image without an alt attribute',
  'figure-name': 'Figure without a name',
  'heading-order': 'Heading level skipped',
  'table-rows': 'Table rows of different lengths',
  'table-cell-empty': 'Empty table cell',
  'masked-text': 'Text under a CSS mask',
  'filtered-text': 'Text under a CSS filter',
  'document-language': 'No language stated',
  'table-headers': 'Table without header cells',
  'link-name': 'Link without a name',
  'generated-text': 'Text generated by CSS',
  'fixed-text': 'Fixed text on every page',
  'running-text': 'Only in the header or footer',
};

/** The values a finding's sentence is built from. */
export type AuditArgs = Record<string, string | number>;

export interface AuditFinding {
  code: AuditCode;
  severity: AuditSeverity;
  /**
   * `data-ff-src` of the nearest tag that carries one: the template's own position, which only the
   * editor's previews write. Null anywhere else, and for a finding about the document as a whole.
   */
  src: string | null;
  /** The element's start tag, cut to 120 characters; empty for a finding about the document. */
  snippet: string;
  args: AuditArgs;
}

/** A link and the name a screen reader says for it (plan 21 §4, decision 7). */
export interface AuditLink {
  /** An absolute URL, or `#name` for a place in the document. */
  href: string;
  name: string;
}

export interface AuditReport {
  findings: AuditFinding[];
  /** The body's links in document order. */
  links: AuditLink[];
  /** The links of the header and footer templates. */
  templateLinks: AuditLink[];
}

export interface AuditOptions {
  /** Whether findings are wanted, or only the links' names (a tagged PDF without `pdf.ua`). */
  findings?: boolean;
  /**
   * Header and footer templates where they are not elements of the document: Chromium prints them
   * in a page of their own, so the render-worker hands them over as text.
   */
  header?: string;
  footer?: string;
  /** How many pages the document has, where the host knows (the paged preview). */
  pages?: number;
  /** The height of one page's content in CSS pixels, to tell whether there is more than one. */
  pageHeight?: number;
  /** Whether the settings name a locale, which stands in for a missing `lang`. */
  locale?: boolean;
}

/** Longest snippet a finding carries. */
export const AUDIT_SNIPPET_LENGTH = 120;

const text = (value: string | number | undefined) => String(value ?? '');

/**
 * A finding as an English sentence that says what is wrong and what to do about it. The editor
 * words the same findings per locale from `args`; the API, the CLI and the worker's log use these.
 */
export function auditMessage(
  finding: Pick<AuditFinding, 'code' | 'args'>,
): string {
  const args = finding.args;
  switch (finding.code) {
    case 'document-title':
      return 'The document has no title. A PDF viewer shows the title in its title bar and a screen reader says it first: set pdf.metadata.title, or give the page a <title>.';
    case 'image-alt':
      return 'The image has no alt attribute. Say what it shows, or write alt="" if it is decoration.';
    case 'figure-name':
      return `The ${text(args['tag'])} has no text alternative. Give it an aria-label that says what it shows; the chart helper takes alt.`;
    case 'heading-order':
      return args['previous'] === 0
        ? `The first heading is an h${text(args['level'])}. Start with an h1 and size it with CSS.`
        : `This h${text(args['level'])} follows an h${text(args['previous'])}, so a heading level is skipped. Make it an h${Number(args['previous']) + 1} and size it with CSS.`;
    case 'table-rows':
      return `The rows of this table span different numbers of columns (${text(args['first'])} and ${text(args['other'])}). Even them out with colspan.`;
    case 'table-cell-empty':
      return Number(args['count']) > 1
        ? `${text(args['count'])} cells of this table are empty. Chromium writes no cell for an empty td, so their rows come out shorter than the others: put a non-breaking space (&nbsp;) or a dash into each.`
        : 'This table cell is empty. Chromium writes no cell for an empty td, so its row comes out shorter than the others: put a non-breaking space (&nbsp;) or a dash into it.';
    case 'masked-text':
      return 'This element has a CSS mask and holds text. Chromium then writes the text in a way PDF/UA-1 does not allow, and no repair reaches it: mask an element without text instead.';
    case 'filtered-text':
      return 'This element has a CSS filter and holds text. The filter turns the text into a picture, which nobody can have read out or select.';
    case 'document-language':
      return 'The document names no language. Set lang on the html element, or the locale in the settings.';
    case 'table-headers':
      return 'The table has no header cells. Use th for the titles of its columns or rows, or a screen reader says the cells without them.';
    case 'link-name':
      return 'The link has no text. A screen reader says its address instead: give it text, an aria-label, or an image with alt.';
    case 'generated-text':
      return `“${text(args['text'])}” comes from CSS (::before or ::after). Generated text is not read out: write it into the template.`;
    case 'fixed-text':
      return 'This element is position: fixed, so it is printed on every page and read once per page, one after the other.';
    case 'running-text':
      return `“${text(args['text'])}” stands only in the ${text(args['part'])}. A screen reader skips page headers and footers, so say it in the body too.`;
  }
}

// --- the report --------------------------------------------------------------------------------

/** How many failed rules a render keeps, and how many elements of each. */
export const ACCESSIBILITY_MAX_FAILURES = 20;
export const ACCESSIBILITY_MAX_ELEMENTS = 5;

/** One rule of the validator a file failed. */
export interface AccessibilityFailure {
  /** Clause and test number of veraPDF's PDF/UA-1 profile, `7.3-1`. */
  rule: string;
  /** The audit's finding the rule is about, where it maps to one. */
  code?: AuditCode;
  /** How many checks of the rule failed. */
  count: number;
  /** The finding's sentence, else the validator's own. */
  message: string;
  /** The elements the audit found for it: start tags of the document, at most five. */
  elements: string[];
}

/** What a reader will stumble over although no rule fails for it. */
export interface AccessibilityWarning {
  code: AuditCode;
  count: number;
  /** Start tags, or the text itself for `running-text` and `generated-text`. */
  elements: string[];
}

/**
 * `accessibility` on a render (plan 21 §7): `null` unless `pdf.ua` was set. `conformant` is the
 * validator's word on the machine-checkable rules of PDF/UA-1, no more: a passed check does not
 * make a document accessible.
 */
export interface AccessibilityResult {
  standard: typeof PDFUA_STANDARD;
  check: UaCheck;
  conformant: boolean;
  /** The validator and its version: its rule set moves between releases. */
  validator: string;
  rules: { passed: number; failed: number };
  failures: AccessibilityFailure[];
  warnings: AccessibilityWarning[];
  /** More rules failed than the render keeps. */
  truncated?: boolean;
}

/** One failed rule as the validator reports it. */
export interface ValidatorFailure {
  /** Clause and test number, `7.3-1`. */
  rule: string;
  description: string;
  /** How many checks of the rule failed. */
  checks: number;
}

/** What the validator said about a file, before the audit's findings are joined to it. */
export interface ValidatorVerdict {
  validator: string;
  compliant: boolean;
  rules: { passed: number; failed: number };
  failures: ValidatorFailure[];
}

const elementOf = (finding: AuditFinding): string =>
  finding.code === 'running-text' || finding.code === 'generated-text'
    ? text(finding.args['text'])
    : finding.snippet;

/**
 * The report a render keeps: the validator's verdict, with the audit's findings joined to the rules
 * they explain. The rule and its count are the validator's; the code, the sentence and the elements
 * are the audit's where one of its findings fails that rule, else the validator's own description.
 * Findings that fail no rule are the warnings.
 */
export function accessibilityResult(
  options: UaOptions,
  verdict: ValidatorVerdict,
  findings: readonly AuditFinding[],
): AccessibilityResult {
  const failures = verdict.failures.map((failure): AccessibilityFailure => {
    const about = findings.filter((finding) =>
      AUDIT_RULES[finding.code].includes(failure.rule),
    );
    const first = about[0];
    return {
      rule: failure.rule,
      ...(first ? { code: first.code } : {}),
      count: failure.checks,
      message: first
        ? auditMessage(first)
        : failure.description.replace(/\s+/g, ' ').trim(),
      elements: [...new Set(about.map(elementOf).filter(Boolean))].slice(
        0,
        ACCESSIBILITY_MAX_ELEMENTS,
      ),
    };
  });
  const warnings: AccessibilityWarning[] = [];
  for (const finding of findings) {
    if (finding.severity !== 'warning') continue;
    let warning = warnings.find((entry) => entry.code === finding.code);
    if (!warning)
      warnings.push((warning = { code: finding.code, count: 0, elements: [] }));
    warning.count++;
    const element = elementOf(finding);
    if (
      element &&
      warning.elements.length < ACCESSIBILITY_MAX_ELEMENTS &&
      !warning.elements.includes(element)
    )
      warning.elements.push(element);
  }
  return {
    standard: PDFUA_STANDARD,
    check: options.check,
    conformant: verdict.compliant,
    validator: verdict.validator,
    rules: verdict.rules,
    failures: failures.slice(0, ACCESSIBILITY_MAX_FAILURES),
    warnings,
    ...(failures.length > ACCESSIBILITY_MAX_FAILURES
      ? { truncated: true }
      : {}),
  };
}

/** What the binary answer says in `X-Formfeed-PDF-UA`. */
export function accessibilityHeader(
  result: Pick<AccessibilityResult, 'conformant'>,
): 'conformant' | 'not-conformant' {
  return result.conformant ? 'conformant' : 'not-conformant';
}

/** How long the report may be as a header value: proxies refuse a response whose headers grow past a few kilobytes. */
export const ACCESSIBILITY_HEADER_LENGTH = 8000;

/**
 * The report as a response header carries it: the editor's true render reads the file from the body
 * and the verdict from `X-Formfeed-Accessibility`, percent-encoded because an element's text is not
 * always ASCII. A report that is too long for a header loses what the template check lists anyway,
 * in this order: all but one element of each entry, every element, the warnings, then the failures
 * from the last. The verdict, the validator and the counts always arrive, and `truncated` says that
 * something did not.
 */
export function accessibilityHeaderValue(
  result: AccessibilityResult,
  limit = ACCESSIBILITY_HEADER_LENGTH,
): string {
  const encode = (report: AccessibilityResult) =>
    encodeURIComponent(JSON.stringify(report));
  const keep = (report: AccessibilityResult, elements: number) => ({
    ...report,
    truncated: true,
    failures: report.failures.map((failure) => ({
      ...failure,
      elements: failure.elements.slice(0, elements),
    })),
    warnings: report.warnings.map((warning) => ({
      ...warning,
      elements: warning.elements.slice(0, elements),
    })),
  });
  let value = encode(result);
  if (value.length <= limit) return value;
  for (const elements of [1, 0]) {
    value = encode(keep(result, elements));
    if (value.length <= limit) return value;
  }
  let report = keep(result, 0);
  while (report.failures.length + report.warnings.length > 0) {
    report = report.warnings.length
      ? { ...report, warnings: report.warnings.slice(0, -1) }
      : { ...report, failures: report.failures.slice(0, -1) };
    value = encode(report);
    if (value.length <= limit) return value;
  }
  return value;
}
