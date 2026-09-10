import type { HelperDefinition } from '../types';
import { toNumber } from './format';

const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const get = (item: unknown, path: unknown): unknown =>
  String(path ?? '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      item,
    );
const numbers = (v: unknown, path?: unknown): number[] =>
  list(v)
    .map((item) => toNumber(path ? get(item, path) : item))
    .filter((n) => !Number.isNaN(n));

export const collectionHelpers: HelperDefinition[] = [
  {
    name: 'sum',
    doc: {
      signature: 'sum(list, path?)',
      description: 'Sum of the items, or of `path` inside each item.',
      example: "{{ invoice.lines | sum('total') | money }}",
      category: 'collection',
    },
    fn: (_ctx, value, path?) => numbers(value, path).reduce((a, b) => a + b, 0),
  },
  {
    name: 'avg',
    doc: {
      signature: 'avg(list, path?)',
      description: 'Average of the items or of `path` inside each item.',
      example: '{{ scores | avg | number(1) }}',
      category: 'collection',
    },
    fn: (_ctx, value, path?) => {
      const ns = numbers(value, path);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
    },
  },
  {
    name: 'min',
    doc: {
      signature: 'min(list, path?)',
      description: 'Smallest number.',
      example: '{{ prices | min }}',
      category: 'collection',
    },
    fn: (_ctx, value, path?) => Math.min(...numbers(value, path)),
  },
  {
    name: 'max',
    doc: {
      signature: 'max(list, path?)',
      description: 'Largest number.',
      example: '{{ prices | max }}',
      category: 'collection',
    },
    fn: (_ctx, value, path?) => Math.max(...numbers(value, path)),
  },
  {
    name: 'groupBy',
    aliases: ['group_by', 'groupby'],
    doc: {
      signature: 'groupBy(list, path)',
      description:
        'Groups items by a field; returns a list of `{ key, items }`.',
      example:
        "{% for group in lines | groupBy('category') %}{{ group.key }}{% endfor %}",
      category: 'collection',
    },
    fn: (_ctx, value, path) => {
      const groups = new Map<string, unknown[]>();
      for (const item of list(value)) {
        const key = String(get(item, path) ?? '');
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      return [...groups.entries()].map(([key, items]) => ({ key, items }));
    },
  },
  {
    name: 'sortBy',
    aliases: ['sort_by', 'sort'],
    doc: {
      signature: "sortBy(list, path?, direction = 'asc')",
      description:
        'Sorts items by a field (numbers numerically, strings by locale).',
      example: "{% for l in lines | sortBy('position') %}",
      category: 'collection',
    },
    fn: (ctx, value, path?, direction?) => {
      const dir = String(direction ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
      const collator = new Intl.Collator(ctx.locale, { numeric: true });
      return [...list(value)].sort((a, b) => {
        const x = path ? get(a, path) : a;
        const y = path ? get(b, path) : b;
        if (typeof x === 'number' && typeof y === 'number')
          return (x - y) * dir;
        return collator.compare(String(x ?? ''), String(y ?? '')) * dir;
      });
    },
  },
  {
    name: 'where',
    aliases: ['filter_by'],
    doc: {
      signature: 'where(list, path, value?)',
      description:
        'Keeps items whose field equals `value` (or is truthy when omitted).',
      example: "{% for l in lines | where('taxable', true) %}",
      category: 'collection',
    },
    fn: (_ctx, value, path, expected?) =>
      list(value).filter((item) => {
        const v = get(item, path);
        return expected === undefined
          ? Boolean(v)
          : v === expected || String(v) === String(expected);
      }),
  },
  {
    name: 'pluck',
    aliases: ['map'],
    doc: {
      signature: 'pluck(list, path)',
      description: 'Extracts one field from every item.',
      example: "{{ lines | pluck('sku') | join(', ') }}",
      category: 'collection',
    },
    fn: (_ctx, value, path) => list(value).map((item) => get(item, path)),
  },
  {
    name: 'chunk',
    aliases: ['batch'],
    doc: {
      signature: 'chunk(list, size)',
      description:
        'Splits a list into lists of `size` items (rows of labels, columns).',
      example: '{% for row in labels | chunk(3) %}',
      category: 'collection',
    },
    fn: (_ctx, value, size) => {
      const n = Math.max(1, toNumber(size) || 1);
      const items = list(value);
      const out: unknown[][] = [];
      for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
      return out;
    },
  },
  {
    name: 'range',
    doc: {
      signature: 'range(start, end?, step = 1)',
      description: 'List of numbers from start to end (exclusive).',
      example: '{% for i in range(1, 4) %}',
      category: 'collection',
    },
    fn: (_ctx, start, end?, step?) => {
      let from = toNumber(start);
      const to = end === undefined || end === null ? from : toNumber(end);
      if (end === undefined || end === null) from = 0;
      const by = toNumber(step) || 1;
      const out: number[] = [];
      for (let i = from; by > 0 ? i < to : i > to; i += by) out.push(i);
      return out;
    },
  },
  {
    name: 'first',
    doc: {
      signature: 'first(list)',
      description: 'First item.',
      example: '{{ lines | first }}',
      category: 'collection',
    },
    fn: (_ctx, value) => list(value)[0],
  },
  {
    name: 'last',
    doc: {
      signature: 'last(list)',
      description: 'Last item.',
      example: '{{ lines | last }}',
      category: 'collection',
    },
    fn: (_ctx, value) => list(value).at(-1),
  },
  {
    name: 'length',
    aliases: ['size', 'count'],
    doc: {
      signature: 'length(value)',
      description:
        'Number of items in a list, keys in an object or characters in a string.',
      example: '{{ lines | length }}',
      category: 'collection',
    },
    fn: (_ctx, value) =>
      Array.isArray(value) || typeof value === 'string'
        ? value.length
        : value && typeof value === 'object'
          ? Object.keys(value).length
          : 0,
  },
];
