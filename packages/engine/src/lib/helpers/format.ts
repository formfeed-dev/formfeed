import { TZDate } from '@date-fns/tz';
import { add, format as formatDate, isValid, parseISO } from 'date-fns';
import { de, enGB, enUS, es, fr, it, nl } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';
import { marked } from 'marked';
import { toCardinal as deWords } from 'n2words/de';
import { toCardinal as enWords } from 'n2words/en';
import { toCardinal as esWords } from 'n2words/es';
import { toCardinal as frWords } from 'n2words/fr';
import { toCardinal as itWords } from 'n2words/it';
import { toCardinal as nlWords } from 'n2words/nl';
import type { HelperContext, HelperDefinition } from '../types';
import { toNumber } from '../values';
import { officeUnsupported } from './office';

// `toNumber` moved to `lib/values.ts` so the browser-only code entry can have it without date-fns
export { toNumber };

const dateLocales: Record<string, DateFnsLocale> = {
  de,
  en: enGB,
  'en-GB': enGB,
  'en-US': enUS,
  fr,
  es,
  it,
  nl,
};

function dateLocale(locale: string): DateFnsLocale {
  return dateLocales[locale] ?? dateLocales[locale.split('-')[0] ?? ''] ?? enGB;
}

export function toDate(value: unknown, tz: string): Date | null {
  if (value === 'now' || value === undefined || value === null || value === '')
    return new TZDate(Date.now(), tz);
  if (value instanceof Date) return new TZDate(value.getTime(), tz);
  if (typeof value === 'number')
    return new TZDate(value < 1e12 ? value * 1000 : value, tz);
  if (typeof value === 'string') {
    const iso = parseISO(value);
    if (isValid(iso)) {
      // date-only strings are calendar dates in the render timezone, not UTC midnight
      return /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new TZDate(iso.getFullYear(), iso.getMonth(), iso.getDate(), tz)
        : new TZDate(iso.getTime(), tz);
    }
    const parsed = new Date(value);
    if (isValid(parsed)) return new TZDate(parsed.getTime(), tz);
  }
  return null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A trailing object of named arguments: Jinja2 keywords, Liquid keyword arguments, a Handlebars hash. */
const isNamedArgs = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

const str = (v: unknown): string =>
  v === undefined || v === null ? '' : String(v);
const opt = <T>(v: unknown, fallback: T): T =>
  v === undefined || v === null || v === '' ? fallback : (v as T);

/**
 * A number that is not one — `NaN` or infinity, what arithmetic on text or on a missing value
 * returns — stops the render rather than printing "NaN" on a document. Text that is not a number
 * still passes through as text, so a price column can say "on request".
 */
function requireFinite(helper: string, value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error(`${helper}: got ${value}, the result of a calculation with a value that is missing or not a number`);
}

const wordsByLang: Record<string, (n: number | string | bigint) => string> = {
  de: deWords,
  en: enWords,
  es: esWords,
  fr: frWords,
  it: itWords,
  nl: nlWords,
};

export const formatHelpers: HelperDefinition[] = [
  {
    name: 'money',
    aliases: ['currency'],
    deprecatedAlias: { currency_format: 'money' },
    doc: {
      signature: 'money(value, currency?, locale?)',
      description:
        'Formats a number as currency with Intl.NumberFormat. Defaults come from the template settings. Text that is not a number is printed as it is; a calculation that came out as NaN stops the render.',
      examples: {
        jinja2: "{{ line.total | money('EUR') }} → 1.234,50 €",
        liquid: "{{ line.total | money: 'EUR' }} → 1.234,50 €",
        handlebars: "{{money line.total 'EUR'}} → 1.234,50 €",
      },
      category: 'format',
    },
    fn: (ctx: HelperContext, value, currency?, locale?) => {
      requireFinite('money', value);
      const n = toNumber(value);
      if (Number.isNaN(n)) return str(value);
      return new Intl.NumberFormat(opt(locale, ctx.locale), {
        style: 'currency',
        currency: opt(currency, ctx.currency),
      }).format(n);
    },
  },
  {
    name: 'number',
    doc: {
      signature: 'number(value, decimals?, locale?)',
      description:
        'Formats a number with grouping. With decimals, exactly that many (rounded half away from zero); without, the decimals the number has, at most three, so 1234.5 → 1.234,5 and 2.34567 → 2,346. Use number(0) for whole numbers.',
      examples: {
        jinja2: '{{ qty | number(2) }} → 1.234,00',
        liquid: '{{ qty | number: 2 }} → 1.234,00',
        handlebars: '{{number qty 2}} → 1.234,00',
      },
      category: 'format',
    },
    fn: (ctx, value, decimals?, locale?) => {
      requireFinite('number', value);
      const n = toNumber(value);
      if (Number.isNaN(n)) return str(value);
      const d =
        decimals === undefined || decimals === null
          ? undefined
          : Number(decimals);
      return new Intl.NumberFormat(opt(locale, ctx.locale), {
        minimumFractionDigits: d,
        maximumFractionDigits: d ?? 3,
      }).format(n);
    },
  },
  {
    name: 'date',
    doc: {
      signature: 'date(value, format?, tz?, locale?)',
      description:
        "Formats a date with date-fns tokens (e.g. 'dd.MM.yyyy', 'PPP'). Accepts ISO strings, epoch numbers and 'now'.",
      examples: {
        jinja2: "{{ invoice.date | date('dd.MM.yyyy') }}",
        liquid: "{{ invoice.date | date: 'dd.MM.yyyy' }}",
        handlebars: "{{date invoice.date 'dd.MM.yyyy'}}",
      },
      category: 'format',
    },
    fn: (ctx, value, format?, tz?, locale?) => {
      const d = toDate(value, opt(tz, ctx.timezone));
      if (!d) return str(value);
      return formatDate(d, opt(format, 'PP'), {
        locale: dateLocale(opt(locale, ctx.locale)),
      });
    },
  },
  {
    name: 'dateAdd',
    aliases: ['date_add'],
    doc: {
      signature: 'dateAdd(value, amount, unit)',
      description:
        'Adds days, weeks, months or years to a date; returns an ISO string for further formatting.',
      examples: {
        jinja2: "{{ invoice.date | dateAdd(14, 'days') | date('PP') }}",
        liquid: "{{ invoice.date | dateAdd: 14, 'days' | date: 'PP' }}",
        handlebars: "{{date (dateAdd invoice.date 14 'days') 'PP'}}",
      },
      category: 'format',
    },
    fn: (ctx, value, amount, unit) => {
      const d = toDate(value, ctx.timezone);
      if (!d) return str(value);
      const n = toNumber(amount);
      const u = str(unit || 'days').replace(/s?$/, 's') as
        'days' | 'weeks' | 'months' | 'years' | 'hours' | 'minutes';
      return add(d, { [u]: n }).toISOString();
    },
  },
  {
    name: 'add',
    aliases: ['plus'],
    doc: {
      signature: 'add(a, b)',
      description: 'a + b (Handlebars has no arithmetic of its own).',
      examples: {
        jinja2: '{{ line.qty | add(1) }}',
        liquid: '{{ line.qty | add: 1 }}',
        handlebars: '{{#each invoice.lines}}{{add @index 1}}{{/each}}',
      },
      category: 'format',
    },
    fn: (_ctx, a, b) => toNumber(a) + toNumber(b),
  },
  {
    name: 'subtract',
    aliases: ['minus', 'sub'],
    doc: {
      signature: 'subtract(a, b)',
      description: 'a minus b.',
      examples: {
        jinja2: '{{ total | subtract(discount) }}',
        liquid: '{{ total | subtract: discount }}',
        handlebars: '{{subtract total discount}}',
      },
      category: 'format',
    },
    fn: (_ctx, a, b) => toNumber(a) - toNumber(b),
  },
  {
    name: 'multiply',
    aliases: ['times', 'mul'],
    doc: {
      signature: 'multiply(a, b)',
      description: 'a times b.',
      examples: {
        jinja2: '{{ line.qty | multiply(line.price) | money }}',
        liquid: '{{ line.qty | multiply: line.price | money }}',
        handlebars: '{{money (multiply line.qty line.price)}}',
      },
      category: 'format',
    },
    fn: (_ctx, a, b) => toNumber(a) * toNumber(b),
  },
  {
    name: 'divide',
    aliases: ['divided_by', 'div'],
    doc: {
      signature: 'divide(a, b)',
      description: 'a divided by b; empty when b is 0.',
      examples: {
        jinja2: '{{ total | divide(count) }}',
        liquid: '{{ total | divide: count }}',
        handlebars: '{{divide total count}}',
      },
      category: 'format',
    },
    fn: (_ctx, a, b) => (toNumber(b) === 0 ? '' : toNumber(a) / toNumber(b)),
  },
  {
    name: 'round',
    doc: {
      signature: "round(value, decimals = 0, method = 'common')",
      description:
        "Rounds to the given decimals, as Jinja2's round does: 'common' rounds half away from zero, 'floor' always down and 'ceil' always up.",
      examples: {
        jinja2: "{{ 2.345 | round(2) }} gives 2.35, {{ 2.349 | round(2, 'floor') }} gives 2.34",
        liquid: "{{ 2.345 | round: 2 }} gives 2.35, {{ 2.349 | round: 2, 'floor' }} gives 2.34",
        handlebars: "{{round 2.345 2}} gives 2.35, {{round 2.349 2 'floor'}} gives 2.34",
      },
      category: 'format',
    },
    // `round(2, method='floor')` (Jinja2) and `round: 2, method: 'floor'` (Liquid) arrive as a
    // trailing object, as does a Handlebars hash
    fn: (_ctx, value, ...args) => {
      const n = toNumber(value);
      if (Number.isNaN(n)) return '';
      const named = (args.find(isNamedArgs) ?? {}) as Record<string, unknown>;
      const [decimals, method] = args.filter((a) => !isNamedArgs(a));
      const places = Number(opt(decimals, opt(named['precision'], opt(named['decimals'], 0))));
      const how = String(opt(method, opt(named['method'], 'common')));
      const f = 10 ** places;
      // `2.3 * 100` is 229.99999999999997: the product is cleaned before it is cut
      const scaled = Number((Math.abs(n) * f).toPrecision(15));
      if (how === 'floor') return (n < 0 ? -Math.ceil(scaled) : Math.floor(scaled)) / f;
      if (how === 'ceil') return (n < 0 ? -Math.floor(scaled) : Math.ceil(scaled)) / f;
      if (how !== 'common') throw new Error(`round: method must be 'common', 'floor' or 'ceil', not '${how}'`);
      return (Math.round(scaled + Number.EPSILON) / f) * Math.sign(n);
    },
  },
  {
    name: 'upper',
    aliases: ['upcase'],
    doc: {
      signature: 'upper(value)',
      description: 'Upper-cases a string.',
      examples: {
        jinja2: '{{ name | upper }}',
        liquid: '{{ name | upper }}',
        handlebars: '{{upper name}}',
      },
      category: 'text',
    },
    fn: (_ctx, value) => str(value).toUpperCase(),
  },
  {
    name: 'lower',
    aliases: ['downcase'],
    doc: {
      signature: 'lower(value)',
      description: 'Lower-cases a string.',
      examples: {
        jinja2: '{{ name | lower }}',
        liquid: '{{ name | lower }}',
        handlebars: '{{lower name}}',
      },
      category: 'text',
    },
    fn: (_ctx, value) => str(value).toLowerCase(),
  },
  {
    name: 'title',
    aliases: ['capitalize_words'],
    doc: {
      signature: 'title(value)',
      description: 'Capitalises every word.',
      examples: {
        jinja2: "{{ 'hello world' | title }} → Hello World",
        liquid: "{{ 'hello world' | title }} → Hello World",
        handlebars: "{{title 'hello world'}} → Hello World",
      },
      category: 'text',
    },
    fn: (_ctx, value) =>
      str(value).replace(
        /\p{L}[\p{L}\p{M}]*/gu,
        (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
      ),
  },
  {
    name: 'truncate',
    doc: {
      signature: "truncate(value, length = 255, suffix = '…')",
      description:
        'Cuts a string to `length` characters and appends the suffix when cut.',
      examples: {
        jinja2: '{{ description | truncate(40) }}',
        liquid: '{{ description | truncate: 40 }}',
        handlebars: '{{truncate description 40}}',
      },
      category: 'text',
    },
    fn: (_ctx, value, length?, suffix?) => {
      const s = str(value);
      const max = opt(Number(length), 255);
      const end = opt(suffix, '…');
      return s.length <= max
        ? s
        : s.slice(0, Math.max(0, max - end.length)) + end;
    },
  },
  {
    name: 'replace',
    doc: {
      signature: 'replace(value, search, replacement)',
      description: 'Replaces every occurrence of `search`.',
      examples: {
        jinja2: "{{ iban | replace(' ', '') }}",
        liquid: "{{ iban | replace: ' ', '' }}",
        handlebars: "{{replace iban ' ' ''}}",
      },
      category: 'text',
    },
    fn: (_ctx, value, search, replacement?) =>
      str(value).split(str(search)).join(str(replacement)),
  },
  {
    name: 'split',
    doc: {
      signature: "split(value, separator = ',')",
      description: 'Splits a string into a list.',
      examples: {
        jinja2: "{% for tag in keywords | split(',') %}{{ tag }}{% endfor %}",
        liquid: "{% assign tags = keywords | split: ',' %}{% for tag in tags %}{{ tag }}{% endfor %}",
        handlebars: "{{#each (split keywords ',')}}{{this}}{{/each}}",
      },
      category: 'text',
    },
    fn: (_ctx, value, separator?) => str(value).split(str(opt(separator, ','))),
  },
  {
    name: 'join',
    doc: {
      signature: "join(list, separator = ', ')",
      description: 'Joins a list into a string.',
      examples: {
        jinja2: "{{ tags | join(' · ') }}",
        liquid: "{{ tags | join: ' · ' }}",
        handlebars: "{{join tags ' · '}}",
      },
      category: 'collection',
    },
    fn: (_ctx, value, separator?) =>
      Array.isArray(value)
        ? value.map(str).join(str(opt(separator, ', ')))
        : str(value),
  },
  {
    name: 'default',
    aliases: ['d'],
    doc: {
      signature: 'default(value, fallback)',
      description:
        'Returns the fallback when the value is empty, null or undefined.',
      examples: {
        jinja2: "{{ customer.vat | default('—') }}",
        liquid: "{{ customer.vat | default: '—' }}",
        handlebars: "{{default customer.vat '—'}}",
      },
      category: 'text',
    },
    fn: (_ctx, value, fallback?) =>
      value === undefined || value === null || value === '' ? fallback : value,
  },
  {
    name: 'nl2br',
    html: true,
    doc: {
      signature: 'nl2br(value)',
      description: 'Escapes the text and turns line breaks into <br>.',
      examples: {
        jinja2: '{{ address | nl2br }}',
        liquid: '{{ address | nl2br }}',
        handlebars: '{{nl2br address}}',
      },
      category: 'text',
    },
    // office templates turn line breaks into breaks themselves, and escape the text once
    fn: (ctx, value) => (ctx.mode === 'office' ? str(value) : escapeHtml(str(value)).replace(/\r?\n/g, '<br>\n')),
  },
  {
    name: 'markdown',
    html: true,
    doc: {
      signature: 'markdown(value)',
      description:
        'Renders Markdown to HTML (no sanitiser: template data is trusted by the author).',
      examples: {
        jinja2: '{{ notes | markdown }}',
        liquid: '{{ notes | markdown }}',
        handlebars: '{{markdown notes}}',
      },
      category: 'text',
    },
    fn: (ctx, value) => {
      if (ctx.mode === 'office') throw new Error(officeUnsupported('markdown'));
      return marked.parse(str(value), {
        async: false,
        gfm: true,
        breaks: false,
      }) as string;
    },
  },
  {
    name: 'safe',
    aliases: ['raw'],
    html: true,
    doc: {
      signature: 'safe(value)',
      description: 'Marks a string as HTML so the engine does not escape it.',
      examples: {
        jinja2: '{{ html_snippet | safe }}',
        liquid: '{{ html_snippet | safe }}',
        handlebars: '{{safe html_snippet}}',
      },
      category: 'text',
    },
    fn: (_ctx, value) => str(value),
  },
  {
    name: 'json',
    aliases: ['tojson', 'dump'],
    doc: {
      signature: 'json(value, indent = 2)',
      description:
        'Serialises a value as JSON; handy while building a template.',
      examples: {
        jinja2: '<pre>{{ invoice | json }}</pre>',
        liquid: '<pre>{{ invoice | json }}</pre>',
        handlebars: '<pre>{{json invoice}}</pre>',
      },
      category: 'debug',
    },
    fn: (_ctx, value, indent?) =>
      JSON.stringify(value, null, opt(Number(indent), 2)),
  },
  {
    name: 'numToWords',
    aliases: ['num_to_words', 'spellout'],
    doc: {
      signature: 'numToWords(value, locale?)',
      description: 'Spells a number out in words (de, en, fr, es, it, nl).',
      examples: {
        jinja2: "{{ total | numToWords('de') }} → zweihundertdreiundvierzig",
        liquid: "{{ total | numToWords: 'de' }} → zweihundertdreiundvierzig",
        handlebars: "{{numToWords total 'de'}} → zweihundertdreiundvierzig",
      },
      category: 'format',
    },
    fn: (ctx, value, locale?) => {
      requireFinite('numToWords', value);
      const n = toNumber(value);
      if (Number.isNaN(n)) return str(value);
      const lang = str(opt(locale, ctx.locale)).split('-')[0] ?? 'en';
      return (wordsByLang[lang] ?? enWords)(n);
    },
  },
  {
    name: 't',
    aliases: ['translate'],
    doc: {
      signature: 't(key, params?)',
      description:
        "Looks a key up in the template's i18n dictionary for the request locale; `{name}` placeholders come from params.",
      examples: {
        jinja2: "{{ t('invoice.title', { number: invoice.number }) }}",
        liquid: "{{ 'invoice.title' | t: number: invoice.number }}",
        handlebars: "{{t 'invoice.title' number=invoice.number}}",
      },
      category: 'text',
    },
    fn: (ctx, key, params?) => {
      const dictionaries = ctx.i18n ?? {};
      const lang = ctx.locale.split('-')[0] ?? ctx.locale;
      const text =
        dictionaries[ctx.locale]?.[str(key)] ??
        dictionaries[lang]?.[str(key)] ??
        dictionaries['en']?.[str(key)] ??
        str(key);
      const p = (params ?? {}) as Record<string, unknown>;
      return text.replace(/\{(\w+)\}/g, (_, name: string) => str(p[name]));
    },
  },
  {
    name: 'asset',
    doc: {
      signature: 'asset(name)',
      description:
        'URL of a file in the workspace library (logo, background) on the CDN. Upload it on the Files page or with `POST /files` and use the name it has there; relative image paths resolve against the same library.',
      examples: {
        jinja2: `<img src="{{ asset('logo.png') }}">`,
        liquid: `<img src="{{ 'logo.png' | asset }}">`,
        handlebars: `<img src="{{asset 'logo.png'}}">`,
      },
      category: 'document',
    },
    fn: (ctx, name) =>
      `${(ctx.assetBaseUrl ?? '').replace(/\/$/, '')}/${str(name).replace(/^\//, '')}`,
  },
  {
    name: 'pageBreak',
    aliases: ['page_break'],
    html: true,
    doc: {
      signature: 'pageBreak()',
      description: 'Starts a new page in PDF output.',
      examples: {
        jinja2: '{{ pageBreak() }}',
        liquid: "{{ '' | pageBreak }}",
        handlebars: '{{pageBreak}}',
      },
      category: 'document',
    },
    fn: (ctx) =>
      ctx.drawing ? ctx.drawing({ kind: 'page-break' }) : '<div class="page-break" style="break-after:page"></div>',
  },
];
