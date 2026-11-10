import MarkdownIt from 'markdown-it';
import {
  MARKDOWN_LIMITS,
  markdownTextWithinLimit,
  utf8Bytes,
} from './settings';

/**
 * Pictures of a Markdown file on the author's disk (plan 29, decisions 10 and 11): `formfeed pdf
 * convert notes.md` and the stdio MCP server's `markdown_to_pdf` send a picture named by a relative
 * path inside the file's folder as a data URI, because the API never reads the caller's disk. A
 * relative name with no file behind it stays as written, a file of the workspace library by name; a
 * path outside the folder is refused, so a document cannot carry `../../.ssh/id_rsa` along.
 *
 * Pure and free of Node: the caller says where a path leads and reads the file (`PictureFiles`).
 */

/** The types a picture may have, by the extension of its file, as the converter keeps `data:image/`. */
export const MARKDOWN_PICTURE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Why a picture cannot go along: outside the folder, not a picture type, or the document too large. */
export type MarkdownPictureProblem = 'outside' | 'type' | 'too_large';

export class MarkdownPictureError extends Error {
  constructor(
    readonly code: MarkdownPictureProblem,
    message: string,
    /** The path as the document wrote it; for `too_large`, the largest picture. */
    readonly path: string,
  ) {
    super(message);
    this.name = 'MarkdownPictureError';
  }
}

/** Where a path leads and what is there, as the caller's disk answers. */
export interface PictureFiles {
  /** The file a relative path names, or null when it lies outside the document's folder. */
  locate(path: string): string | null;
  /** The bytes of a located file, or null when there is no file (then it is a library name). */
  read(file: string): Promise<Uint8Array | null>;
}

export interface InlinedPictures {
  /** The text with each local picture as a data URI. */
  markdown: string;
  /** The paths sent along, as the document wrote them. */
  inlined: string[];
  /** The relative names with no file behind them, left for the workspace library. */
  library: string[];
}

/** A picture's address in the text: its offsets, and the path it names. */
interface Occurrence {
  start: number;
  end: number;
  path: string;
}

const blockParser = new MarkdownIt('default', { html: true });

/** The lines whose text is not Markdown's own: code blocks and raw HTML blocks. */
function opaqueLines(markdown: string): Set<number> {
  const lines = new Set<number>();
  for (const token of blockParser.parse(markdown, {})) {
    if (
      (token.type === 'fence' ||
        token.type === 'code_block' ||
        token.type === 'html_block') &&
      token.map
    )
      for (let line = token.map[0]; line < token.map[1]; line++)
        lines.add(line);
  }
  return lines;
}

/**
 * A line with its inline code spans blanked out, so offsets stay where they are: a run of backticks
 * opens a span that the next run of the same length closes, as CommonMark reads them.
 */
function withoutCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n++;
    let close = -1;
    for (let j = i + n; j < line.length;) {
      if (line[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (line[j + m] === '`') m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close < 0) {
      out += line.slice(i, i + n);
      i += n;
      continue;
    }
    out += ' '.repeat(close + n - i);
    i = close + n;
  }
  return out;
}

/** A destination as written: without its angle brackets and escapes, percent-decoded. */
function pathOf(destination: string): string {
  const bare =
    destination.startsWith('<') && destination.endsWith('>')
      ? destination.slice(1, -1)
      : destination;
  const unescaped = bare.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

/** Whether an address names something on the author's disk: no scheme, no anchor, no host. */
function isLocal(path: string): boolean {
  if (!path || path.startsWith('#') || path.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

const normaliseLabel = (label: string) =>
  label.trim().replace(/\s+/g, ' ').toLowerCase();

const INLINE_PICTURE = /!\[(?:[^\]\\]|\\.)*\]\([ \t]*(<[^>\n]*>|[^\s)]+)/g;
const PICTURE_REFERENCE =
  /!\[((?:[^\]\\]|\\.)*)\](?!\()(?:\[((?:[^\]\\]|\\.)*)\])?/g;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)/;

