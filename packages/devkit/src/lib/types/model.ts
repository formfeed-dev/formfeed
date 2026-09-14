/**
 * The language-neutral model `formfeed types` emits from (spec 19 §2.4): each template's data schema
 * becomes a tree of type nodes plus the named objects it refers to, so the TypeScript and Python
 * emitters share one reading of JSON Schema and differ only in spelling.
 */

export type TypeNode =
  | { kind: 'unknown'; note?: string }
  | { kind: 'never' }
  | { kind: 'primitive'; name: 'string' | 'number' | 'integer' | 'boolean' | 'null' }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'array'; items: TypeNode }
  | { kind: 'record'; values: TypeNode }
  | { kind: 'ref'; name: string }
  | { kind: 'union'; members: TypeNode[] }
  | { kind: 'intersection'; members: TypeNode[] };

export interface Field {
  key: string;
  type: TypeNode;
  required: boolean;
  doc: string[];
}

export interface NamedObject {
  name: string;
  doc: string[];
  fields: Field[];
  /** Type of properties the schema does not list, when `additionalProperties` is a schema. */
  extra: TypeNode | null;
}

/** Where a template's schema came from; the header of the generated file says it per template. */
export type SchemaOrigin = 'local' | 'stored' | 'inferred';

export interface TypeSource {
  slug: string;
  schema: Record<string, unknown>;
  origin: SchemaOrigin;
  /** The version the schema belongs to, for the header. */
  version?: number | null;
  channel?: string | null;
}

export interface TemplateTypes {
  slug: string;
  origin: SchemaOrigin;
  version: number | null;
  channel: string | null;
  /** The name the data type is exported under (`InvoiceData`). */
  rootName: string;
  /** The data type; a `ref` to `rootName` when the schema is an object. */
  root: TypeNode;
  /** Named objects in the order they were first met, the root first. */
  objects: NamedObject[];
}

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords whose meaning the types cannot express; they are listed in a doc comment instead. */
const UNSUPPORTED = [
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'prefixItems',
  'contains',
  'dependentSchemas',
  'dependentRequired',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
];

export function pascalCase(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const joined = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  if (!joined) return 'Field';
  return /^[0-9]/.test(joined) ? `T${joined}` : joined;
}

/** `items` → `Item`, `addresses` → `Address`, `entries` → `Entry`; null when the word is not a plural. */
export function singular(word: string): string | null {
  if (/ies$/i.test(word) && word.length > 3) return word.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/[^su]s$/i.test(word)) return word.slice(0, -1);
  return null;
}

/** Names already handed out in one generated file; a clash gets a number. */
export class NameRegistry {
  private readonly used = new Set<string>();

  constructor(reserved: Iterable<string> = []) {
    for (const name of reserved) this.used.add(name);
  }

  claim(wanted: string): string {
    let name = wanted;
    for (let i = 2; this.used.has(name); i++) name = `${wanted}${i}`;
    this.used.add(name);
    return name;
  }
}

/** An inferred schema knows which fields the sample had, not which the template needs: all optional. */
export function relaxRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxRequired);
  if (!isObject(schema)) return schema;
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required') continue;
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      out[key] = isObject(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relaxRequired(v)]))
        : value;
    } else if (key === 'examples' || key === 'enum' || key === 'const' || key === 'default') {
      out[key] = value;
    } else {
      out[key] = relaxRequired(value);
    }
  }
  return out;
}

function docOf(schema: Schema): string[] {
  const lines: string[] = [];
  if (typeof schema['title'] === 'string' && schema['title'] !== schema['description']) lines.push(schema['title']);
  if (typeof schema['description'] === 'string') lines.push(...schema['description'].split('\n'));
  if (typeof schema['format'] === 'string') lines.push(`Format: ${schema['format']}`);
  const unsupported = UNSUPPORTED.filter((k) => k in schema);
  if (unsupported.length) lines.push(`Not expressed in the types: ${unsupported.join(', ')}`);
  if (Array.isArray(schema['examples']) && schema['examples'].length)
    lines.push(`@example ${JSON.stringify(schema['examples'][0])}`);
  if (schema['deprecated'] === true) lines.push('@deprecated');
  return lines;
}

