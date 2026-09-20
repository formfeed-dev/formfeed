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
      examples: {
        jinja2: "{{ invoice.lines | sum('total') | money }}",
        liquid: "{{ invoice.lines | sum: 'total' | money }}",
        handlebars: "{{money (sum invoice.lines 'total')}}",
      },
      category: 'collection',
    },
    fn: (_ctx, value, path?) => numbers(value, path).reduce((a, b) => a + b, 0),
  },
  {
    name: 'avg',
    doc: {
      signature: 'avg(list, path?)',
      description: 'Average of the items or of `path` inside each item.',
      examples: {
        jinja2: '{{ scores | avg | number(1) }}',
        liquid: '{{ scores | avg | number: 1 }}',
        handlebars: '{{number (avg scores) 1}}',
      },
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
      examples: {
        jinja2: '{{ prices | min }}',
        liquid: '{{ prices | min }}',
        handlebars: '{{min prices}}',
      },
      category: 'collection',
    },
    fn: (_ctx, value, path?) => Math.min(...numbers(value, path)),
  },
  {
    name: 'max',
    doc: {
      signature: 'max(list, path?)',
      description: 'Largest number.',
      examples: {
        jinja2: '{{ prices | max }}',
        liquid: '{{ prices | max }}',
        handlebars: '{{max prices}}',
      },
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
      examples: {
        jinja2: "{% for group in lines | groupBy('category') %}{{ group.key }}{% endfor %}",
        liquid: "{% assign groups = lines | groupBy: 'category' %}{% for group in groups %}{{ group.key }}{% endfor %}",
        handlebars: "{{#each (groupBy lines 'category')}}{{key}}{{/each}}",
      },
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
      examples: {
        jinja2: "{% for l in lines | sortBy('position') %}{{ l.sku }}{% endfor %}",
        liquid: "{% assign sorted = lines | sortBy: 'position' %}{% for l in sorted %}{{ l.sku }}{% endfor %}",
        handlebars: "{{#each (sortBy lines 'position')}}{{sku}}{{/each}}",
      },
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
      examples: {
        jinja2: "{% for l in lines | where('taxable', true) %}{{ l.sku }}{% endfor %}",
        liquid: "{% assign taxable = lines | where: 'taxable', true %}{% for l in taxable %}{{ l.sku }}{% endfor %}",
        handlebars: "{{#each (where lines 'taxable' true)}}{{sku}}{{/each}}",
      },
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
      examples: {
        jinja2: "{{ lines | pluck('sku') | join(', ') }}",
        liquid: "{{ lines | pluck: 'sku' | join: ', ' }}",
        handlebars: "{{join (pluck lines 'sku') ', '}}",
      },
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
      examples: {
        jinja2: "{% for row in labels | chunk(3) %}{{ row | join(', ') }}{% endfor %}",
        liquid: "{% assign rows = labels | chunk: 3 %}{% for row in rows %}{{ row | join: ', ' }}{% endfor %}",
        handlebars: "{{#each (chunk labels 3)}}{{join this ', '}}{{/each}}",
      },
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
      examples: {
        jinja2: '{% for i in range(1, 4) %}{{ i }}{% endfor %}',
        liquid: '{% assign nums = 1 | range: 4 %}{% for i in nums %}{{ i }}{% endfor %}',
        handlebars: '{{#each (range 1 4)}}{{this}}{{/each}}',
      },
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
      examples: {
        jinja2: '{{ tags | first }}',
        liquid: '{{ tags | first }}',
        handlebars: '{{first tags}}',
      },
      category: 'collection',
    },
    fn: (_ctx, value) => list(value)[0],
  },
  {
    name: 'last',
    doc: {
      signature: 'last(list)',
      description: 'Last item.',
      examples: {
        jinja2: '{{ tags | last }}',
        liquid: '{{ tags | last }}',
        handlebars: '{{last tags}}',
      },
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
      examples: {
        jinja2: '{{ lines | length }}',
        liquid: '{{ lines | length }}',
        handlebars: '{{length lines}}',
      },
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
