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

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof value === 'bigint') return Number(value);
  return NaN;
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

const str = (v: unknown): string =>
  v === undefined || v === null ? '' : String(v);
const opt = <T>(v: unknown, fallback: T): T =>
  v === undefined || v === null || v === '' ? fallback : (v as T);

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
        'Formats a number as currency with Intl.NumberFormat. Defaults come from the template settings.',
      example: "{{ line.total | money('EUR') }} → 1.234,50 €",
      category: 'format',
    },
    fn: (ctx: HelperContext, value, currency?, locale?) => {
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
        'Formats a number with grouping and a fixed number of decimals.',
      example: '{{ qty | number(2) }} → 1.234,00',
      category: 'format',
    },
    fn: (ctx, value, decimals?, locale?) => {
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
      example: "{{ invoice.date | date('dd.MM.yyyy') }}",
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
      example: "{{ invoice.date | dateAdd(14, 'days') | date('PP') }}",
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
      example: '{{add @index 1}}',
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
      example: '{{subtract total discount}}',
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
      example: '{{money (multiply line.qty line.price)}}',
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
      example: '{{divide total count}}',
      category: 'format',
    },
    fn: (_ctx, a, b) => (toNumber(b) === 0 ? '' : toNumber(a) / toNumber(b)),
  },
  {
    name: 'round',
    doc: {
      signature: 'round(value, decimals = 0)',
      description: 'Rounds half away from zero.',
      example: '{{ 2.345 | round(2) }} gives 2.35',
      category: 'format',
    },
    fn: (_ctx, value, decimals?) => {
      const n = toNumber(value);
      const f =
        10 **
        (decimals === undefined || decimals === null ? 0 : Number(decimals));
      return Number.isNaN(n)
        ? ''
        : (Math.round((Math.abs(n) + Number.EPSILON) * f) / f) * Math.sign(n);
    },
  },
  {
    name: 'upper',
    aliases: ['upcase'],
    doc: {
      signature: 'upper(value)',
      description: 'Upper-cases a string.',
      example: '{{ name | upper }}',
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
      example: '{{ name | lower }}',
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
      example: "{{ 'hello world' | title }} → Hello World",
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
      example: '{{ description | truncate(40) }}',
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
      example: "{{ iban | replace(' ', '') }}",
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
      example: "{% for tag in tags | split(',') %}",
      category: 'text',
    },
    fn: (_ctx, value, separator?) => str(value).split(str(opt(separator, ','))),
  },
  {
    name: 'join',
    doc: {
      signature: "join(list, separator = ', ')",
      description: 'Joins a list into a string.',
      example: "{{ tags | join(' · ') }}",
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
      example: "{{ customer.vat | default('—') }}",
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
      example: '{{ address | nl2br }}',
      category: 'text',
    },
    fn: (_ctx, value) => escapeHtml(str(value)).replace(/\r?\n/g, '<br>\n'),
  },
  {
    name: 'markdown',
    html: true,
    doc: {
      signature: 'markdown(value)',
      description:
        'Renders Markdown to HTML (no sanitiser: template data is trusted by the author).',
      example: '{{ notes | markdown }}',
      category: 'text',
    },
    fn: (_ctx, value) =>
      marked.parse(str(value), {
        async: false,
        gfm: true,
        breaks: false,
      }) as string,
  },
  {
    name: 'safe',
    aliases: ['raw'],
    html: true,
    doc: {
      signature: 'safe(value)',
      description: 'Marks a string as HTML so the engine does not escape it.',
      example: '{{ html_snippet | safe }}',
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
      example: '<pre>{{ invoice | json }}</pre>',
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
      example: "{{ total | numToWords('de') }} → zweihundertdreiundvierzig",
      category: 'format',
    },
    fn: (ctx, value, locale?) => {
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
      example: "{{ t('invoice.title', { number: invoice.number }) }}",
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
      description: 'URL of a workspace asset (logo, background) on the CDN.',
      example: '<img src="{{ asset(\'logo.png\') }}">',
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
      example: '{{ pageBreak() }}',
      category: 'document',
    },
    fn: () => '<div class="page-break" style="break-after:page"></div>',
  },
];
