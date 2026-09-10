import type { HelperDefinition } from '../types';

/**
 * Comparisons and boolean logic (spec 05 §2). Jinja2 and Liquid have operators for these
 * (`{% if total > 1000 %}`); Handlebars has none, so without these a Handlebars template could not
 * show a discount above an amount at all. They are registered for every engine like every helper,
 * which also makes `{{ a | gt: b }}` work in Liquid.
 */

/** Equal by value, and by text so that `1` from the data equals `'1'` from the template. */
const same = (a: unknown, b: unknown): boolean =>
  a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

/** Numbers compare as numbers; anything else (ISO dates, names) as text. */
function compare(a: unknown, b: unknown): number {
  const x = typeof a === 'number' ? a : Number(a);
  const y = typeof b === 'number' ? b : Number(b);
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** An empty list is false, as in Handlebars' `{{#if}}` and Jinja2's `{% if %}`. */
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));

const comparison = (
  name: string,
  test: (a: unknown, b: unknown) => boolean,
  description: string,
): HelperDefinition => ({
  name,
  doc: {
    signature: `${name}(a, b)`,
    description,
    example: `{{#if (${name} invoice.total 1000)}}…{{/if}}`,
    category: 'logic',
  },
  fn: (_ctx, a, b) => test(a, b),
});

export const logicHelpers: HelperDefinition[] = [
  comparison('eq', same, 'True when both values are equal; `1` equals `"1"`.'),
  comparison('ne', (a, b) => !same(a, b), 'True when the values differ.'),
  comparison('gt', (a, b) => compare(a, b) > 0, 'Greater than; numbers as numbers, anything else as text.'),
  comparison('gte', (a, b) => compare(a, b) >= 0, 'Greater than or equal.'),
  comparison('lt', (a, b) => compare(a, b) < 0, 'Less than.'),
  comparison('lte', (a, b) => compare(a, b) <= 0, 'Less than or equal.'),
  {
    name: 'and',
    doc: {
      signature: 'and(a, b, …)',
      description: 'True when every value is true; an empty list counts as false.',
      example: '{{#if (and customer.vatId (eq country "DE"))}}…{{/if}}',
      category: 'logic',
    },
    fn: (_ctx, ...values) => values.length > 0 && values.every(truthy),
  },
  {
    name: 'or',
    doc: {
      signature: 'or(a, b, …)',
      description: 'True when any value is true.',
      example: '{{#if (or invoice.paid invoice.credited)}}…{{/if}}',
      category: 'logic',
    },
    fn: (_ctx, ...values) => values.some(truthy),
  },
  {
    name: 'not',
    doc: {
      signature: 'not(value)',
      description: 'The opposite truth value.',
      example: '{{#if (not invoice.paid)}}…{{/if}}',
      category: 'logic',
    },
    fn: (_ctx, value) => !truthy(value),
  },
];
