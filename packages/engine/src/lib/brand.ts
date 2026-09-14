import type { PartialResolver } from './types';

/**
 * The organisation's brand kit as a template sees it (spec 18 §2.1): `brand.colors.primary`,
 * `brand.logo.mark`, `brand.legal_footer`. Unset values are `null`; `colors` is always an object.
 */
export interface BrandContext {
  version: number;
  name: string | null;
  colors: Record<string, string>;
  fonts: { heading: string | null; body: string | null };
  font_size: string | null;
  logo: { primary: string | null; inverse: string | null; mark: string | null };
  legal_footer: string | null;
}

/** The `brand` of an organisation that has set nothing, and of local renders without a pulled kit. */
export function emptyBrand(): BrandContext {
  return {
    version: 0,
    name: null,
    colors: {},
    fonts: { heading: null, body: null },
    font_size: null,
    logo: { primary: null, inverse: null, mark: null },
    legal_footer: null,
  };
}

const token = /^[a-z][a-z0-9-]{0,31}$/;
const colour = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const fontSize = /^\d{1,2}(?:\.\d{1,2})?(?:pt|px)$/;

/** A family name as a CSS string; quotes and backslashes cannot leave it. */
const cssFamily = (family: string) => `"${family.replace(/["\\<>\n\r]/g, '')}"`;

/**
 * The `--brand-*` custom properties of spec 18 §2.2. Values are validated again here, because the
 * stylesheet sits in a `<style>` element and a kit from a pulled file or an old cache is still input.
 */
export function brandCss(brand: BrandContext | undefined): string {
  if (!brand) return '';
  const vars: string[] = [];
  for (const [name, value] of Object.entries(brand.colors ?? {}))
    if (token.test(name) && colour.test(value)) vars.push(`--brand-color-${name}: ${value};`);
  if (brand.fonts?.heading) vars.push(`--brand-font-heading: ${cssFamily(brand.fonts.heading)};`);
  if (brand.fonts?.body) vars.push(`--brand-font-body: ${cssFamily(brand.fonts.body)};`);
  if (brand.font_size && fontSize.test(brand.font_size)) vars.push(`--brand-font-size: ${brand.font_size};`);
  return vars.length ? `:root { ${vars.join(' ')} }` : '';
}

/** The family names a kit names, so `fontFaceCss` injects their faces even behind `var(--brand-font-*)`. */
export function brandFontFamilies(brand: BrandContext | undefined): string {
  return [brand?.fonts?.heading, brand?.fonts?.body].filter(Boolean).join('\n');
}

/**
 * The name a shared partial is matched by (spec 18 §2.3): lowercase, one template file extension
 * removed. `@formfeed/api-types` and the database (`private.normalise_partial_name`) keep copies.
 */
export function normalisePartialName(name: string): string {
  return name.replace(/\.(?:html|htm|j2|njk|jinja|liquid|hbs|handlebars)$/i, '').toLowerCase();
}

/** A shared partial as hosts pass it: its source and the version a render records. */
export interface SharedPartial {
  source: string;
  version: number;
}

/**
 * One resolver over both kinds of partial: the version's own by exact name first, then the
 * organisation's shared ones by normalised name. `onShared` hears every shared partial that was
 * actually read, which is what the render-worker records for reproducibility.
 */
export function layeredPartials(
  own: Record<string, string> | undefined,
  shared: Record<string, SharedPartial> | undefined,
  onShared?: (name: string, partial: SharedPartial) => void,
): PartialResolver {
  const byName = new Map<string, [string, SharedPartial]>();
  for (const [name, partial] of Object.entries(shared ?? {}))
    byName.set(normalisePartialName(name), [name, partial]);
  return (name) => {
    if (own && Object.prototype.hasOwnProperty.call(own, name)) return own[name];
    const hit = byName.get(normalisePartialName(name));
    if (!hit) return undefined;
    onShared?.(hit[0], hit[1]);
    return hit[1].source;
  };
}
