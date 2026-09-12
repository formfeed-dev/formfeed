/**
 * The workspace file library (spec 04 §2.3, spec 07 §4). Shared, because four places have to agree
 * on the same key: the gateway (uploads and deletes), the CDN Worker (serves `/a/…`), the app (the
 * files page and the editor preview) and the render-worker (`asset()` and image watermarks).
 *
 * Keys are name-addressed — `a/<workspace_id>/<name>` — because `asset('logo.png')` and the
 * `<base href>` the assembler writes resolve by name. A content hash in the key would make the
 * helper impossible without a lookup table per render.
 */

/** One name segment: starts with a letter or digit, then letters, digits, dot, dash, underscore. */
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*';

/** A file name as templates write it: `logo.png`, `brand/header.svg`. Mirrors the check on `public.files.name`. */
export const ASSET_NAME_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);

/** The largest single file (spec 04: 413 above it). Images and PDFs for merging, not archives. */
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;

/**
 * What the library accepts. Images because templates show them, PDFs because they are merge sources
 * and watermark material. Fonts are not here: an organisation's fonts have their own page, their own
 * table and their own RLS-scoped bucket (spec 05 §6).
 */
export const ASSET_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

/** `true` when the name is one a template can reference and a key can safely be built from. */
export function isAssetName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    ASSET_NAME_PATTERN.test(name) &&
    !name.split('/').includes('..')
  );
}

/**
 * Turns an uploaded file name into a library name: strips a leading slash and any directory the
 * browser sent, lowercases nothing (names are case-sensitive) and replaces every character the
 * pattern does not allow with a dash. Returns null when nothing usable is left.
 */
export function toAssetName(input: string): string | null {
  const cleaned = input
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''))
    .filter(Boolean)
    .join('/');
  return cleaned && isAssetName(cleaned) ? cleaned : null;
}

/** Object key of a library file in the assets bucket. */
export function assetKey(workspaceId: string, name: string): string {
  return `a/${workspaceId}/${name}`;
}

/** Where the workspace's assets are served from; the `<base href>` of every render. */
export function assetBaseUrl(cdnBaseUrl: string, workspaceId: string): string {
  return `${cdnBaseUrl.replace(/\/$/, '')}/a/${workspaceId}`;
}

/** Public URL of one file. Assets are served without a signature (spec 07 §4). */
export function assetUrl(cdnBaseUrl: string, workspaceId: string, name: string): string {
  return `${assetBaseUrl(cdnBaseUrl, workspaceId)}/${name
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}
