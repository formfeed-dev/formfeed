import { ibanChecksum, normaliseIban } from '../codes/epc';
import {
  countryCodes,
  currencyCodes,
  documentTypeCodes,
  electronicAddressSchemes,
  paymentMeansCodes,
  unitCodes,
} from './codes.generated';
import {
  abs,
  decimalPlaces,
  decimalText,
  divideRounded,
  fromUnits,
  toUnits,
} from './decimal';
import {
  invoiceSchema,
  type EinvoiceProfile,
  type ParsedInvoice,
  type ParsedParty,
  type VatCategory,
} from './schema';

/**
 * Reads an `_invoice` block against EN 16931 (spec 17 §4.3): the shape first, then the rules a
 * request can be held to before anything is rendered. What comes out is either the invoice with
 * every number as exact decimal text, ready for the XML, or the list of what is wrong, each finding
 * with the field and the rule it breaks.
 *
 * Nothing is computed for the caller and nothing is rounded into place. A total that is a cent off
 * is a finding, because an e-invoice whose XML disagrees with the seller's books is a tax problem,
 * and correcting it here would hide exactly that.
 *
 * The full rule set (the official schematron, some 430 assertions) runs in the sidecar on every
 * document. This is the part worth knowing early: it needs no JVM, so the gateway answers a bad
 * request at once, and the editor and the CLI say the same thing offline.
 */

export interface InvoiceProblem {
  /** What kind of finding, for a caller that words it in its own language. */
  code: InvoiceProblemCode;
  /** The field inside `_invoice`, dotted, list items as `lines[1]` (zero-based). */
  path: string;
  /** The rule of EN 16931 (`BR-CO-15`) or of the French specifications (`BR-FR-10`), where one applies. */
  rule?: string;
  /** The same in English, naming the field and the rule. */
  message: string;
  /** The values `message` was built from. */
  args: Record<string, string | number>;
}

export type InvoiceProblemCode =
  | 'missing'
  | 'invalid'
  | 'not_a_number'
  | 'decimals'
  | 'negative'
  | 'code_list'
  | 'date'
  | 'date_order'
  | 'scheme_required'
  | 'vat_id_prefix'
  | 'iban'
  | 'sum'
  | 'breakdown_missing'
  | 'breakdown_duplicate'
  | 'rate_required'
  | 'rate_positive'
  | 'rate_zero'
  | 'rate_forbidden'
  | 'amount_zero'
  | 'exemption_reason_required'
  | 'exemption_reason_forbidden'
  | 'seller_tax_id_required'
  | 'buyer_tax_id_required'
  | 'vat_id_forbidden'
  | 'only_category'
  | 'delivery_required'
  | 'account_required'
  | 'means_code_required'
  | 'due_or_terms_required'
  | 'seller_identifier_required'
  | 'siren_mismatch'
  | 'fr_seller_siren'
  | 'fr_buyer_siren'
  | 'fr_operation'
  | 'fr_vat_on_debits'
  | 'profile';

export interface Identifier {
  value: string;
  scheme?: string;
}

export interface InvoiceAddress {
  street?: string;
  street2?: string;
  street3?: string;
  postcode?: string;
  city?: string;
  country: string;
  subdivision?: string;
}

export interface InvoiceParty {
  name: string;
  trading_name?: string;
  id?: Identifier;
  legal_registration?: Identifier;
  vat_id?: string;
  address: InvoiceAddress;
  contact?: { name?: string; phone?: string; email?: string };
  electronic_address?: Required<Identifier>;
}

export interface InvoiceAllowance {
  amount: string;
  reason?: string;
  reason_code?: string;
  base_amount?: string;
  percent?: string;
}

export interface InvoiceTax {
  category: VatCategory;
  /** Percent as decimal text; absent for category O only. */
  rate?: string;
}

export interface InvoiceLine {
  id: string;
  name: string;
  description?: string;
  quantity: string;
  unit_code: string;
  net_price: string;
  price_base_quantity?: string;
  net_amount: string;
  tax: InvoiceTax;
  period?: { start?: string; end?: string };
  allowances: InvoiceAllowance[];
  charges: InvoiceAllowance[];
  buyer_accounting_reference?: string;
  note?: string;
  seller_item_id?: string;
  buyer_item_id?: string;
  standard_item_id?: Identifier;
  order_line_reference?: string;
}

export interface InvoiceBreakdown extends InvoiceTax {
  basis: string;
  amount: string;
  exemption_reason?: string;
  exemption_reason_code?: string;
}

/**
 * An invoice that passed: every amount is decimal text with at most two places, every code is in
 * its list, and the totals add up. The XML is written from this and from nothing else.
 */
export interface Invoice {
  number: string;
  issue_date: string;
  type_code: string;
  currency: string;
  accounting_currency?: string;
  buyer_reference?: string;
  order_reference?: string;
  contract_reference?: string;
  notes: Array<{ text: string; subject_code?: string }>;
  period?: { start?: string; end?: string };
  preceding_invoices: Array<{ number: string; issue_date?: string }>;
  /** The business process (BT-23); French invoices carry their billing framework here. */
  business_process?: string;
  seller: InvoiceParty & {
    tax_number?: string;
    legal_info?: string;
    vat_on_debits?: boolean;
  };
  buyer: InvoiceParty;
  delivery?: { name?: string; date?: string; address?: InvoiceAddress };
  lines: InvoiceLine[];
  allowances: Array<InvoiceAllowance & { tax: InvoiceTax }>;
  charges: Array<InvoiceAllowance & { tax: InvoiceTax }>;
  breakdown: InvoiceBreakdown[];
  totals: {
    line_net: string;
    allowances?: string;
    charges?: string;
    tax_basis: string;
    tax_total: string;
    tax_total_accounting?: string;
    grand: string;
    prepaid?: string;
    rounding?: string;
    due: string;
  };
  payment?: {
    means_code?: string;
    iban?: string;
    bic?: string;
    account_name?: string;
    reference?: string;
    terms?: string;
    due_date?: string;
    mandate_id?: string;
    creditor_id?: string;
    debited_iban?: string;
  };
}

