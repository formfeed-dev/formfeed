import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyBrand, type BrandContext } from '@formfeed/engine';
import { DevkitError } from './errors';
import type { Project } from './project-config';

/**
 * The organisation's brand kit as `formfeed brand pull` stores it (spec 18 §8): the `GET /brand`
 * response, kept whole in `.formfeed/brand.json` so page defaults and the timestamp survive. Local
 * renders take the template's `brand` from it; without the file they get the empty kit, which is
 * also what an organisation that has set nothing renders with.
 */
export const brandPath = (project: Project) => join(project.root, '.formfeed', 'brand.json');

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The `brand` a template sees, from a stored `GET /brand` body; unknown or malformed fields fall back to the empty kit. */
export function brandFromJson(json: unknown): BrandContext {
  const body = record(json);
  const empty = emptyBrand();
  const colors = Object.fromEntries(Object.entries(record(body['colors'])).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const fonts = record(body['fonts']);
  const logo = record(body['logo']);
  return {
    version: typeof body['version'] === 'number' ? body['version'] : empty.version,
    name: text(body['name']),
    colors,
    fonts: { heading: text(fonts['heading']), body: text(fonts['body']) },
    font_size: text(body['font_size']),
    logo: { primary: text(logo['primary']), inverse: text(logo['inverse']), mark: text(logo['mark']) },
    legal_footer: text(body['legal_footer']),
  };
}

export function readBrand(project: Project): BrandContext {
  const path = brandPath(project);
  if (!existsSync(path)) return emptyBrand();
  try {
    return brandFromJson(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new DevkitError(`.formfeed/brand.json is not valid JSON: ${path} (${e instanceof Error ? e.message : e})`, 'validation');
  }
}

/** Stores a `GET /brand` body; returns the file path. */
export function writeBrand(project: Project, brand: unknown): string {
  mkdirSync(join(project.root, '.formfeed'), { recursive: true });
  const path = brandPath(project);
  writeFileSync(path, JSON.stringify(brand, null, 2) + '\n');
  return path;
}
