import { EngineSyntaxError } from './errors';
import { engineIds, engines } from './engines';
import { defaultHelpers } from './helpers';
import type { EngineId, RenderContext } from './types';

/**
 * Parity harness (plan 00 week 3, MVP checklist: 40 documents × 3 engines): the same document
 * written in every engine renders to the same HTML, and every helper appears in at least one case.
 * Growing it to 40 found four engine bugs, each now pinned by its case: Handlebars helper names
 * shadowing data fields, Jinja2 dict methods shadowing `items`/`keys`/`values`, Liquid reading a
 * two-element string list as a keyword argument, and nunjucks compiling `not a == b` wrongly.
 */
interface ParityCase {
  name: string;
  data: unknown;
  sources: Record<EngineId, string>;
  /** A pattern where the exact bytes are not the point (QR and barcode images); the engines must
   * still agree with each other byte for byte. */
  expected: string | RegExp;
  partials?: Record<string, Record<EngineId, string>>;
  /** Render settings the case needs: locale and dictionaries for `t`, the asset base for `asset`. */
  context?: Partial<RenderContext>;
}

const data = {
  company: { name: 'Fennlor Studio GmbH', iban: 'DE00 0000 0000 0000 0000 00' },
  invoice: {
    number: '2026-0042',
    date: '2026-09-07',
    lines: [
      { description: 'Beratung', qty: 8, price: 120, taxable: true },
      {
        description: 'Umsetzung <Phase 1>',
        qty: 20,
        price: 110,
        taxable: true,
      },
    ],
    notes: '',
  },
};

const cases: ParityCase[] = [
  {
    name: 'interpolation with money and date helpers',
    data,
    sources: {
      jinja2: `<h1>Rechnung {{ invoice.number }}</h1><p>{{ invoice.date | date('dd.MM.yyyy') }} · {{ invoice.lines | sum('price') | money }}</p>`,
      liquid: `<h1>Rechnung {{ invoice.number }}</h1><p>{{ invoice.date | date: 'dd.MM.yyyy' }} · {{ invoice.lines | sum: 'price' | money }}</p>`,
      handlebars: `<h1>Rechnung {{invoice.number}}</h1><p>{{date invoice.date 'dd.MM.yyyy'}} · {{money (sum invoice.lines 'price')}}</p>`,
    },
    expected: '<h1>Rechnung 2026-0042</h1><p>07.09.2026 · 230,00 €</p>',
  },
  {
    name: 'loops with index and escaping of data',
    data,
    sources: {
      jinja2: `<ul>{% for line in invoice.lines %}<li>{{ loop.index }}. {{ line.description }} ({{ line.qty | number(0) }})</li>{% endfor %}</ul>`,
      liquid: `<ul>{% for line in invoice.lines %}<li>{{ forloop.index }}. {{ line.description | escape }} ({{ line.qty | number: 0 }})</li>{% endfor %}</ul>`,
      handlebars: `<ul>{{#each invoice.lines}}<li>{{add @index 1}}. {{description}} ({{number qty 0}})</li>{{/each}}</ul>`,
    },
    expected:
      '<ul><li>1. Beratung (8)</li><li>2. Umsetzung &lt;Phase 1&gt; (20)</li></ul>',
  },
  {
    name: 'conditionals and defaults',
    data,
    sources: {
      jinja2: `{% if invoice.notes %}<p>{{ invoice.notes }}</p>{% else %}<p>{{ invoice.notes | default('Keine Anmerkungen') }}</p>{% endif %}`,
      liquid: `{% if invoice.notes != '' %}<p>{{ invoice.notes }}</p>{% else %}<p>{{ invoice.notes | default: 'Keine Anmerkungen' }}</p>{% endif %}`,
      handlebars: `{{#if invoice.notes}}<p>{{invoice.notes}}</p>{{else}}<p>{{default invoice.notes 'Keine Anmerkungen'}}</p>{{/if}}`,
    },
    expected: '<p>Keine Anmerkungen</p>',
  },
  {
    name: 'partials from the workspace',
    data,
    partials: {
      footer: {
        jinja2: `<footer>{{ company.name }} · {{ company.iban | replace(' ', '') }}</footer>`,
        liquid: `<footer>{{ company.name }} · {{ company.iban | replace: ' ', '' }}</footer>`,
        handlebars: `<footer>{{company.name}} · {{replace company.iban ' ' ''}}</footer>`,
      },
    },
    sources: {
      jinja2: `<main>x</main>{% include "footer" %}`,
      liquid: `<main>x</main>{% render "footer", company: company %}`,
      handlebars: `<main>x</main>{{> footer}}`,
    },
    expected:
      '<main>x</main><footer>Fennlor Studio GmbH · DE00000000000000000000</footer>',
  },
  {
    name: 'html helpers are not escaped',
    data: { text: 'a & b\nc' },
    sources: {
      jinja2: `{{ text | nl2br }}{{ pageBreak() }}`,
      liquid: `{{ text | nl2br }}{{ '' | pageBreak }}`,
      handlebars: `{{nl2br text}}{{pageBreak}}`,
    },
    expected:
      'a &amp; b<br>\nc<div class="page-break" style="break-after:page"></div>',
  },
  {
    name: 'chart and image document helpers',
    data: {
      salesChart: {
        type: 'line',
        width: 300,
        height: 150,
        data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] },
      },
      photo: 'https://cdn.example/p.jpg',
    },
    sources: {
      jinja2: `{{ chart(salesChart) }}{{ image(photo, { width: 120, height: 80, fit: 'cover' }) }}`,
      liquid: `{{ salesChart | chart }}{{ photo | image: width: 120, height: 80, fit: 'cover' }}`,
      handlebars: `{{chart salesChart}}{{image photo width=120 height=80 fit='cover'}}`,
    },
    expected:
      '<canvas class="ff-chart" width="300" height="150" style="width:300px;height:150px" data-ff-chart="{&quot;type&quot;:&quot;line&quot;,&quot;data&quot;:{&quot;labels&quot;:[&quot;a&quot;,&quot;b&quot;],&quot;datasets&quot;:[{&quot;data&quot;:[1,2]}]},&quot;options&quot;:{&quot;animation&quot;:false,&quot;responsive&quot;:false}}"></canvas><img src="https://cdn.example/p.jpg" alt="" style="width:120px;height:80px;object-fit:cover">',
  },
  {
    // plain data with its options beside it: an object literal, keyword arguments, hash arguments
    name: 'chart from labels and values',
    data: { sales: { labels: ['Q1', 'Q2'], values: [1, '2.5'] }, accent: '#0f766e' },
    sources: {
      jinja2: `{{ chart(sales, { type: 'line', width: 300, height: 150, color: accent }) }}`,
      liquid: `{{ sales | chart: type: 'line', width: 300, height: 150, color: accent }}`,
      handlebars: `{{chart sales type='line' width=300 height=150 color=accent}}`,
    },
    expected: `<canvas class="ff-chart" width="300" height="150" style="width:300px;height:150px" data-ff-chart="${JSON.stringify({
      type: 'line',
      data: {
        labels: ['Q1', 'Q2'],
        datasets: [{ data: [1, 2.5], backgroundColor: '#0f766e', borderColor: '#0f766e', fill: false }],
      },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } } },
    }).replace(/"/g, '&quot;')}"></canvas>`,
  },
];

