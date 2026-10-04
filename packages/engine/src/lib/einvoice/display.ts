import type { Invoice } from './check';
import { abs, toUnits, withPlaces } from './decimal';

/**
 * The display check (spec 17 §5.2). In a hybrid invoice the XML is the invoice, and a PDF that shows
 * other details can count as a second one. Nothing makes a template print `_invoice`: one that adds
 * up its own totals, or shows another field's number, renders without complaint. So the text of the
 * finished PDF is searched for what the XML says: the invoice number and the totals.
 *
 * It finds a value that is missing, not a wrong one printed beside the right one. It is a net, not
 * a proof, and it errs towards "shown": signs are ignored, because a credit note prints as negative
 * what its XML states as positive, and a number counts in either notation, `1.234,56` or `1,234.56`.
 *
 * One function for the worker (the text the sidecar extracts), the editor (the preview's text) and
 * the CLI, so all three agree on what "shown" means.
 */

export interface DisplayValue {
  /** The business term of EN 16931, `BT-112`. */
  term: string;
  /** Where the value sits in `_invoice`. */
  path: string;
  /** The value as the XML states it. */
  value: string;
  shown: boolean;
}

export interface DisplayCheck {
  /** The terms that were looked for, in the order they were checked. */
  checked: string[];
  /** Those of them the text does not show. */
  missing: string[];
  values: DisplayValue[];
}

/** What a term is called where a message names it. */
export const DISPLAY_TERMS: Record<string, string> = {
  'BT-1': 'invoice number',
  'BT-109': 'net total',
  'BT-110': 'VAT total',
  'BT-112': 'total',
  'BT-115': 'amount due',
  'BT-117': 'VAT amount',
};

