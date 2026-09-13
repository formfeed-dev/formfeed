/**
 * Python's `str.format` for the Jinja2 engine (spec 05 §8): templates from apitemplate.io format
 * numbers with it, e.g. `"{:,.2f}".format(total)`, including nested fields in the spec
 * (`"{:,.{}f}".format(value, places)`). Covers positional, numbered and named fields, attribute
 * lookups (`{0.name}`), `{{`/`}}` escapes and the format mini-language: fill and alignment, sign,
 * `#`, zero padding, width, `,`/`_` grouping, precision and the types `s d n b o x X e E f F g G %`.
 */

const SPEC =
  /^(?:([\s\S])?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/;

function group(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** Python writes exponents with at least two digits: `1.5e+02`. */
function pythonExponent(text: string): string {
  return text.replace(/e([+-])(\d)$/i, (m, sign: string, digit: string) => `${m[0]}${sign}0${digit}`);
}

function formatNumber(value: number, type: string, precision: number | undefined, alternate: boolean): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : 'inf';
  const abs = Math.abs(value);
  switch (type) {
    case 'f':
    case 'F':
      return abs.toFixed(precision ?? 6);
    case '%':
      return `${(abs * 100).toFixed(precision ?? 6)}%`;
    case 'e':
    case 'E': {
      const text = pythonExponent(abs.toExponential(precision ?? 6));
      return type === 'E' ? text.toUpperCase() : text;
    }
    case 'g':
    case 'G': {
      const p = precision === 0 ? 1 : (precision ?? 6);
      const exp = abs === 0 ? 0 : Math.floor(Math.log10(abs));
      let text =
        exp < -4 || exp >= p
          ? pythonExponent(abs.toExponential(p - 1))
          : abs.toFixed(Math.max(0, p - 1 - exp));
      // without `#`, trailing zeros go, and the point with them when nothing is left after it
      if (!alternate) {
        const [mantissa = '', exponent] = text.split('e');
        const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
        text = exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
      }
      return type === 'G' ? text.toUpperCase() : text;
    }
    case 'd':
    case 'n':
      return String(Math.trunc(abs));
    case 'b':
      return (alternate ? '0b' : '') + Math.trunc(abs).toString(2);
    case 'o':
      return (alternate ? '0o' : '') + Math.trunc(abs).toString(8);
    case 'x':
      return (alternate ? '0x' : '') + Math.trunc(abs).toString(16);
    case 'X':
      return (alternate ? '0X' : '') + Math.trunc(abs).toString(16).toUpperCase();
    default:
      // no type: like str() for integers, the shortest repr otherwise; a precision acts like `g`
      return precision === undefined ? String(abs) : formatNumber(abs, 'g', precision, alternate);
  }
}

/** Formats one value with a format spec (the part after `:`). */
export function formatValue(value: unknown, spec: string): string {
  const m = SPEC.exec(spec);
  if (!m) return String(value ?? '');
  const [, fillChar, alignChar, sign, alt, zero, widthText, grouping, precisionText, type = ''] = m;
  const precision = precisionText === undefined ? undefined : Number(precisionText);
  const width = widthText === undefined ? 0 : Number(widthText);
  const numericType = /[bdeEfFgGnoxX%]/.test(type);
  const asNumber =
    typeof value === 'number'
      ? value
      : typeof value === 'boolean'
        ? Number(value)
        : numericType && value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value))
          ? Number(value)
          : undefined;

  let body: string;
  let prefix = '';
  if (asNumber !== undefined && type !== 's' && type !== 'c') {
    body = formatNumber(asNumber, type, precision, Boolean(alt));
    if (grouping) {
      const [int = '', ...rest] = body.split('.');
      const radix = /^0[box]/i.exec(int)?.[0] ?? '';
      body = radix + group(int.slice(radix.length), grouping) + (rest.length ? `.${rest.join('.')}` : '');
    }
    const negative = asNumber < 0 || Object.is(asNumber, -0);
    prefix = negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '';
  } else if (type === 'c' && asNumber !== undefined) {
    body = String.fromCodePoint(asNumber);
  } else {
    body = String(value ?? 'None');
    // Python raises for text with a numeric type; the text is shown unchanged instead
    if (precision !== undefined && !numericType) body = body.slice(0, precision);
  }

  const isNumber = asNumber !== undefined && type !== 's';
  const align = alignChar ?? (zero && isNumber ? '=' : isNumber ? '>' : '<');
  const fill = fillChar ?? (zero && !alignChar ? '0' : ' ');
  const pad = Math.max(0, width - prefix.length - body.length);
  switch (align) {
    case '<':
      return prefix + body + fill.repeat(pad);
    case '^':
      return fill.repeat(Math.floor(pad / 2)) + prefix + body + fill.repeat(Math.ceil(pad / 2));
    case '=':
      return prefix + fill.repeat(pad) + body;
    default:
      return fill.repeat(pad) + prefix + body;
  }
}

function lookupField(name: string, positional: unknown[], named: Record<string, unknown>, next: () => number): unknown {
  const [head = '', ...rest] = name.split(/(?=[.[])/);
  let value: unknown = head === '' ? positional[next()] : /^\d+$/.test(head) ? positional[Number(head)] : named[head];
  for (const part of rest) {
    const key = part.startsWith('[') ? part.slice(1, -1) : part.slice(1);
    value =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[Array.isArray(value) && /^\d+$/.test(key) ? Number(key) : key]
        : undefined;
  }
  return value;
}

/**
 * `template.format(*positional, **named)`. Unknown fields format as empty text instead of raising,
 * because a template should render rather than fail on a missing value.
 */
export function pythonFormat(template: string, positional: unknown[], named: Record<string, unknown> = {}): string {
  let auto = 0;
  const next = () => auto++;
  const render = (text: string): string => {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '}') {
        out += '}';
        if (text[i + 1] === '}') i++;
        continue;
      }
      if (ch !== '{') {
        out += ch;
        continue;
      }
      if (text[i + 1] === '{') {
        out += '{';
        i++;
        continue;
      }
      // the field runs to the matching brace; nested fields may appear in its format spec
      let depth = 1;
      let j = i + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      if (depth > 0) {
        out += text.slice(i);
        break;
      }
      const field = text.slice(i + 1, j - 1);
      const colon = field.indexOf(':');
      const head = colon < 0 ? field : field.slice(0, colon);
      const name = head.replace(/![rsa]$/, '');
      // the outer field takes its automatic number before the fields nested in its spec
      const value = lookupField(name, positional, named, next);
      const spec = colon < 0 ? '' : render(field.slice(colon + 1));
      out += value === undefined ? '' : formatValue(value, spec);
      i = j - 1;
    }
    return out;
  };
  return render(template);
}
