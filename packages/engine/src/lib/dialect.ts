import type { EngineId } from './types';

/**
 * Template syntax per engine, for code that writes templates: the snippet library (spec 06 §2) and
 * the design emitter (plan 16 §4.2). Jinja2 passes filter arguments in parentheses, Liquid after a
 * colon (and cannot build object literals, so options are keyword arguments), Handlebars calls
 * helpers with positional arguments and a hash.
 */

/** Handlebars has no loop variable: inside `{{#each}}` the item's fields are read directly. */
export const loop = (
  engine: EngineId,
  item: string,
  list: string,
  body: string,
): string =>
  engine === 'handlebars'
    ? `{{#each ${list}}}\n${body.replace(new RegExp(`(?<![\\w.])${item}\\.`, 'g'), '')}\n{{/each}}`
    : `{% for ${item} in ${list} %}\n${body}\n{% endfor %}`;

/** An expression, optionally through one filter written the Jinja2 way (`date('dd.MM.yyyy')`). */
export const val = (
  engine: EngineId,
  expr: string,
  filter?: string,
): string => {
  if (!filter) return `{{ ${expr} }}`;
  if (engine === 'handlebars')
    return `{{${filter.split('(')[0]} ${expr}${filter.includes('(') ? ' ' + filter.slice(filter.indexOf('(') + 1, -1) : ''}}}`;
  return engine === 'liquid'
    ? `{{ ${expr} | ${filter.replace('(', ': ').replace(')', '')} }}`
    : `{{ ${expr} | ${filter} }}`;
};

export const ifElse = (
  engine: EngineId,
  cond: string,
  then: string,
  otherwise: string,
): string =>
  engine === 'handlebars'
    ? `{{#if ${cond}}}${then}{{else}}${otherwise}{{/if}}`
    : `{% if ${cond} %}${then}{% else %}${otherwise}{% endif %}`;

/** A `t` call with optional placeholder params (`{ rate: 'invoice.vat_rate' }`, values are expressions). */
export const tr = (
  engine: EngineId,
  key: string,
  params: Record<string, string> = {},
): string => {
  const entries = Object.entries(params);
  if (engine === 'handlebars')
    return `{{t '${key}'${entries.map(([k, v]) => ` ${k}=${v}`).join('')}}}`;
  if (engine === 'liquid')
    return `{{ '${key}' | t${entries.length ? ': ' + entries.map(([k, v]) => `${k}: ${v}`).join(', ') : ''} }}`;
  return `{{ t('${key}'${entries.length ? `, { ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }` : ''}) }}`;
};

/** `body` only when `cond` has a value. */
export const ifBlock = (
  engine: EngineId,
  cond: string,
  body: string,
): string =>
  engine === 'handlebars'
    ? `{{#if ${cond}}}${body}{{/if}}`
    : `{% if ${cond} %}${body}{% endif %}`;

/**
 * A string literal the engine reads back as `value`. Liquid has no escapes, so it takes whichever
 * quote the value lacks and turns an apostrophe into a typographic one when it contains both.
 */
export function stringLiteral(engine: EngineId, value: string): string {
  if (engine === 'liquid') {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `'${value.replace(/'/g, '’')}'`;
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * `input` through a filter with literal-or-expression arguments, as one output tag: Jinja2
 * `{{ x | f(a, b) }}`, Liquid `{{ x | f: a, b }}`, Handlebars `{{f x a b}}`.
 */
export function filterCall(
  engine: EngineId,
  input: string,
  name: string,
  args: string[] = [],
): string {
  if (engine === 'handlebars')
    return `{{${name} ${input}${args.map((a) => ` ${a}`).join('')}}}`;
  if (engine === 'liquid')
    return `{{ ${input} | ${name}${args.length ? `: ${args.join(', ')}` : ''} }}`;
  return `{{ ${input} | ${name}${args.length ? `(${args.join(', ')})` : ''} }}`;
}

/**
 * A helper that takes an input and named options, as one output tag: Jinja2
 * `{{ f(x, { a: 1 }) }}`, Liquid `{{ x | f: a: 1 }}`, Handlebars `{{f x a=1}}`. Option values are
 * expressions or literals the caller wrote with `stringLiteral`.
 */
export function helperCall(
  engine: EngineId,
  name: string,
  input: string,
  options: Record<string, string> = {},
): string {
  const entries = Object.entries(options);
  if (engine === 'handlebars')
    return `{{${name} ${input}${entries.map(([k, v]) => ` ${k}=${v}`).join('')}}}`;
  if (engine === 'liquid')
    return `{{ ${input} | ${name}${entries.length ? `: ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''} }}`;
  return `{{ ${name}(${input}${entries.length ? `, { ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }` : ''}) }}`;
}
