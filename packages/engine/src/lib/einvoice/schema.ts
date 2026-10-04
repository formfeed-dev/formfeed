import { z } from 'zod';

/**
 * The `_invoice` block of the render data (spec 17 §4.3): what the e-invoice's XML is built from.
 *
 * This file says what the block looks like and nothing about whether the invoice is right: a field
 * that is a number here may still have three decimals, and totals may not add up. `checkInvoice`
 * (`check.ts`) reads the parsed block against EN 16931 and names the rule a finding breaks.
 *
 * Unknown fields are dropped, not refused. A template reads `_invoice` for display too, and data
 * that only the page needs (a line's picture, a salutation) may sit beside what the XML takes.
 */

/** A number as JSON has it, or the same as text (`"3760.40"`), which survives every serialiser. */
const numeric = z.union([z.number(), z.string()]);
const text = z.string().trim().min(1);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

/** An identifier with the scheme it belongs to (ISO 6523 or the EAS list), or the bare value. */
const identifier = z.union([
  text,
  z.object({ value: text, scheme: text.optional() }),
]);

const address = z.object({
  street: text.optional(),
  street2: text.optional(),
  street3: text.optional(),
  postcode: text.optional(),
  city: text.optional(),
  /** ISO 3166-1 alpha-2 (BT-40, BT-55, BT-80). */
  country: text,
  /** Region or province (BT-39, BT-54, BT-79). */
  subdivision: text.optional(),
});

/**
 * Who to ask about the invoice (BG-6, BG-9). One name only, a person's or a department's: the
 * standard has a single "contact point", and the syntax refuses a second.
 */
const contact = z.object({
  name: text.optional(),
  phone: text.optional(),
  email: text.optional(),
});

const party = z.object({
  name: text,
  /** The name the business trades under, where it differs (BT-28, BT-45). */
  trading_name: text.optional(),
  /** An identifier of the party (BT-29, BT-46). */
  id: identifier.optional(),
  /** The register entry (BT-30, BT-47): a SIREN, a company number. */
  legal_registration: identifier.optional(),
  vat_id: text.optional(),
  address,
  contact: contact.optional(),
  /** Where the party receives electronic invoices (BT-34, BT-49); a bare e-mail address is scheme EM. */
  electronic_address: identifier.optional(),
});

const period = z.object({ start: isoDate.optional(), end: isoDate.optional() });

/** VAT categories of UNCL 5305 as EN 16931 uses them (spec 17 §4.3). */
export const VAT_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];
const vatCategory = z.enum(VAT_CATEGORIES);

const lineTax = z.object({
  category: vatCategory,
  /** Percent, `19` for 19 %. Left out for category O only. */
  rate: numeric.optional(),
});

const allowanceOrCharge = z.object({
  amount: numeric,
  reason: text.optional(),
  /** UNTDID 5189 for an allowance, UNTDID 7161 for a charge. */
  reason_code: text.optional(),
  base_amount: numeric.optional(),
  percent: numeric.optional(),
});

const line = z.object({
  id: z.union([text, z.number()]),
  name: text,
  description: text.optional(),
  quantity: numeric,
  /** UN/ECE Recommendation 20: C62 a piece, HUR an hour, DAY a day, KGM a kilogram. */
  unit_code: text.default('C62'),
  net_price: numeric,
  /** The quantity the price is for, where it is not one unit (BT-149). */
  price_base_quantity: numeric.optional(),
  net_amount: numeric,
  tax: lineTax,
  period: period.optional(),
  allowances: z.array(allowanceOrCharge).optional(),
  charges: z.array(allowanceOrCharge).optional(),
  buyer_accounting_reference: text.optional(),
  note: text.optional(),
  /** The seller's and the buyer's article numbers (BT-155, BT-156), a GTIN and the like (BT-157). */
  seller_item_id: text.optional(),
  buyer_item_id: text.optional(),
  standard_item_id: identifier.optional(),
  /** The line of the buyer's order this one answers (BT-132). */
  order_line_reference: text.optional(),
});