export type InvoiceCheck =
  | { ok: true; invoice: Invoice; problems: [] }
  | { ok: false; invoice: null; problems: InvoiceProblem[] };

export interface CheckOptions {
  /** The profile the XML will be written in; `basic` cannot carry everything `en16931` can. */
  profile?: EinvoiceProfile;
}

/** The fields EN 16931 asks of every invoice, with the rule and the business term that say so. */
const REQUIRED: Record<string, [rule: string, term: string]> = {
  number: ['BR-02', 'BT-1'],
  issue_date: ['BR-03', 'BT-2'],
  currency: ['BR-05', 'BT-5'],
  seller: ['BR-06', 'BG-4'],
  'seller.name': ['BR-06', 'BT-27'],
  'seller.address': ['BR-08', 'BG-5'],
  'seller.address.country': ['BR-09', 'BT-40'],
  buyer: ['BR-07', 'BG-7'],
  'buyer.name': ['BR-07', 'BT-44'],
  'buyer.address': ['BR-10', 'BG-8'],
  'buyer.address.country': ['BR-11', 'BT-55'],
  lines: ['BR-16', 'BG-25'],
  'lines[].id': ['BR-21', 'BT-126'],
  'lines[].quantity': ['BR-22', 'BT-129'],
  'lines[].net_amount': ['BR-24', 'BT-131'],
  'lines[].name': ['BR-25', 'BT-153'],
  'lines[].net_price': ['BR-26', 'BT-146'],
  'lines[].tax': ['BR-CO-04', 'BT-151'],
  'lines[].tax.category': ['BR-CO-04', 'BT-151'],
  tax: ['BR-CO-18', 'BG-23'],
  'tax.breakdown': ['BR-CO-18', 'BG-23'],
  'tax.breakdown[].basis': ['BR-45', 'BT-116'],
  'tax.breakdown[].amount': ['BR-46', 'BT-117'],
  'tax.breakdown[].category': ['BR-47', 'BT-118'],
  totals: ['BR-12', 'BG-22'],
  'totals.line_net': ['BR-12', 'BT-106'],
  'totals.tax_basis': ['BR-13', 'BT-109'],
  'totals.tax_total': ['BR-CO-14', 'BT-110'],
  'totals.grand': ['BR-14', 'BT-112'],
  'totals.due': ['BR-15', 'BT-115'],
  'allowances[].amount': ['BR-31', 'BT-92'],
  'allowances[].tax': ['BR-32', 'BT-95'],
  'allowances[].tax.category': ['BR-32', 'BT-95'],
  'charges[].amount': ['BR-36', 'BT-99'],
  'charges[].tax': ['BR-37', 'BT-102'],
  'charges[].tax.category': ['BR-37', 'BT-102'],
  'lines[].allowances[].amount': ['BR-41', 'BT-136'],
  'lines[].charges[].amount': ['BR-43', 'BT-141'],
  'delivery.address.country': ['BR-57', 'BT-80'],
  'preceding_invoices[].number': ['BR-55', 'BT-25'],
};

/** The rule that asks for a VAT breakdown per category in use, by category (S: BR-S-01, K: BR-IC-01). */
const RULE_PREFIX: Record<VatCategory, string> = {
  S: 'BR-S',
  Z: 'BR-Z',
  E: 'BR-E',
  AE: 'BR-AE',
  K: 'BR-IC',
  G: 'BR-G',
  O: 'BR-O',
};

/** What people write where a unit code belongs, and the code they meant. */
const UNIT_SUGGESTIONS: Record<string, string> = {
  piece: 'C62',
  pieces: 'C62',
  pcs: 'C62',
  pc: 'C62',
  stk: 'C62',
  stück: 'C62',
  unit: 'C62',
  units: 'C62',
  each: 'C62',
  hour: 'HUR',
  hours: 'HUR',
  h: 'HUR',
  std: 'HUR',
  stunde: 'HUR',
  stunden: 'HUR',
  day: 'DAY',
  days: 'DAY',
  tag: 'DAY',
  tage: 'DAY',
  month: 'MON',
  months: 'MON',
  monat: 'MON',
  year: 'ANN',
  min: 'MIN',
  minute: 'MIN',
  minutes: 'MIN',
  kg: 'KGM',
  g: 'GRM',
  t: 'TNE',
  l: 'LTR',
  litre: 'LTR',
  liter: 'LTR',
  m: 'MTR',
  km: 'KMT',
  m2: 'MTK',
  qm: 'MTK',
  m3: 'MTQ',
  kwh: 'KWH',
  flat: 'LS',
  pauschal: 'LS',
};

/** The billing frameworks the French specifications allow in BT-23 (BR-FR-08). */
const FRENCH_FRAMEWORKS = new Set([
  'B1',
  'S1',
  'M1',
  'B2',
  'S2',
  'M2',
  'B4',
  'S4',
  'M4',
  'S5',
  'S6',
  'B7',
  'S7',
]);
const FRENCH_OPERATION = { goods: 'B1', services: 'S1', mixed: 'M1' } as const;

/** Payment means that are a credit transfer, for which BR-61 asks for the account. */
const CREDIT_TRANSFER = new Set(['30', '58']);

