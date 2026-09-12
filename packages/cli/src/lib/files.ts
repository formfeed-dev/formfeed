import type { Formfeed, LibraryFile } from '@formfeed/sdk-ts';
import type { LocalFile } from '@formfeed/devkit';

export type FileSyncStatus = 'new' | 'modified' | 'unchanged';

export interface FilePlanRow {
  name: string;
  status: FileSyncStatus;
}

/**
 * What `files push` would upload: a local file the library does not have, or has with other bytes.
 * The comparison is the sha256 the API reports, so an unchanged file is never uploaded again and the
 * CDN cache of its name stays warm.
 */
export function planPush(local: LocalFile[], remote: LibraryFile[]): FilePlanRow[] {
  const byName = new Map(remote.map((f) => [f.name, f]));
  return local.map((file) => {
    const known = byName.get(file.name);
    return { name: file.name, status: !known ? 'new' : known.sha256 === file.sha256 ? 'unchanged' : 'modified' };
  });
}

/** What `files pull` would download: a remote file missing locally, or with other bytes. */
export function planPull(remote: LibraryFile[], local: LocalFile[]): FilePlanRow[] {
  const byName = new Map(local.map((f) => [f.name, f]));
  return remote.map((file) => {
    const known = byName.get(file.name);
    return { name: file.name, status: !known ? 'new' : known.sha256 === file.sha256 ? 'unchanged' : 'modified' };
  });
}

/** Keeps the rows a name filter asks for; no names means all of them. */
export function onlyNames<T extends { name: string }>(rows: T[], names: string[]): T[] {
  if (names.length === 0) return rows;
  const wanted = new Set(names.map((n) => n.replace(/\\/g, '/').replace(/^files\//, '')));
  return rows.filter((r) => wanted.has(r.name));
}

/**
 * The CDN base of the workspace library, for a document the CLI renders locally and sends to the API
 * as HTML: that document arrives complete, so its `<base href>` has to be right before it leaves.
 * The base is read off a file's URL (`<cdn>/a/<workspace>/<name>`), which needs `file:read`; an empty
 * library has nothing to resolve, and a key without the scope renders as before.
 */
export async function remoteAssetBase(client: Pick<Formfeed, 'files'>): Promise<string | undefined> {
  try {
    const page = await client.files.list({ limit: 1 });
    const file = page.data[0];
    if (!file) return undefined;
    const encoded = file.name.split('/').map(encodeURIComponent).join('/');
    return file.url.endsWith(`/${encoded}`) ? file.url.slice(0, -(encoded.length + 1)) : undefined;
  } catch {
    return undefined;
  }
}