const breakdown = z.object({
  category: vatCategory,
  rate: numeric.optional(),
  basis: numeric,
  amount: numeric,
  exemption_reason: text.optional(),
  /** A VATEX code (BT-121), for example VATEX-EU-AE for reverse charge. */
  exemption_reason_code: text.optional(),
});

const totals = z.object({
  line_net: numeric,
  allowances: numeric.optional(),
  charges: numeric.optional(),
  tax_basis: numeric,
  tax_total: numeric,
  /** The VAT total in the accounting currency (BT-111). */
  tax_total_accounting: numeric.optional(),
  grand: numeric,
  prepaid: numeric.optional(),
  rounding: numeric.optional(),
  due: numeric,
});

const payment = z.object({
  /** UNTDID 4461: 58 SEPA credit transfer, 59 SEPA direct debit, 30 credit transfer, 48 card. */
  means_code: z.union([text, z.number()]).optional(),
  iban: text.optional(),
  bic: text.optional(),
  account_name: text.optional(),
  /** What the payer quotes with the payment (BT-83). */
  reference: text.optional(),
  terms: text.optional(),
  due_date: isoDate.optional(),
  /** Direct debit: the mandate (BT-89), the creditor's identifier (BT-90), the account debited (BT-91). */
  mandate_id: text.optional(),
  creditor_id: text.optional(),
  debited_iban: text.optional(),
});

const note = z.object({
  text,
  /** UNTDID 4451, which French invoices use for their statutory mentions (PMT, PMD, AAB). */
  subject_code: text.optional(),
});

export const invoiceSchema = z.object({
  number: text,
  issue_date: isoDate,
  /** UNTDID 1001: 380 invoice, 381 credit note, 384 corrected invoice, 389 self-billed. */
  type_code: z.union([text, z.number()]).default('380'),
  currency: text,
  /** The currency the VAT is accounted in, where the invoice is in another (BT-6); goes with `totals.tax_total_accounting`. */
  accounting_currency: text.optional(),
  /** The buyer's routing reference (BT-10); a German authority's Leitweg-ID goes here. */
  buyer_reference: text.optional(),
  order_reference: text.optional(),
  contract_reference: text.optional(),
  note: text.optional(),
  notes: z.array(note).optional(),
  period: period.optional(),
  /** The invoices a credit note or a correction refers to (BG-3). */
  preceding_invoices: z
    .array(z.object({ number: text, issue_date: isoDate.optional() }))
    .optional(),
  /** France (spec 17 §4.4): what was sold, and the billing framework's code where the plain case does not fit. */
  operation: z.enum(['goods', 'services', 'mixed']).optional(),
  operation_code: text.optional(),
  seller: party.extend({
    tax_number: text.optional(),
    /** Further legal information the invoice must state (BT-33): register court, capital. */
    legal_info: text.optional(),
    /** France: VAT is owed when the invoice is issued, not when it is paid. */
    vat_on_debits: z.boolean().optional(),
  }),
  buyer: party.extend({
    /** France: the buyer's SIREN, nine digits. */
    siren: text.optional(),
  }),
  delivery: z
    .object({
      name: text.optional(),
      date: isoDate.optional(),
      address: address.optional(),
    })
    .optional(),
  lines: z.array(line).min(1),
  /** Allowances and charges on the whole document (BG-20, BG-21), each with the VAT it falls under. */
  allowances: z.array(allowanceOrCharge.extend({ tax: lineTax })).optional(),
  charges: z.array(allowanceOrCharge.extend({ tax: lineTax })).optional(),
  tax: z.object({ breakdown: z.array(breakdown).min(1) }),
  totals,
  payment: payment.optional(),
});

/** The block as a caller writes it. */
export type InvoiceInput = z.input<typeof invoiceSchema>;
/** The block once parsed: defaults filled in, numbers still as they came. */
export type ParsedInvoice = z.output<typeof invoiceSchema>;
export type ParsedParty = ParsedInvoice['seller'] | ParsedInvoice['buyer'];
export type ParsedLine = ParsedInvoice['lines'][number];

// --- options ---------------------------------------------------------------------------------

export const EINVOICE_PROFILES = ['basic', 'en16931'] as const;
export type EinvoiceProfile = (typeof EINVOICE_PROFILES)[number];
export const EINVOICE_FLAVOURS = ['factur-x', 'zugferd'] as const;
export type EinvoiceFlavour = (typeof EINVOICE_FLAVOURS)[number];