export function checkInvoice(
  data: unknown,
  options: CheckOptions = {},
): InvoiceCheck {
  const problems: InvoiceProblem[] = [];
  const add = (
    code: InvoiceProblemCode,
    path: string,
    message: string,
    extra: { rule?: string; args?: Record<string, string | number> } = {},
  ): void => {
    problems.push({
      code,
      path,
      ...(extra.rule ? { rule: extra.rule } : {}),
      message: extra.rule ? `${message} (${extra.rule})` : message,
      args: {
        path,
        ...(extra.rule ? { rule: extra.rule } : {}),
        ...extra.args,
      },
    });
  };

  const parsed = invoiceSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = pathText(issue.path);
      const required = REQUIRED[path.replace(/\[\d+\]/g, '[]')];
      // whatever the schema says about a value that is not there (a wrong type, no member of a
      // union), the finding is that it is not there
      const absent = valueAt(data, issue.path) === undefined;
      if (absent && required)
        add('missing', path, `_invoice.${path} is missing (${required[1]})`, {
          rule: required[0],
          args: { term: required[1] },
        });
      else if (absent) add('missing', path, `_invoice.${path} is missing`);
      else if (issue.code === 'too_small' && path === 'lines')
        add(
          'missing',
          path,
          '_invoice.lines is empty: an invoice has at least one line (BG-25)',
          {
            rule: 'BR-16',
            args: { term: 'BG-25' },
          },
        );
      else if (issue.code === 'too_small' && path === 'tax.breakdown')
        add(
          'missing',
          path,
          '_invoice.tax.breakdown is empty: an invoice has at least one VAT breakdown (BG-23)',
          {
            rule: 'BR-CO-18',
            args: { term: 'BG-23' },
          },
        );
      else
        add('invalid', path, `_invoice.${path}: ${issue.message}`, {
          args: { detail: issue.message },
        });
    }
    return { ok: false, invoice: null, problems };
  }

  const invoice = normalise(parsed.data, add, options);
  if (problems.length > 0) return { ok: false, invoice: null, problems };
  rules(invoice, add);
  return problems.length > 0
    ? { ok: false, invoice: null, problems }
    : { ok: true, invoice, problems: [] };
}

type Add = (
  code: InvoiceProblemCode,
  path: string,
  message: string,
  extra?: { rule?: string; args?: Record<string, string | number> },
) => void;

function pathText(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const key of path)
    out +=
      typeof key === 'number'
        ? `[${key}]`
        : out
          ? `.${String(key)}`
          : String(key);
  return out;
}

function valueAt(data: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let value = data;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value === null ? undefined : value;
}