// Code points rather than characters or escapes: half of these are invisible in an editor.
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const DOT = 0x2e;
const COMMA = 0x2c;
/** Group separators that are a space: the ordinary one, no-break, narrow no-break (`Intl` writes it for French), thin. */
const SPACES = new Set([0x20, 0xa0, 0x202f, 0x2009]);
/** Swiss amounts group with an apostrophe, straight or typographic. */
const APOSTROPHES = new Set([0x27, 0x2019]);
/** Hyphens and dashes a number or an invoice number may be typeset with, and the real minus sign. */
const DASHES = new Set([0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2212]);
/** Characters that are in the text and not on the page: soft hyphen, zero-width spaces and joiners. */
const INVISIBLE = new Set([0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

const isDigit = (code: number): boolean => code >= DIGIT_0 && code <= DIGIT_9;

/** At most this many groups are read as one number; more is a row of numbers, not an amount. */
const MAX_GROUPS = 6;

/**
 * Every amount the text shows, in cents and without its sign. A run of digits and separators is
 * read each way it can be read: `3.760` is three thousand seven hundred and sixty and also three
 * point seven six, and `8 120,00` is both that number and `120,00` after an `8`. A line break never
 * joins two numbers, so a page number above a total does not become part of it.
 */
export function shownAmounts(text: string): Set<bigint> {
  const found = new Set<bigint>();
  let run = '';
  const flush = (): void => {
    // a run ends with a digit: what follows the last one is punctuation of the sentence
    const trimmed = run.replace(/[^0-9]+$/, '');
    run = '';
    if (!trimmed) return;
    const parts = trimmed
      .split(' ')
      // "3, 5" is a three, a comma of the sentence, and a five
      .map((part) => part.replace(/[.,]+$/, ''))
      .filter((part) => part !== '');
    for (let start = 0; start < parts.length; start += 1) {
      for (const cents of readings(parts[start] ?? '')) found.add(cents);
      const first = parts[start] ?? '';
      if (!/^\d{1,3}$/.test(first)) continue;
      let whole = first;
      for (
        let end = start + 1;
        end < parts.length && end - start < MAX_GROUPS;
        end += 1
      ) {
        const part = parts[end] ?? '';
        const last = /^(\d{3})(?:[.,](\d+))?$/.exec(part);
        if (!last) break;
        const cents = toCents(whole + last[1], last[2] ?? '');
        if (cents !== null) found.add(cents);
        // a group with decimals ends the number; a bare group may be followed by another
        if (last[2] !== undefined) break;
        whole += last[1];
      }
    }
  };
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (INVISIBLE.has(code)) continue;
    if (isDigit(code)) run += character;
    else if (run && (code === DOT || code === COMMA)) run += character;
    else if (run && SPACES.has(code)) run += ' ';
    // an apostrophe groups and nothing else, so it is simply taken out
    else if (run && APOSTROPHES.has(code)) continue;
    else flush();
  }
  flush();
  return found;
}

/** One stretch without spaces, read with the dot as the decimal sign and with the comma. */
function readings(part: string): bigint[] {
  if (/^\d+$/.test(part)) {
    const cents = toCents(part, '');
    return cents === null ? [] : [cents];
  }
  const out: bigint[] = [];
  for (const [group, decimal] of [
    ['.', ','],
    [',', '.'],
  ] as const) {
    const pieces = part.split(decimal);
    if (pieces.length > 2) continue;
    const [whole = '', fraction] = pieces;
    if (fraction !== undefined && !/^\d+$/.test(fraction)) continue;
    const groups = whole.split(group);
    const grouped = groups.every(
      (digits, index) =>
        /^\d+$/.test(digits) &&
        (index === 0
          ? groups.length === 1 || digits.length <= 3
          : digits.length === 3),
    );
    if (!grouped) continue;
    const cents = toCents(groups.join(''), fraction ?? '');
    if (cents !== null) out.push(cents);
  }
  return out;
}

/** Whole digits and fraction digits as cents; `null` for a value finer than a cent or absurdly long. */
function toCents(whole: string, fraction: string): bigint | null {
  if (whole.length > 18 || /[1-9]/.test(fraction.slice(2))) return null;
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

/**
 * Text as it is compared for the invoice number: no whitespace at all, one kind of dash, one case.
 * A heading in capitals, a number broken over two lines or spaced out by letter-spacing still match.
 */
function squeeze(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (INVISIBLE.has(code) || /\s/.test(character) || SPACES.has(code))
      continue;
    out += DASHES.has(code) ? '-' : character.toLowerCase();
  }
  return out;
}

/** The text of a PDF (one string, or one per page) against the invoice its XML states. */
export function displayCheck(
  text: string | readonly string[],
  invoice: Invoice,
): DisplayCheck {
  // pages are joined by a line break, which keeps a number at the foot of one page apart from the
  // first of the next
  const whole = typeof text === 'string' ? text : text.join('\n');
  const amounts = shownAmounts(whole);
  const squeezed = squeeze(whole);
  const values: DisplayValue[] = [];

  values.push({
    term: 'BT-1',
    path: 'number',
    value: invoice.number,
    shown: squeezed.includes(squeeze(invoice.number)),
  });

  const amount = (term: string, path: string, value: string): void => {
    const cents = abs(toUnits(value, 2));
    // a template need not print "0,00"
    if (cents === 0n) return;
    values.push({
      term,
      path,
      // as the XML writes it and a reader expects it: `3760.40`, not `3760.4`
      value: withPlaces(value, 2),
      shown: amounts.has(cents),
    });
  };
  const { totals } = invoice;
  amount('BT-109', 'totals.tax_basis', totals.tax_basis);
  amount('BT-110', 'totals.tax_total', totals.tax_total);
  amount('BT-112', 'totals.grand', totals.grand);
  if (toUnits(totals.due, 2) !== toUnits(totals.grand, 2))
    amount('BT-115', 'totals.due', totals.due);
  if (invoice.breakdown.length > 1)
    invoice.breakdown.forEach((row, index) =>
      amount('BT-117', `tax.breakdown[${index}].amount`, row.amount),
    );

  const unique = (terms: string[]): string[] => [...new Set(terms)];
  return {
    checked: unique(values.map((value) => value.term)),
    missing: unique(
      values.filter((value) => !value.shown).map((value) => value.term),
    ),
    values,
  };
}

/** The values a check did not find, as one sentence for a problem or a warning; `null` when all are shown. */
export function displayMissingText(check: DisplayCheck): string | null {
  const missing = check.values.filter((value) => !value.shown);
  if (missing.length === 0) return null;
  const named = missing.map(
    (value) =>
      `the ${DISPLAY_TERMS[value.term] ?? value.term} ${value.value} (${value.term})`,
  );
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `The PDF does not show ${list} of the e-invoice`;
}
