import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkInvoice,
  displayCheck,
  displayMissingText,
  shownAmounts,
  type Invoice,
} from './index';

function invoiceOf(
  name: string,
  change?: (invoice: Record<string, any>) => void,
): Invoice {
  const data = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'),
  );
  change?.(data);
  const check = checkInvoice(data);
  if (!check.ok) throw new Error(JSON.stringify(check.problems));
  return check.invoice;
}

// The characters a PDF's text really holds, by code point: typed as themselves they are invisible.
const NBSP = String.fromCharCode(0xa0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const MINUS = String.fromCharCode(0x2212);
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const APOSTROPHE = String.fromCharCode(0x2019);

const cents = (text: string): bigint[] =>
  [...shownAmounts(text)].sort((a, b) => (a < b ? -1 : 1));

describe('shownAmounts', () => {
  it('reads an amount in the German and in the English notation', () => {
    expect(cents('Gesamt 3.760,40 €')).toEqual([376040n]);
    expect(cents('Total 3,760.40 EUR')).toEqual([376040n]);
    expect(cents('1.234.567,89')).toEqual([123456789n]);
    expect(cents('1,234,567.89')).toEqual([123456789n]);
  });

  it('reads a number with one separator both ways, because the text does not say which it is', () => {
    // three thousand seven hundred and sixty, or three point seven six
    expect(cents('3.760')).toEqual([376n, 376000n]);
    expect(cents('3,760')).toEqual([376n, 376000n]);
    // two decimals can only be decimals
    expect(cents('600,40')).toEqual([60040n]);
    expect(cents('600.40')).toEqual([60040n]);
  });

  it('takes a space of any kind as a group separator', () => {
    for (const space of [' ', NBSP, NARROW_NBSP]) {
      expect(cents(`3${space}760,40`)).toContain(376040n);
      expect(cents(`1${space}234${space}567,89 €`)).toContain(123456789n);
    }
    // Chromium prints what Intl formats: a no-break space before the currency sign
    expect(cents(`3.760,40${NBSP}€`)).toEqual([376040n]);
  });

  it('reads a row of numbers as the row and as each number in it', () => {
    // a quantity and a price side by side: 8 and 120,00, which also reads as 8120,00
    expect(cents('8 120,00 €')).toEqual([800n, 12000n, 812000n]);
  });

  it('never joins numbers across a line break', () => {
    expect(cents('Seite 1\n234,56')).toEqual([100n, 23456n]);
    // an amount the layout broke in two is not an amount any more
    expect(cents('3.760,\n40')).toEqual([376n, 4000n, 376000n]);
  });

  it('ignores the sign, whichever character writes it', () => {
    expect(cents(`${MINUS}285,60 €`)).toEqual([28560n]);
    expect(cents('-285,60 €')).toEqual([28560n]);
  });

  it('reads Swiss grouping', () => {
    expect(cents("CHF 1'190.00")).toEqual([119000n]);
    expect(cents(`CHF 1${APOSTROPHE}190.00`)).toEqual([119000n]);
  });

  it('does not take a date, a postcode with a street number or an IBAN for an amount of the invoice', () => {
    expect(cents('10.09.2026')).toEqual([]);
    expect(cents('IBAN DE36 0000 0000 0000 0000 00').includes(376040n)).toBe(
      false,
    );
    // finer than a cent is not an amount of money
    expect(cents('0,335')).toEqual([33500n]);
    expect(cents('0.3351')).toEqual([]);
  });
});

describe('displayCheck', () => {
  const page = [
    'Fennlor Studio GmbH · Musterstraße 1 · 12345 Musterstadt',
    'Rechnung RE-2026-0042',
    'Datum 10.09.2026, fällig am 24.09.2026',
    'Consulting 8 120,00 € 960,00 €',
    'Implementation 20 110,00 € 2.200,00 €',
    `Netto 3.160,00${NBSP}€`,
    `USt. 19 % 600,40${NBSP}€`,
    `Gesamt 3.760,40${NBSP}€`,
    'Seite 1 von 1',
  ].join('\n');

  it('finds the number and the totals of a page that prints them', () => {
    const check = displayCheck(page, invoiceOf('simple'));
    expect(check.checked).toEqual(['BT-1', 'BT-109', 'BT-110', 'BT-112']);
    expect(check.missing).toEqual([]);
    expect(displayMissingText(check)).toBeNull();
  });

  it('finds them in an English page, and across pages', () => {
    const check = displayCheck(
      ['Invoice RE-2026-0042', 'Net 3,160.00\nVAT 600.40\nTotal EUR 3,760.40'],
      invoiceOf('simple'),
    );
    expect(check.missing).toEqual([]);
  });

  it('names what a page does not show', () => {
    // the template prints another field's number and adds the VAT up itself
    const other = page
      .replace('RE-2026-0042', '2026-0042')
      .replace('600,40', '600,00');
    const check = displayCheck(other, invoiceOf('simple'));
    expect(check.missing).toEqual(['BT-1', 'BT-110']);
    expect(check.values.filter((value) => !value.shown)).toEqual([
      { term: 'BT-1', path: 'number', value: 'RE-2026-0042', shown: false },
      {
        term: 'BT-110',
        path: 'totals.tax_total',
        value: '600.40',
        shown: false,
      },
    ]);
    expect(displayMissingText(check)).toBe(
      'The PDF does not show the invoice number RE-2026-0042 (BT-1) and the VAT total 600.40 (BT-110) of the e-invoice',
    );
  });

  it('matches the invoice number whatever the typesetting did to it', () => {
    const invoice = invoiceOf('simple');
    const shown = (text: string): boolean =>
      !displayCheck(
        `${text}\n3.160,00 600,40 3.760,40`,
        invoice,
      ).missing.includes('BT-1');
    expect(shown('RECHNUNG RE-2026-0042')).toBe(true);
    expect(shown('Rechnung re-2026-0042')).toBe(true);
    // letter-spaced, broken over two lines, set with a non-breaking hyphen, hyphenated softly
    expect(shown('R E - 2 0 2 6 - 0 0 4 2')).toBe(true);
    expect(shown('Rechnung RE-2026-\n0042')).toBe(true);
    expect(
      shown(`RE${NON_BREAKING_HYPHEN}2026${NON_BREAKING_HYPHEN}0042`),
    ).toBe(true);
    expect(shown(`RE-2026${SOFT_HYPHEN}-0042`)).toBe(true);
    expect(shown('Rechnung 2026-0042')).toBe(false);
  });

  it('skips amounts that are zero: a page need not print 0,00', () => {
    const check = displayCheck(
      'Rechnung RE-2026-0051\nNetto 3.800,00 €',
      invoiceOf('reverse-charge'),
    );
    // net total and total are the same 3800.00; the VAT total is zero and not looked for
    expect(check.checked).toEqual(['BT-1', 'BT-109', 'BT-112']);
    expect(check.missing).toEqual([]);
  });

  it('looks for the amount due only where it differs from the total', () => {
    const invoice = invoiceOf('allowance-charge');
    const check = displayCheck('RE-2026-0060 211,30 40,15 251,45', invoice);
    expect(check.checked).toEqual([
      'BT-1',
      'BT-109',
      'BT-110',
      'BT-112',
      'BT-115',
    ]);
    expect(check.missing).toEqual(['BT-115']);
    expect(
      displayCheck('RE-2026-0060 211,30 40,15 251,45 201,45', invoice).missing,
    ).toEqual([]);
  });

  it('looks for each VAT amount where there is more than one rate', () => {
    const invoice = invoiceOf('multi-rate');
    const check = displayCheck(
      'RE-2026-0043 1.294,60 235,21 1.529,81 6,28',
      invoice,
    );
    expect(check.checked).toEqual([
      'BT-1',
      'BT-109',
      'BT-110',
      'BT-112',
      'BT-117',
    ]);
    expect(check.missing).toEqual(['BT-117']);
    expect(check.values.find((value) => !value.shown)).toMatchObject({
      path: 'tax.breakdown[1].amount',
      value: '228.93',
    });
  });

  it("finds a credit note's amounts printed as negative", () => {
    const check = displayCheck(
      `Gutschrift GS-2026-0007\nNetto ${MINUS}240,00 €\nUSt. ${MINUS}45,60 €\nGesamt ${MINUS}285,60 €`,
      invoiceOf('credit-note'),
    );
    expect(check.missing).toEqual([]);
  });

  it('finds French amounts as Intl writes them', () => {
    const check = displayCheck(
      `Facture FA-2026-0015\nTotal HT 1${NARROW_NBSP}020,00${NBSP}€\nTVA 20 % 204,00${NBSP}€\nTotal TTC 1${NARROW_NBSP}224,00${NBSP}€`,
      invoiceOf('france-domestic'),
    );
    expect(check.missing).toEqual([]);
  });
});
