import { toNumber } from '../values';

/**
 * The SEPA credit transfer QR code, EPC069-12 version 002 — the GiroCode a German invoice carries
 * so a banking app fills the transfer in by scanning it (spec 05 §2, `epcQr`).
 *
 * The payload is built here and validated here, apart from the helper registration, so the browser
 * can have both without the rest of the engine: `helpers/codes.ts` also brings bwip-js in for
 * barcodes, which is far larger than everything on this page put together.
 */

/**
 * A complete payment. A caller that has one should say so with this type; the two functions below
 * take `EpcInput` instead, because a template hands over whatever the data happened to hold and
 * telling someone what is missing is the whole job of `validateEpc`.
 */
export interface EpcPayment {
  /** The beneficiary, at most 70 characters. Required. */
  name: string;
  /** The beneficiary's IBAN. Required. */
  iban: string;
  /** Optional with version 002 inside SEPA; 8 or 11 characters. */
  bic?: string;
  /** Euro; the code carries no other currency. */
  amount?: number | string;
  /** Structured remittance information, at most 35 characters. Excludes `text`. */
  reference?: string;
  /** Unstructured remittance information, at most 140 characters. Excludes `reference`. */
  text?: string;
  /** Purpose code (AT-44), at most 4 characters. */
  purpose?: string;
}

/** What a caller actually hands over: the same fields, none of them guaranteed to be there. */
export type EpcInput = Partial<EpcPayment>;

/** EPC QR (GiroCode) payload, version 002, UTF-8, SCT. */
export function epcPayload(input: EpcInput): string {
  const amount =
    input.amount === undefined || input.amount === '' ? '' : `EUR${toNumber(input.amount).toFixed(2)}`;
  return [
    'BCD',
    '002',
    '1',
    'SCT',
    (input.bic ?? '').replace(/\s/g, ''),
    String(input.name ?? '').slice(0, 70),
    String(input.iban ?? '').replace(/\s/g, ''),
    amount,
    (input.purpose ?? '').slice(0, 4),
    (input.reference ?? '').slice(0, 35),
    input.reference ? '' : (input.text ?? '').slice(0, 140),
    '',
  ].join('\n');
}

/**
 * What is wrong with a payment, as a code rather than a sentence: the engine has no locale, and the
 * one caller that shows these to a person says them in two languages.
 */
export interface EpcProblem {
  field: keyof EpcPayment | 'payload';
  code:
    | 'required'
    | 'too_long'
    | 'iban_characters'
    | 'iban_country_length'
    | 'iban_checksum'
    | 'bic_format'
    | 'not_a_number'
    | 'out_of_range'
    | 'reference_or_text';
  /** The limit that was passed, where there is one. */
  max?: number;
  /** What the value actually is, where a number says more than the code alone. */
  actual?: number;
}

/** Length of an IBAN per country, so a typo is caught before the checksum is even reached. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GI: 23, GL: 18, GR: 27, HR: 21, HU: 28,
  IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18,
  NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

/** The whole payload must fit 331 bytes, and a German umlaut is two of them. */
export const EPC_MAX_BYTES = 331;

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Spaces and case are the writer's business, not the code's. */
export const normaliseIban = (iban: string): string => iban.replace(/\s/g, '').toUpperCase();

/**
 * Whether an IBAN's check digits match its body (ISO 7064 mod 97-10). The remainder is taken digit
 * by digit because the rearranged number runs to 30-odd digits, well past a safe integer.
 */
export function ibanChecksum(iban: string): boolean {
  const rearranged = normaliseIban(iban).slice(4) + normaliseIban(iban).slice(0, 4);
  const digits = [...rearranged]
    .map((c) => (c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c))
    .join('');
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

/** Everything wrong with a payment, in the order a form shows its fields; empty when it is valid. */
export function validateEpc(input: EpcInput): EpcProblem[] {
  const problems: EpcProblem[] = [];
  const name = String(input.name ?? '').trim();
  if (!name) problems.push({ field: 'name', code: 'required' });
  else if (name.length > 70) problems.push({ field: 'name', code: 'too_long', max: 70, actual: name.length });

  const iban = normaliseIban(String(input.iban ?? ''));
  if (!iban) problems.push({ field: 'iban', code: 'required' });
  else if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) problems.push({ field: 'iban', code: 'iban_characters' });
  else {
    const expected = IBAN_LENGTHS[iban.slice(0, 2)];
    if (expected !== undefined && iban.length !== expected)
      problems.push({ field: 'iban', code: 'iban_country_length', max: expected, actual: iban.length });
    else if (!ibanChecksum(iban)) problems.push({ field: 'iban', code: 'iban_checksum' });
  }

  const bic = String(input.bic ?? '').replace(/\s/g, '').toUpperCase();
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) problems.push({ field: 'bic', code: 'bic_format' });

  if (input.amount !== undefined && input.amount !== '') {
    const amount = toNumber(input.amount);
    if (Number.isNaN(amount)) problems.push({ field: 'amount', code: 'not_a_number' });
    // EPC069-12: at least one cent, and the field holds no more than twelve characters
    else if (amount < 0.01 || amount > 999999999.99) problems.push({ field: 'amount', code: 'out_of_range' });
  }

  const purpose = String(input.purpose ?? '');
  if (purpose.length > 4) problems.push({ field: 'purpose', code: 'too_long', max: 4, actual: purpose.length });

  const reference = String(input.reference ?? '').trim();
  const text = String(input.text ?? '').trim();
  if (reference && text) problems.push({ field: 'reference', code: 'reference_or_text' });
  if (reference.length > 35)
    problems.push({ field: 'reference', code: 'too_long', max: 35, actual: reference.length });
  if (text.length > 140) problems.push({ field: 'text', code: 'too_long', max: 140, actual: text.length });

  const bytes = byteLength(epcPayload(input));
  if (bytes > EPC_MAX_BYTES)
    problems.push({ field: 'payload', code: 'too_long', max: EPC_MAX_BYTES, actual: bytes });
  return problems;
}
