import type { Position } from '../types';

/**
 * Where a finding sits in the JSON a data set is written as, so that the editor can mark the place
 * and the CLI can print `data/default.json:38:5` instead of a path to count out by hand.
 *
 * `JSON.parse` keeps no positions, so the text is walked here. It only has to find its way through
 * JSON that already parsed, not to judge it: anything unexpected ends the walk and the answer is
 * what was reached until then.
 */

export interface JsonLocation extends Position {
  /** How many segments of the path exist in the text; fewer than asked means the rest is missing. */
  depth: number;
}

/** `lines[1].tax.rate` as the keys and indexes it names. */
export function invoicePathSegments(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path.split('.')) {
    if (!part) continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      segments.push(part);
      continue;
    }
    if (match[1]) segments.push(match[1]);
    for (const index of match[2]?.matchAll(/\[(\d+)\]/g) ?? [])
      segments.push(Number(index[1]));
  }
  return segments;
}

/**
 * The position of `path` in `text`: of the key (or the list item) the path ends on, or, when the
 * text does not go that far, of the deepest part that is there. A field that is missing is thereby
 * marked at the object it is missing from. `null` when the text has no value at all.
 */
export function locateJsonPath(
  text: string,
  path: ReadonlyArray<string | number>,
): JsonLocation | null {
  let offset = skipSpace(text, 0);
  if (offset >= text.length) return null;
  let best = { offset, depth: 0 };
  try {
    for (let depth = 0; depth < path.length; depth += 1) {
      const segment = path[depth];
      const found =
        typeof segment === 'number'
          ? arrayItem(text, offset, segment)
          : objectMember(text, offset, String(segment));
      if (!found) break;
      best = { offset: found.at, depth: depth + 1 };
      offset = found.value;
    }
  } catch {
    // text that is not JSON after all: what was found until here stands
  }
  return { ...positionAt(text, best.offset), depth: best.depth };
}

function positionAt(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1)
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  return { line, column: offset - lineStart + 1 };
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  return i;
}

/** The index after the string that opens at `from`. */
function stringEnd(text: string, from: number): number {
  if (text[from] !== '"') throw new Error('string');
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error('string');
}

/** The index after the value that starts at `from`, whatever it is. */
function valueEnd(text: string, from: number): number {
  const start = skipSpace(text, from);
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']';
    let i = skipSpace(text, start + 1);
    if (text[i] === close) return i + 1;
    for (;;) {
      if (first === '{') {
        i = skipSpace(text, stringEnd(text, skipSpace(text, i)));
        if (text[i] !== ':') throw new Error('colon');
        i += 1;
      }
      i = skipSpace(text, valueEnd(text, i));
      if (text[i] === close) return i + 1;
      if (text[i] !== ',') throw new Error('comma');
      i += 1;
    }
  }
  // a number, true, false or null runs to the next delimiter
  let i = start;
  while (i < text.length && !/[\s,\]}]/.test(text[i] ?? '')) i += 1;
  if (i === start) throw new Error('value');
  return i;
}

/** In the object at `from`: where the member `key` starts and where its value does. */
function objectMember(
  text: string,
  from: number,
  key: string,
): { at: number; value: number } | null {
  const start = skipSpace(text, from);
  if (text[start] !== '{') return null;
  let i = skipSpace(text, start + 1);
  while (text[i] !== '}') {
    const at = skipSpace(text, i);
    const end = stringEnd(text, at);
    const colon = skipSpace(text, end);
    if (text[colon] !== ':') throw new Error('colon');
    const value = skipSpace(text, colon + 1);
    // the key as JSON reads it, so an escaped character in it still matches
    if (JSON.parse(text.slice(at, end)) === key) return { at, value };
    i = skipSpace(text, valueEnd(text, value));
    if (text[i] === ',') i = skipSpace(text, i + 1);
    else if (text[i] !== '}') throw new Error('comma');
  }
  return null;
}

/** In the list at `from`: where item `index` starts. */
function arrayItem(
  text: string,
  from: number,
  index: number,
): { at: number; value: number } | null {
  const start = skipSpace(text, from);
  if (text[start] !== '[') return null;
  let i = skipSpace(text, start + 1);
  for (let n = 0; text[i] !== ']'; n += 1) {
    const at = skipSpace(text, i);
    if (n === index) return { at, value: at };
    i = skipSpace(text, valueEnd(text, at));
    if (text[i] === ',') i = skipSpace(text, i + 1);
    else if (text[i] !== ']') throw new Error('comma');
  }
  return null;
}
