/**
 * Compares two data schemas from the caller's point of view (spec 19 §3.1): the caller sends data,
 * the template reads it. A change is breaking when data that fitted the previous schema may no
 * longer fit the next one. Keywords this module does not analyse compare by deep equality and count
 * as breaking when they differ, so the check asks rather than waves a change through.
 *
 * Worker-safe (no Node APIs): the gateway runs it before publishing and before moving a channel.
 */

export type SchemaChangeKind =
  | 'field-added-required'
  | 'field-added-optional'
  | 'field-removed'
  | 'field-became-required'
  | 'field-became-optional'
  | 'type-narrowed'
  | 'type-widened'
  | 'enum-values-removed'
  | 'enum-values-added'
  | 'enum-added'
  | 'enum-removed'
  | 'const-changed'
  | 'constraint-tightened'
  | 'constraint-relaxed'
  | 'additional-properties-closed'
  | 'additional-properties-opened'
  | 'keyword-changed';

export interface SchemaChange {
  /** Dotted field path (`customer.email`, `items[]`); empty for the root. */
  path: string;
  /** JSON pointer into the next schema (or the previous one for a removal). */
  pointer: string;
  kind: SchemaChangeKind;
  breaking: boolean;
  message: string;
}

export interface SchemaDiff {
  breaking: SchemaChange[];
  safe: SchemaChange[];
}

type Schema = Record<string, unknown>;

/** Keywords that describe rather than constrain; changing them never affects a caller. */
const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$anchor',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** A higher value accepts less. */
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
/** A lower value accepts less. */
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];

/** Keywords the walk below analyses itself. */
const ANALYSED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'format',
  'pattern',
  '$ref',
  '$defs',
  'definitions',
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
]);

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

/** `type` as a set; null means "any type". `integer` is a subset of `number`. */
function typesOf(schema: Schema): Set<string> | null {
  const t = schema['type'];
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  return null;
}

