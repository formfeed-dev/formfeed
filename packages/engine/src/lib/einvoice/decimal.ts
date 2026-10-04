/**
 * Exact decimals for an invoice. Totals are compared to the cent and written into the XML as text,
 * so nothing here goes through floating-point arithmetic: a value is read once into its decimal
 * text and from there into a `bigint` of the smallest unit the comparison needs.
 */

/**
 * The decimal text of a JSON number or a numeric string, without an exponent and without trailing
 * zeros; `null` when it is not a plain decimal.
 *
 * A number is taken at fifteen significant digits, which is every digit a double holds exactly: a
 * request built with ordinary arithmetic sends `0.30000000000000004` for thirty cents, and refusing
 * that as "more than two decimals" would punish the language, not the invoice. A string is taken
 * as written, since whoever sends `"0.300000000000000004"` typed those digits.
 */
export function decimalText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return /^-?\d+(\.\d+)?$/.test(text) ? trimZeros(text) : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const text = value.toPrecision(15);
  return /^-?\d+(\.\d+)?$/.test(text) ? trimZeros(text) : null;
}

function trimZeros(text: string): string {
  const trimmed = text.includes('.')
    ? text.replace(/0+$/, '').replace(/\.$/, '')
    : text;
  return trimmed === '-0' ? '0' : trimmed;
}

/** How many decimal places a decimal text carries. */
export function decimalPlaces(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * A decimal text as an integer of `10^-scale` units. The text must not carry more places than
 * `scale`; callers check that first and name the field, because that is a finding about the data.
 */
export function toUnits(text: string, scale: number): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split(
    '.',
  );
  const units = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
  return negative ? -units : units;
}

/** Integer units back to decimal text with exactly `places` decimals (`376040n, 2` → `3760.40`). */
export function fromUnits(
  units: bigint,
  scale: number,
  places = scale,
): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).padEnd(places, '0');
  const text = places > 0 ? `${whole}.${fraction.slice(0, places)}` : whole;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/** A decimal text padded to at least `min` decimals, as the XML writes amounts (`3760.4` → `3760.40`). */
export function withPlaces(text: string, min: number): string {
  const places = decimalPlaces(text);
  if (places >= min) return text;
  return places === 0
    ? `${text}.${'0'.repeat(min)}`
    : text + '0'.repeat(min - places);
}

/** `value / divisor`, rounded half away from zero, as the standard rounds a VAT amount. */
export function divideRounded(value: bigint, divisor: bigint): bigint {
  const negative = value < 0n !== divisor < 0n;
  const a = value < 0n ? -value : value;
  const b = divisor < 0n ? -divisor : divisor;
  const quotient = (a * 2n + b) / (b * 2n);
  return negative ? -quotient : quotient;
}

export const abs = (value: bigint): bigint => (value < 0n ? -value : value);
