import { describe, expect, it } from 'vitest';
import { EPC_MAX_BYTES, epcPayload, ibanChecksum, normaliseIban, validateEpc, type EpcPayment } from './epc';

/**
 * The GiroCode a banking app refuses is worse than no code at all: the payer has already scanned it
 * and now distrusts the invoice. `validateEpc` is what the landing site's generator and anyone
 * building the code by hand check against, so its rules are pinned here against EPC069-12.
 */

/**
 * Invented, and still valid: the account number is all zeros as published sample data must be, but
 * the check digits are the ones that body really has (36 for Germany), because the whole point of
 * this module is that `DE00 …` is refused.
 */
const payment: EpcPayment = {
  name: 'Fennlor Studio GmbH',
  iban: 'DE36 0000 0000 0000 0000 00',
  amount: 1234.5,
  reference: 'RG 2026-0042',
};

describe('epcPayload', () => {
  it('writes the twelve lines of version 002', () => {
    expect(epcPayload(payment).split('\n')).toEqual([
      'BCD',
      '002',
      '1',
      'SCT',
      '',
      'Fennlor Studio GmbH',
      'DE36000000000000000000',
      'EUR1234.50',
      '',
      'RG 2026-0042',
      '',
      '',
    ]);
  });

  it('leaves the amount out when there is none, rather than writing EUR0.00', () => {
    expect(epcPayload({ ...payment, amount: undefined }).split('\n')[7]).toBe('');
    expect(epcPayload({ ...payment, amount: '' }).split('\n')[7]).toBe('');
  });

  it('drops the unstructured text when a reference is given, as the standard allows only one', () => {
    const lines = epcPayload({ ...payment, text: 'Vielen Dank' }).split('\n');
    expect(lines[9]).toBe('RG 2026-0042');
    expect(lines[10]).toBe('');
  });
});

describe('ibanChecksum', () => {
  it('accepts a correct IBAN whatever the spacing and case', () => {
    expect(ibanChecksum('DE36 0000 0000 0000 0000 00')).toBe(true);
    expect(ibanChecksum('de36000000000000000000')).toBe(true);
    expect(ibanChecksum('AT18 0000 0000 0000 0000')).toBe(true);
  });

  it('rejects one digit changed', () => {
    expect(ibanChecksum('DE37000000000000000000')).toBe(false);
    // a transposition of the check digits, which is what a checksum is for
    expect(ibanChecksum('AT81000000000000000000')).toBe(false);
  });

  it('works past the safe integer, where the rearranged number is 36 digits', () => {
    expect(normaliseIban('mt31 0000 0000 0000 0000 0000 0000 000')).toHaveLength(31);
    expect(ibanChecksum('MT31000000000000000000000000000')).toBe(false);
  });
});

describe('validateEpc', () => {
  it('passes a complete payment', () => {
    expect(validateEpc(payment)).toEqual([]);
  });

  it('wants a beneficiary and an account', () => {
    expect(validateEpc({ name: '', iban: '' }).map((p) => [p.field, p.code])).toEqual([
      ['name', 'required'],
      ['iban', 'required'],
    ]);
  });

  it('names the reason an IBAN is refused', () => {
    const reason = (iban: string) => validateEpc({ ...payment, iban }).find((p) => p.field === 'iban')?.code;
    // a letter is legal in the body, a dash is not
    expect(reason('DE36 0000 0000 0000 0000 0-')).toBe('iban_characters');
    expect(reason('DE3600000000000000000')).toBe('iban_country_length');
    expect(reason('DE99000000000000000000')).toBe('iban_checksum');
    // a country we hold no length for still has to pass the checksum
    expect(reason('ZZ00000000000000')).toBe('iban_checksum');
  });

  it('takes a BIC of 8 or 11 characters and nothing between', () => {
    const bic = (value: string) => validateEpc({ ...payment, bic: value }).some((p) => p.field === 'bic');
    expect(bic('MUSTDEFFXXX')).toBe(false);
    expect(bic('MUSTDEFF')).toBe(false);
    expect(bic('MUSTDEFFX')).toBe(true);
    expect(bic('MUST1EFF')).toBe(true);
  });

  it('holds the amount to what the field can carry', () => {
    const code = (amount: unknown) =>
      validateEpc({ ...payment, amount: amount as number }).find((p) => p.field === 'amount')?.code;
    expect(code(0)).toBe('out_of_range');
    expect(code(0.01)).toBeUndefined();
    expect(code(999999999.99)).toBeUndefined();
    expect(code(1000000000)).toBe('out_of_range');
    expect(code('abc')).toBe('not_a_number');
    // a German amount as a person types it
    expect(code('1234,50')).toBeUndefined();
  });

  it('refuses a reference and a free text together, because the code carries one', () => {
    expect(validateEpc({ ...payment, text: 'Vielen Dank' }).map((p) => p.code)).toContain('reference_or_text');
    expect(validateEpc({ ...payment, reference: '', text: 'Vielen Dank' })).toEqual([]);
  });

  it('measures the whole payload in bytes, where an umlaut counts twice', () => {
    const long = { ...payment, reference: '', text: 'ä'.repeat(140) };
    const problem = validateEpc(long).find((p) => p.field === 'payload');
    expect(problem?.code).toBe('too_long');
    expect(problem?.max).toBe(EPC_MAX_BYTES);
    expect(validateEpc({ ...long, text: 'a'.repeat(140) }).find((p) => p.field === 'payload')).toBeUndefined();
  });
});