/** Numbers into exact decimal text, codes into their canonical spelling, each finding recorded. */
function normalise(
  input: ParsedInvoice,
  add: Add,
  options: CheckOptions,
): Invoice {
  /** An amount of money: at most two decimals, which the standard asks of every one of them. */
  const amount = (value: unknown, path: string): string => {
    const text = decimalText(value);
    if (text === null) {
      add('not_a_number', path, `_invoice.${path} is not a number`);
      return '0';
    }
    if (decimalPlaces(text) > 2) {
      add(
        'decimals',
        path,
        `_invoice.${path} has more than 2 decimals; an amount of the invoice is exact to the cent`,
        {
          args: { max: 2, value: text },
        },
      );
      return '0';
    }
    return text;
  };
  /** A quantity, a unit price or a percentage: more places than an amount, but not without end. */
  const number = (value: unknown, path: string, max: number): string => {
    const text = decimalText(value);
    if (text === null) {
      add('not_a_number', path, `_invoice.${path} is not a number`);
      return '0';
    }
    if (decimalPlaces(text) > max) {
      add('decimals', path, `_invoice.${path} has more than ${max} decimals`, {
        args: { max, value: text },
      });
      return '0';
    }
    return text;
  };
  const optionalAmount = (value: unknown, path: string): string | undefined =>
    value === undefined ? undefined : amount(value, path);
  const date = (
    value: string | undefined,
    path: string,
  ): string | undefined => {
    if (value === undefined) return undefined;
    const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
    const real = new Date(Date.UTC(year, month - 1, day));
    if (
      real.getUTCFullYear() !== year ||
      real.getUTCMonth() !== month - 1 ||
      real.getUTCDate() !== day
    ) {
      add('date', path, `_invoice.${path} is not a date of the calendar`, {
        args: { value },
      });
    }
    return value;
  };
  const code = (
    value: string,
    path: string,
    list: ReadonlySet<string>,
    name: string,
    rule: string,
  ): string => {
    const upper = value.trim().toUpperCase();
    if (!list.has(upper))
      add(
        'code_list',
        path,
        `_invoice.${path}: "${value}" is not a code of ${name}`,
        {
          rule,
          args: { value, list: name },
        },
      );
    return upper;
  };
  const period = (
    value: { start?: string | undefined; end?: string | undefined } | undefined,
    path: string,
    rule: string,
  ): { start?: string; end?: string } | undefined => {
    if (!value || (value.start === undefined && value.end === undefined))
      return undefined;
    const start = date(value.start, `${path}.start`);
    const end = date(value.end, `${path}.end`);
    if (start && end && end < start)
      add('date_order', path, `_invoice.${path} ends before it starts`, {
        rule,
      });
    return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  };
  const identifier = (
    value: string | { value: string; scheme?: string | undefined } | undefined,
  ): Identifier | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return { value };
    return {
      value: value.value,
      ...(value.scheme ? { scheme: value.scheme } : {}),
    };
  };
  const address = (
    value: ParsedParty['address'],
    path: string,
  ): InvoiceAddress => ({
    ...defined({
      street: value.street,
      street2: value.street2,
      street3: value.street3,
      postcode: value.postcode,
      city: value.city,
      subdivision: value.subdivision,
    }),
    country: code(
      value.country,
      `${path}.country`,
      countryCodes,
      'ISO 3166-1 (two letters, as in DE)',
      'BR-CL-14',
    ),
  });
  const vatId = (
    value: string | undefined,
    path: string,
  ): string | undefined => {
    if (value === undefined) return undefined;
    const id = value.replace(/\s/g, '').toUpperCase();
    const prefix = id.slice(0, 2);
    // Greece writes EL, and the standard's own list lets it
    if (!(countryCodes.has(prefix) || prefix === 'EL') || !/^[A-Z]{2}/.test(id))
      add(
        'vat_id_prefix',
        path,
        `_invoice.${path} must start with the country code of the VAT ID, as in DE123456789`,
        {
          rule: 'BR-CO-09',
          args: { value },
        },
      );
    return id;
  };
  const electronicAddress = (
    value: string | { value: string; scheme?: string | undefined } | undefined,
    path: string,
    rule: string,
  ): Required<Identifier> | undefined => {
    const id = identifier(value);
    if (!id) return undefined;
    const scheme =
      id.scheme?.trim().toUpperCase() ??
      (/^[^@\s]+@[^@\s]+$/.test(id.value) ? 'EM' : undefined);
    if (!scheme) {
      add(
        'scheme_required',
        path,
        `_invoice.${path} needs its scheme: write { "value": …, "scheme": … } with a code of the EAS list, or an e-mail address`,
        { rule },
      );
      return undefined;
    }
    if (!electronicAddressSchemes.has(scheme))
      add(
        'code_list',
        `${path}.scheme`,
        `_invoice.${path}.scheme: "${scheme}" is not a code of the EAS list (EM is an e-mail address)`,
        {
          rule: 'BR-CL-25',
          args: { value: scheme, list: 'the EAS list' },
        },
      );
    return { value: id.value, scheme };
  };
  const party = (
    value: ParsedParty,
    path: string,
    addressRule: string,
  ): InvoiceParty => {
    const id = identifier(value.id);
    const registration = identifier(value.legal_registration);
    const electronic = electronicAddress(
      value.electronic_address,
      `${path}.electronic_address`,
      addressRule,
    );
    const vat = vatId(value.vat_id, `${path}.vat_id`);
    return {
      name: value.name,
      ...defined({ trading_name: value.trading_name, vat_id: vat }),
      ...(id ? { id } : {}),
      ...(registration ? { legal_registration: registration } : {}),
      address: address(value.address, `${path}.address`),
      ...(value.contact &&
      Object.values(value.contact).some((v) => v !== undefined)
        ? { contact: defined(value.contact) }
        : {}),
      ...(electronic ? { electronic_address: electronic } : {}),
    };
  };
  const tax = (
    value: { category: VatCategory; rate?: unknown },
    path: string,
  ): InvoiceTax => ({
    category: value.category,
    ...(value.rate === undefined || value.rate === null
      ? {}
      : { rate: number(value.rate, `${path}.rate`, 4) }),
  });
  const allowance = (
    value: {
      amount: unknown;
      reason?: string | undefined;
      reason_code?: string | undefined;
      base_amount?: unknown;
      percent?: unknown;
    },
    path: string,
  ): InvoiceAllowance => ({
    amount: amount(value.amount, `${path}.amount`),
    ...defined({
      reason: value.reason,
      reason_code: value.reason_code?.trim().toUpperCase(),
      base_amount: optionalAmount(value.base_amount, `${path}.base_amount`),
      percent:
        value.percent === undefined
          ? undefined
          : number(value.percent, `${path}.percent`, 4),
    }),
  });

  const seller = party(input.seller, 'seller', 'BR-62');
  const buyer = party(input.buyer, 'buyer', 'BR-63');

  // France writes the buyer's SIREN as a field of its own; it is the buyer's legal registration
  // (BT-47) under ISO 6523's code for the SIRENE register
  if (input.buyer.siren !== undefined) {
    const siren = input.buyer.siren.replace(/\s/g, '');
    if (
      buyer.legal_registration &&
      buyer.legal_registration.value.replace(/\s/g, '') !== siren
    )
      add(
        'siren_mismatch',
        'buyer.siren',
        '_invoice.buyer.siren and _invoice.buyer.legal_registration name different registrations; state one of them',
      );
    else
      buyer.legal_registration = {
        value: siren,
        scheme: buyer.legal_registration?.scheme ?? '0002',
      };
  }

  const notes = [
    ...(input.note ? [{ text: input.note }] : []),
    ...(input.notes ?? []).map((note) => ({
      text: note.text,
      ...(note.subject_code
        ? { subject_code: note.subject_code.trim().toUpperCase() }
        : {}),
    })),
  ];

  const delivery = input.delivery
    ? defined({
        name: input.delivery.name,
        date: date(input.delivery.date, 'delivery.date'),
        address: input.delivery.address
          ? address(input.delivery.address, 'delivery.address')
          : undefined,
      })
    : undefined;

  let businessProcess: string | undefined;
  if (input.operation_code !== undefined)
    businessProcess = input.operation_code.trim().toUpperCase();
  else if (input.operation !== undefined)
    businessProcess = FRENCH_OPERATION[input.operation];

  const payment = input.payment
    ? defined({
        means_code:
          input.payment.means_code === undefined
            ? undefined
            : code(
                String(input.payment.means_code),
                'payment.means_code',
                paymentMeansCodes,
                'UNTDID 4461 (58 is a SEPA credit transfer)',
                'BR-CL-16',
              ),
        iban: iban(input.payment.iban, 'payment.iban', add),
        bic: input.payment.bic?.replace(/\s/g, '').toUpperCase(),
        account_name: input.payment.account_name,
        reference: input.payment.reference,
        terms: input.payment.terms,
        due_date: date(input.payment.due_date, 'payment.due_date'),
        mandate_id: input.payment.mandate_id,
        creditor_id: input.payment.creditor_id,
        debited_iban: iban(
          input.payment.debited_iban,
          'payment.debited_iban',
          add,
        ),
      })
    : undefined;

  const rounding = optionalAmount(input.totals.rounding, 'totals.rounding');
  if (
    options.profile === 'basic' &&
    rounding !== undefined &&
    toUnits(rounding, 2) !== 0n
  )
    add(
      'profile',
      'totals.rounding',
      '_invoice.totals.rounding cannot be carried by the profile basic, which has no rounding amount (BT-114); use en16931',
      {
        args: { profile: 'basic', term: 'BT-114' },
      },
    );

  return {
    number: input.number,
    issue_date: date(input.issue_date, 'issue_date') ?? input.issue_date,
    type_code: code(
      String(input.type_code),
      'type_code',
      documentTypeCodes,
      'UNTDID 1001 (380 is an invoice, 381 a credit note)',
      'BR-CL-01',
    ),
    currency: code(
      input.currency,
      'currency',
      currencyCodes,
      'ISO 4217 (three letters, as in EUR)',
      'BR-CL-04',
    ),
    ...defined({
      accounting_currency:
        input.accounting_currency === undefined
          ? undefined
          : code(
              input.accounting_currency,
              'accounting_currency',
              currencyCodes,
              'ISO 4217 (three letters, as in EUR)',
              'BR-CL-05',
            ),
      buyer_reference: input.buyer_reference,
      order_reference: input.order_reference,
      contract_reference: input.contract_reference,
      period: period(input.period, 'period', 'BR-29'),
      business_process: businessProcess,
    }),
    notes,
    preceding_invoices: (input.preceding_invoices ?? []).map(
      (reference, i) => ({
        number: reference.number,
        ...defined({
          issue_date: date(
            reference.issue_date,
            `preceding_invoices[${i}].issue_date`,
          ),
        }),
      }),
    ),
    seller: {
      ...seller,
      ...defined({
        tax_number: input.seller.tax_number,
        legal_info: input.seller.legal_info,
        vat_on_debits: input.seller.vat_on_debits,
      }),
    },
    buyer,
    ...(delivery && Object.keys(delivery).length > 0 ? { delivery } : {}),
    lines: input.lines.map((line, i) => {
      const path = `lines[${i}]`;
      const unit = line.unit_code.trim();
      const known = unitCodes.has(unit.toUpperCase()) || unitCodes.has(unit);
      if (!known) {
        const suggestion = UNIT_SUGGESTIONS[unit.toLowerCase()];
        add(
          'code_list',
          `${path}.unit_code`,
          `_invoice.${path}.unit_code: "${unit}" is not a code of UN/ECE Recommendation 20${suggestion ? `; ${suggestion} is the code for it` : ' (C62 is a piece, HUR an hour, DAY a day)'}`,
          {
            rule: 'BR-CL-23',
            args: {
              value: unit,
              list: 'UN/ECE Recommendation 20',
              ...(suggestion ? { suggestion } : {}),
            },
          },
        );
      }
      const price = number(line.net_price, `${path}.net_price`, 6);
      if (price.startsWith('-'))
        add(
          'negative',
          `${path}.net_price`,
          `_invoice.${path}.net_price must not be negative; a credit is a negative quantity`,
          { rule: 'BR-27' },
        );
      const standard = identifier(line.standard_item_id);
      if (standard && !standard.scheme)
        add(
          'scheme_required',
          `${path}.standard_item_id`,
          `_invoice.${path}.standard_item_id needs its scheme: write { "value": …, "scheme": … }, 0160 for a GTIN`,
          { rule: 'BR-64' },
        );
      return {
        id: String(line.id),
        name: line.name,
        quantity: number(line.quantity, `${path}.quantity`, 6),
        unit_code: unitCodes.has(unit) ? unit : unit.toUpperCase(),
        net_price: price,
        net_amount: amount(line.net_amount, `${path}.net_amount`),
        tax: tax(line.tax, `${path}.tax`),
        allowances: (line.allowances ?? []).map((a, j) =>
          allowance(a, `${path}.allowances[${j}]`),
        ),
        charges: (line.charges ?? []).map((c, j) =>
          allowance(c, `${path}.charges[${j}]`),
        ),
        ...defined({
          description: line.description,
          price_base_quantity:
            line.price_base_quantity === undefined
              ? undefined
              : number(
                  line.price_base_quantity,
                  `${path}.price_base_quantity`,
                  6,
                ),
          period: period(line.period, `${path}.period`, 'BR-30'),
          buyer_accounting_reference: line.buyer_accounting_reference,
          note: line.note,
          seller_item_id: line.seller_item_id,
          buyer_item_id: line.buyer_item_id,
          standard_item_id: standard,
          order_line_reference: line.order_line_reference,
        }),
      };
    }),
    allowances: (input.allowances ?? []).map((a, i) => ({
      ...allowance(a, `allowances[${i}]`),
      tax: tax(a.tax, `allowances[${i}].tax`),
    })),
    charges: (input.charges ?? []).map((c, i) => ({
      ...allowance(c, `charges[${i}]`),
      tax: tax(c.tax, `charges[${i}].tax`),
    })),
    breakdown: input.tax.breakdown.map((row, i) => ({
      ...tax(row, `tax.breakdown[${i}]`),
      basis: amount(row.basis, `tax.breakdown[${i}].basis`),
      amount: amount(row.amount, `tax.breakdown[${i}].amount`),
      ...defined({
        exemption_reason: row.exemption_reason,
        exemption_reason_code: row.exemption_reason_code?.trim(),
      }),
    })),
    totals: {
      line_net: amount(input.totals.line_net, 'totals.line_net'),
      tax_basis: amount(input.totals.tax_basis, 'totals.tax_basis'),
      tax_total: amount(input.totals.tax_total, 'totals.tax_total'),
      grand: amount(input.totals.grand, 'totals.grand'),
      due: amount(input.totals.due, 'totals.due'),
      ...defined({
        allowances: optionalAmount(
          input.totals.allowances,
          'totals.allowances',
        ),
        charges: optionalAmount(input.totals.charges, 'totals.charges'),
        prepaid: optionalAmount(input.totals.prepaid, 'totals.prepaid'),
        tax_total_accounting: optionalAmount(
          input.totals.tax_total_accounting,
          'totals.tax_total_accounting',
        ),
        rounding,
      }),
    },
    ...(payment && Object.keys(payment).length > 0 ? { payment } : {}),
  };
}

