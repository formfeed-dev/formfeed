/**
 * `@formfeed/engine/markdown` (plan 29): what `settings.markdown` asks for, its limits, the one
 * wording of its refusals and the versions a Markdown render records. No parser is imported here and
 * nothing of Node, so the gateway Worker reads the same names as the render-worker, the CLI and the
 * engine's converter (`convert.ts`).
 */

/**
 * The look of a Markdown document: `document` (the default) is a stylesheet written for the wrapper
 * the converter writes, and takes the brand kit's fonts and colour; `none` is the print reset only,
 * for a caller's own `css`.
 */
export const MARKDOWN_THEMES = ['document', 'none'] as const;
export type MarkdownTheme = (typeof MARKDOWN_THEMES)[number];

/**
 * Raw HTML in the text (plan 29, decision 3). `safe`, the default of a Markdown source, shows it as
 * text and keeps only a few formatting tags without attributes; `allow` writes it as it stands, for
 * Markdown the caller wrote.
 */
export const MARKDOWN_HTML_MODES = ['safe', 'allow'] as const;
export type MarkdownHtmlMode = (typeof MARKDOWN_HTML_MODES)[number];

/** `settings.markdown` as a request writes it. */
export interface MarkdownSettings {
  theme?: MarkdownTheme;
  html?: MarkdownHtmlMode;
  /** A single line break is a `<br>`, as in a chat; off by default, as in GitHub Flavored Markdown. */
  breaks?: boolean;
  /** A stylesheet that comes after the theme. */
  css?: string;
}

/** `settings.markdown` with every default filled in. */
export interface ResolvedMarkdown {
  theme: MarkdownTheme;
  html: MarkdownHtmlMode;
  breaks: boolean;
  css: string;
}

export const MARKDOWN_LIMITS = {
  /**
   * The text of a Markdown source, in UTF-8 bytes. Step 1 measured 735 pages of prose for 1 MB in
   * 5.5 s on production's CPU, where 2 MB took 26 s and 5 MB lay past what Chromium prints.
   */
  textBytes: 1024 * 1024,
  /** `settings.markdown.css`, in UTF-8 bytes. */
  cssBytes: 256 * 1024,
} as const;

const SETTING_KEYS = ['theme', 'html', 'breaks', 'css'] as const;

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;
const kilobytes = (bytes: number) => `${bytes / 1024} kB`;

/**
 * Every refusal of a Markdown request, worded once. The gateway answers each as 400
 * `invalid_request` with the field it names.
 */
export const MARKDOWN_REFUSALS = {
  notObject: 'settings.markdown must be an object',
  unknownKey: (key: string) =>
    `settings.markdown.${key} is not a setting: the settings are ${SETTING_KEYS.join(', ')}`,
  theme: `settings.markdown.theme must be one of ${MARKDOWN_THEMES.join(', ')}`,
  html: `settings.markdown.html must be one of ${MARKDOWN_HTML_MODES.join(', ')}`,
  breaks: 'settings.markdown.breaks must be true or false',
  css: 'settings.markdown.css must be a stylesheet as text',
  cssTooLarge: `settings.markdown.css is larger than ${kilobytes(MARKDOWN_LIMITS.cssBytes)}`,
  textTooLarge: `markdown is larger than ${megabytes(MARKDOWN_LIMITS.textBytes)}`,
  otherSource: 'settings.markdown applies to a markdown source only',
} as const;