function accepts(types: Set<string> | null, type: string): boolean {
  if (types === null) return true;
  return types.has(type) || (type === 'integer' && types.has('number'));
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

interface Location {
  path: string;
  pointer: string;
}

const child = (at: Location, key: string): Location => ({
  path: at.path ? `${at.path}.${key}` : key,
  pointer: `${at.pointer}/properties/${escapePointer(key)}`,
});

const itemsOf = (at: Location): Location => ({
  path: `${at.path}[]`,
  pointer: `${at.pointer}/items`,
});

const label = (at: Location) => (at.path ? `"${at.path}"` : 'the data');

class Walker {
  readonly changes: SchemaChange[] = [];
  private readonly depthLimit = 64;

  constructor(
    private readonly previousRoot: Schema,
    private readonly nextRoot: Schema,
  ) {}

  add(at: Location, kind: SchemaChangeKind, breaking: boolean, message: string): void {
    this.changes.push({ path: at.path, pointer: at.pointer || '/', kind, breaking, message });
  }

  /** Follows a local `$ref` (`#/$defs/x`, `#/definitions/x`) so both sides compare their targets. */
  resolve(schema: Schema, root: Schema, depth: number): Schema {
    let current = schema;
    for (let hops = 0; hops < 16 && typeof current['$ref'] === 'string'; hops++) {
      const ref = current['$ref'] as string;
      if (!ref.startsWith('#/') || depth > this.depthLimit) return current;
      const target = ref
        .slice(2)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<unknown>((node, part) => (isObject(node) ? node[part] : undefined), root);
      if (!isObject(target)) return current;
      const { $ref: _ref, ...rest } = current;
      void _ref;
      current = { ...target, ...rest };
    }
    return current;
  }

  compare(previousRaw: unknown, nextRaw: unknown, at: Location, depth = 0): void {
    if (depth > this.depthLimit) return;
    // `true` / `{}` accept anything, `false` accepts nothing
    const previous = this.resolve(schemaOf(previousRaw), this.previousRoot, depth);
    const next = this.resolve(schemaOf(nextRaw), this.nextRoot, depth);
    if (previousRaw === false && nextRaw !== false) {
      this.add(at, 'type-widened', false, `${label(at)} is accepted again`);
      return;
    }
    if (nextRaw === false && previousRaw !== false) {
      this.add(at, 'type-narrowed', true, `${label(at)} is no longer accepted`);
      return;
    }

    this.compareTypes(previous, next, at);
    this.compareEnum(previous, next, at);
    this.compareBounds(previous, next, at);
    this.compareExact(previous, next, at, 'format');
    this.compareExact(previous, next, at, 'pattern');
    this.compareObject(previous, next, at, depth);
    if ('items' in previous || 'items' in next)
      this.compare(previous['items'] ?? true, next['items'] ?? true, itemsOf(at), depth + 1);
    this.compareUnknown(previous, next, at);
  }

  private compareTypes(previous: Schema, next: Schema, at: Location): void {
    const before = typesOf(previous);
    const after = typesOf(next);
    const lost = before === null ? (after === null ? [] : ['any']) : [...before].filter((t) => !accepts(after, t));
    const gained =
      after === null ? (before === null ? [] : ['any']) : [...after].filter((t) => !accepts(before, t));
    if (lost.length)
      this.add(
        at,
        'type-narrowed',
        true,
        `${label(at)} no longer accepts ${lost.join(', ')} (now ${after ? [...after].join(' | ') : 'any'})`,
      );
    else if (gained.length)
      this.add(at, 'type-widened', false, `${label(at)} also accepts ${gained.join(', ')}`);
  }

  private compareEnum(previous: Schema, next: Schema, at: Location): void {
    const before = Array.isArray(previous['enum']) ? previous['enum'] : null;
    const after = Array.isArray(next['enum']) ? next['enum'] : null;
    if (!before && after) this.add(at, 'enum-added', true, `${label(at)} is limited to ${after.map(show).join(', ')}`);
    else if (before && !after) this.add(at, 'enum-removed', false, `${label(at)} is no longer limited to a list of values`);
    else if (before && after) {
      const removed = before.filter((v) => !after.some((w) => equal(v, w)));
      const added = after.filter((v) => !before.some((w) => equal(v, w)));
      if (removed.length)
        this.add(at, 'enum-values-removed', true, `${label(at)} no longer accepts ${removed.map(show).join(', ')}`);
      if (added.length)
        this.add(at, 'enum-values-added', false, `${label(at)} also accepts ${added.map(show).join(', ')}`);
    }
    if ('const' in next && (!('const' in previous) || !equal(previous['const'], next['const'])))
      this.add(at, 'const-changed', true, `${label(at)} must be ${show(next['const'])}`);
    else if ('const' in previous && !('const' in next))
      this.add(at, 'const-changed', false, `${label(at)} is no longer fixed to ${show(previous['const'])}`);
  }

  private compareBounds(previous: Schema, next: Schema, at: Location): void {
    for (const keyword of LOWER_BOUNDS) {
      const before = numberOr(previous[keyword], null);
      const after = numberOr(next[keyword], null);
      if (after !== null && (before === null || after > before))
        this.add(at, 'constraint-tightened', true, `${label(at)}: ${keyword} ${before ?? 'none'} → ${after}`);
      else if (before !== null && (after === null || after < before))
        this.add(at, 'constraint-relaxed', false, `${label(at)}: ${keyword} ${before} → ${after ?? 'none'}`);
    }
    for (const keyword of UPPER_BOUNDS) {
      const before = numberOr(previous[keyword], null);
      const after = numberOr(next[keyword], null);
      if (after !== null && (before === null || after < before))
        this.add(at, 'constraint-tightened', true, `${label(at)}: ${keyword} ${before ?? 'none'} → ${after}`);
      else if (before !== null && (after === null || after > before))
        this.add(at, 'constraint-relaxed', false, `${label(at)}: ${keyword} ${before} → ${after ?? 'none'}`);
    }
  }

  private compareExact(previous: Schema, next: Schema, at: Location, keyword: 'format' | 'pattern'): void {
    const before = previous[keyword];
    const after = next[keyword];
    if (after !== undefined && !equal(before, after))
      this.add(at, 'constraint-tightened', true, `${label(at)}: ${keyword} ${before === undefined ? 'none' : show(before)} → ${show(after)}`);
    else if (before !== undefined && after === undefined)
      this.add(at, 'constraint-relaxed', false, `${label(at)}: ${keyword} ${show(before)} removed`);
  }

  private compareObject(previous: Schema, next: Schema, at: Location, depth: number): void {
    const beforeProps = isObject(previous['properties']) ? previous['properties'] : {};
    const afterProps = isObject(next['properties']) ? next['properties'] : {};
    const beforeRequired = new Set(stringList(previous['required']));
    const afterRequired = new Set(stringList(next['required']));
    const closedBefore = previous['additionalProperties'] === false;
    const closedAfter = next['additionalProperties'] === false;

    if (!closedBefore && closedAfter)
      this.add(at, 'additional-properties-closed', true, `${label(at)} no longer accepts fields the schema does not list`);
    else if (closedBefore && !closedAfter)
      this.add(at, 'additional-properties-opened', false, `${label(at)} accepts fields the schema does not list`);
    else if (isObject(previous['additionalProperties']) || isObject(next['additionalProperties']))
      this.compare(
        previous['additionalProperties'] ?? true,
        next['additionalProperties'] ?? true,
        { path: at.path ? `${at.path}.*` : '*', pointer: `${at.pointer}/additionalProperties` },
        depth + 1,
      );

    const keys = new Set([...Object.keys(beforeProps), ...Object.keys(afterProps), ...beforeRequired, ...afterRequired]);
    for (const key of [...keys].sort()) {
      const where = child(at, key);
      const inBefore = key in beforeProps || beforeRequired.has(key);
      const inAfter = key in afterProps || afterRequired.has(key);
      if (!inBefore && inAfter) {
        if (afterRequired.has(key)) this.add(where, 'field-added-required', true, `New required field ${label(where)}`);
        else this.add(where, 'field-added-optional', false, `New optional field ${label(where)}`);
        continue;
      }
      if (inBefore && !inAfter) {
        // callers may still send it; only a closed object turns that into a rejection
        if (closedAfter)
          this.add(where, 'field-removed', true, `${label(where)} was removed and ${label(at)} accepts no unlisted fields`);
        else this.add(where, 'field-removed', false, `${label(where)} is no longer in the schema`);
        continue;
      }
      if (!beforeRequired.has(key) && afterRequired.has(key))
        this.add(where, 'field-became-required', true, `${label(where)} is now required`);
      else if (beforeRequired.has(key) && !afterRequired.has(key))
        this.add(where, 'field-became-optional', false, `${label(where)} is now optional`);
      this.compare(beforeProps[key] ?? true, afterProps[key] ?? true, where, depth + 1);
    }
  }

  private compareUnknown(previous: Schema, next: Schema, at: Location): void {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const keyword of [...keys].sort()) {
      if (ANNOTATIONS.has(keyword) || ANALYSED.has(keyword)) continue;
      if (!equal(previous[keyword], next[keyword]))
        this.add(at, 'keyword-changed', true, `${label(at)}: "${keyword}" changed (not analysed, treated as breaking)`);
    }
  }
}

function schemaOf(value: unknown): Schema {
  if (isObject(value)) return value;
  return {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * The changes from `previous` to `next`, split into breaking and safe. `null` on either side means
 * "no schema": nothing to compare, so the result is empty.
 */
export function diffSchemas(previous: unknown, next: unknown): SchemaDiff {
  if (!isObject(previous) || !isObject(next)) return { breaking: [], safe: [] };
  const walker = new Walker(previous, next);
  walker.compare(previous, next, { path: '', pointer: '' });
  return {
    breaking: walker.changes.filter((c) => c.breaking),
    safe: walker.changes.filter((c) => !c.breaking),
  };
}
