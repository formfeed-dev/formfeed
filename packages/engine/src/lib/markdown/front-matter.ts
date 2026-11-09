/**
 * A YAML front matter block at the start of a Markdown document (plan 29, decision 7): removed from
 * the text, and its `title`, `author`, `subject` and `keywords` fill the PDF's metadata where the
 * settings leave it empty. A block that is no YAML mapping stays Markdown, where `---` is a rule or
 * the line under a heading. The `yaml` package is imported only when a document opens with `---`.
 */

/** What the metadata of a document can take from its front matter. */
export interface FrontMatterMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
}

export interface FrontMatter {
  /** The text after the block. */
  body: string;
  /** The block's lines, which the text after it no longer counts. */
  lines: number;
  metadata: FrontMatterMetadata;
}

/** A block longer than this is no front matter anyone wrote; it stays Markdown. */
const MAX_BLOCK = 64 * 1024;

/** `---` on the first line, after a byte order mark if the file has one. */
const OPENING = new RegExp(`^${String.fromCharCode(0xfeff)}?---[ \\t]*\\r?\\n`);
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;

const KEYS = ['title', 'author', 'subject', 'keywords'] as const;

/** Where the block ends: the index after its closing line, and its YAML, or `null` for none. */
function findBlock(
  text: string,
): { yaml: string; end: number; lines: number } | null {
  const opening = OPENING.exec(text.slice(0, 16));
  if (!opening) return null;
  let at = opening[0].length;
  let lines = 1;
  while (at <= text.length && at - opening[0].length <= MAX_BLOCK) {
    const newline = text.indexOf('\n', at);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(at, lineEnd).replace(/\r$/, '');
    lines++;
    if (CLOSING.test(line))
      return {
        yaml: text.slice(opening[0].length, at),
        end: newline < 0 ? text.length : newline + 1,
        lines,
      };
    if (newline < 0) return null;
    at = newline + 1;
  }
  return null;
}

/** A scalar, or a list of scalars joined as keywords are; anything else says nothing. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) {
    const items = value.map(textOf).filter((v): v is string => !!v);
    return items.length ? items.join(', ') : undefined;
  }
  return undefined;
}

/** Whether a document opens with what may be front matter; `readFrontMatter` decides. */
export function opensWithFrontMatter(text: string): boolean {
  return OPENING.test(text.slice(0, 16));
}

/**
 * Reads the front matter of a document, or returns `null` when it has none: no block, a block
 * without its closing line, YAML that does not parse, or YAML that is no mapping.
 */
export async function readFrontMatter(
  text: string,
): Promise<FrontMatter | null> {
  const block = findBlock(text);
  if (!block) return null;
  const { parse } = await import('yaml');
  let value: unknown;
  try {
    // `error` throws on a broken block and prints no warnings; aliases are capped as by default
    value = parse(block.yaml, {
      logLevel: 'error',
      uniqueKeys: false,
      maxAliasCount: 100,
    });
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const metadata: FrontMatterMetadata = {};
  for (const key of KEYS) {
    const v = textOf(fields[key]);
    if (v) metadata[key] = v;
  }
  return { body: text.slice(block.end), lines: block.lines, metadata };
}