class Builder {
  readonly objects: NamedObject[] = [];
  private readonly defs = new Map<string, string>();
  private rootName = '';

  constructor(
    private readonly root: Schema,
    private readonly base: string,
    private readonly names: NameRegistry,
  ) {}

  /**
   * A plain object schema becomes the interface `rootName` itself; anything else (a nullable object,
   * a union, an array) becomes an alias of that name, so the root never names two things.
   */
  build(rootName: string): TypeNode {
    this.rootName = rootName;
    const s = this.root;
    const plainObject =
      (s['type'] === 'object' || (s['type'] === undefined && isObject(s['properties']))) &&
      isObject(s['properties']) &&
      Object.keys(s['properties']).length > 0 &&
      !['$ref', 'const', 'enum', 'anyOf', 'oneOf', 'allOf'].some((k) => k in s);
    return this.convert(s, null, null, plainObject ? rootName : undefined);
  }

  /**
   * `owner` + `key` name the objects found below: property `customer` of `Invoice` is
   * `InvoiceCustomer`, an element of `items` is `InvoiceItem`. `exact` forces a name (the root).
   */
  convert(raw: unknown, owner: string | null, key: string | null, exact?: string, depth = 0): TypeNode {
    if (raw === true || raw === undefined) return { kind: 'unknown' };
    if (raw === false) return { kind: 'never' };
    if (!isObject(raw) || depth > 48) return { kind: 'unknown' };
    const schema = raw;

    if (typeof schema['$ref'] === 'string') return this.reference(schema['$ref']);
    if ('const' in schema) return literal(schema['const']);
    if (Array.isArray(schema['enum'])) {
      const members = schema['enum'].map(literal);
      return members.length === 1 ? members[0]! : { kind: 'union', members };
    }
    for (const combinator of ['anyOf', 'oneOf'] as const) {
      const list = schema[combinator];
      if (Array.isArray(list) && list.length) {
        const members = list.map((option, i) =>
          this.convert(option, owner, key === null ? `Option${i + 1}` : `${key}Option${i + 1}`, undefined, depth + 1),
        );
        return union(members);
      }
    }
    if (Array.isArray(schema['allOf']) && schema['allOf'].length) {
      const members = schema['allOf'].map((part, i) =>
        this.convert(part, owner, key === null ? `Part${i + 1}` : `${key}Part${i + 1}`, undefined, depth + 1),
      );
      return members.length === 1 ? members[0]! : { kind: 'intersection', members };
    }

    const declared = typeof schema['type'] === 'string' ? [schema['type']] : Array.isArray(schema['type']) ? schema['type'] : null;
    const types =
      declared ??
      (isObject(schema['properties']) || isObject(schema['additionalProperties'])
        ? ['object']
        : 'items' in schema
          ? ['array']
          : null);
    if (!types) {
      const unsupported = UNSUPPORTED.filter((k) => k in schema);
      return unsupported.length ? { kind: 'unknown', note: unsupported.join(', ') } : { kind: 'unknown' };
    }
    const members = types.map((type): TypeNode => {
      switch (type) {
        case 'object':
          return this.object(schema, owner, key, exact, depth);
        case 'array':
          return { kind: 'array', items: this.convert(schema['items'], owner, itemKey(key), undefined, depth + 1) };
        case 'string':
        case 'number':
        case 'integer':
        case 'boolean':
        case 'null':
          return { kind: 'primitive', name: type };
        default:
          return { kind: 'unknown' };
      }
    });
    return union(members);
  }

