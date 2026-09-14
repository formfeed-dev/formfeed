/**
 * Shape-keeping redaction of render data (spec 20 §3.3), for `formfeed renders pull --redact`.
 *
 * Strings become placeholders of the same length that keep the character classes: upper-case
 * letters become `A`, other letters `a`, digits `0`, and everything else (spaces, `@`, `.`, `-`)
 * stays, so `jane@acme.com` becomes `aaaa@aaaa.aaa` and `DE89 3704` becomes `AA00 0000`. Numbers,
 * booleans and null are kept: they are usually what made the render go wrong, and they rarely
 * identify a person. Arrays and objects keep their keys and lengths.
 *
 * Paths select what is redacted, from the root of the data: dotted segments (`customer.email`),
 * `*` for any one key or array item (`customer.*`), and `[]` for every item of an array
 * (`items[].name`, the same as `items.*.name`). A path that ends on an object or array redacts
 * everything below it. Without paths (or with an empty list) the whole data set is redacted.
 */
export function redactData<T>(value: T, paths?: readonly string[]): T {
  if (!paths || paths.length === 0) return redactAll(value) as T;
  return walk(value, paths.map(parseRedactPath)) as T;
}

/** A placeholder of the same length with the character classes of `text` kept. */
export function redactString(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/\p{Lu}/u.test(ch)) out += 'A';
    else if (/\p{L}/u.test(ch)) out += 'a';
    else if (/\p{N}/u.test(ch)) out += '0';
    else out += ch;
  }
  return out;
}

/** `items[].name` → `['items', '*', 'name']`; `lines[0].qty` → `['lines', '0', 'qty']`. */
export function parseRedactPath(path: string): string[] {
  const segments: string[] = [];
  for (const part of path.trim().split('.')) {
    if (part === '') continue;
    const match = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!match) {
      segments.push(part);
      continue;
    }
    if (match[1]) segments.push(match[1]);
    for (const index of match[2]!.match(/\[[^\]]*\]/g) ?? []) {
      const inner = index.slice(1, -1).trim();
      segments.push(inner === '' || inner === '*' ? '*' : inner);
    }
  }
  return segments;
}

function redactAll(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactAll);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAll(v)]));
  return value;
}

function walk(value: unknown, patterns: string[][]): unknown {
  if (patterns.some((p) => p.length === 0)) return redactAll(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const next = advance(patterns, String(index));
      return next.length ? walk(item, next) : item;
    });
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const next = advance(patterns, key);
        return [key, next.length ? walk(item, next) : item];
      }),
    );
  }
  // a path that continues below a string, number or null selects nothing
  return value;
}

function advance(patterns: string[][], key: string): string[][] {
  return patterns.filter((p) => p[0] === '*' || p[0] === key).map((p) => p.slice(1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
