/**
 * Value coercions small enough that a module may want them without the rest of the engine. They
 * live here rather than in `helpers/format.ts`, which pulls in date-fns, marked and n2words: the
 * landing site's GiroCode tool imports `lib/codes` in the browser and would otherwise carry all
 * three for the sake of one eight-line function.
 */

/** A number from whatever the data holds; `NaN` when it is not a number at all. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof value === 'bigint') return Number(value);
  return NaN;
}