  private object(schema: Schema, owner: string | null, key: string | null, exact: string | undefined, depth: number): TypeNode {
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    const additional = schema['additionalProperties'];
    const extra = isObject(additional) ? this.convert(additional, owner, `${key ?? ''}Value`, undefined, depth + 1) : null;
    if (Object.keys(properties).length === 0) return { kind: 'record', values: extra ?? { kind: 'unknown' } };

    const name = exact ?? this.names.claim(`${owner ?? this.base}${key === null ? '' : pascalCase(key)}`);
    const target: NamedObject = { name, doc: docOf(schema), fields: [], extra };
    this.objects.push(target);
    const required = new Set(Array.isArray(schema['required']) ? schema['required'] : []);
    // nested names hang off the template's base name (`InvoiceCustomer`), not off `InvoiceData`
    const nestedOwner = name === this.rootName ? this.base : name;
    for (const [field, child] of Object.entries(properties)) {
      target.fields.push({
        key: field,
        type: this.convert(child, nestedOwner, field, undefined, depth + 1),
        required: required.has(field),
        doc: isObject(child) ? docOf(child) : [],
      });
    }
    return { kind: 'ref', name };
  }

  private reference(ref: string): TypeNode {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!match) return { kind: 'unknown', note: `$ref ${ref}` };
    const known = this.defs.get(ref);
    if (known) return { kind: 'ref', name: known };
    const section = this.root[match[1]!];
    const target = isObject(section) ? section[decodePointer(match[2]!)] : undefined;
    if (!isObject(target)) return { kind: 'unknown', note: `$ref ${ref}` };
    const hasProperties = isObject(target['properties']) && Object.keys(target['properties']).length > 0;
    if (!hasProperties) return this.convert(target, this.base, decodePointer(match[2]!));
    // register before converting, so a recursive definition refers to itself by name
    const name = this.names.claim(`${this.base}${pascalCase(decodePointer(match[2]!))}`);
    this.defs.set(ref, name);
    this.convert(target, null, null, name);
    return { kind: 'ref', name };
  }
}

const decodePointer = (part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~');

function itemKey(key: string | null): string | null {
  if (key === null) return 'Item';
  return singular(key) ?? `${key}Item`;
}

function literal(value: unknown): TypeNode {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return { kind: 'literal', value };
  return { kind: 'unknown' };
}

function union(members: TypeNode[]): TypeNode {
  const flat: TypeNode[] = [];
  for (const member of members) {
    if (member.kind === 'union') flat.push(...member.members);
    else flat.push(member);
  }
  if (flat.some((m) => m.kind === 'unknown')) return { kind: 'unknown' };
  const unique = flat.filter((m, i) => flat.findIndex((n) => JSON.stringify(n) === JSON.stringify(m)) === i);
  return unique.length === 1 ? unique[0]! : { kind: 'union', members: unique };
}

/** Builds the model for a set of templates; names are unique across the whole file. */
export function buildTypes(sources: TypeSource[], reserved: Iterable<string> = []): TemplateTypes[] {
  const names = new NameRegistry(reserved);
  return [...sources]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((source) => {
      const schema = (source.origin === 'inferred' ? relaxRequired(source.schema) : source.schema) as Schema;
      const base = pascalCase(source.slug);
      const rootName = names.claim(`${base}Data`);
      const builder = new Builder(schema, base, names);
      const root = builder.build(rootName);
      // a schema that is not an object with properties still gets its exported name, as an alias
      return {
        slug: source.slug,
        origin: source.origin,
        version: source.version ?? null,
        channel: source.channel ?? null,
        rootName,
        root,
        objects: builder.objects,
      };
    });
}

export function originNote(t: Pick<TemplateTypes, 'origin' | 'version' | 'channel'>): string {
  switch (t.origin) {
    case 'local':
      return 'schema.json of the project';
    case 'stored':
      return `stored schema of version ${t.version ?? '?'}${t.channel ? ` (channel ${t.channel})` : ''}`;
    case 'inferred':
      return 'inferred from sample data, every field optional: store a schema to make this a contract';
  }
}