/** Data for the helper catalogue cases: every helper appears in at least one case (CLAUDE.md). */
const ledger = {
  items: [
    { name: 'Widget', category: 'tools', price: 19.99, qty: 3 },
    { name: 'Gadget', category: 'toys', price: 5.5, qty: 10 },
    { name: 'Doohickey', category: 'tools', price: 120, qty: 1 },
  ],
  customer: { name: 'erika mustermann', city: 'Köln' },
  tags: 'red,green,blue',
  pair: ['red', 'green'],
  total: 1234.5,
  amount: 42,
  blurb: 'The quick brown fox jumps over the lazy dog',
  md: '**bold** and *em*',
  markup: '<em>x</em>',
  obj: { a: 1, b: [true, null] },
  quote: 'Tom & "Jerry"',
  iban: 'DE00000000000000000000',
};

const helperCases: ParityCase[] = [
  {
    name: 'avg with number formatting',
    data: ledger,
    sources: {
      jinja2: `{{ items | avg('price') | number(2) }}`,
      liquid: `{{ items | avg: 'price' | number: 2 }}`,
      handlebars: `{{number (avg items 'price') 2}}`,
    },
    expected: '48,50',
  },
  {
    name: 'min and max of a field',
    data: ledger,
    sources: {
      jinja2: `{{ items | min('price') }} to {{ items | max('price') }}`,
      liquid: `{{ items | min: 'price' }} to {{ items | max: 'price' }}`,
      handlebars: `{{min items 'price'}} to {{max items 'price'}}`,
    },
    expected: '5.5 to 120',
  },
  {
    // Jinja2 used to resolve `g.items` to the Python dict method and count 0 in every group
    name: 'groupBy with the group items',
    data: ledger,
    sources: {
      jinja2: `{% for g in items | groupBy('category') %}[{{ g.key }}:{{ g.items | length }}]{% endfor %}`,
      liquid: `{% assign groups = items | groupBy: 'category' %}{% for g in groups %}[{{ g.key }}:{{ g.items | length }}]{% endfor %}`,
      handlebars: `{{#each (groupBy items 'category')}}[{{key}}:{{length items}}]{{/each}}`,
    },
    expected: '[tools:2][toys:1]',
  },
  {
    name: 'sortBy ascending',
    data: ledger,
    sources: {
      jinja2: `{{ items | sortBy('price') | pluck('name') | join(', ') }}`,
      liquid: `{{ items | sortBy: 'price' | pluck: 'name' | join: ', ' }}`,
      handlebars: `{{join (pluck (sortBy items 'price') 'name') ', '}}`,
    },
    expected: 'Gadget, Widget, Doohickey',
  },
  {
    name: 'sortBy descending',
    data: ledger,
    sources: {
      jinja2: `{{ items | sortBy('price', 'desc') | pluck('name') | join(', ') }}`,
      liquid: `{{ items | sortBy: 'price', 'desc' | pluck: 'name' | join: ', ' }}`,
      handlebars: `{{join (pluck (sortBy items 'price' 'desc') 'name') ', '}}`,
    },
    expected: 'Doohickey, Widget, Gadget',
  },
  {
    // two matches: Liquid used to read the two names as a keyword argument and join nothing
    name: 'where with two matches, plucked and joined',
    data: ledger,
    sources: {
      jinja2: `{{ items | where('category', 'tools') | pluck('name') | join(', ') }}`,
      liquid: `{{ items | where: 'category', 'tools' | pluck: 'name' | join: ', ' }}`,
      handlebars: `{{join (pluck (where items 'category' 'tools') 'name') ', '}}`,
    },
    expected: 'Widget, Doohickey',
  },
  {
    name: 'a two-element list of strings joined',
    data: ledger,
    sources: {
      jinja2: `{{ pair | join(' + ') }}`,
      liquid: `{{ pair | join: ' + ' }}`,
      handlebars: `{{join pair ' + '}}`,
    },
    expected: 'red + green',
  },
  {
    name: 'chunk into table rows',
    data: ledger,
    sources: {
      jinja2: `{% for row in items | chunk(2) %}<tr>{% for i in row %}<td>{{ i.name }}</td>{% endfor %}</tr>{% endfor %}`,
      liquid: `{% assign rows = items | chunk: 2 %}{% for row in rows %}<tr>{% for i in row %}<td>{{ i.name }}</td>{% endfor %}</tr>{% endfor %}`,
      handlebars: `{{#each (chunk items 2)}}<tr>{{#each this}}<td>{{name}}</td>{{/each}}</tr>{{/each}}`,
    },
    expected: '<tr><td>Widget</td><td>Gadget</td></tr><tr><td>Doohickey</td></tr>',
  },
  {
    name: 'range',
    data: {},
    sources: {
      jinja2: `{% for n in range(1, 4) %}{{ n }};{% endfor %}`,
      liquid: `{% assign ns = 1 | range: 4 %}{% for n in ns %}{{ n }};{% endfor %}`,
      handlebars: `{{#each (range 1 4)}}{{this}};{{/each}}`,
    },
    expected: '1;2;3;',
  },
  {
    name: 'first, last and length',
    data: ledger,
    sources: {
      jinja2: `{{ (items | first).name }}/{{ (items | last).name }}/{{ items | length }}/{{ blurb | length }}`,
      liquid: `{% assign f = items | first %}{% assign l = items | last %}{{ f.name }}/{{ l.name }}/{{ items | length }}/{{ blurb | length }}`,
      handlebars: `{{lookup (first items) 'name'}}/{{lookup (last items) 'name'}}/{{length items}}/{{length blurb}}`,
    },
    expected: 'Widget/Doohickey/3/43',
  },
  {
    name: 'money in another currency and locale',
    data: ledger,
    sources: {
      jinja2: `{{ total | money('USD', 'en-US') }}`,
      liquid: `{{ total | money: 'USD', 'en-US' }}`,
      handlebars: `{{money total 'USD' 'en-US'}}`,
    },
    expected: '$1,234.50',
  },
  {
    name: 'money from the template settings',
    data: ledger,
    sources: {
      jinja2: `{{ total | money }}`,
      liquid: `{{ total | money }}`,
      handlebars: `{{money total}}`,
    },
    expected: '1.234,50 €',
  },
  {
    name: 'number with decimals and locale',
    data: ledger,
    sources: {
      jinja2: `{{ total | number(1, 'en-GB') }}|{{ total | number(0) }}`,
      liquid: `{{ total | number: 1, 'en-GB' }}|{{ total | number: 0 }}`,
      handlebars: `{{number total 1 'en-GB'}}|{{number total 0}}`,
    },
    expected: '1,234.5|1.235',
  },
  {
    name: 'date in a timezone',
    data: {},
    sources: {
      jinja2: `{{ '2026-09-07T22:30:00Z' | date('dd.MM.yyyy HH:mm', 'Europe/Berlin') }}`,
      liquid: `{{ '2026-09-07T22:30:00Z' | date: 'dd.MM.yyyy HH:mm', 'Europe/Berlin' }}`,
      handlebars: `{{date '2026-09-07T22:30:00Z' 'dd.MM.yyyy HH:mm' 'Europe/Berlin'}}`,
    },
    expected: '08.09.2026 00:30',
  },
  {
    name: 'dateAdd across a month end',
    data: {},
    sources: {
      jinja2: `{{ '2026-01-31' | dateAdd(1, 'months') | date('yyyy-MM-dd') }}|{{ '2026-09-07' | dateAdd(14, 'days') | date('dd.MM.') }}`,
      liquid: `{{ '2026-01-31' | dateAdd: 1, 'months' | date: 'yyyy-MM-dd' }}|{{ '2026-09-07' | dateAdd: 14, 'days' | date: 'dd.MM.' }}`,
      handlebars: `{{date (dateAdd '2026-01-31' 1 'months') 'yyyy-MM-dd'}}|{{date (dateAdd '2026-09-07' 14 'days') 'dd.MM.'}}`,
    },
    expected: '2026-02-28|21.09.',
  },
  {
    name: 'arithmetic and rounding',
    data: ledger,
    sources: {
      jinja2: `{{ amount | add(8) }} {{ amount | subtract(2) }} {{ amount | multiply(1.19) | round(2) }} {{ amount | divide(8) }}`,
      liquid: `{{ amount | add: 8 }} {{ amount | subtract: 2 }} {{ amount | multiply: 1.19 | round: 2 }} {{ amount | divide: 8 }}`,
      handlebars: `{{add amount 8}} {{subtract amount 2}} {{round (multiply amount 1.19) 2}} {{divide amount 8}}`,
    },
    expected: '50 40 49.98 5.25',
  },
  {
    name: 'upper, lower and title',
    data: ledger,
    sources: {
      jinja2: `{{ customer.name | upper }}|{{ 'MiXeD' | lower }}|{{ customer.name | title }}`,
      liquid: `{{ customer.name | upper }}|{{ 'MiXeD' | lower }}|{{ customer.name | title }}`,
      handlebars: `{{upper customer.name}}|{{lower 'MiXeD'}}|{{title customer.name}}`,
    },
    expected: 'ERIKA MUSTERMANN|mixed|Erika Mustermann',
  },
  {
    name: 'truncate with the default and a custom suffix',
    data: ledger,
    sources: {
      jinja2: `{{ blurb | truncate(15) }}|{{ blurb | truncate(9, '...') }}`,
      liquid: `{{ blurb | truncate: 15 }}|{{ blurb | truncate: 9, '...' }}`,
      handlebars: `{{truncate blurb 15}}|{{truncate blurb 9 '...'}}`,
    },
    expected: 'The quick brow…|The qu...',
  },
  {
    name: 'split and join',
    data: ledger,
    sources: {
      jinja2: `{{ tags | split(',') | join(' / ') }}`,
      liquid: `{{ tags | split: ',' | join: ' / ' }}`,
      handlebars: `{{join (split tags ',') ' / '}}`,
    },
    expected: 'red / green / blue',
  },
  {
    name: 'default keeps a present value',
    data: ledger,
    sources: {
      jinja2: `{{ customer.city | default('–') }}|{{ customer.zip | default('–') }}`,
      liquid: `{{ customer.city | default: '–' }}|{{ customer.zip | default: '–' }}`,
      handlebars: `{{default customer.city '–'}}|{{default customer.zip '–'}}`,
    },
    expected: 'Köln|–',
  },
  {
    name: 'markdown',
    data: ledger,
    sources: {
      jinja2: `{{ md | markdown }}`,
      liquid: `{{ md | markdown }}`,
      handlebars: `{{markdown md}}`,
    },
    expected: '<p><strong>bold</strong> and <em>em</em></p>',
  },
  {
    // Liquid does not escape output by default, so the template asks for it
    name: 'escaped data next to safe output',
    data: ledger,
    sources: {
      jinja2: `{{ markup }}|{{ markup | safe }}`,
      liquid: `{{ markup | escape }}|{{ markup | safe }}`,
      handlebars: `{{markup}}|{{safe markup}}`,
    },
    expected: '&lt;em&gt;x&lt;/em&gt;|<em>x</em>',
  },
  {
    name: 'json for debugging',
    data: ledger,
    sources: {
      jinja2: `<pre>{{ obj | json(0) }}</pre>`,
      liquid: `<pre>{{ obj | json: 0 | escape }}</pre>`,
      handlebars: `<pre>{{json obj 0}}</pre>`,
    },
    expected: '<pre>{&quot;a&quot;:1,&quot;b&quot;:[true,null]}</pre>',
  },
  {
    name: 'numToWords in two languages',
    data: {},
    sources: {
      jinja2: `{{ 1234 | numToWords }}|{{ 21 | numToWords('en') }}`,
      liquid: `{{ 1234 | numToWords }}|{{ 21 | numToWords: 'en' }}`,
      handlebars: `{{numToWords 1234}}|{{numToWords 21 'en'}}`,
    },
    expected: 'eintausendzweihundertvierunddreißig|twenty-one',
  },
  {
    name: 't with parameters and a missing key',
    data: ledger,
    context: { locale: 'de', i18n: { de: { greeting: 'Hallo {name}', total: 'Summe' } } },
    sources: {
      jinja2: `{{ t('greeting', { name: customer.name }) }}|{{ t('total') }}|{{ t('missing') }}`,
      liquid: `{{ 'greeting' | t: name: customer.name }}|{{ 'total' | t }}|{{ 'missing' | t }}`,
      handlebars: `{{t 'greeting' name=customer.name}}|{{t 'total'}}|{{t 'missing'}}`,
    },
    expected: 'Hallo erika mustermann|Summe|missing',
  },
  {
    name: 'asset URLs',
    data: {},
    context: { assetBaseUrl: 'https://cdn.example/a/ws1' },
    sources: {
      jinja2: `<img src="{{ asset('logo.png') }}">`,
      liquid: `<img src="{{ 'logo.png' | asset }}">`,
      handlebars: `<img src="{{asset 'logo.png'}}">`,
    },
    expected: '<img src="https://cdn.example/a/ws1/logo.png">',
  },
  {
    name: 'qrcode',
    data: {},
    sources: {
      jinja2: `{{ qrcode('https://formfeed.dev', { size: 64 }) }}`,
      liquid: `{{ 'https://formfeed.dev' | qrcode: size: 64 }}`,
      handlebars: `{{qrcode 'https://formfeed.dev' size=64}}`,
    },
    expected: /^data:image\/svg\+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww\.w3\.org%2F2000%2Fsvg%22%20width%3D%2264%22/,
  },
  {
    name: 'barcode',
    data: {},
    sources: {
      jinja2: `{{ barcode('4006381333931', { type: 'ean13', height: 20 }) }}`,
      liquid: `{{ '4006381333931' | barcode: type: 'ean13', height: 20 }}`,
      handlebars: `{{barcode '4006381333931' type='ean13' height=20}}`,
    },
    expected: /^data:image\/svg\+xml;utf8,%3Csvg%20viewBox/,
  },
  {
    // Liquid cannot build an object literal: a string input is the IBAN, the rest keyword arguments
    name: 'epcQr from the same payment in every engine',
    data: ledger,
    sources: {
      jinja2: `{{ epcQr({ name: 'Fennlor Studio GmbH', iban: iban, amount: 12.5, reference: 'RE-1' }) }}`,
      liquid: `{{ iban | epcQr: name: 'Fennlor Studio GmbH', amount: 12.5, reference: 'RE-1' }}`,
      handlebars: `{{epcQr name='Fennlor Studio GmbH' iban=iban amount=12.5 reference='RE-1'}}`,
    },
    expected: /^data:image\/svg\+xml;utf8,/,
  },
  {
    name: 'loop first and last markers',
    data: ledger,
    sources: {
      jinja2: `{% for i in items %}{% if loop.first %}[{% endif %}{{ i.name }}{% if not loop.last %},{% endif %}{% if loop.last %}]{% endif %}{% endfor %}`,
      liquid: `{% for i in items %}{% if forloop.first %}[{% endif %}{{ i.name }}{% unless forloop.last %},{% endunless %}{% if forloop.last %}]{% endif %}{% endfor %}`,
      handlebars: `{{#each items}}{{#if @first}}[{{/if}}{{name}}{{#unless @last}},{{/unless}}{{#if @last}}]{{/if}}{{/each}}`,
    },
    expected: '[Widget,Gadget,Doohickey]',
  },
  {
    name: 'comparison in a condition',
    data: ledger,
    sources: {
      jinja2: `{% for i in items %}{% if i.price > 50 %}{{ i.name }}!{% endif %}{% endfor %}`,
      liquid: `{% for i in items %}{% if i.price > 50 %}{{ i.name }}!{% endif %}{% endfor %}`,
      handlebars: `{{#each items}}{{#if (gt price 50)}}{{name}}!{{/if}}{{/each}}`,
    },
    expected: 'Doohickey!',
  },
  {
    name: 'boolean logic',
    data: ledger,
    sources: {
      jinja2: `{% if amount > 10 and not blurb == '' %}yes{% endif %}|{% if amount < 10 or tags %}or{% endif %}`,
      liquid: `{% if amount > 10 and blurb != '' %}yes{% endif %}|{% if amount < 10 or tags %}or{% endif %}`,
      handlebars: `{{#if (and (gt amount 10) (ne blurb ''))}}yes{{/if}}|{{#if (or (lt amount 10) tags)}}or{{/if}}`,
    },
    expected: 'yes|or',
  },
  {
    name: 'comparisons at their boundaries',
    data: ledger,
    sources: {
      jinja2: `{% for i in items %}{{ i.qty }}{% if i.qty == 10 %}=10{% endif %}{% if i.qty >= 3 %}>=3{% endif %}{% if i.qty <= 3 %}<=3{% endif %}{% if not i.qty == 1 %}!1{% endif %};{% endfor %}`,
      liquid: `{% for i in items %}{{ i.qty }}{% if i.qty == 10 %}=10{% endif %}{% if i.qty >= 3 %}>=3{% endif %}{% if i.qty <= 3 %}<=3{% endif %}{% if i.qty != 1 %}!1{% endif %};{% endfor %}`,
      handlebars: `{{#each items}}{{qty}}{{#if (eq qty 10)}}=10{{/if}}{{#if (gte qty 3)}}>=3{{/if}}{{#if (lte qty 3)}}<=3{{/if}}{{#if (not (eq qty 1))}}!1{{/if}};{{/each}}`,
    },
    expected: '3>=3<=3!1;10=10>=3!1;1<=3;',
  },
  {
    name: 'quotes and ampersands in an attribute',
    data: ledger,
    sources: {
      jinja2: `<a title="{{ quote }}">x</a>`,
      liquid: `<a title="{{ quote | escape }}">x</a>`,
      handlebars: `<a title="{{quote}}">x</a>`,
    },
    expected: '<a title="Tom &amp; &quot;Jerry&quot;">x</a>',
  },
  {
    name: 'line totals in a loop',
    data: ledger,
    sources: {
      jinja2: `{% for i in items %}{{ i.price | multiply(i.qty) | money }};{% endfor %}`,
      liquid: `{% for i in items %}{{ i.price | multiply: i.qty | money }};{% endfor %}`,
      handlebars: `{{#each items}}{{money (multiply price qty)}};{{/each}}`,
    },
    expected: '59,97 €;55,00 €;120,00 €;',
  },
  {
    // Handlebars used to call the helper of the same name: `{{date}}` printed today, `{{number}}` nothing
    name: 'data fields named like helpers',
    data: { title: 'Rechnung', date: '2026-09-07', number: 'RE-42', first: 'Erika' },
    sources: {
      jinja2: `{{ title }} {{ number }} vom {{ date }} an {{ first }}`,
      liquid: `{{ title }} {{ number }} vom {{ date }} an {{ first }}`,
      handlebars: `{{title}} {{number}} vom {{date}} an {{first}}`,
    },
    expected: 'Rechnung RE-42 vom 2026-09-07 an Erika',
  },
  {
    // Jinja2 used to answer these with Python dict methods: the loop over invoice.items rendered nothing
    name: 'data fields named like dict methods',
    data: { invoice: { items: [{ d: 'A' }, { d: 'B' }], keys: 'k', values: [1, 2] } },
    sources: {
      jinja2: `{% for i in invoice.items %}{{ i.d }}{% endfor %}|{{ invoice.keys }}|{{ invoice.values | length }}`,
      liquid: `{% for i in invoice.items %}{{ i.d }}{% endfor %}|{{ invoice.keys }}|{{ invoice.values | length }}`,
      handlebars: `{{#each invoice.items}}{{d}}{{/each}}|{{invoice.keys}}|{{length invoice.values}}`,
    },
    expected: 'AB|k|2',
  },
];