function iban(
  value: string | undefined,
  path: string,
  add: Add,
): string | undefined {
  if (value === undefined) return undefined;
  const normalised = normaliseIban(value);
  if (
    !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(normalised) ||
    !ibanChecksum(normalised)
  )
    add(
      'iban',
      path,
      `_invoice.${path} is not a valid IBAN: its check digits do not match`,
    );
  return normalised;
}

/** An object without the keys whose value is `undefined`, so the result compares and serialises cleanly. */
function defined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

const cents = (text: string | undefined): bigint =>
  text === undefined ? 0n : toUnits(text, 2);
const money = (value: bigint): string => fromUnits(value, 2);
/** A rate as text for a message and as a key for grouping: `19`, `7`, `5.5`. */
const rateKey = (tax: InvoiceTax): string =>
  `${tax.category}|${tax.rate ?? ''}`;

/** The business rules of EN 16931 that need no validator to check (and the French ones of spec 17 §4.4). */
function rules(invoice: Invoice, add: Add): void {
  const { totals } = invoice;

  // --- the totals, each the sum the standard defines it as --------------------------------
  const sum = (
    path: string,
    stated: bigint,
    expected: bigint,
    rule: string,
    formula: string,
  ): void => {
    if (stated !== expected)
      add(
        'sum',
        path,
        `_invoice.${path} is ${money(stated)}, but ${formula} ${money(expected)}`,
        {
          rule,
          args: { value: money(stated), expected: money(expected) },
        },
      );
  };
  const lineNet = invoice.lines.reduce(
    (total, line) => total + cents(line.net_amount),
    0n,
  );
  const allowanceSum = invoice.allowances.reduce(
    (total, a) => total + cents(a.amount),
    0n,
  );
  const chargeSum = invoice.charges.reduce(
    (total, c) => total + cents(c.amount),
    0n,
  );
  const taxSum = invoice.breakdown.reduce(
    (total, row) => total + cents(row.amount),
    0n,
  );
  sum(
    'totals.line_net',
    cents(totals.line_net),
    lineNet,
    'BR-CO-10',
    'the net amounts of the lines add up to',
  );
  sum(
    'totals.allowances',
    cents(totals.allowances),
    allowanceSum,
    'BR-CO-11',
    'the allowances of the document add up to',
  );
  sum(
    'totals.charges',
    cents(totals.charges),
    chargeSum,
    'BR-CO-12',
    'the charges of the document add up to',
  );
  sum(
    'totals.tax_basis',
    cents(totals.tax_basis),
    cents(totals.line_net) - cents(totals.allowances) + cents(totals.charges),
    'BR-CO-13',
    'line_net less allowances plus charges is',
  );
  sum(
    'totals.tax_total',
    cents(totals.tax_total),
    taxSum,
    'BR-CO-14',
    'the VAT amounts of the breakdown add up to',
  );
  sum(
    'totals.grand',
    cents(totals.grand),
    cents(totals.tax_basis) + cents(totals.tax_total),
    'BR-CO-15',
    'tax_basis plus tax_total is',
  );
  sum(
    'totals.due',
    cents(totals.due),
    cents(totals.grand) - cents(totals.prepaid) + cents(totals.rounding),
    'BR-CO-16',
    'grand less prepaid plus rounding is',
  );

  // an invoice in one currency with its VAT accounted in another states that VAT total as well
  if (
    invoice.accounting_currency !== undefined &&
    totals.tax_total_accounting === undefined
  )
    add(
      'missing',
      'totals.tax_total_accounting',
      `_invoice.totals.tax_total_accounting is missing: with accounting_currency ${invoice.accounting_currency} the invoice states its VAT total in that currency (BT-111)`,
      {
        rule: 'BR-53',
        args: { term: 'BT-111' },
      },
    );
  if (
    invoice.accounting_currency === undefined &&
    totals.tax_total_accounting !== undefined
  )
    add(
      'missing',
      'accounting_currency',
      '_invoice.accounting_currency is missing: totals.tax_total_accounting needs the currency it is stated in (BT-6)',
      {
        rule: 'BR-53',
        args: { term: 'BT-6' },
      },
    );

  // --- the VAT breakdown against what the lines, allowances and charges fall under --------
  const used = new Map<
    string,
    { tax: InvoiceTax; basis: bigint; items: number; first: string }
  >();
  const use = (tax: InvoiceTax, value: bigint, path: string): void => {
    const entry = used.get(rateKey(tax)) ?? {
      tax,
      basis: 0n,
      items: 0,
      first: path,
    };
    entry.basis += value;
    entry.items += 1;
    used.set(rateKey(tax), entry);
  };
  invoice.lines.forEach((line, i) =>
    use(line.tax, cents(line.net_amount), `lines[${i}]`),
  );
  invoice.allowances.forEach((a, i) =>
    use(a.tax, -cents(a.amount), `allowances[${i}]`),
  );
  invoice.charges.forEach((c, i) =>
    use(c.tax, cents(c.amount), `charges[${i}]`),
  );

  const seen = new Set<string>();
  invoice.breakdown.forEach((row, i) => {
    const path = `tax.breakdown[${i}]`;
    const prefix = RULE_PREFIX[row.category];
    const shown =
      row.rate === undefined
        ? row.category
        : `${row.category} at ${row.rate} %`;
    if (seen.has(rateKey(row)))
      add(
        'breakdown_duplicate',
        path,
        `_invoice.tax.breakdown lists category ${shown} twice; one entry per category and rate`,
        {
          args: { category: row.category, rate: row.rate ?? '' },
        },
      );
    seen.add(rateKey(row));
    const entry = used.get(rateKey(row));
    const expected = entry?.basis ?? 0n;
    if (cents(row.basis) !== expected)
      add(
        'sum',
        `${path}.basis`,
        `_invoice.${path}.basis is ${money(cents(row.basis))}, but the lines, charges and allowances of category ${shown} come to ${money(expected)}`,
        {
          rule: `${prefix}-08`,
          args: {
            value: money(cents(row.basis)),
            expected: money(expected),
            category: row.category,
            rate: row.rate ?? '',
          },
        },
      );
    if (row.rate !== undefined) {
      // BR-CO-17 allows a whole currency unit of difference, which lets a wrong amount through.
      // What can honestly differ is the rounding: VAT taken line by line is at most half a cent
      // off per item, so that is the tolerance, and never more than the standard's own.
      const computed = divideRounded(
        cents(row.basis) * toUnits(row.rate, 4),
        1_000_000n,
      );
      const items = BigInt(Math.max(1, entry?.items ?? 1));
      const tolerance = (items + 1n) / 2n > 100n ? 100n : (items + 1n) / 2n;
      if (abs(cents(row.amount) - computed) > tolerance)
        add(
          'sum',
          `${path}.amount`,
          `_invoice.${path}.amount is ${money(cents(row.amount))}, but ${row.rate} % of ${money(cents(row.basis))} is ${money(computed)}`,
          {
            rule: 'BR-CO-17',
            args: {
              value: money(cents(row.amount)),
              expected: money(computed),
              rate: row.rate,
              basis: money(cents(row.basis)),
            },
          },
        );
    }
  });
  for (const [key, entry] of used) {
    if (seen.has(key)) continue;
    const shown =
      entry.tax.rate === undefined
        ? entry.tax.category
        : `${entry.tax.category} at ${entry.tax.rate} %`;
    add(
      'breakdown_missing',
      'tax.breakdown',
      `_invoice.tax.breakdown has no entry for category ${shown}, which _invoice.${entry.first} falls under`,
      {
        rule: `${RULE_PREFIX[entry.tax.category]}-01`,
        args: {
          category: entry.tax.category,
          rate: entry.tax.rate ?? '',
          used: entry.first,
        },
      },
    );
  }

  // --- what each VAT category asks for ------------------------------------------------------
  const rate = (
    tax: InvoiceTax,
    path: string,
    at: 'line' | 'allowance' | 'charge' | 'breakdown',
  ): void => {
    const prefix = RULE_PREFIX[tax.category];
    // the rule numbers of a category run line, allowance, charge: -05, -06, -07
    const number =
      at === 'line' || at === 'breakdown'
        ? '05'
        : at === 'allowance'
          ? '06'
          : '07';
    if (tax.category === 'O') {
      if (tax.rate !== undefined)
        add(
          'rate_forbidden',
          `${path}.rate`,
          `_invoice.${path}.rate must be left out: category O is not subject to VAT and has no rate`,
          { rule: `${prefix}-${number}` },
        );
      return;
    }
    if (tax.rate === undefined) {
      add(
        'rate_required',
        `${path}.rate`,
        `_invoice.${path}.rate is missing: category ${tax.category} states its rate${tax.category === 'S' ? '' : ', which is 0'}`,
        {
          rule: at === 'breakdown' ? 'BR-48' : `${prefix}-${number}`,
          args: { category: tax.category },
        },
      );
      return;
    }
    const value = toUnits(tax.rate, 4);
    if (tax.category === 'S' && value <= 0n)
      add(
        'rate_positive',
        `${path}.rate`,
        `_invoice.${path}.rate is ${tax.rate}: category S is standard rated and needs a rate above 0; a rate of 0 is category Z or E`,
        {
          rule: `${prefix}-${number}`,
          args: { rate: tax.rate },
        },
      );
    if (tax.category !== 'S' && value !== 0n)
      add(
        'rate_zero',
        `${path}.rate`,
        `_invoice.${path}.rate is ${tax.rate}: category ${tax.category} carries a rate of 0`,
        {
          rule: `${prefix}-${number}`,
          args: { rate: tax.rate, category: tax.category },
        },
      );
  };
  invoice.lines.forEach((line, i) => rate(line.tax, `lines[${i}].tax`, 'line'));
  invoice.allowances.forEach((a, i) =>
    rate(a.tax, `allowances[${i}].tax`, 'allowance'),
  );
  invoice.charges.forEach((c, i) => rate(c.tax, `charges[${i}].tax`, 'charge'));

  const categories = new Set<VatCategory>(
    [...used.values()].map((entry) => entry.tax.category),
  );
  invoice.breakdown.forEach((row, i) => {
    const path = `tax.breakdown[${i}]`;
    const prefix = RULE_PREFIX[row.category];
    rate(row, path, 'breakdown');
    categories.add(row.category);
    const reason =
      row.exemption_reason !== undefined ||
      row.exemption_reason_code !== undefined;
    if (row.category === 'S' || row.category === 'Z') {
      if (reason)
        add(
          'exemption_reason_forbidden',
          `${path}.exemption_reason`,
          `_invoice.${path} must not state an exemption reason: category ${row.category} is not an exemption`,
          {
            rule: `${prefix}-10`,
            args: { category: row.category },
          },
        );
    } else if (!reason) {
      add(
        'exemption_reason_required',
        `${path}.exemption_reason`,
        `_invoice.${path}.exemption_reason is missing: category ${row.category} says why no VAT is charged, as text or as exemption_reason_code`,
        {
          rule: `${prefix}-10`,
          args: { category: row.category },
        },
      );
    }
    if (row.category !== 'S' && cents(row.amount) !== 0n)
      add(
        'amount_zero',
        `${path}.amount`,
        `_invoice.${path}.amount is ${money(cents(row.amount))}: category ${row.category} carries no VAT, so the amount is 0`,
        {
          rule: `${prefix}-09`,
          args: { value: money(cents(row.amount)), category: row.category },
        },
      );
  });

  const sellerTaxId =
    invoice.seller.vat_id !== undefined ||
    invoice.seller.tax_number !== undefined;
  for (const category of categories) {
    const prefix = RULE_PREFIX[category];
    if (category === 'O') {
      if (invoice.seller.vat_id !== undefined)
        add(
          'vat_id_forbidden',
          'seller.vat_id',
          '_invoice.seller.vat_id must be left out: an invoice of category O is not subject to VAT; the seller is named by tax_number or legal_registration',
          { rule: 'BR-O-02' },
        );
      if (invoice.buyer.vat_id !== undefined)
        add(
          'vat_id_forbidden',
          'buyer.vat_id',
          '_invoice.buyer.vat_id must be left out: an invoice of category O is not subject to VAT',
          { rule: 'BR-O-02' },
        );
      if (categories.size > 1)
        add(
          'only_category',
          'tax.breakdown',
          '_invoice mixes category O with others: an invoice that is not subject to VAT has that one category only',
          { rule: 'BR-O-11' },
        );
      continue;
    }
    if (category === 'K' || category === 'G') {
      if (invoice.seller.vat_id === undefined)
        add(
          'seller_tax_id_required',
          'seller.vat_id',
          `_invoice.seller.vat_id is missing: category ${category} names the seller's VAT ID`,
          {
            rule: `${prefix}-02`,
            args: { category },
          },
        );
    } else if (!sellerTaxId) {
      add(
        'seller_tax_id_required',
        'seller.vat_id',
        `_invoice.seller.vat_id is missing: category ${category} names the seller's VAT ID, or tax_number where there is none`,
        {
          rule: `${prefix}-02`,
          args: { category },
        },
      );
    }
    if (
      category === 'AE' &&
      invoice.buyer.vat_id === undefined &&
      invoice.buyer.legal_registration === undefined
    )
      add(
        'buyer_tax_id_required',
        'buyer.vat_id',
        "_invoice.buyer.vat_id is missing: with reverse charge the buyer owes the VAT, so the invoice names the buyer's VAT ID or legal_registration",
        {
          rule: 'BR-AE-02',
          args: { category },
        },
      );
    if (category === 'K') {
      if (invoice.buyer.vat_id === undefined)
        add(
          'buyer_tax_id_required',
          'buyer.vat_id',
          "_invoice.buyer.vat_id is missing: an intra-community supply names the buyer's VAT ID",
          {
            rule: 'BR-IC-02',
            args: { category },
          },
        );
      if (invoice.delivery?.date === undefined && invoice.period === undefined)
        add(
          'delivery_required',
          'delivery.date',
          '_invoice.delivery.date is missing: an intra-community supply states when it was delivered, or the invoicing period',
          { rule: 'BR-IC-11' },
        );
      if (invoice.delivery?.address === undefined)
        add(
          'delivery_required',
          'delivery.address.country',
          '_invoice.delivery.address.country is missing: an intra-community supply states the country it was delivered to',
          { rule: 'BR-IC-12' },
        );
    }
  }

  // --- who the seller is, and how the invoice is paid -----------------------------------------
  if (
    invoice.seller.id === undefined &&
    invoice.seller.legal_registration === undefined &&
    invoice.seller.vat_id === undefined
  )
    add(
      'seller_identifier_required',
      'seller.vat_id',
      '_invoice.seller needs an identifier the buyer can match: vat_id, legal_registration or id',
      { rule: 'BR-CO-26' },
    );

  const payment = invoice.payment;
  const account =
    payment?.iban !== undefined ||
    payment?.bic !== undefined ||
    payment?.account_name !== undefined;
  if (
    payment &&
    payment.means_code === undefined &&
    (account ||
      payment.mandate_id !== undefined ||
      payment.debited_iban !== undefined)
  )
    add(
      'means_code_required',
      'payment.means_code',
      '_invoice.payment.means_code is missing: payment details say how the invoice is paid, 58 for a SEPA credit transfer, 59 for a SEPA direct debit',
      { rule: 'BR-49' },
    );
  if (
    payment?.means_code !== undefined &&
    CREDIT_TRANSFER.has(payment.means_code) &&
    payment.iban === undefined
  )
    add(
      'account_required',
      'payment.iban',
      `_invoice.payment.iban is missing: a payment by credit transfer (code ${payment.means_code}) names the account`,
      {
        rule: 'BR-61',
        args: { means: payment.means_code },
      },
    );
  if (
    cents(totals.due) > 0n &&
    payment?.due_date === undefined &&
    payment?.terms === undefined
  )
    add(
      'due_or_terms_required',
      'payment.due_date',
      '_invoice.payment.due_date is missing: an invoice with an amount due states when it is due, or its payment terms',
      { rule: 'BR-CO-25' },
    );

  // --- invoices between French businesses (spec 17 §4.4) ---------------------------------------
  if (
    invoice.seller.address.country === 'FR' &&
    invoice.buyer.address.country === 'FR'
  ) {
    const digits = (id: Identifier | undefined): string =>
      (id?.value ?? '').replace(/\s/g, '');
    if (!/^\d{9}$/.test(digits(invoice.seller.legal_registration)))
      add(
        'fr_seller_siren',
        'seller.legal_registration',
        "_invoice.seller.legal_registration is missing or not nine digits: an invoice between French businesses names the seller's SIREN (BT-30)",
        { rule: 'BR-FR-10' },
      );
    if (!/^\d{9}$/.test(digits(invoice.buyer.legal_registration)))
      add(
        'fr_buyer_siren',
        'buyer.siren',
        "_invoice.buyer.siren is missing or not nine digits: an invoice between French businesses names the buyer's SIREN (BT-47)",
        { rule: 'BR-FR-11' },
      );
    if (invoice.business_process === undefined)
      add(
        'fr_operation',
        'operation',
        '_invoice.operation is missing: an invoice between French businesses says whether it is for goods, services or mixed (BT-23)',
        { rule: 'BR-FR-08' },
      );
    else if (!FRENCH_FRAMEWORKS.has(invoice.business_process))
      add(
        'code_list',
        'operation_code',
        `_invoice.operation_code: "${invoice.business_process}" is not a billing framework of the French specifications (B1, S1, M1 and their variants)`,
        {
          rule: 'BR-FR-08',
          args: {
            value: invoice.business_process,
            list: 'the French billing frameworks',
          },
        },
      );
    if (invoice.seller.vat_on_debits === undefined)
      add(
        'fr_vat_on_debits',
        'seller.vat_on_debits',
        '_invoice.seller.vat_on_debits is missing: an invoice between French businesses says whether the seller pays VAT on invoicing (true) or on payment (false)',
      );
  }
}