/**
 * The local pictures of a Markdown text: inline ones (`![alt](logo.png)`) and the definitions that
 * a reference-style picture uses (`![alt][logo]` with `[logo]: logo.png`). Code blocks, raw HTML
 * blocks and code spans are skipped, and so is every address with a scheme.
 */
function localPictures(markdown: string): Occurrence[] {
  const opaque = opaqueLines(markdown);
  const lines = markdown.split('\n');
  const found: Occurrence[] = [];
  const labels = new Set<string>();
  const definitions: Array<{ label: string; occurrence: Occurrence }> = [];
  let offset = 0;
  for (const [index, raw] of lines.entries()) {
    const start = offset;
    offset += raw.length + 1;
    if (opaque.has(index)) continue;
    const line = withoutCodeSpans(raw);
    for (const m of line.matchAll(INLINE_PICTURE)) {
      const destination = m[1]!;
      const at = start + m.index! + m[0].length - destination.length;
      const path = pathOf(
        raw.slice(at - start, at - start + destination.length),
      );
      if (isLocal(path))
        found.push({ start: at, end: at + destination.length, path });
    }
    for (const m of line.matchAll(PICTURE_REFERENCE))
      labels.add(normaliseLabel(m[2] || m[1]!));
    const definition = DEFINITION.exec(line);
    if (definition) {
      const destination = definition[2]!;
      const at = start + definition[0].length - destination.length;
      const path = pathOf(
        raw.slice(at - start, at - start + destination.length),
      );
      if (isLocal(path))
        definitions.push({
          label: normaliseLabel(definition[1]!),
          occurrence: { start: at, end: at + destination.length, path },
        });
    }
  }
  for (const { label, occurrence } of definitions)
    if (labels.has(label)) found.push(occurrence);
  return found.sort((a, b) => a.start - b.start);
}

/** Base64 with Web APIs only, in chunks, since a picture can be larger than an argument list. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const megabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;

/**
 * Sends a Markdown file's local pictures along as data URIs. Throws `MarkdownPictureError` for a
 * path outside the folder, a file that is not a PNG, JPEG, GIF, WebP or SVG, and a document that
 * would be larger than the 1 MB a Markdown render takes, naming the largest picture.
 */
export async function inlineMarkdownPictures(
  markdown: string,
  files: PictureFiles,
): Promise<InlinedPictures> {
  const occurrences = localPictures(markdown);
  const uris = new Map<string, string | null>();
  const sizes = new Map<string, number>();
  for (const { path } of occurrences) {
    if (uris.has(path)) continue;
    const file = files.locate(path);
    if (file === null)
      throw new MarkdownPictureError(
        'outside',
        `The picture ${path} lies outside the document's folder; only pictures inside it are sent along`,
        path,
      );
    const bytes = await files.read(file);
    if (bytes === null) {
      uris.set(path, null);
      continue;
    }
    const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';
    const type = MARKDOWN_PICTURE_TYPES[extension];
    if (!type)
      throw new MarkdownPictureError(
        'type',
        `The picture ${path} is no PNG, JPEG, GIF, WebP or SVG file`,
        path,
      );
    uris.set(path, `data:${type};base64,${base64(bytes)}`);
    sizes.set(path, bytes.length);
  }
  let out = markdown;
  for (const { start, end, path } of [...occurrences].reverse()) {
    const uri = uris.get(path);
    if (uri) out = `${out.slice(0, start)}${uri}${out.slice(end)}`;
  }
  if (!markdownTextWithinLimit(out)) {
    const largest = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0];
    throw new MarkdownPictureError(
      'too_large',
      `With its pictures the document is ${megabytes(utf8Bytes(out))}, more than the ${megabytes(MARKDOWN_LIMITS.textBytes)} a Markdown render takes; upload the larger pictures${largest ? ` (${largest[0]} is ${megabytes(largest[1])})` : ''} to the file library and name them there`,
      largest?.[0] ?? '',
    );
  }
  const inlined = [...uris.entries()].filter(([, uri]) => uri).map(([p]) => p);
  const library = [...uris.entries()].filter(([, uri]) => !uri).map(([p]) => p);
  return { markdown: out, inlined, library };
}