/** A refusal and the field it is about, as `settings.markdown.<key>` or `settings.markdown`. */
export interface MarkdownProblem {
  field: string;
  message: string;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a text, counted without encoding it where its length alone settles the question. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Whether a text is within a byte limit; a string is at most three bytes per UTF-16 unit. */
function withinBytes(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return true;
  return text.length <= limit && utf8Bytes(text) <= limit;
}

/** Whether the text of a Markdown source is within `MARKDOWN_LIMITS.textBytes`. */
export function markdownTextWithinLimit(text: string): boolean {
  return withinBytes(text, MARKDOWN_LIMITS.textBytes);
}

/**
 * What is wrong with a `settings.markdown` block, or `null` when the API takes it. The block is
 * strict (plan 29, decision 6): an unknown key or a value that does not exist is refused, never
 * ignored, so a typo does not quietly print a document in another look.
 */
export function markdownSettingsProblem(
  value: unknown,
): MarkdownProblem | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    return { field: 'settings.markdown', message: MARKDOWN_REFUSALS.notObject };
  const block = value as Record<string, unknown>;
  for (const key of Object.keys(block))
    if (!(SETTING_KEYS as readonly string[]).includes(key))
      return {
        field: `settings.markdown.${key}`,
        message: MARKDOWN_REFUSALS.unknownKey(key),
      };
  const at = (key: (typeof SETTING_KEYS)[number], message: string) => ({
    field: `settings.markdown.${key}`,
    message,
  });
  if (
    block['theme'] !== undefined &&
    !(MARKDOWN_THEMES as readonly unknown[]).includes(block['theme'])
  )
    return at('theme', MARKDOWN_REFUSALS.theme);
  if (
    block['html'] !== undefined &&
    !(MARKDOWN_HTML_MODES as readonly unknown[]).includes(block['html'])
  )
    return at('html', MARKDOWN_REFUSALS.html);
  if (block['breaks'] !== undefined && typeof block['breaks'] !== 'boolean')
    return at('breaks', MARKDOWN_REFUSALS.breaks);
  if (block['css'] !== undefined) {
    if (typeof block['css'] !== 'string')
      return at('css', MARKDOWN_REFUSALS.css);
    if (!withinBytes(block['css'], MARKDOWN_LIMITS.cssBytes))
      return at('css', MARKDOWN_REFUSALS.cssTooLarge);
  }
  return null;
}

/** Whether a `settings.markdown` value is one the API takes. */
export function isMarkdownSettings(
  value: unknown,
): value is MarkdownSettings | null | undefined {
  return markdownSettingsProblem(value) === null;
}

/**
 * `settings.markdown` as a render reads it: the defaults where the block says nothing, and the
 * defaults again for a value the API would have refused, since a render never fails on its look.
 */
export function resolveMarkdown(value: unknown): ResolvedMarkdown {
  const block =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const theme = block['theme'];
  const html = block['html'];
  return {
    theme: (MARKDOWN_THEMES as readonly unknown[]).includes(theme)
      ? (theme as MarkdownTheme)
      : 'document',
    html: (MARKDOWN_HTML_MODES as readonly unknown[]).includes(html)
      ? (html as MarkdownHtmlMode)
      : 'safe',
    breaks: block['breaks'] === true,
    css: typeof block['css'] === 'string' ? block['css'] : '',
  };
}

// --- versions ----------------------------------------------------------------------------------

/**
 * What converts the text: the parser, its release (`convert.spec.ts` holds it to the installed
 * package) and the revision of our own rules on top of it (front matter, page breaks, heading levels
 * and ids, cells, task lists, raw HTML). A change to the rules that changes a document bumps `rules`.
 */
export const MARKDOWN_CONVERTER = {
  parser: 'markdown-it',
  version: '15.0.3',
  rules: 1,
} as const;

/**
 * The revision of each theme's stylesheet. A change to a theme bumps its revision, so a render is
 * never deduplicated against a file in yesterday's look; `themes.spec.ts` holds each to a hash of
 * its CSS.
 */
export const MARKDOWN_THEME_REVISIONS: Readonly<Record<MarkdownTheme, number>> =
  {
    document: 1,
    none: 1,
  };

/**
 * How a render records its converter and theme, in `engine_version` and the deduplication key:
 * `markdown-it 15.0.3, rules 1, theme document 1`.
 */
export function markdownVersion(theme: MarkdownTheme): string {
  const { parser, version, rules } = MARKDOWN_CONVERTER;
  return `${parser} ${version}, rules ${rules}, theme ${theme} ${MARKDOWN_THEME_REVISIONS[theme]}`;
}