/**
 * `post.einvoice` of a request and `settings.einvoice` of a template (spec 17 §4.1). `profile` and
 * `flavour` are text here on purpose: a profile we do not emit (`minimum`, `xrechnung`) is answered
 * with `einvoice_profile_unsupported` and its own explanation, not as a malformed request.
 */
export const einvoiceOptionsSchema = z
  .object({
    profile: z.string().optional(),
    flavour: z.string().optional(),
    xml: z.enum(['embedded', 'both']).optional(),
    display_check: z.enum(['warn', 'strict']).optional(),
  })
  .strict();
export type EinvoiceOptionsInput = z.infer<typeof einvoiceOptionsSchema>;

/** The options with every default filled in: what the worker acts on and the render records. */
export interface EinvoiceOptions {
  profile: EinvoiceProfile;
  flavour: EinvoiceFlavour;
  xml: 'embedded' | 'both';
  display_check: 'warn' | 'strict';
}

export const defaultEinvoiceOptions: EinvoiceOptions = {
  profile: 'en16931',
  flavour: 'factur-x',
  xml: 'embedded',
  display_check: 'warn',
};

/** Profiles of the specification that exist and that we do not emit, with the reason a caller is told. */
const knownUnsupported: Record<string, string> = {
  minimum:
    'MINIMUM carries no invoice lines and is not an invoice on its own; use basic or en16931',
  'basic-wl':
    'BASIC WL carries no invoice lines and is not an invoice on its own; use basic or en16931',
  basicwl:
    'BASIC WL carries no invoice lines and is not an invoice on its own; use basic or en16931',
  extended:
    'EXTENDED is not offered; use en16931, which carries the full European standard',
  xrechnung: 'XRechnung is not offered yet; use en16931',
};

export type ResolvedEinvoice =
  | { ok: true; options: EinvoiceOptions | null }
  | { ok: false; field: 'profile' | 'flavour'; value: string; reason: string };

/**
 * One e-invoice declaration out of its layers, earliest first (the template's settings, the
 * request's settings, `post.einvoice`). Fields merge one by one with the later layer winning, like
 * every other setting; `false` drops whatever was declared before it, so a request can switch a
 * template's declaration off; `null` when nothing declares an e-invoice.
 */
export function resolveEinvoiceOptions(
  ...layers: Array<EinvoiceOptionsInput | false | null | undefined>
): ResolvedEinvoice {
  let merged: EinvoiceOptionsInput | null = null;
  for (const layer of layers) {
    if (layer === false) merged = null;
    else if (layer) merged = { ...(merged ?? {}), ...definedOnly(layer) };
  }
  if (!merged) return { ok: true, options: null };
  const profile = (merged.profile ?? defaultEinvoiceOptions.profile)
    .trim()
    .toLowerCase();
  const flavour = (merged.flavour ?? defaultEinvoiceOptions.flavour)
    .trim()
    .toLowerCase();
  if (!(EINVOICE_PROFILES as readonly string[]).includes(profile))
    return {
      ok: false,
      field: 'profile',
      value: profile,
      reason:
        knownUnsupported[profile] ??
        `Unknown profile; use ${EINVOICE_PROFILES.join(' or ')}`,
    };
  if (!(EINVOICE_FLAVOURS as readonly string[]).includes(flavour))
    return {
      ok: false,
      field: 'flavour',
      value: flavour,
      reason: `Unknown flavour; use ${EINVOICE_FLAVOURS.join(' or ')}`,
    };
  return {
    ok: true,
    options: {
      profile: profile as EinvoiceProfile,
      flavour: flavour as EinvoiceFlavour,
      xml: merged.xml ?? defaultEinvoiceOptions.xml,
      display_check:
        merged.display_check ?? defaultEinvoiceOptions.display_check,
    },
  };
}

function definedOnly(layer: EinvoiceOptionsInput): EinvoiceOptionsInput {
  return Object.fromEntries(
    Object.entries(layer).filter(([, value]) => value !== undefined),
  ) as EinvoiceOptionsInput;
}
