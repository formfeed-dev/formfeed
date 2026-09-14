/**
 * JSON Schema (draft 2020-12) inference from sample data (spec 05 §4). Arrays infer their item
 * schema from every element; objects mark keys present in all samples as required.
 */
export interface JsonSchema {
  $schema?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  examples?: unknown[];
  format?: string;
  additionalProperties?: boolean;
}

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uri = /^https?:\/\/\S+$/;

function typeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value === 'object' ? 'object' : typeof value;
}

function formatOf(value: string): string | undefined {
  if (isoDateTime.test(value)) return 'date-time';
  if (isoDate.test(value)) return 'date';
  if (email.test(value)) return 'email';
  if (uri.test(value)) return 'uri';
  return undefined;
}

function unionTypes(
  a: JsonSchema['type'],
  b: JsonSchema['type'],
): JsonSchema['type'] {
  const set = new Set<string>([
    ...(Array.isArray(a) ? a : a ? [a] : []),
    ...(Array.isArray(b) ? b : b ? [b] : []),
  ]);
  if (set.has('number')) set.delete('integer');
  const list = [...set];
  return list.length === 1 ? list[0] : list;
}

function merge(a: JsonSchema | undefined, b: JsonSchema): JsonSchema {
  if (!a) return b;
  const out: JsonSchema = { type: unionTypes(a.type, b.type) };
  if (a.format && a.format === b.format) out.format = a.format;
  if (a.properties || b.properties) {
    out.properties = { ...a.properties };
    for (const [key, schema] of Object.entries(b.properties ?? {}))
      out.properties[key] = merge(out.properties[key], schema);
    const req = new Set(a.required ?? []);
    out.required = (b.required ?? []).filter((k) => req.has(k));
    if (out.required.length === 0) delete out.required;
  }
  if (a.items || b.items) out.items = merge(a.items, b.items ?? {});
  const examples = [...(a.examples ?? []), ...(b.examples ?? [])].filter(
    (v, i, arr) =>
      arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(v)) === i,
  );
  if (examples.length) out.examples = examples.slice(0, 3);
  return out;
}

function infer(value: unknown): JsonSchema {
  const type = typeOf(value);
  switch (type) {
    case 'array': {
      const items = (value as unknown[]).map(infer);
      const schema: JsonSchema = { type: 'array' };
      if (items.length)
        schema.items = items.reduce<JsonSchema | undefined>(
          (acc, s) => merge(acc, s),
          undefined,
        );
      return schema;
    }
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>))
        properties[key] = infer(v);
      return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: true,
      };
    }
    case 'string': {
      const schema: JsonSchema = { type: 'string', examples: [value] };
      const format = formatOf(value as string);
      if (format) schema.format = format;
      return schema;
    }
    case 'null':
      return { type: 'null' };
    default:
      return { type, examples: [value] };
  }
}

export function inferSchema(sample: unknown): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...infer(sample),
  };
}

/**
 * One schema over several data sets (spec 19 §2.5): a field is required only when every set has
 * it, the way array elements are merged. The editor's "Store as contract" uses it, so a field that
 * only one data set carries becomes optional.
 */
export function inferSchemaFromDataSets(samples: unknown[]): JsonSchema {
  if (samples.length === 0) return inferSchema({});
  const merged = samples
    .map(infer)
    .reduce<JsonSchema | undefined>((acc, s) => merge(acc, s), undefined)!;
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...merged };
}

/** Flat list of dotted paths with their types, for completion items in the editor. */
export function schemaPaths(
  schema: JsonSchema,
  prefix: string[] = [],
): Array<{ path: string[]; type: string; format?: string; example?: unknown }> {
  const out: Array<{
    path: string[];
    type: string;
    format?: string;
    example?: unknown;
  }> = [];
  const type = Array.isArray(schema.type)
    ? schema.type.join(' | ')
    : (schema.type ?? 'any');
  if (prefix.length)
    out.push({
      path: prefix,
      type,
      format: schema.format,
      example: schema.examples?.[0],
    });
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    out.push(...schemaPaths(child, [...prefix, key]));
  if (schema.items) out.push(...schemaPaths(schema.items, [...prefix, '[]']));
  return out;
}

export { diffSchemas } from './schema-diff';
export type { SchemaChange, SchemaChangeKind, SchemaDiff } from './schema-diff';
