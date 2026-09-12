import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ASSET_CONTENT_TYPES, ASSET_MAX_BYTES, isAssetName } from '@formfeed/api-types';
import { DevkitError } from './errors';
import type { Project } from './project-config';

/**
 * The project's `files/` folder: the local copy of the workspace file library (spec 04 §2.3). A
 * file's path below the folder is its library name, so `files/brand/logo.png` is what a template
 * reaches with `asset('brand/logo.png')`, locally in `formfeed dev` and remotely after `files push`.
 */
export interface LocalFile {
  /** The library name: the path below the files folder, with `/`. */
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  /** From the extension; null for a type the library does not take. */
  contentType: string | null;
}

export interface LocalFileListing {
  files: LocalFile[];
  /** Paths the library would refuse: an unusable name, an unknown type, too large or empty. */
  skipped: Array<{ path: string; reason: string }>;
}

const byExtension: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_CONTENT_TYPES).map(([type, ext]) => [ext, type]),
);
byExtension['jpeg'] = 'image/jpeg';

/** The content type the library stores for a name, going by its extension. */
export function contentTypeFor(name: string): string | null {
  return byExtension[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export function sha256File(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file below the files folder, with the ones the library would refuse listed apart. */
export function listLocalFiles(project: Project): LocalFileListing {
  const listing: LocalFileListing = { files: [], skipped: [] };
  if (!existsSync(project.filesDir)) return listing;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = relative(project.filesDir, path).split(sep).join('/');
      const size = statSync(path).size;
      const contentType = contentTypeFor(name);
      const reason = !isAssetName(name)
        ? 'the name has characters a library name cannot have (letters, digits, dot, dash, underscore)'
        : !contentType
          ? 'not an image or a PDF'
          : size === 0
            ? 'empty'
            : size > ASSET_MAX_BYTES
              ? `larger than ${ASSET_MAX_BYTES / 1024 / 1024} MB`
              : null;
      if (reason) {
        listing.skipped.push({ path, reason });
        continue;
      }
      const bytes = readFileSync(path);
      listing.files.push({ name, path, bytes: size, sha256: sha256File(bytes), contentType });
    }
  };
  walk(project.filesDir);
  listing.files.sort((a, b) => a.name.localeCompare(b.name));
  return listing;
}

/** The path of a library name inside the files folder; refuses a name that would leave it. */
export function localFilePath(project: Project, name: string): string {
  if (!isAssetName(name)) throw new DevkitError(`"${name}" is not a library file name`);
  const path = resolve(project.filesDir, ...name.split('/'));
  if (!path.startsWith(resolve(project.filesDir) + sep)) throw new DevkitError(`"${name}" is not inside the files folder`);
  return path;
}

/** Writes a pulled file below the files folder, creating folders for names like `brand/logo.png`. */
export function writeLocalFile(project: Project, name: string, bytes: Uint8Array): string {
  const path = localFilePath(project, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}