function context(
  partials: ParityCase['partials'],
  engine: EngineId,
  overrides: Partial<RenderContext> = {},
): RenderContext {
  return {
    locale: 'de-DE',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    partials: (name) => partials?.[name]?.[engine],
    helpers: defaultHelpers(),
    limits: { ms: 5000, outputBytes: 20 * 1024 * 1024, includeDepth: 8 },
    ...overrides,
  };
}

/** Same rendered HTML: one character spelled as different entities (`&#34;`, `&quot;`) is one. */
const normalise = (s: string) =>
  s
    .replace(/&#34;|&#x22;/gi, '&quot;')
    .replace(/&#x27;/gi, '&#39;')
    .replace(/&#x3D;/gi, '=')
    .replace(/&#x60;/gi, '`')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim();

const allCases = [...cases, ...helperCases];

async function renderCase(c: ParityCase, id: EngineId): Promise<string> {
  const engine = engines[id];
  const tpl = engine.compile(c.sources[id], { name: c.name });
  return normalise(await engine.render(tpl, c.data, context(c.partials, id, c.context)));
}

describe('engine parity', () => {
  it('covers the MVP bar of 40 documents in all three engines', () => {
    expect(allCases.length).toBeGreaterThanOrEqual(40);
  });

  for (const c of allCases) {
    for (const id of engineIds) {
      it(`${c.name} [${id}]`, async () => {
        const out = await renderCase(c, id);
        if (typeof c.expected === 'string') expect(out).toBe(normalise(c.expected));
        else expect(out).toMatch(c.expected);
      });
    }
    if (c.expected instanceof RegExp)
      it(`${c.name} [identical in every engine]`, async () => {
        const outputs = await Promise.all(engineIds.map((id) => renderCase(c, id)));
        expect(new Set(outputs).size).toBe(1);
      });
  }
});

describe('every helper is exercised by a parity case', () => {
  // CLAUDE.md: add every new helper to the parity fixtures. Only the canonical names count; the
  // aliases (apitemplate.io compatibility) resolve to the same function.
  const sources = allCases.flatMap((c) => [
    ...Object.values(c.sources),
    ...Object.values(c.partials ?? {}).flatMap((p) => Object.values(p)),
  ]);
  for (const name of defaultHelpers().definitions.keys())
    it(name, () => {
      expect(sources.some((s) => new RegExp(`\\b${name}\\b`).test(s))).toBe(true);
    });
});

describe('syntax errors carry a position', () => {
  it.each([
    ['jinja2', '<p>{% for x in items %}{{ x }}</p>'],
    ['liquid', '<p>{% if a %}{{ a }}</p>'],
    ['handlebars', '<p>{{#each items}}{{this}}</p>'],
  ] as const)('%s', (id, source) => {
    expect(() => engines[id].compile(source)).toThrow(EngineSyntaxError);
    try {
      engines[id].compile(source);
    } catch (e) {
      const err = e as EngineSyntaxError;
      expect(err.engine).toBe(id);
      expect(err.line).toBeGreaterThanOrEqual(1);
      expect(err.column).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('jinja2 python compatibility', () => {
  const ctx = context(undefined, 'jinja2');
  it('supports string methods, dict.items() and tojson', async () => {
    const tpl = engines.jinja2.compile(
      `{{ name.upper() }}|{{ name.replace('a', 'o') }}|{% for k, v in meta.items() %}{{ k }}={{ v }};{% endfor %}|{{ tags | tojson }}|{{ 7 is divisibleby(7) }}`,
    );
    const out = await engines.jinja2.render(
      tpl,
      { name: 'banana', meta: { a: 1, b: 2 }, tags: ['x'] },
      ctx,
    );
    expect(out).toBe('BANANA|bonono|a=1;b=2;|[&quot;x&quot;]|true');
  });

  it('keeps apitemplate.io aliases working', async () => {
    const tpl = engines.jinja2.compile(
      `{{ 12.5 | currency_format('EUR', 'en-GB') }}`,
    );
    expect(await engines.jinja2.render(tpl, {}, ctx)).toBe('€12.50');
  });

  it('reads not a == b as not (a == b), as Jinja2 does', async () => {
    const tpl = engines.jinja2.compile(
      `{% if not status == 'paid' %}open{% endif %}|{{ not 3 == 1 }}|{{ not flag }}|{{ not (a and b) }}`,
    );
    const out = await engines.jinja2.render(
      tpl,
      { status: 'sent', flag: false, a: true, b: false },
      ctx,
    );
    expect(out).toBe('open|true|true|true');
  });

  it('runs Python format specs, namespaces and the Jinja2 forms of truncate, map and selectattr', async () => {
    const render = (src: string, data: unknown) => engines.jinja2.render(engines.jinja2.compile(src), data, ctx);
    // apitemplate.io's German number formatting idiom
    expect(
      await render(
        `{% macro de(v, places) %}{{ "{:,.{}f}".format(v, places|default(0)).replace(',', 'x').replace('.', ',').replace('x', '.') }}{% endmacro %}{{ de(1234.5, 2) }}|{{ de(72) }}`,
        {},
      ),
    ).toBe('1.234,50|72');
    expect(
      await render(
        `{% set ns = namespace(count=0, power=0) %}{% for m in mods %}{% set ns.count = ns.count + m.n %}{% set ns.power = ns.power + m.n * m.w %}{% endfor %}{{ ns.count }}/{{ ns.power }}`,
        { mods: [{ n: 2, w: 400 }, { n: 3, w: 450 }] },
      ),
    ).toBe('5/2150');
    await expect(render(`{% set data.x = 1 %}`, { data: {} })).rejects.toThrow('non-namespace');
    expect(await render(`{{ s | truncate(12, True, '~') }}|{{ s | truncate(12) }}|{{ short | truncate(12, False) }}`, { s: 'one two three four', short: 'tiny' })).toBe(
      'one two thr~|one two thr…|tiny',
    );
    expect(await render(`{{ s | truncate(12, False, '~', 0) }}`, { s: 'one two three four' })).toBe('one two~');
    expect(await render(`{{ xs | map(attribute='a.b') | join(',') }}|{{ words | map('upper') | join(',') }}|{{ xs | map('a') | length }}`, { xs: [{ a: { b: 1 } }, { a: { b: 2 } }], words: ['x', 'y'] })).toBe(
      '1,2|X,Y|2',
    );
    const lines = { xs: [{ net: 5000, vat: { v: 500 } }, { net: 200, vat: { v: 50 } }] };
    expect(await render(`{{ xs | sum(attribute='net') }}|{{ xs | sum(attribute='vat.v', start=1) }}|{{ xs | sum('net') }}|{{ [1, 2] | sum }}`, lines)).toBe('5200|551|5200|3');
    // lists and dicts print as Python shows them, so `"data": {{ values }}` in a chart script is an array
    expect(await render(`<script>var a = {{ xs }};</script>{{ d }}`, { xs: [-1500.5, 200], d: { k: ['x', "it's"], on: true, no: null } })).toBe(
      `<script>var a = [-1500.5, 200];</script>{&#39;k&#39;: [&#39;x&#39;, &quot;it&#39;s&quot;], &#39;on&#39;: True, &#39;no&#39;: None}`,
    );
    expect(await render(`{{ xs }}|{{ flag }}|{{ xs | join(',') }}`, { xs: [], flag: true })).toBe('[]|true|');
    const items = { xs: [{ c: 'ROOF', n: 1 }, { c: 'OTHER', n: 2 }, { c: 'ROOF', n: 3, on: true }] };
    expect(
      await render(
        `{% for x in xs | selectattr("c", "equalto", "ROOF") %}{{ x.n }}{% endfor %}|{% for x in xs | rejectattr("c", "==", "ROOF") %}{{ x.n }}{% endfor %}|{{ xs | selectattr("on") | length }}|{{ xs | selectattr("n", "gt", 1) | length }}|{{ xs | selectattr("c", "in", ["OTHER"]) | length }}`,
        items,
      ),
    ).toBe('13|2|1|2|1');
  });

  it('keeps slice bounds, which the member lookup used to drop', async () => {
    const tpl = engines.jinja2.compile(`{{ nums[1:3] | join(',') }}`);
    expect(await engines.jinja2.render(tpl, { nums: [1, 2, 3, 4] }, ctx)).toBe('2,3');
  });

  it('prefers a data field to the Python dict method of the same name', async () => {
    const tpl = engines.jinja2.compile(
      `{{ d.items | length }}|{% for k, v in m.items() %}{{ k }}={{ v }}{% endfor %}`,
    );
    const out = await engines.jinja2.render(tpl, { d: { items: [1, 2, 3] }, m: { a: 1 } }, ctx);
    expect(out).toBe('3|a=1');
  });

  it('autoescapes data but not safe output', async () => {
    const tpl = engines.jinja2.compile(`{{ v }} {{ v | safe }}`);
    expect(await engines.jinja2.render(tpl, { v: '<b>' }, ctx)).toBe(
      '&lt;b&gt; <b>',
    );
  });
});

describe('limits', () => {
  it('rejects output above the byte limit', async () => {
    const ctx = {
      ...context(undefined, 'liquid'),
      limits: { ms: 5000, outputBytes: 64, includeDepth: 8 },
    };
    const tpl = engines.liquid.compile(
      `{% for i in (1..100) %}0123456789{% endfor %}`,
    );
    await expect(engines.liquid.render(tpl, {}, ctx)).rejects.toThrow(
      /limit is 64 bytes/,
    );
  });
});
